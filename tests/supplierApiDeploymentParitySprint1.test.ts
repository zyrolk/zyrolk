import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string): string => readFileSync(path, 'utf8');

test('Sprint 1 makes the Functions Supplier API the production manual-sync authority', () => {
  const routes = source('functions/src/api/routes/supplier.ts');
  const worker = source('functions/src/scheduled/supplierSync.ts');
  const hub = source('src/components/SupplierHubFiveStars.tsx');

  assert.match(routes, /app\.post\("\/api\/supplier-sync", requireSupplierHubAdmin/);
  assert.match(routes, /runSupplierSync\(\{[\s\S]*trigger: "manual"/);
  assert.match(worker, /export async function runSupplierSync\(options: SupplierSyncRunOptions = \{\}\)/);
  assert.match(worker, /export async function runScheduledSupplierSync\(\): Promise<void> \{\s+await runSupplierSync\(\{ trigger: "scheduled" \}\);/);
  assert.match(hub, /postSupplierApi\('\/api\/supplier-sync'/);

  const productionHandler = hub.slice(hub.indexOf('const handleSyncSupplier ='), hub.indexOf('// --- CONNECT SUPPLIER HANDLERS ---'));
  assert.doesNotMatch(productionHandler, /postSupplierApi\('\/api\/fetch-supplier'/);
  assert.doesNotMatch(productionHandler, /VITE_USE_LOCAL_SUPPLIER_SYNC|runLocalSupplierSync/);
});

test('server.ts exposes canonical Supplier routes only in a local runtime', () => {
  const server = source('server.ts');
  const hosting = source('firebase.json');

  assert.match(server, /const isLocalSupplierApiRuntime = process\.env\.NODE_ENV !== "production";/);
  assert.match(server, /if \(isLocalSupplierApiRuntime\) \{\s+registerSupplierRoutes\(app\);\s+registerSupplierPortalRoutes\(app/);
  assert.match(server, /if \(isLocalSupplierApiRuntime && process\.env\.USE_LEGACY_SUPPLIER_SERVER === "true"\)/);
  assert.match(hosting, /"source": "\/api\/\*\*"[\s\S]*"function": "api"/);
});
