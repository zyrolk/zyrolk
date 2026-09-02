import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  hasSupplierHubAdvancedAccess,
  PRODUCT_REVIEW_FILTERS,
  supplierConnectionPresentation,
  supplierReviewStatusLabel,
} from '../src/services/supplierHubPresentation';

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Sprint 5.1 exposes Settings in business navigation and protects its Advanced section', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const navigation = hub.slice(
    hub.indexOf('{/* Business navigation */}'),
    hub.indexOf('{/* SUB-TAB CONTENTS */}'),
  );

  for (const label of ['Suppliers', 'Product Review', 'Activity', 'Settings']) {
    assert.match(navigation, new RegExp(`label: '${label}'`));
  }
  assert.doesNotMatch(navigation, /label: 'Advanced'/);
  assert.equal(hasSupplierHubAdvancedAccess({ role: 'super_admin' }), true);
  assert.equal(hasSupplierHubAdvancedAccess({ superAdmin: true }), true);
  assert.equal(hasSupplierHubAdvancedAccess({ role: 'admin' }), false);
});

test('new supplier save is explicit and never starts Initial Sync from the Sprint 5 UI', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const routes = projectFile('functions/src/api/routes/supplier.ts');

  assert.match(hub, /startInitialSync: false/);
  assert.match(hub, /newSupplierConfigurationVerified/);
  assert.match(hub, /Connect Source/);
  assert.match(hub, /Run Initial Sync/);
  assert.match(hub, /Go to Product Review/);
  assert.doesNotMatch(hub, /Save & Start Initial Sync/);
  assert.match(routes, /const startInitialSync = req\.body\?\.startInitialSync !== false/);
  assert.match(routes, /const initialRequest = startInitialSync[\s\S]*const initialSync = initialRequest[\s\S]*createSupplierSyncJob/);
});

test('supplier cards expose only business controls and delay Auto Sync until Initial Sync completes', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const connectionBadge = projectFile('src/components/supplier-ui/SupplierConnectionBadge.tsx');

  for (const label of [
    'Connected Sources',
    'Supplier Platform',
    'Active',
    'Paused',
    'Auto Sync',
    'Last Successful Sync',
    'Health',
    'Test Connection',
    'Sync Now',
    'Edit',
  ]) assert.match(hub, new RegExp(label));

  assert.match(hub, /<SupplierConnectionBadge source=\{source\}/);
  assert.match(connectionBadge, /supplierConnectionPresentation/);
  assert.equal(supplierConnectionPresentation({ connectionStatus: 'failed', lastFailureClassification: 'connector' }).label, 'Connection Problem');
  assert.equal(supplierConnectionPresentation({ connectionStatus: 'failed', lastFailureClassification: 'validation' }).label, 'Connected');
  assert.match(hub, /disabled=\{savingSettingsSourceId !== null \|\| !supplierHasCompletedInitialSync\(source\)\}/);
  assert.match(hub, /setManualSyncSource\(source\)/);
  assert.doesNotMatch(hub, /runManualSupplierSync\(\{ sourceIds: \[id\], mode: 'full' \}\)/);
  assert.match(hub, /<SupplierManualSyncDialog/);
});

test('Product Review is the only normal approval workspace and uses business language', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const quickCard = projectFile('src/components/SupplierReviewQuickCard.tsx');

  assert.deepEqual(PRODUCT_REVIEW_FILTERS.map((item) => item.label), [
    'New Products',
    'Product Updates',
    'Removed Products',
    'Conflicts',
    'Needs Attention',
    'Approval History',
  ]);
  for (const label of [
    'Supplier SKU',
    'Selling price',
    'Supplier cost',
    'Profit',
    'Margin',
    'Stock',
    'Zyro category',
    'Zyro brand',
    'Storefront',
    'Supplier/source',
    'Approve',
    'Reject',
    'Review Product',
  ]) assert.match(quickCard, new RegExp(label.replaceAll('&', '\\&')));

  assert.doesNotMatch(hub, /Bulk Delete/);
  assert.doesNotMatch(hub, /Bulk Approve|Bulk Reject/);
  assert.doesNotMatch(hub, /Import Queue/);
  assert.doesNotMatch(hub, /Pending Changes/);
  assert.equal(supplierReviewStatusLabel({ queueState: 'processing' }), 'Preparing');
  assert.equal(supplierReviewStatusLabel({ queueState: 'review_pending' }), 'Ready for Review');
  assert.equal(supplierReviewStatusLabel({ queueState: 'dead_letter' }), 'Needs Attention');
  assert.equal(supplierReviewStatusLabel({ queueState: 'approved' }), 'Approved');
  assert.equal(supplierReviewStatusLabel({ queueState: 'rejected' }), 'Rejected');
});

test('Activity remains business-focused while diagnostics and controls stay in protected Settings', () => {
  const dashboard = projectFile('src/components/supplier-operations/SupplierOperationsDashboard.tsx');
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');

  for (const label of ['Current sync', 'Last successful sync', 'Failed sync', 'Retry', 'Sync History']) {
    assert.match(dashboard, new RegExp(label));
  }
  assert.match(dashboard, /mode === 'advanced'[\s\S]*Queue monitoring/);
  assert.match(dashboard, /Advanced Media Diagnostics/);
  assert.match(dashboard, /Advanced Performance Diagnostics/);
  assert.match(hub, /Global Auto Sync/);
  assert.match(hub, /Default Profit Margin/);
  assert.match(hub, /Category restrictions/i);
  assert.match(hub, /Brand restrictions/i);
  assert.match(hub, /Catalog fetch page size/i);
  assert.match(hub, /Maximum Image Limit/);
  assert.match(hub, /Supplier Sync Settings/);
  assert.match(hub, /Advanced Settings/);
  assert.match(hub, /canAccessAdvanced && <section/);
});

test('legacy onboarding presentation controls are absent without changing backend compatibility', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const onboarding = projectFile('src/services/supplierSourceOnboarding.ts');
  const compatibility = projectFile('functions/src/api/suppliers/supplierSourceCompatibility.ts');

  assert.doesNotMatch(hub, /Reset Settings|CSS Selector|Import Queue|Pending Changes/);
  assert.doesNotMatch(onboarding, /cssPriceSelector|cssProductSelector|cssStockSelector/);
  assert.match(compatibility, /legacy/i);
});
