import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  A2ZConnectorService,
  buildA2ZSessionScopeKey,
  type A2ZSessionScope,
} from '../functions/src/api/suppliers/a2z/A2ZConnectorService';
import type {
  SupplierOutboundPolicy,
  SupplierOutboundResponse,
} from '../functions/src/api/security/supplierOutboundRequest';

interface OutboundCall {
  url: string;
  method: string;
  cookie: string;
  username: string;
}

interface A2ZHarness {
  calls: OutboundCall[];
  authenticationCount: (username: string) => number;
  fetchOutbound: (
    url: string,
    init: RequestInit,
    policy: SupplierOutboundPolicy,
  ) => Promise<SupplierOutboundResponse>;
}

const response = (status: number, body: string, setCookie?: string): SupplierOutboundResponse => {
  const headers = new Headers();
  if (setCookie) headers.set('set-cookie', setCookie);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => body,
    json: async <T = unknown>() => JSON.parse(body) as T,
  };
};

function createHarness(options: { rejectFirstCatalogFor?: string } = {}): A2ZHarness {
  const calls: OutboundCall[] = [];
  const authenticationCounts = new Map<string, number>();
  const rejectedCatalogs = new Set<string>();

  return {
    calls,
    authenticationCount: (username) => authenticationCounts.get(username) || 0,
    fetchOutbound: async (url, init) => {
      const parsedUrl = new URL(url);
      const method = String(init.method || 'GET').toUpperCase();
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : '';
      const username = new URLSearchParams(body).get('un') || '';
      calls.push({ url, method, cookie: headers.get('cookie') || '', username });

      if (parsedUrl.pathname === '/dash') {
        return response(200, '<html></html>', `pre=${parsedUrl.host}; Path=/; HttpOnly`);
      }
      if (parsedUrl.pathname === '/Login/auth') {
        const count = (authenticationCounts.get(username) || 0) + 1;
        authenticationCounts.set(username, count);
        return response(200, '{"status":"success"}', `session=${username}-${count}; Path=/; HttpOnly`);
      }
      if (parsedUrl.pathname === '/Product/getAllproducts2') {
        const rejectedUsername = options.rejectFirstCatalogFor;
        if (rejectedUsername
          && headers.get('cookie')?.includes(`session=${rejectedUsername}-1`)
          && !rejectedCatalogs.has(rejectedUsername)) {
          rejectedCatalogs.add(rejectedUsername);
          return response(200, '<!DOCTYPE html><html>login</html>');
        }
        return response(200, '{"data":[],"recordsTotal":0}');
      }
      throw new Error(`Unexpected A2Z test request: ${method} ${url}`);
    },
  };
}

const scope = (overrides: Partial<A2ZSessionScope> = {}): A2ZSessionScope => ({
  supplierId: 'supplier-a',
  sourceId: 'source-a',
  targetUrl: 'https://supplier.example.com',
  credentialReference: 'secret-manager:profile-a',
  ...overrides,
});

const policy = (sourceId: string, host = 'supplier.example.com'): SupplierOutboundPolicy => ({
  approvedHosts: [host],
  connector: 'a2z',
  sourceId,
});

test('A2Z session identity includes supplier, source, target host, and credential reference', () => {
  const baseline = buildA2ZSessionScopeKey(scope());
  const variants = [
    buildA2ZSessionScopeKey(scope({ supplierId: 'supplier-b' })),
    buildA2ZSessionScopeKey(scope({ sourceId: 'source-b' })),
    buildA2ZSessionScopeKey(scope({ targetUrl: 'https://other.example.com' })),
    buildA2ZSessionScopeKey(scope({ credentialReference: 'secret-manager:profile-b' })),
  ];
  assert.equal(new Set([baseline, ...variants]).size, 5);
});

test('two A2Z suppliers authenticate simultaneously without sharing sessions', async () => {
  const harness = createHarness();
  const supplierA = new A2ZConnectorService(scope(), { fetchOutbound: harness.fetchOutbound });
  const supplierB = new A2ZConnectorService(scope({
    supplierId: 'supplier-b',
    sourceId: 'source-b',
    credentialReference: 'secret-manager:profile-b',
  }), { fetchOutbound: harness.fetchOutbound });

  await Promise.all([
    supplierA.fetchCatalogPage(scope().targetUrl, { username: 'user-a', password: 'password-a' }, policy('source-a'), { cursor: null, pageSize: 100 }),
    supplierB.fetchCatalogPage(scope().targetUrl, { username: 'user-b', password: 'password-b' }, policy('source-b'), { cursor: null, pageSize: 100 }),
  ]);

  const catalogCalls = harness.calls.filter((call) => new URL(call.url).pathname === '/Product/getAllproducts2');
  assert.equal(catalogCalls.length, 2);
  assert.ok(catalogCalls.some((call) => call.cookie.includes('session=user-a-1') && !call.cookie.includes('user-b')));
  assert.ok(catalogCalls.some((call) => call.cookie.includes('session=user-b-1') && !call.cookie.includes('user-a')));
});

test('an A2Z session is reused before expiry and refreshed after expiry', async () => {
  let currentTime = 1_000;
  const harness = createHarness();
  const service = new A2ZConnectorService(scope(), {
    fetchOutbound: harness.fetchOutbound,
    now: () => currentTime,
  });
  const credentials = { username: 'expiry-user', password: 'password' };

  await service.fetchCatalog(scope().targetUrl, credentials, policy('source-a'));
  currentTime += (15 * 60 * 1_000) - 1;
  await service.fetchCatalog(scope().targetUrl, credentials, policy('source-a'));
  assert.equal(harness.authenticationCount('expiry-user'), 1);

  currentTime += 2;
  await service.fetchCatalog(scope().targetUrl, credentials, policy('source-a'));
  assert.equal(harness.authenticationCount('expiry-user'), 2);
});

test('credential rotation on one A2Z source cannot reuse its previous authenticated session', async () => {
  const harness = createHarness();
  const service = new A2ZConnectorService(scope(), { fetchOutbound: harness.fetchOutbound });

  await service.fetchCatalog(scope().targetUrl, { username: 'before-rotation', password: 'password-1' }, policy('source-a'));
  await service.fetchCatalog(scope().targetUrl, { username: 'after-rotation', password: 'password-2' }, policy('source-a'));

  assert.equal(harness.authenticationCount('before-rotation'), 1);
  assert.equal(harness.authenticationCount('after-rotation'), 1);
  const catalogCookies = harness.calls
    .filter((call) => new URL(call.url).pathname === '/Product/getAllproducts2')
    .map((call) => call.cookie);
  assert.ok(catalogCookies.some((cookie) => cookie.includes('session=before-rotation-1')));
  assert.ok(catalogCookies.some((cookie) => cookie.includes('session=after-rotation-1')));
});

test('catalog authentication rejection refreshes only the affected supplier session and retries once', async () => {
  const harness = createHarness({ rejectFirstCatalogFor: 'retry-user' });
  const service = new A2ZConnectorService(scope(), { fetchOutbound: harness.fetchOutbound });

  await service.fetchCatalog(scope().targetUrl, { username: 'retry-user', password: 'password' }, policy('source-a'));

  assert.equal(harness.authenticationCount('retry-user'), 2);
  const catalogCookies = harness.calls
    .filter((call) => new URL(call.url).pathname === '/Product/getAllproducts2')
    .map((call) => call.cookie);
  assert.equal(catalogCookies.length, 2);
  assert.ok(catalogCookies[0].includes('session=retry-user-1'));
  assert.ok(catalogCookies[1].includes('session=retry-user-2'));
});

test('parallel page requests share one in-flight login only within their own supplier scope', async () => {
  const harness = createHarness();
  const supplierA = new A2ZConnectorService(scope(), { fetchOutbound: harness.fetchOutbound });
  const supplierB = new A2ZConnectorService(scope({
    supplierId: 'supplier-b',
    sourceId: 'source-b',
    credentialReference: 'secret-manager:profile-b',
  }), { fetchOutbound: harness.fetchOutbound });

  await Promise.all([
    supplierA.fetchCatalogPage(scope().targetUrl, { username: 'parallel-a', password: 'password-a' }, policy('source-a'), { cursor: null, pageSize: 50 }),
    supplierA.fetchCatalogPage(scope().targetUrl, { username: 'parallel-a', password: 'password-a' }, policy('source-a'), { cursor: '50', pageSize: 50 }),
    supplierB.fetchCatalogPage(scope().targetUrl, { username: 'parallel-b', password: 'password-b' }, policy('source-b'), { cursor: null, pageSize: 50 }),
    supplierB.fetchCatalogPage(scope().targetUrl, { username: 'parallel-b', password: 'password-b' }, policy('source-b'), { cursor: '50', pageSize: 50 }),
  ]);

  assert.equal(harness.authenticationCount('parallel-a'), 1);
  assert.equal(harness.authenticationCount('parallel-b'), 1);
  const catalogCalls = harness.calls.filter((call) => new URL(call.url).pathname === '/Product/getAllproducts2');
  assert.equal(catalogCalls.filter((call) => call.cookie.includes('parallel-a')).length, 2);
  assert.equal(catalogCalls.filter((call) => call.cookie.includes('parallel-b')).length, 2);
});

test('the A2Z registry integration supplies every session isolation dimension', () => {
  const connector = readFileSync('functions/src/api/suppliers/a2z/A2ZSupplierConnector.ts', 'utf8');
  const registry = readFileSync('functions/src/api/suppliers/SupplierRegistry.ts', 'utf8');
  const service = readFileSync('functions/src/api/suppliers/a2z/A2ZConnectorService.ts', 'utf8');

  assert.match(connector, /this\.supplierId = options\.supplierId \|\| this\.id/);
  assert.match(connector, /supplierId: this\.supplierId/);
  assert.match(connector, /sourceId: this\.id/);
  assert.match(connector, /targetUrl,/);
  assert.match(
    connector,
    /this\.credentialReference = normalizeA2ZCredentialReference\(options\.credentialReference \|\| DEFAULT_A2Z_CREDENTIAL_REFERENCE\)/,
  );
  assert.match(connector, /credentialReference: this\.credentialReference/);
  assert.match(registry, /supplierId: source\.supplierId/);
  assert.match(registry, /sourceId: source\.id/);
  assert.match(registry, /source\.authentication\.secretRef/);
  assert.match(registry, /source\.authentication\.credentialProfile/);
  assert.doesNotMatch(service, /private static sessionCookie/);
  assert.doesNotMatch(service, /private static lastLoginTime/);
});
