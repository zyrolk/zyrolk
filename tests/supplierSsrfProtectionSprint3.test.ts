import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  isBlockedSupplierIp,
  validateSupplierOutboundUrl,
  validateSupplierRequestTarget,
} from '../functions/src/api/security/supplierUrlProtection';
import {
  createPinnedLookup,
  fetchSupplierOutbound,
  SupplierOutboundResponse,
  SupplierOutboundTransport,
} from '../functions/src/api/security/supplierOutboundRequest';

const publicHost = 'supplier.example.com';
const publicAddress = '93.184.216.34';

const response = (status: number, location?: string): SupplierOutboundResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(location ? { location } : {}),
  text: async () => '[]',
  json: async <T>() => [] as T,
});

const runPinnedLookup = (all: boolean) => new Promise<{ address: string | Array<{ address: string; family: number }>; family?: number }>((resolve, reject) => {
  createPinnedLookup(publicAddress)(publicHost, { all }, (error, address, family) => {
    if (error) {
      reject(error);
      return;
    }
    resolve({ address, family });
  });
});

test('pinned lookup returns Node-compatible single and all-address result shapes', async () => {
  const singleResult = await runPinnedLookup(false);
  assert.equal(singleResult.address, publicAddress);
  assert.equal(singleResult.family, 4);

  const allResult = await runPinnedLookup(true);
  assert.deepEqual(allResult.address, [{ address: publicAddress, family: 4 }]);
  assert.equal(allResult.family, undefined);
});

test('Enterprise outbound policy blocks localhost, metadata, private, carrier-grade, reserved, and special-use IP ranges', async () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '198.18.0.1', '224.0.0.1', '240.0.0.1',
    '::1', '::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1',
  ]) {
    assert.equal(isBlockedSupplierIp(address), true, `${address} must be blocked`);
  }
  assert.equal(isBlockedSupplierIp(publicAddress), false);
  assert.equal(isBlockedSupplierIp('2606:4700:4700::1111'), false);

  await assert.rejects(
    () => validateSupplierOutboundUrl('http://localhost', ['localhost'], async () => ['127.0.0.1']),
    /host is blocked/,
  );
  await assert.rejects(
    () => validateSupplierOutboundUrl('http://metadata.google.internal', ['metadata.google.internal'], async () => [publicAddress]),
    /host is blocked/,
  );
});

test('supplier target validation permits only allowlisted public destinations', async () => {
  const target = await validateSupplierRequestTarget(
    `https://${publicHost}`,
    '/catalog',
    [publicHost],
    async () => [publicAddress],
  );
  assert.equal(target.targetUrl, `https://${publicHost}/catalog`);
  assert.deepEqual(target.resolvedAddresses, [publicAddress]);
  await assert.rejects(
    () => validateSupplierOutboundUrl('https://unapproved.example.net/catalog', [publicHost], async () => [publicAddress]),
    /allowlist/,
  );
});

test('redirect destinations are DNS-validated before a second outbound connection', async () => {
  const visited: string[] = [];
  const transport: SupplierOutboundTransport = async (target) => {
    visited.push(target.hostname);
    return response(302, 'https://private-redirect.example.com/catalog');
  };

  await assert.rejects(
    () => fetchSupplierOutbound(`https://${publicHost}/catalog`, {}, {
      approvedHosts: [publicHost, 'private-redirect.example.com'],
      connector: 'test',
      resolveHost: async (hostname) => hostname === publicHost ? [publicAddress] : ['10.0.0.5'],
    }, transport),
    /blocked network address/,
  );
  assert.deepEqual(visited, [publicHost]);
});

test('outbound execution re-resolves the host and defeats initial-validation DNS rebinding', async () => {
  let resolutions = 0;
  const resolver = async () => {
    resolutions += 1;
    return resolutions === 1 ? [publicAddress] : ['192.168.1.20'];
  };
  await validateSupplierRequestTarget(`https://${publicHost}`, '', [publicHost], resolver);

  let transportCalls = 0;
  const transport: SupplierOutboundTransport = async () => {
    transportCalls += 1;
    return response(200);
  };
  await assert.rejects(
    () => fetchSupplierOutbound(`https://${publicHost}`, {}, {
      approvedHosts: [publicHost], connector: 'test', resolveHost: resolver,
    }, transport),
    /blocked network address/,
  );
  assert.equal(transportCalls, 0);
  assert.equal(resolutions, 2);
});

test('public redirects succeed only after each hop is validated and sensitive headers do not cross hosts', async () => {
  const visited: string[] = [];
  const transport: SupplierOutboundTransport = async (target, init) => {
    visited.push(target.hostname);
    if (target.hostname === publicHost) return response(302, 'https://cdn.supplier.example.com/catalog');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.equal(new Headers(init.headers).has('cookie'), false);
    return response(200);
  };
  const result = await fetchSupplierOutbound(`https://${publicHost}/catalog`, {
    headers: { authorization: 'Bearer secret', cookie: 'session=secret' },
  }, {
    approvedHosts: [publicHost],
    connector: 'test',
    resolveHost: async () => [publicAddress],
  }, transport);
  assert.equal(result.status, 200);
  assert.deepEqual(visited, [publicHost, 'cdn.supplier.example.com']);
});

test('A2Z and generic HTTP connectors share the central outbound request policy', () => {
  const genericConnector = readFileSync('functions/src/api/suppliers/HttpSupplierConnector.ts', 'utf8');
  const a2zConnector = readFileSync('functions/src/api/suppliers/a2z/A2ZConnectorService.ts', 'utf8');
  const registry = readFileSync('functions/src/api/suppliers/SupplierRegistry.ts', 'utf8');

  assert.match(genericConnector, /fetchSupplierOutbound\(this\.targetUrl/);
  assert.match(a2zConnector, /fetchSupplierOutbound\(url/);
  assert.doesNotMatch(genericConnector, /await fetch\(/);
  assert.doesNotMatch(a2zConnector, /await fetch\(/);
  assert.match(registry, /outboundPolicy:/);
  assert.match(registry, /approvedHosts/);
});
