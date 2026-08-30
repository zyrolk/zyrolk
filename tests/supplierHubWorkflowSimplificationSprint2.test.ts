import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  hasSupplierHubAdvancedAccess,
  matchesProductChangeFilter,
  matchesProductReviewFilter,
  PRODUCT_REVIEW_FILTERS,
  supplierHealthLabel,
  supplierReviewApiState,
} from '../src/services/supplierHubPresentation';

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Supplier Hub exposes only the four business navigation sections', () => {
  const component = projectFile('src/components/SupplierHubFiveStars.tsx');
  const navigation = component.slice(
    component.indexOf('{/* Business navigation */}'),
    component.indexOf('{/* SUB-TAB CONTENTS */}'),
  );

  for (const label of ['Suppliers', 'Product Review', 'Activity', 'Settings']) {
    assert.match(navigation, new RegExp(`label: '${label}'`));
  }
  for (const internalLabel of ['Review Queue', 'Import Queue', 'Pending Changes', 'Operations']) {
    assert.doesNotMatch(navigation, new RegExp(`label: '${internalLabel}'`));
  }
});

test('Product Review presents the required business filters and maps them to existing data', () => {
  assert.deepEqual(PRODUCT_REVIEW_FILTERS.map((filter) => filter.label), [
    'New Products',
    'Product Updates',
    'Removed Products',
    'Conflicts',
    'Needs Attention',
    'Approval History',
  ]);
  assert.equal(matchesProductReviewFilter({ comparison: { comparisonStatus: 'NEW_PRODUCT' } }, 'new_products'), true);
  assert.equal(matchesProductReviewFilter({ comparison: { comparisonStatus: 'PRICE_CHANGED' } }, 'product_updates'), true);
  assert.equal(matchesProductReviewFilter({ comparison: { comparisonStatus: 'SUPPLIER_OFFER_REMOVED' } }, 'removed_products'), true);
  assert.equal(matchesProductReviewFilter({ queueState: 'conflict' }, 'conflicts'), true);
  assert.equal(matchesProductReviewFilter({ productValidation: { readyToPublish: false } }, 'needs_attention'), true);
  assert.equal(matchesProductReviewFilter({ status: 'Approved' }, 'approved_history'), true);
  assert.equal(matchesProductChangeFilter({ changeType: 'PRODUCT_REMOVED' }, 'removed_products'), true);
  assert.equal(supplierReviewApiState('conflicts'), 'conflict');
  assert.equal(supplierReviewApiState('approved_history'), 'history');
});

test('supplier cards use business health labels and retain existing actions', () => {
  assert.equal(supplierHealthLabel({ enabled: false }), 'Disabled');
  assert.equal(supplierHealthLabel({ sourceStatus: 'paused' }), 'Paused');
  assert.equal(supplierHealthLabel({ connectionStatus: 'connected' }), 'Healthy');
  assert.equal(supplierHealthLabel({ lastError: 'timeout' }), 'Needs attention');

  const component = projectFile('src/components/SupplierHubFiveStars.tsx');
  for (const control of ['Connect External Supplier', 'Edit', 'Test Connection', 'Run Initial Sync', 'Sync Now']) {
    assert.match(component, new RegExp(control));
  }
  assert.match(component, /handleSupplierPauseAction/);
  assert.match(component, /const action = isPaused \? 'resume' : 'pause'/);
  assert.match(component, /Auto Sync/);
  assert.match(component, /Last Successful Sync/);
  assert.match(component, /Health/);
  assert.doesNotMatch(component, /Advanced supplier details/);
});

test('Activity exposes only business sync state while technical operations stay Advanced', () => {
  const component = projectFile('src/components/supplier-operations/SupplierOperationsDashboard.tsx');
  assert.match(component, /'Current sync'/);
  assert.match(component, /'Last successful sync'/);
  assert.match(component, /'Failed sync'/);
  assert.match(component, /'Retry'/);
  assert.match(component, />Sync History</);
  assert.match(component, /Approval & Activity History/);
  assert.match(component, /mode === 'advanced'[\s\S]*Advanced Diagnostics/);
  assert.match(component, /Advanced Media Diagnostics/);
  assert.match(component, /Advanced Performance Diagnostics/);
});

test('product review editor prioritizes storefront fields and collapses supplier details', () => {
  const editor = projectFile('src/components/SupplierReviewEditorModal.tsx');
  assert.match(editor, /<details open className="order-10[\s\S]*?aria-labelledby="supplier-product-images-title"/);
  assert.match(editor, /<details open className="order-20[^\"]*"[\s\S]*?>Product, pricing & catalogue</);
  assert.match(editor, /<details open className="order-30[\s\S]*?aria-labelledby="supplier-review-content-title"/);
  assert.match(editor, /<details open className="order-40[\s\S]*?>Category specifications</);
  assert.match(editor, /Supplier information/);
  assert.match(editor, /Supplier metadata/);
  assert.match(editor, /Advanced field protection/);
});

test('Settings contains business controls and a claim-restricted Advanced section', () => {
  const component = projectFile('src/components/SupplierHubFiveStars.tsx');
  assert.equal(hasSupplierHubAdvancedAccess({ role: 'super_admin' }), true);
  assert.equal(hasSupplierHubAdvancedAccess({ role: 'admin' }), false);
  assert.match(component, /activeSubTab === 'settings'/);
  assert.match(component, /Global Auto Sync/);
  assert.match(component, /Default Auto Sync Behaviour/);
  assert.match(component, /Advanced Settings/);
  assert.match(component, /Supplier Restrictions & Limits/);
});
