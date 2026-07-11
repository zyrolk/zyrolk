import { AI_USAGE_POLICY, type AIUsagePolicy } from './AIUsagePolicy';
import { AIProviderRegistry } from './AIProviderRegistry';
import {
  AIProviderError,
  type AIProvider,
  type AIProviderCapability,
  type AIProviderHealth,
  type AIProviderRequest,
} from './contracts/AIProvider';

export interface AIOrchestrationSelection {
  readonly providerId: string;
  readonly providerName: string;
  readonly health: AIProviderHealth;
  readonly request: AIProviderRequest;
  readonly timeoutMs: number;
}
export type AIOrchestrationResult =
  | { readonly ok: true; readonly selection: AIOrchestrationSelection }
  | { readonly ok: false; readonly error: AIProviderError };

function supports(provider: AIProvider, request: AIProviderRequest): boolean {
  if (!provider.capabilities.domains.includes(request.domain)) return false;
  return request.requiredCapabilities.every((capability: AIProviderCapability) => (
    capability === 'read-only' ? provider.capabilities.readOnly : provider.capabilities.features.includes(capability)
  ));
}

function contextSize(context: unknown): number | null {
  try { return new TextEncoder().encode(JSON.stringify(context)).byteLength; } catch { return null; }
}

export class AIOrchestrator {
  constructor(private readonly registry: AIProviderRegistry, private readonly policy: AIUsagePolicy = AI_USAGE_POLICY) {}

  async prepare(request: AIProviderRequest): Promise<AIOrchestrationResult> {
    const fail = (error: AIProviderError): AIOrchestrationResult => Object.freeze({ ok: false, error });
    if (!request || !request.requestId?.trim() || !request.domain || !request.prompt || request.prompt.domain !== request.domain) {
      return fail(new AIProviderError('INVALID_REQUEST', 'Request ID, matching domain, and prompt are required.'));
    }
    if (request.prompt.constraints.readOnly !== true || this.policy.mode !== 'read-only') return fail(new AIProviderError('POLICY_VIOLATION', 'Only read-only orchestration requests are allowed.'));
    const size = contextSize(request.prompt.context);
    if (size === null) return fail(new AIProviderError('INVALID_REQUEST', 'Prompt context must be serializable.'));
    if (size > this.policy.maxContextSize) return fail(new AIProviderError('CONTEXT_TOO_LARGE', `Prompt context exceeds ${this.policy.maxContextSize} bytes.`));

    const provider = request.providerId
      ? this.registry.getProvider(request.providerId)
      : this.registry.listProviders().find((candidate) => supports(candidate, request));
    if (!provider) return fail(new AIProviderError('PROVIDER_NOT_FOUND', request.providerId ? `Provider "${request.providerId}" is not registered.` : 'No registered provider supports this request.'));
    if (!supports(provider, request)) return fail(new AIProviderError('UNSUPPORTED_CAPABILITY', `Provider "${provider.id}" does not support the requested domain or capabilities.`));
    if (size > provider.capabilities.maxContextSize) return fail(new AIProviderError('CONTEXT_TOO_LARGE', `Prompt context exceeds provider "${provider.id}" capacity.`));

    let health: AIProviderHealth;
    try { health = await provider.getHealth(); }
    catch { return fail(new AIProviderError('PROVIDER_UNAVAILABLE', `Provider "${provider.id}" health could not be determined.`)); }
    if (health.state === 'unavailable' || health.state === 'unknown') return fail(new AIProviderError('PROVIDER_UNAVAILABLE', `Provider "${provider.id}" health is ${health.state}.`, { healthState: health.state }));
    const selection: AIOrchestrationSelection = Object.freeze({
      providerId: provider.id, providerName: provider.displayName,
      health: Object.freeze({ ...health }), request, timeoutMs: this.policy.timeoutMs,
    });
    return Object.freeze({ ok: true, selection });
  }
}
