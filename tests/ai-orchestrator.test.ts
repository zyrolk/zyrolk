import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIOrchestrator,
  AIProviderError,
  AIProviderRegistry,
  AI_USAGE_POLICY,
  ContextSanitizer,
  DEFAULT_MAX_CONTEXT_SIZE,
  PromptBuilder,
  ResponseValidator,
  type AIProvider,
  type AIProviderCapability,
  type AIProviderHealthState,
  type AIProviderRequest,
  type AIUsagePolicy,
} from '../src/services/ai-orchestrator/index';

function provider(id: string, state: AIProviderHealthState = 'available', features: readonly AIProviderCapability[] = ['read-only', 'structured-output']): AIProvider {
  return Object.freeze({
    id, displayName: `Provider ${id}`,
    capabilities: Object.freeze({ domains: Object.freeze(['sales', 'pricing'] as const), features: Object.freeze([...features]), readOnly: true as const, maxContextSize: DEFAULT_MAX_CONTEXT_SIZE }),
    getHealth: () => Object.freeze({ state, checkedAt: '2026-01-01T00:00:00.000Z', reason: `Health is ${state}.` }),
  });
}

function prompt(context: unknown = { revenue: 100 }) {
  return new PromptBuilder().build({
    domain: 'sales', task: 'Summarize observed sales facts.', instructions: ['Use facts only.'], businessContext: context,
    outputSchema: { name: 'SalesSummary', requiredFields: ['summary'] },
  });
}

function request(overrides: Partial<AIProviderRequest> = {}): AIProviderRequest {
  return Object.freeze({ requestId: 'request-1', domain: 'sales', requiredCapabilities: Object.freeze(['read-only', 'structured-output'] as const), prompt: prompt(), ...overrides });
}

test('provider registry is instance-based and supports register, get, list, unregister, and duplicate unregister', () => {
  const first = new AIProviderRegistry();
  const second = new AIProviderRegistry();
  const fixture = provider('fixture');
  first.register(fixture);
  assert.equal(first.getProvider('fixture'), fixture);
  assert.equal(second.getProvider('fixture'), undefined);
  assert.deepEqual(first.listProviders(), [fixture]);
  assert.equal(Object.isFrozen(first.listProviders()), true);
  assert.equal(first.unregister('fixture'), true);
  assert.equal(first.unregister('fixture'), false);
});

test('provider registry rejects duplicate registration with a typed error', () => {
  const registry = new AIProviderRegistry();
  registry.register(provider('fixture'));
  assert.throws(() => registry.register(provider('fixture')), (error) => error instanceof AIProviderError && error.code === 'PROVIDER_ALREADY_REGISTERED');
});

test('orchestrator selects a capable provider without invoking inference', async () => {
  const registry = new AIProviderRegistry();
  registry.register(provider('fixture'));
  const result = await new AIOrchestrator(registry).prepare(request());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.selection.providerId, 'fixture');
    assert.equal(result.selection.timeoutMs, AI_USAGE_POLICY.timeoutMs);
    assert.equal(Object.isFrozen(result.selection), true);
  }
  assert.equal('infer' in registry.getProvider('fixture')!, false);
  assert.equal('generate' in registry.getProvider('fixture')!, false);
});

test('orchestrator rejects missing providers, UNKNOWN health, and unsupported capabilities', async () => {
  const empty = await new AIOrchestrator(new AIProviderRegistry()).prepare(request());
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error.code, 'PROVIDER_NOT_FOUND');

  const unknownRegistry = new AIProviderRegistry();
  unknownRegistry.register(provider('unknown', 'unknown'));
  const unknown = await new AIOrchestrator(unknownRegistry).prepare(request({ providerId: 'unknown' }));
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'PROVIDER_UNAVAILABLE');

  const limitedRegistry = new AIProviderRegistry();
  limitedRegistry.register(provider('limited', 'available', ['read-only']));
  const unsupported = await new AIOrchestrator(limitedRegistry).prepare(request({ providerId: 'limited' }));
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.error.code, 'UNSUPPORTED_CAPABILITY');
});

test('context sanitizer removes customer identifiers without mutating input and safely handles circular references', () => {
  const input: Record<string, unknown> = {
    product: { name: 'Public Product' },
    customer: { name: 'Private Name', email: 'private@example.com', phone: '0770000000', address: 'Private Address', uid: 'secret-uid' },
  };
  input.self = input;
  const sanitized = new ContextSanitizer().sanitize(input) as Record<string, unknown>;
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('Private Name'), false);
  assert.equal(serialized.includes('private@example.com'), false);
  assert.equal(serialized.includes('secret-uid'), false);
  assert.equal(serialized.includes('Public Product'), true);
  assert.equal(sanitized.self, '[Circular]');
  assert.equal((input.customer as Record<string, unknown>).email, 'private@example.com');
  assert.equal(Object.isFrozen(sanitized), true);
});

test('prompt builder returns provider-neutral immutable prompts and rejects oversized sanitized context', () => {
  const built = prompt({ customerName: 'Private', productName: 'Public Product' });
  assert.equal(Object.isFrozen(built), true);
  assert.equal(Object.isFrozen(built.instructions), true);
  assert.equal(JSON.stringify(built).includes('Private'), false);
  assert.equal(JSON.stringify(built).includes('Public Product'), true);

  const smallPolicy: AIUsagePolicy = { ...AI_USAGE_POLICY, maxContextSize: 16 };
  const builder = new PromptBuilder(new ContextSanitizer(), smallPolicy);
  assert.throws(() => builder.build({ domain: 'sales', task: 'Test', instructions: [], businessContext: { value: 'This exceeds sixteen bytes.' }, outputSchema: { name: 'Test', requiredFields: [] } }), (error) => error instanceof AIProviderError && error.code === 'CONTEXT_TOO_LARGE');
});

test('response validator canonicalizes required fields, ignores unknown provider fields, and validates total usage', () => {
  const validator = new ResponseValidator();
  const valid = validator.validate({
    responseId: 'response-1', requestId: 'request-1', providerId: 'fixture', status: 'success', content: { summary: 'Fact' },
    providerMetadata: { providerId: 'fixture', model: 'future-model', unknownProviderField: 'ignored' },
    usage: { inputUnits: 10, outputUnits: 5, totalUnits: 15, latencyMs: 20, unknownUsageField: 1 },
    unknownTopLevelField: true,
  });
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal('unknownProviderField' in valid.response.providerMetadata, false);
    assert.equal('unknownTopLevelField' in valid.response, false);
    assert.equal(Object.isFrozen(valid.response), true);
  }
  const inconsistent = validator.validate({
    responseId: 'response-1', requestId: 'request-1', providerId: 'fixture', status: 'success', content: {},
    providerMetadata: { providerId: 'fixture' }, usage: { inputUnits: 10, outputUnits: 5, totalUnits: 99, latencyMs: 20 },
  });
  assert.equal(inconsistent.valid, false);
  if (!inconsistent.valid) assert.equal(inconsistent.error.code, 'INVALID_RESPONSE');
});

test('usage policy is immutable, read-only, and exposes named context and timeout defaults', () => {
  assert.equal(DEFAULT_MAX_CONTEXT_SIZE, 32 * 1024);
  assert.equal(AI_USAGE_POLICY.maxContextSize, DEFAULT_MAX_CONTEXT_SIZE);
  assert.equal(AI_USAGE_POLICY.timeoutMs, 30_000);
  assert.equal(AI_USAGE_POLICY.mode, 'read-only');
  assert.equal(AI_USAGE_POLICY.retry.automatic, false);
  assert.equal(AI_USAGE_POLICY.futureRateLimit.enabled, false);
  assert.equal(Object.isFrozen(AI_USAGE_POLICY), true);
  assert.equal(Object.isFrozen(AI_USAGE_POLICY.approvalRequiredActions), true);
});
