import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { supplierConnectionPresentation } from '../src/services/supplierHubPresentation';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const hub = read('../src/components/SupplierHubFiveStars.tsx');
const quickCard = read('../src/components/SupplierReviewQuickCard.tsx');
const editor = read('../src/components/SupplierReviewEditorModal.tsx');
const activity = read('../src/components/supplier-operations/SupplierOperationsDashboard.tsx');
const badge = read('../src/components/supplier-ui/SupplierConnectionBadge.tsx');

test('one connection presentation normalizes every supported Supplier Hub state', () => {
  assert.deepEqual(supplierConnectionPresentation({ connectionStatus: 'connected' }), { state: 'connected', label: 'Connected' });
  assert.deepEqual(supplierConnectionPresentation({ connectionStatus: 'connected' }, true), { state: 'syncing', label: 'Syncing' });
  assert.deepEqual(supplierConnectionPresentation({ operationalState: 'paused', connectionStatus: 'connected' }, true), { state: 'paused', label: 'Paused' });
  assert.deepEqual(supplierConnectionPresentation({ enabled: false, connectionStatus: 'connected' }, true), { state: 'disabled', label: 'Disabled' });
  assert.deepEqual(supplierConnectionPresentation({ connectionStatus: 'failed' }), { state: 'problem', label: 'Connection Problem' });
});

test('supplier operations share the memoized connection badge while Product Review uses compact attribution', () => {
  assert.match(badge, /supplierConnectionPresentation/);
  assert.match(badge, /export default memo\(SupplierConnectionBadge\)/);
  assert.ok((hub.match(/<SupplierConnectionBadge/g) || []).length >= 1);
  assert.match(hub, /compactSupplierAttribution/);
  assert.match(activity, /<SupplierConnectionBadge/);
});

test('review editor keeps every field while presenting mobile-friendly sections', () => {
  for (const section of [
    'Images & gallery',
    'Product, pricing & catalogue',
    'Content, SEO & merchandising',
    'Specifications',
    'Supplier information',
    'Supplier metadata',
    'Supplier offers',
    'Advanced field protection',
  ]) assert.match(editor, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  for (const field of [
    'Product Name', 'Selling Price', 'Compare Price', 'Cost Price', 'Market Price', 'Stock',
    'Category', 'Subcategory', 'Registered brand', 'Short description', 'Full description',
    'Model', 'Barcode', 'Product type', 'SEO slug', 'Tags', 'Key features', "What's included",
  ]) assert.match(editor, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.match(editor, /max-h-\[calc\(100dvh-1rem\)\]/);
  assert.match(editor, /sticky bottom-0 z-30/);
});

test('suggestions, validation checklist, and gallery controls reuse existing draft data', () => {
  assert.match(editor, /Suggested Category/);
  assert.match(editor, /Suggested Brand/);
  assert.match(editor, /% confidence/);
  assert.match(editor, />Apply</);
  assert.match(editor, /validationChecklist\.map/);
  assert.match(editor, /supplier-publish-blocked-reason/);
  assert.match(editor, /Primary image/);
  assert.match(editor, /moveGalleryImage\(index, -1\)/);
  assert.match(editor, /moveGalleryImage\(index, 1\)/);
  assert.match(editor, /removeGalleryImage\(index\)/);
  assert.match(editor, /No additional gallery images\./);
});

test('individual review cards, explicit detail editing, and Activity filters are present', () => {
  assert.doesNotMatch(hub, /Approving products\.\.\.|Bulk review request in progress/);
  assert.match(hub, /grid gap-4 lg:grid-cols-2/);
  assert.match(hub, /supplierReviewCanQuickApprove/);
  assert.match(quickCard, /View Details/);
  assert.match(editor, /Edit product data/);
  assert.match(activity, /\['all', 'success', 'failed', 'skipped', 'running'\]/);
  assert.match(activity, /aria-label="Filter synchronization history"/);
});
