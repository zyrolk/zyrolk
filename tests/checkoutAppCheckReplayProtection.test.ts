import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fetchJson } from '../src/services/network/fetchJson';

// Deployed Functions are tsc CommonJS output, where `import * as express` is callable.
// tsx's esbuild interop makes it a non-callable namespace, so functions/src is loaded
// here through the TypeScript compiler's CommonJS emit instead.
const functionsSourceRoot = path.resolve('functions/src') + path.sep;
const typescript = createRequire(path.resolve('functions/package.json'))('typescript') as typeof import('typescript');
const moduleExtensions = (Module as unknown as { _extensions: Record<string, (module: { _compile(code: string, filename: string): void }, filename: string) => void> })._extensions;
const tsxTypeScriptLoader = moduleExtensions['.ts'];
moduleExtensions['.ts'] = function loadFunctionsSource(module, filename) {
  if (!filename.startsWith(functionsSourceRoot)) return tsxTypeScriptLoader.call(this, module, filename);
  const { outputText } = typescript.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  });
  module._compile(outputText, filename);
};
const functionsRequire = createRequire(path.resolve('functions/package.json'));
const { createApiApp, requiresAppCheckReplayProtection } = functionsRequire('./src/api/app.ts') as typeof import('../functions/src/api/app');
const { adminAppCheck, adminDb } = functionsRequire('./src/api/firebase.ts') as typeof import('../functions/src/api/firebase');

interface VerifyCall { token: string; options?: { consume?: boolean } }

const verifyCalls: VerifyCall[] = [];
const consumedTokens = new Set<string>();
const originalVerifyToken = adminAppCheck.verifyToken;
let server: http.Server;

const fakeVerifyToken = async (token: string, options?: { consume?: boolean }) => {
  verifyCalls.push({ token, options });
  if (token === 'invalid-token') throw new Error('token signature invalid');
  if (!options?.consume) return { appId: 'web-app', token: {} };
  const alreadyConsumed = consumedTokens.has(token);
  consumedTokens.add(token);
  return { appId: 'web-app', token: {}, alreadyConsumed };
};

function send(method: string, requestPath: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: string }> {
  const { port } = server.address() as AddressInfo;
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, body: text }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

before(async () => {
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.REQUIRE_APP_CHECK;
  (adminAppCheck as unknown as { verifyToken: typeof fakeVerifyToken }).verifyToken = fakeVerifyToken;
  server = createApiApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
});

after(async () => {
  (adminAppCheck as unknown as { verifyToken: typeof originalVerifyToken }).verifyToken = originalVerifyToken;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  verifyCalls.length = 0;
});

test('replay protection applies only to requests Express routes to the checkout handler', () => {
  assert.equal(requiresAppCheckReplayProtection('POST', '/api/checkout'), true);
  assert.equal(requiresAppCheckReplayProtection('POST', '/api/checkout/'), true);
  assert.equal(requiresAppCheckReplayProtection('POST', '/API/Checkout'), true);
  assert.equal(requiresAppCheckReplayProtection('GET', '/api/checkout'), false);
  assert.equal(requiresAppCheckReplayProtection('POST', '/api/checkout/coupon'), false);
  assert.equal(requiresAppCheckReplayProtection('POST', '/api/checkoutx'), false);
  assert.equal(requiresAppCheckReplayProtection('POST', '/api/checkout//'), false);
  assert.equal(requiresAppCheckReplayProtection('POST', '/api/contact-inquiries'), false);
});

test('POST /api/checkout consumes a fresh limited-use token and continues to the checkout handler', async () => {
  const response = await send('POST', '/api/checkout', { 'X-Firebase-AppCheck': 'checkout-token-1' }, {});
  assert.deepEqual(verifyCalls, [{ token: 'checkout-token-1', options: { consume: true } }]);
  assert.equal(response.status, 400);
  assert.doesNotMatch(response.body, /App verification/);
});

test('an already consumed token is rejected on checkout with the safe App Check response', async () => {
  await send('POST', '/api/checkout', { 'X-Firebase-AppCheck': 'checkout-token-replayed' }, {});
  verifyCalls.length = 0;
  const replay = await send('POST', '/api/checkout', { 'X-Firebase-AppCheck': 'checkout-token-replayed' }, {});
  assert.deepEqual(verifyCalls, [{ token: 'checkout-token-replayed', options: { consume: true } }]);
  assert.equal(replay.status, 401);
  assert.deepEqual(JSON.parse(replay.body), { error: 'App verification failed' });
});

test('trailing-slash and mixed-case checkout paths that reach the handler also consume', async () => {
  const slash = await send('POST', '/api/checkout/', { 'X-Firebase-AppCheck': 'checkout-token-slash' }, {});
  const upper = await send('POST', '/API/CHECKOUT', { 'X-Firebase-AppCheck': 'checkout-token-upper' }, {});
  assert.deepEqual(verifyCalls, [
    { token: 'checkout-token-slash', options: { consume: true } },
    { token: 'checkout-token-upper', options: { consume: true } },
  ]);
  assert.equal(slash.status, 400);
  assert.equal(upper.status, 400);
});

test('POST /api/checkout/coupon keeps ordinary reusable verification', async () => {
  const first = await send('POST', '/api/checkout/coupon', { 'X-Firebase-AppCheck': 'session-token' }, {});
  const second = await send('POST', '/api/checkout/coupon', { 'X-Firebase-AppCheck': 'session-token' }, {});
  assert.deepEqual(verifyCalls, [{ token: 'session-token', options: undefined }, { token: 'session-token', options: undefined }]);
  assert.equal(first.status, 400);
  assert.equal(second.status, 400);
  assert.doesNotMatch(`${first.body}${second.body}`, /App verification/);
});

test('an unrelated API route keeps ordinary verification', async () => {
  const response = await send('POST', '/api/monitoring/client-error', { 'X-Firebase-AppCheck': 'session-token' }, { context: 'test' });
  assert.deepEqual(verifyCalls, [{ token: 'session-token', options: undefined }]);
  assert.equal(response.status, 202);
});

test('an invalid token fails closed on checkout without falling back to ordinary verification', async () => {
  const checkout = await send('POST', '/api/checkout', { 'X-Firebase-AppCheck': 'invalid-token' }, {});
  assert.deepEqual(verifyCalls, [{ token: 'invalid-token', options: { consume: true } }]);
  assert.equal(checkout.status, 401);
  assert.deepEqual(JSON.parse(checkout.body), { error: 'App verification failed' });

  verifyCalls.length = 0;
  const coupon = await send('POST', '/api/checkout/coupon', { 'X-Firebase-AppCheck': 'invalid-token' }, {});
  assert.deepEqual(verifyCalls, [{ token: 'invalid-token', options: undefined }]);
  assert.equal(coupon.status, 401);
});

test('a missing token is still rejected before verification', async () => {
  const response = await send('POST', '/api/checkout', {}, {});
  assert.equal(verifyCalls.length, 0);
  assert.equal(response.status, 401);
  assert.deepEqual(JSON.parse(response.body), { error: 'App verification is required' });
});

test('guest tracking requires App Check but does not require Firebase Auth', async () => {
  const missing = await send('POST', '/api/orders/guest-track', {}, { recoveryToken: 'bad' });
  assert.equal(missing.status, 401);
  assert.deepEqual(JSON.parse(missing.body), { error: 'App verification is required' });

  const originalCollection = adminDb.collection;
  (adminDb as unknown as { collection: typeof originalCollection }).collection = (() => ({
    where: () => ({ limit: () => ({ get: async () => ({ size: 0, docs: [] }) }) }),
  })) as unknown as typeof originalCollection;
  try {
    const authorizedByAppCheckOnly = await send('POST', '/api/orders/guest-track', { 'X-Firebase-AppCheck': 'session-token' }, { recoveryToken: 'bad' });
    assert.equal(authorizedByAppCheckOnly.status, 401);
    assert.deepEqual(JSON.parse(authorizedByAppCheckOnly.body), { error: 'Order details could not be verified.' });
  } finally {
    (adminDb as unknown as { collection: typeof originalCollection }).collection = originalCollection;
  }
});

test('sitemap remains exempt from App Check', async () => {
  const originalCollection = adminDb.collection;
  (adminDb as unknown as { collection: () => unknown }).collection = () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) });
  try {
    const response = await send('GET', '/sitemap.xml');
    assert.equal(response.status, 200);
    assert.match(response.body, /<urlset/);
    assert.equal(verifyCalls.length, 0);
  } finally {
    (adminDb as unknown as { collection: typeof originalCollection }).collection = originalCollection;
  }
});

test('the exact loopback Functions-emulator bypass is unchanged, including for checkout', async () => {
  process.env.FUNCTIONS_EMULATOR = 'true';
  try {
    const loopback = await send('POST', '/api/checkout', {}, {});
    assert.equal(loopback.status, 400);
    assert.equal(verifyCalls.length, 0);

    const remoteHost = await send('POST', '/api/checkout', { Host: 'zyro.example' }, {});
    assert.equal(remoteHost.status, 401);
    assert.deepEqual(JSON.parse(remoteHost.body), { error: 'App verification is required' });
    assert.equal(verifyCalls.length, 0);
  } finally {
    delete process.env.FUNCTIONS_EMULATOR;
  }
});

test('fetchJson sends the configured limited-use header as the only App Check header', async () => {
  const sent: Headers[] = [];
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  await fetchJson('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Firebase-AppCheck': 'stale-session-token' },
    body: '{}',
  }, { fetchImpl: fakeFetch, appCheckHeaders: async () => ({ 'X-Firebase-AppCheck': 'limited-use-token' }) });

  assert.equal(sent[0].get('X-Firebase-AppCheck'), 'limited-use-token');
  assert.equal(sent[0].get('Content-Type'), 'application/json');
});

test('separate checkout attempts acquire separate limited-use tokens while keeping the same Idempotency-Key and body', async () => {
  const sent: Array<{ headers: Headers; body: unknown }> = [];
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ headers: new Headers(init?.headers), body: init?.body });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
  let acquisitions = 0;
  const limitedUseHeaders = async () => ({ 'X-Firebase-AppCheck': `limited-use-token-${++acquisitions}` });
  const body = JSON.stringify({ customerUid: 'guest', cartItems: [{ productId: 'p1', quantity: 1, expectedUnitPrice: 1000 }], idempotencyKey: 'same-key' });
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'same-key' }, body };

  await fetchJson('/api/checkout', init, { fetchImpl: fakeFetch, appCheckHeaders: limitedUseHeaders });
  await fetchJson('/api/checkout', init, { fetchImpl: fakeFetch, appCheckHeaders: limitedUseHeaders });

  assert.equal(acquisitions, 2);
  assert.deepEqual(sent.map((request) => request.headers.get('X-Firebase-AppCheck')), ['limited-use-token-1', 'limited-use-token-2']);
  assert.deepEqual(sent.map((request) => request.headers.get('Idempotency-Key')), ['same-key', 'same-key']);
  assert.deepEqual(sent.map((request) => request.body), [body, body]);
});

test('fetchJson default behaviour is unchanged when no App Check provider is configured', async () => {
  const sent: Headers[] = [];
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
  await fetchJson('/api/example', {}, { fetchImpl: fakeFetch });
  assert.equal(sent[0].has('X-Firebase-AppCheck'), false);

  const source = readFileSync('src/services/network/fetchJson.ts', 'utf8');
  assert.match(source, /: options\.fetchImpl \? \{\} : await getAppCheckRequestHeaders\(\);/);
  assert.doesNotMatch(source, /getLimitedUse/);
});

test('ordinary App Check stays on getToken and the limited-use helper uses getLimitedUseToken without caching', () => {
  const source = readFileSync('src/services/security/appCheck.ts', 'utf8');
  const ordinary = source.slice(source.indexOf('export async function getAppCheckRequestHeaders'), source.indexOf('export async function getLimitedUseAppCheckRequestHeaders'));
  const limited = source.slice(source.indexOf('export async function getLimitedUseAppCheckRequestHeaders'), source.indexOf('export async function initializeStorefrontAppCheck'));

  assert.match(ordinary, /getToken\(instance as Parameters<typeof getToken>\[0\], forceRefresh\)/);
  assert.doesNotMatch(ordinary, /getLimitedUseToken/);
  assert.match(limited, /await getAppCheckInstance\(\)/);
  assert.match(limited, /getLimitedUseToken\(instance as Parameters<typeof getLimitedUseToken>\[0\]\)/);
  assert.match(limited, /return \{ 'X-Firebase-AppCheck': result\.token \}/);
  assert.doesNotMatch(limited, /getToken\(|initializeAppCheck|let |=\s*result/);
  assert.equal((source.match(/initializeAppCheck\(/g) || []).length, 1);
});

test('only the checkout order request uses limited-use tokens and guest recovery remains additive', () => {
  const drawer = readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8');
  const checkoutCall = drawer.slice(drawer.indexOf("fetchJson<{ success: boolean; order: Order; error?: string }>('/api/checkout', {") + 60);
  const couponCall = drawer.slice(drawer.indexOf("'/api/checkout/coupon'"), drawer.indexOf('const handleCheckout'));

  assert.match(checkoutCall, /^[^;]*appCheckHeaders: getLimitedUseAppCheckRequestHeaders \}\);/);
  assert.doesNotMatch(couponCall, /getLimitedUse|appCheckHeaders/);
  assert.doesNotMatch(drawer, /X-Firebase-AppCheck/);
  assert.match(drawer, /headers: \{ 'Content-Type': 'application\/json', 'Idempotency-Key': idempotencyKey, \.\.\.\(token \? \{ Authorization: `Bearer \$\{token\}` \} : \{\}\) \},/);
  assert.match(drawer, /body: JSON\.stringify\(\{ \.\.\.requestPayload, idempotencyKey \}\),/);
  assert.match(drawer, /const checkoutSignature = JSON\.stringify\(payload\);/);
  assert.match(drawer, /const idempotencyKey = getIdempotencyKey\(checkoutSignature\);/);
  assert.match(drawer, /guestRecoveryToken/);
  assert.match(drawer, /if \(previous\.key && previous\.signature === signature\) return previous\.key;/);
  assert.match(drawer, /window\.sessionStorage\.setItem\(IDEMPOTENCY_KEY, JSON\.stringify\(\{ key, signature \}\)\);/);

  const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
  const limitedUseReferences = sourceFiles('src')
    .filter((file) => /getLimitedUse/.test(readFileSync(file, 'utf8')))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
  assert.deepEqual(limitedUseReferences, ['src/features/checkout/PremiumCheckoutDrawer.tsx', 'src/services/security/appCheck.ts']);
});
