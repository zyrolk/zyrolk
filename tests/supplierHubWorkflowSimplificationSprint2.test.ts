import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
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
    'Approved History',
  ]);
  assert.equal(matchesProductReviewFilter({ comparison: { comparisonStatus: 'NEW_PRODUCT' } }, 'new_products'), true);
  assert.equal(matchesProductReviewFilter({ comparison: { comparisonStatus: 'PRICE_CHANGED' } }, 'product_updates'), true);
  assert.equal(matchesProductReviewFilter({ comparison: { comparisonStatus: 'SUPPLIER_OFFER_REMOVED' } }, 'removed_products'), true);
  assert.equal(matchesProductReviewFilter({ queueState: 'conflict' }, 'conflicts'), true);
  assert.equal(matchesProductReviewFilter({ productValidation: { readyToPublish: false } }, 'needs_attention'), true);
  assert.equal(matchesProductReviewFilter({ status: 'Approved' }, 'approved_history'), true);
  assert.equal(matchesProductChangeFilter({ changeType: 'PRODUCT_REMOVED' }, 'removed_products'), true);
  assert.equal(supplierReviewApiState('conflicts'), 'conflict');
  assert.equal(supplierReviewApiState('approved_history'), 'approved');
});

test('supplier cards use business health labels and retain existing actions', () => {
  assert.equal(supplierHealthLabel({ enabled: false }), 'Disabled');
  assert.equal(supplierHealthLabel({ sourceStatus: 'paused' }), 'Paused');
  assert.equal(supplierHealthLabel({ connectionStatus: 'connected' }), 'Healthy');
  assert.equal(supplierHealthLabel({ lastError: 'timeout' }), 'Needs attention');

  const component = projectFile('src/components/SupplierHubFiveStars.tsx');
  for (const control of ['Add Supplier', 'Edit', 'Test Connection', 'Update Now']) {
    assert.match(component, new RegExp(control));
  }
  assert.match(component, /handleSupplierPauseAction/);
  assert.match(component, /\? 'Resume' : 'Pause'/);
  assert.match(component, /Advanced supplier details/);
});

test('Activity keeps business history and issues visible while diagnostics are collapsed', () => {
  const component = projectFile('src/components/supplier-operations/SupplierOperationsDashboard.tsx');
  assert.match(component, />Activity</);
  assert.match(component, />Sync history</);
  assert.match(component, />Issues</);
  assert.match(component, /Approval & Activity History/);
  assert.match(component, /<details[^>]*>[\s\S]*Advanced Diagnostics/);
  assert.match(component, /Advanced Media Diagnostics/);
  assert.match(component, /Advanced Performance Diagnostics/);
});

test('product review editor prioritizes storefront fields and collapses supplier details', () => {
  const editor = projectFile('src/components/SupplierReviewEditorModal.tsx');
  assert.match(editor, /order-10[^>]*aria-labelledby="supplier-product-images-title"/);
  assert.match(editor, /order-20 grid gap-4/);
  assert.match(editor, /order-30[^>]*aria-labelledby="supplier-review-content-title"/);
  assert.match(editor, /order-40 grid gap-4/);
  assert.match(editor, /Supplier information/);
  assert.match(editor, /Supplier metadata/);
  assert.match(editor, /Advanced field protection/);
});

test('settings expose business choices first and place technical limits in Advanced sections', () => {
  const component = projectFile('src/components/SupplierHubFiveStars.tsx');
  assert.match(component, /Supplier Settings/);
  assert.match(component, /Automatic updates/);
  assert.match(component, /Automatic update schedule/);
  assert.match(component, /Advanced scheduling details/);
  assert.match(component, /Advanced image settings/);
  assert.match(component, /Advanced supplier scope/);
});
