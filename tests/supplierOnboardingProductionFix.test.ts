import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  addSupplierSourceToConfiguredScope,
  sanitizeSupplierSource,
} from '../functions/src/api/suppliers/supplierAdminConfiguration';
import { resolveSupplierProductArray } from '../functions/src/api/suppliers/HttpSupplierConnector';
import { SupplierRegistry } from '../functions/src/api/suppliers/SupplierRegistry';
import { normalizeSupplierSourceConfig } from '../functions/src/api/suppliers/supplierSourceCompatibility';
import { isSupplierSourceEnabled } from '../functions/src/scheduled/supplierSync';
import {
  A2Z_GLOBAL_SECRET_PROFILE,
  buildSupplierOnboardingSource,
} from '../src/services/supplierSourceOnboarding';
import { normalizeSupplierSourceForUi } from '../src/services/supplierSourceUtils';

test('new A2Z onboarding produces a secure registry-compatible source from UI through sync selection', () => {
  const browserPayload = buildSupplierOnboardingSource({
    id: 'new-a2z',
    supplierName: 'New A2Z Supplier',
    supplierType: 'a2z',
    websiteUrl: 'https://supplier.example.com/dash',
    description: 'Production A2Z feed',
  });

  assert.deepEqual(browserPayload.authentication, {
    mode: 'secret_manager',
    credentialProfile: A2Z_GLOBAL_SECRET_PROFILE,
  });
  assert.doesNotMatch(JSON.stringify(browserPayload), /"(?:username|password|apiKey|token)"/i);

  const stored = sanitizeSupplierSource(browserPayload);
  const registrySource = normalizeSupplierSourceConfig('new-a2z', stored);
  assert.equal(stored.supplierType, 'website');
  assert.equal(registrySource.connectorType, 'a2z');
  assert.equal(registrySource.authentication.credentialProfile, A2Z_GLOBAL_SECRET_PROFILE);
  assert.equal(isSupplierSourceEnabled({ id: 'new-a2z', ...stored }, {}), true);
  assert.ok(SupplierRegistry.supportedConnectorTypes().includes(registrySource.connectorType));
});

test('new REST onboarding selects the registered REST connector without adding browser credentials', () => {
  const browserPayload = buildSupplierOnboardingSource({
    id: 'rest-catalog',
    supplierName: 'REST Catalog',
    supplierType: 'api',
    endpoint: 'https://api.example.com/v1/products',
    apiMethod: 'GET',
    apiDataPath: 'products',
  });
  const stored = sanitizeSupplierSource(browserPayload);
  const registrySource = normalizeSupplierSourceConfig('rest-catalog', stored);

  assert.equal(stored.supplierType, 'website');
  assert.equal(stored.websiteUrl, 'https://api.example.com/v1/products');
  assert.deepEqual(stored.authentication, { mode: 'none' });
  assert.equal(registrySource.connectorType, 'rest');
  assert.equal(isSupplierSourceEnabled({ id: 'rest-catalog', ...stored }, {}), true);
  assert.ok(SupplierRegistry.supportedConnectorTypes().includes(registrySource.connectorType));
  assert.deepEqual(resolveSupplierProductArray({ products: [{ sku: 'SKU-1' }] }, 'products'), [{ sku: 'SKU-1' }]);
  assert.deepEqual(resolveSupplierProductArray([{ sku: 'SKU-2' }], 'products'), [{ sku: 'SKU-2' }]);
});

test('generic HTTP onboarding preserves endpoint composition and the existing website UI contract', () => {
  const browserPayload = buildSupplierOnboardingSource({
    id: 'http-catalog',
    supplierName: 'HTTP Catalog',
    supplierType: 'website',
    websiteUrl: 'https://feed.example.com/catalog/',
    endpoint: 'products.json',
  });
  const stored = sanitizeSupplierSource(browserPayload);
  const registrySource = normalizeSupplierSourceConfig('http-catalog', stored);
  const uiSource = normalizeSupplierSourceForUi({ id: 'http-catalog', ...stored });

  assert.equal(registrySource.connectorType, 'http');
  assert.equal(registrySource.endpoint, 'products.json');
  assert.equal(uiSource.supplierType, 'website');
  assert.equal(uiSource.connectorType, 'http');
});

test('new sources still cannot claim Secret Manager authentication without a reference or profile', () => {
  const payload = buildSupplierOnboardingSource({
    id: 'invalid-a2z',
    supplierName: 'Invalid A2Z',
    supplierType: 'a2z',
    websiteUrl: 'https://supplier.example.com',
  });

  assert.throws(() => sanitizeSupplierSource({
    ...payload,
    authentication: { mode: 'secret_manager' },
  }), /Secret Manager reference or credential profile is required/);
});

test('new active sources join an existing explicit sync scope without changing implicit-scope behavior', () => {
  assert.deepEqual(addSupplierSourceToConfiguredScope({
    enabledSupplierIdsConfigured: true,
    enabledSupplierIds: ['existing-source'],
  }, 'new-source'), ['existing-source', 'new-source']);
  assert.deepEqual(addSupplierSourceToConfiguredScope({
    enabledSupplierIdsConfigured: true,
    enabledSupplierIds: ['new-source'],
  }, 'new-source'), ['new-source']);
  assert.equal(addSupplierSourceToConfiguredScope({ enabledSupplierIdsConfigured: false }, 'new-source'), null);
});

test('connection testing uses the exact source registry record while retaining the legacy URL request fallback', () => {
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const hub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');

  assert.match(routes, /createConnectorForSourceRecord\(sourceId, sourceSnapshot\.data\(\) \|\| \{\}\)/);
  assert.match(routes, /createConnectorForSourceRecord\(sourceId, source, \{ allowProposedHost: true \}\)/);
  assert.match(routes, /allowProposedHost: true/);
  assert.match(routes, /createConnectorForTarget\(websiteUrl, endpoint\)/);
  assert.match(routes, /createOnly: true/);
  assert.match(routes, /testConnection === true[\s\S]*testStoredSupplierSource\(sourceId\)/);
  assert.match(hub, /sourceId: source\.id/);
  assert.match(hub, /source: buildNewSupplierSource\('Not Synced'\)/);
});
