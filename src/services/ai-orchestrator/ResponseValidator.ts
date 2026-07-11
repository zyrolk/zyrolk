import { AIProviderError, type AIProviderResponse, type AIUsageMetadata } from './contracts/AIProvider';

export type ResponseValidationResult =
  | { readonly valid: true; readonly response: AIProviderResponse }
  | { readonly valid: false; readonly error: AIProviderError };

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function nonNegativeFinite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function freezeResponse(response: AIProviderResponse): AIProviderResponse {
  Object.freeze(response.providerMetadata); Object.freeze(response.usage); return Object.freeze(response);
}

export class ResponseValidator {
  validate(input: unknown): ResponseValidationResult {
    const fail = (message: string) => Object.freeze({ valid: false as const, error: new AIProviderError('INVALID_RESPONSE', message) });
    if (!isRecord(input)) return fail('Provider response must be an object.');
    const { responseId, requestId, providerId, status, content, providerMetadata, usage } = input;
    if (typeof responseId !== 'string' || !responseId.trim() || typeof requestId !== 'string' || !requestId.trim() || typeof providerId !== 'string' || !providerId.trim()) return fail('Response, request, and provider identifiers are required.');
    if (status !== 'success' && status !== 'error') return fail('Response status must be success or error.');
    if (!Object.prototype.hasOwnProperty.call(input, 'content')) return fail('Response content is required.');
    if (!isRecord(providerMetadata) || providerMetadata.providerId !== providerId) return fail('Provider metadata must contain the matching provider ID.');
    if (providerMetadata.model !== undefined && typeof providerMetadata.model !== 'string') return fail('Provider model metadata must be a string when present.');
    if (!isRecord(usage)) return fail('Usage metadata is required.');
    const { inputUnits, outputUnits, totalUnits, latencyMs } = usage;
    if (!nonNegativeFinite(inputUnits) || !nonNegativeFinite(outputUnits) || !nonNegativeFinite(totalUnits) || !nonNegativeFinite(latencyMs)) return fail('Usage values must be non-negative finite numbers.');
    if (totalUnits !== inputUnits + outputUnits) return fail('Total usage must equal input plus output usage.');
    const canonicalUsage: AIUsageMetadata = { inputUnits, outputUnits, totalUnits, latencyMs };
    const response: AIProviderResponse = {
      responseId: responseId.trim(), requestId: requestId.trim(), providerId: providerId.trim(), status, content,
      providerMetadata: { providerId: providerId.trim(), ...(typeof providerMetadata.model === 'string' ? { model: providerMetadata.model } : {}) },
      usage: canonicalUsage,
    };
    return Object.freeze({ valid: true as const, response: freezeResponse(response) });
  }
}
