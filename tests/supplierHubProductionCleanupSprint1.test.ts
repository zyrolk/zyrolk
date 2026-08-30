import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('Admin Dashboard owns no legacy Supplier Hub state, listeners, writes, or UI', () => {
  const dashboard = readFileSync('src/components/AdminDashboard.tsx', 'utf8');

  assert.match(dashboard, /lazy\(\(\) => import\('\.\/SupplierHubFiveStars'\)\)/);
  assert.match(dashboard, /<SupplierHubFiveStars[\s\S]*isDarkMode=\{isDarkMode\}/);
  assert.doesNotMatch(dashboard, /useState<[^>]*>\([^)]*\).*supplier|setSupplierReviewQueue|setSupplierPendingChanges|setSupplierSyncHistory/);
  assert.doesNotMatch(dashboard, /collection\(db, ["']supplierHub["']\)|collection\(db, ["']supplier_review_queue["']\)/);
  assert.doesNotMatch(dashboard, /Supplier Sync Portal|handleConnectSupplier|handleTriggerImport|showSyncHistoryModal/);
});

test('active Supplier Hub delegates synchronization and privileged queue work to Functions', () => {
  const supplierHub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');

  assert.match(supplierHub, /postSupplierApi\('\/api\/supplier-sync'/);
  assert.match(supplierHub, /postSupplierApi\(`\/api\/supplier-review-queue/);
  assert.doesNotMatch(supplierHub, /runLocalSupplierSync|commitSupplierSyncWrites|writeBatch\(|getDocs\(collection\(db, ["']products["']/);
  assert.doesNotMatch(supplierHub, /setDoc\(doc\(db, ["']supplierSources["']/);
});

test('obsolete browser Supplier Hub prototype trees are removed while shared image validation remains', () => {
  for (const path of [
    'src/services/sync-engine/SyncManager.ts',
    'src/services/integration/IntegrationManager.ts',
    'src/services/image-management/ImageManager.ts',
    'src/services/sandbox/SandboxManager.ts',
    'src/services/connectors/a2z-website/A2ZConnectorService.ts',
  ]) {
    assert.equal(existsSync(path), false, `${path} should not remain in the production client`);
  }
  assert.equal(existsSync('src/services/connectors/a2z-website/productImages.ts'), true);
});

test('Supplier Hub API authentication is centralized for every frontend consumer', () => {
  const api = readFileSync('src/services/supplierHubApi.ts', 'utf8');
  const supplierHub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  const aiManager = readFileSync('src/features/ai-manager/AIManagerPanel.tsx', 'utf8');

  assert.match(api, /getAppCheckRequestHeaders\(forceRefresh\)/);
  assert.match(api, /Authorization: `Bearer \$\{token\}`/);
  assert.match(api, /if \(response\.status === 401\) response = await request\(true\)/);
  assert.match(supplierHub, /from '\.\.\/services\/supplierHubApi'/);
  assert.match(aiManager, /useAIManagerSupplierData/);
});
