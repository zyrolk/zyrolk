import { AI_USAGE_POLICY, type AIUsagePolicy } from './AIUsagePolicy';
import { ContextSanitizer } from './ContextSanitizer';
import { AIProviderError, type AIProviderDomain, type ProviderNeutralPrompt } from './contracts/AIProvider';

export interface PromptBuilderInput {
  readonly domain: AIProviderDomain;
  readonly task: string;
  readonly instructions: readonly string[];
  readonly businessContext: unknown;
  readonly outputSchema: { readonly name: string; readonly requiredFields: readonly string[] };
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  Object.values(value).forEach((child) => { if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child as object); });
  return Object.freeze(value);
}

function byteSize(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

export class PromptBuilder {
  constructor(private readonly sanitizer = new ContextSanitizer(), private readonly policy: AIUsagePolicy = AI_USAGE_POLICY) {}

  build(input: PromptBuilderInput): ProviderNeutralPrompt {
    if (!input.task.trim() || !input.outputSchema.name.trim()) throw new AIProviderError('INVALID_REQUEST', 'Prompt task and output schema name are required.');
    const context = this.sanitizer.sanitize(input.businessContext);
    if (byteSize(context) > this.policy.maxContextSize) {
      throw new AIProviderError('CONTEXT_TOO_LARGE', `Sanitized context exceeds ${this.policy.maxContextSize} bytes.`, { maxContextSize: this.policy.maxContextSize });
    }
    return deepFreeze({
      version: 1 as const,
      domain: input.domain,
      task: input.task.trim(),
      instructions: [...input.instructions.map((item) => item.trim()).filter(Boolean)],
      context,
      output: { format: 'structured-object' as const, schemaName: input.outputSchema.name.trim(), requiredFields: [...input.outputSchema.requiredFields] },
      constraints: { readOnly: true as const, requiresApprovalForActions: true as const },
    }) as ProviderNeutralPrompt;
  }
}
