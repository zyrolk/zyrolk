import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  sanitizeSupplierSource,
  sanitizeSupplierHubSettings,
} from '../functions/src/api/suppliers/supplierAdminConfiguration';

test('Sprint 8 makes Supplier Hub operational collections browser read-only or fully server-only', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  for (const collection of [
    'supplier_review_queue', 'supplier_import_queue', 'supplier_pending_changes',
    'supplier_sync_locks', 'supplier_sync_history', 'supplier_approval_audit',
    'supplier_product_conflicts', 'supplier_settings',
  ]) {
    assert.match(rules, new RegExp(`match /${collection}/\\{docId\\}[\\s\\S]*?allow create, update, delete: if false;`));
  }
  assert.match(rules, /match \/supplierSources\/\{docId\}[\s\S]*?allow read, create, update, delete: if false;/);
  assert.match(rules, /function isSupplierHubAdmin\(\)[\s\S]*?request\.auth\.token\.supplierHubAdmin == true/);
});

test('Supplier Hub authorization uses revocation-checked Firebase custom claims instead of mutable profile roles', () => {
  const middleware = readFileSync('functions/src/api/middleware/supplierHubAdminAuth.ts', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const portal = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');
  assert.match(middleware, /verifyIdToken\(match\[1\], true\)/);
  assert.match(middleware, /claims\.admin === true/);
  assert.doesNotMatch(middleware, /collection\("users"\)/);
  assert.match(routes, /requireSupplierHubAdmin/);
  assert.doesNotMatch(routes, /requireAdminAuth/);
  assert.match(portal, /requireSupplierHubAdmin/);
});

test('Supplier source validation accepts Secret Manager references and rejects credential values', () => {
  const source = sanitizeSupplierSource({
    supplierName: 'A2Z', supplierType: 'a2z', websiteUrl: 'https://supplier.example.com',
    authentication: { mode: 'secret_manager', secretRef: 'A2Z_A2Z_MAIN' },
    settings: { autoSync: '1 hour', productLimit: '25' },
  });
  assert.equal(source.authentication.secretRef, 'A2Z_A2Z_MAIN');
  assert.throws(() => sanitizeSupplierSource({
    supplierName: 'A2Z', supplierType: 'a2z', websiteUrl: 'https://supplier.example.com',
    password: 'not-allowed', authentication: { mode: 'secret_manager', secretRef: 'A2Z_A2Z_MAIN' },
  }), /must not store credentials/);
  assert.throws(() => sanitizeSupplierSource({
    supplierName: 'A2Z', supplierType: 'a2z', websiteUrl: 'https://supplier.example.com',
    config: { apiHeaders: 'Authorization: secret' }, authentication: { mode: 'secret_manager', secretRef: 'A2Z_A2Z_MAIN' },
  }), /must not store credentials/);
  assert.deepEqual(sanitizeSupplierHubSettings({
    maxProducts: 5, defaultImageLimit: 5, defaultMarkup: 10, defaultProfitMargin: 15,
  }).maxProducts, 5);
});

test('A2Z credential resolution has no Firestore or process-environment fallback', () => {
  const credentials = readFileSync('functions/src/api/suppliers/credentials.ts', 'utf8');
  const secrets = readFileSync('functions/src/config/secrets.ts', 'utf8');
  assert.doesNotMatch(credentials, /adminDb|supplierSources|legacyCandidates|resolveA2ZCredentials/);
  assert.match(credentials, /Firebase Secret Manager/);
  assert.doesNotMatch(secrets, /process\.env\.A2Z_USERNAME|process\.env\.A2Z_PASSWORD/);
});
