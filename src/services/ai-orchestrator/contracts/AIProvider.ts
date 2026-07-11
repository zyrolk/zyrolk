export type AIProviderDomain = 'sales' | 'inventory' | 'supplier' | 'pricing' | 'customer' | 'marketing';
export type AIProviderCapability = 'read-only' | 'structured-output' | 'streaming';
export type AIProviderHealthState = 'available' | 'degraded' | 'unavailable' | 'unknown';

export interface AIProviderCapabilities {
  readonly domains: readonly AIProviderDomain[];
  readonly features: readonly AIProviderCapability[];
  readonly readOnly: true;
  readonly maxContextSize: number;
}

export interface AIProviderHealth {
  readonly state: AIProviderHealthState;
  readonly checkedAt: string;
  readonly reason: string;
}

export interface AIProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AIProviderCapabilities;
  getHealth(): AIProviderHealth | Promise<AIProviderHealth>;
}

export interface ProviderNeutralPrompt {
  readonly version: 1;
  readonly domain: AIProviderDomain;
  readonly task: string;
  readonly instructions: readonly string[];
  readonly context: unknown;
  readonly output: {
    readonly format: 'structured-object';
    readonly schemaName: string;
    readonly requiredFields: readonly string[];
  };
  readonly constraints: {
    readonly readOnly: true;
    readonly requiresApprovalForActions: true;
  };
}

export interface AIProviderRequest {
  readonly requestId: string;
  readonly providerId?: string;
  readonly domain: AIProviderDomain;
  readonly requiredCapabilities: readonly AIProviderCapability[];
  readonly prompt: ProviderNeutralPrompt;
}

export interface AIUsageMetadata {
  readonly inputUnits: number;
  readonly outputUnits: number;
  readonly totalUnits: number;
  readonly latencyMs: number;
}

export interface AIProviderResponse {
  readonly responseId: string;
  readonly requestId: string;
  readonly providerId: string;
  readonly status: 'success' | 'error';
  readonly content: unknown;
  readonly providerMetadata: {
    readonly providerId: string;
    readonly model?: string;
  };
  readonly usage: AIUsageMetadata;
}

export type AIProviderErrorCode =
  | 'INVALID_REQUEST'
  | 'CONTEXT_TOO_LARGE'
  | 'PROVIDER_ALREADY_REGISTERED'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_UNAVAILABLE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INVALID_RESPONSE'
  | 'POLICY_VIOLATION';

export class AIProviderError extends Error {
  readonly code: AIProviderErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: AIProviderErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.details = details ? Object.freeze({ ...details }) : undefined;
    Object.freeze(this);
  }
}
