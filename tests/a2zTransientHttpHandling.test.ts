import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  A2ZHttpError,
  A2Z_TRANSIENT_HTTP_MAX_ATTEMPTS,
  classifyA2ZHttpStatus,
  parseRetryAfterMs,
  transientRetryDelayMs,
} from '../functions/src/api/suppliers/a2z/a2zHttpErrors';
import { A2ZConnectorService } from '../functions/src/api/suppliers/a2z/A2ZConnectorService';
import type {
  SupplierOutboundPolicy,
  SupplierOutboundResponse,
} from '../functions/src/api/security/supplierOutboundRequest';

const response = (status: number, body: string, headers: Record<string, string> = {}): SupplierOutboundResponse => {
  const responseHeaders = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: responseHeaders,
    text: async () => body,
    json: async <T = unknown>() => JSON.parse(body) as T,
  };
};

const outboundPolicy = {} as SupplierOutboundPolicy;

test('classifies transient A2Z HTTP statuses as retryable', () => {
  const rateLimited = classifyA2ZHttpStatus(429, '2', 1_000);
  assert.ok(rateLimited instanceof A2ZHttpError);
  assert.equal(rateLimited?.retryable, true);
  assert.equal(rateLimited?.retryAfterMs, 2_000);

  for (const status of [500, 502, 503, 504]) {
    const error = classifyA2ZHttpStatus(status);
    assert.equal(error?.retryable, true, `expected HTTP ${status} to be retryable`);
  }
});

test('classifies authentication failures as non-retryable', () => {
  const authFailure = classifyA2ZHttpStatus(401);
  assert.equal(authFailure?.retryable, false);
  const forbidden = classifyA2ZHttpStatus(403);
  assert.equal(forbidden?.retryable, false);
});

test('parses Retry-After headers with a bounded delay', () => {
  assert.equal(parseRetryAfterMs('3', 0), 3_000);
  assert.equal(parseRetryAfterMs('120', 0), 60_000);
});

test('A2Z connector retries transient catalogue failures before surfacing an error', async () => {
  let catalogAttempts = 0;
  const service = new A2ZConnectorService({
    supplierId: 'supplier-a',
    sourceId: 'source-a',
    targetUrl: 'https://a2zdropshipping.lk',
    credentialReference: 'supplier-a',
  }, {
    fetchOutbound: async (url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/dash') {
        return response(200, '<html></html>', { 'set-cookie': 'pre=test; Path=/' });
      }
      if (parsedUrl.pathname === '/Login/auth') {
        return response(200, '{"status":"success"}', { 'set-cookie': 'session=test-1; Path=/' });
      }
      if (parsedUrl.pathname === '/Product/getAllproducts2') {
        catalogAttempts += 1;
        if (catalogAttempts === 1) {
          return response(503, 'temporary outage');
        }
        return response(200, '{"data":[],"recordsTotal":0}');
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const page = await service.fetchCatalogPage('https://a2zdropshipping.lk', {
    username: 'supplier-user',
    password: 'supplier-pass',
  }, outboundPolicy, { pageSize: 100, cursor: null, mode: 'full' });

  assert.equal(catalogAttempts, 2);
  assert.deepEqual(page.products, []);
});

test('A2Z connector surfaces rate limits as retryable errors after bounded attempts', async () => {
  let catalogAttempts = 0;
  const service = new A2ZConnectorService({
    supplierId: 'supplier-a',
    sourceId: 'source-a',
    targetUrl: 'https://a2zdropshipping.lk',
    credentialReference: 'supplier-a',
  }, {
    fetchOutbound: async (url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/dash') {
        return response(200, '<html></html>', { 'set-cookie': 'pre=test; Path=/' });
      }
      if (parsedUrl.pathname === '/Login/auth') {
        return response(200, '{"status":"success"}', { 'set-cookie': 'session=test-1; Path=/' });
      }
      if (parsedUrl.pathname === '/Product/getAllproducts2') {
        catalogAttempts += 1;
        return response(429, 'rate limited', { 'retry-after': '1' });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  await assert.rejects(
    () => service.fetchCatalogPage('https://a2zdropshipping.lk', {
      username: 'supplier-user',
      password: 'supplier-pass',
    }, outboundPolicy, { pageSize: 100, cursor: null, mode: 'full' }),
    (error: unknown) => error instanceof A2ZHttpError && error.status === 429 && error.retryable === true,
  );
  assert.equal(catalogAttempts, A2Z_TRANSIENT_HTTP_MAX_ATTEMPTS);
});

test('A2Z connector keeps malformed JSON as a fail-closed error', async () => {
  const service = new A2ZConnectorService({
    supplierId: 'supplier-a',
    sourceId: 'source-a',
    targetUrl: 'https://a2zdropshipping.lk',
    credentialReference: 'supplier-a',
  }, {
    fetchOutbound: async (url) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname === '/dash') {
        return response(200, '<html></html>', { 'set-cookie': 'pre=test; Path=/' });
      }
      if (parsedUrl.pathname === '/Login/auth') {
        return response(200, '{"status":"success"}', { 'set-cookie': 'session=test-1; Path=/' });
      }
      if (parsedUrl.pathname === '/Product/getAllproducts2') {
        return response(200, '{not-json');
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  await assert.rejects(
    () => service.fetchCatalogPage('https://a2zdropshipping.lk', {
      username: 'supplier-user',
      password: 'supplier-pass',
    }, outboundPolicy, { pageSize: 100, cursor: null, mode: 'full' }),
    /Failed to parse product catalog as JSON/,
  );
});

test('transient retry delay prefers Retry-After when present', () => {
  const error = new A2ZHttpError('rate limited', 429, true, 4_000);
  assert.equal(transientRetryDelayMs(error, 1), 4_000);
  assert.equal(transientRetryDelayMs(new A2ZHttpError('temporary', 503, true), 2), 2_000);
});

test('A2Z connector service wires HTTP classification into catalogue fetch', () => {
  const connectorService = readFileSync('functions/src/api/suppliers/a2z/A2ZConnectorService.ts', 'utf8');
  assert.match(connectorService, /classifyA2ZHttpStatus/);
  assert.match(connectorService, /A2Z_TRANSIENT_HTTP_MAX_ATTEMPTS/);
  assert.match(connectorService, /REQUEST_TIMEOUT_MS = 15000/);
});
