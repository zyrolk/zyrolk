import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SupplierReviewEditorModal from '../src/components/SupplierReviewEditorModal';
import { SupplierReviewQuickCard, SupplierReviewQuickCardProps } from '../src/components/SupplierReviewQuickCard';
import {
  supplierReviewCanQuickApprove,
  supplierReviewDecisionReady,
  supplierReviewDisplayLabel,
  supplierReviewIsStale,
  supplierReviewManagedImageUrl,
  supplierReviewSpecificationCount,
  supplierReviewTerminalItem,
} from '../src/services/supplierHubPresentation';
import { createSupplierReviewDraft } from '../src/services/supplierReviewEditor';

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const managedImage = 'https://firebasestorage.googleapis.com/v0/b/demo/o/supplier-media%2Fmanaged.webp?alt=media';
const readyItem = {
  status: 'Pending',
  queueState: 'review_pending',
  supplierOfferPendingRevision: 'a'.repeat(64),
  imageUrl: 'https://supplier.example.test/upstream.jpg',
  comparison: { comparisonStatus: 'NEW_PRODUCT' },
  productValidation: { readyToPublish: true, missingFields: [], errors: [] },
  managedMedia: [{ firebaseStorageUrl: managedImage, isPrimary: true, sortOrder: 0 }],
  productPayload: { specs: { Model: 'QA-1', Colour: 'Blue' } },
};

const quickCardProps = (overrides: Partial<SupplierReviewQuickCardProps> = {}): SupplierReviewQuickCardProps => ({
  productName: 'Rendered QA product',
  supplierItemCode: 'SUP-QA-1',
  managedImageUrl: managedImage,
  statusLabel: 'Ready for Review',
  changeLabel: 'New product',
  sellingPrice: 1_500,
  supplierCost: 1_000,
  profit: 500,
  marginPercent: 33.33,
  stock: 7,
  brandLabel: 'Registered Brand',
  categoryLabel: 'Electronics',
  subcategoryLabel: 'Accessories',
  storefrontVisible: true,
  supplierAttribution: 'A2Z Traders · A2Z',
  blockingProblems: [],
  decisionReady: true,
  canQuickApprove: true,
  needsResolution: false,
  processing: false,
  onApprove: () => undefined,
  onReject: () => undefined,
  onViewDetails: () => undefined,
  onViewHistory: () => undefined,
  ...overrides,
});

const renderQuickCard = (overrides: Partial<SupplierReviewQuickCardProps> = {}): string => (
  renderToStaticMarkup(React.createElement(SupplierReviewQuickCard, quickCardProps(overrides)))
);

test('normal ready products are the only records eligible for quick approval', () => {
  assert.equal(supplierReviewCanQuickApprove(readyItem), true);
  assert.equal(supplierReviewCanQuickApprove({
    ...readyItem,
    productValidation: {
      readyToPublish: false,
      missingFields: ['brand'],
      errors: [{ field: 'brand', code: 'required', message: 'Brand is required.' }],
    },
  }), false);
  assert.equal(supplierReviewCanQuickApprove({ ...readyItem, status: 'CONFLICT', queueState: 'conflict', approvalConflict: { reason: 'live_product_changed' } }), false);
  assert.equal(supplierReviewCanQuickApprove({ ...readyItem, comparison: { comparisonStatus: 'SUPPLIER_OFFER_REMOVED' } }), false);
});

test('stale or unbound queue revisions fail closed before the API request', () => {
  assert.equal(supplierReviewIsStale(readyItem), false);
  assert.equal(supplierReviewIsStale({ ...readyItem, supplierOfferPendingRevision: '' }), true);
  assert.equal(supplierReviewIsStale({ ...readyItem, queueState: 'processing' }), true);
  assert.equal(supplierReviewIsStale({ ...readyItem, status: 'Approved' }), true);
  assert.equal(supplierReviewCanQuickApprove({ ...readyItem, supplierOfferPendingRevision: 'stale' }), false);
});

test('quick review uses managed media and canonical productPayload.specs', () => {
  assert.equal(supplierReviewManagedImageUrl(readyItem), managedImage);
  assert.notEqual(supplierReviewManagedImageUrl(readyItem), readyItem.imageUrl);
  assert.equal(supplierReviewSpecificationCount(readyItem), 2);
  assert.equal(supplierReviewSpecificationCount({
    ...readyItem,
    productPayload: { specs: {}, specifications: { Legacy: 'must not count' } },
  } as unknown as typeof readyItem), 0);
  assert.equal(supplierReviewCanQuickApprove({ ...readyItem, managedMedia: [] }), false);
});

test('rendered quick review uses verified catalogue labels and never renders raw catalogue IDs', () => {
  const categoryId = 'internal-category-document-id';
  const subcategoryId = 'internal-subcategory-document-id';
  const brandId = 'internal-brand-document-id';
  const categoryLabel = supplierReviewDisplayLabel(categoryId, [{ id: categoryId, name: 'Electronics' }]);
  const subcategoryLabel = supplierReviewDisplayLabel(subcategoryId, [{ id: subcategoryId, name: 'Accessories' }]);
  const brandLabel = supplierReviewDisplayLabel(brandId, [{ id: brandId, name: 'Registered Brand' }]);
  const markup = renderQuickCard({ categoryLabel, subcategoryLabel, brandLabel });

  assert.match(markup, />Electronics</u);
  assert.match(markup, />Accessories</u);
  assert.match(markup, />Registered Brand</u);
  assert.doesNotMatch(markup, new RegExp(`${categoryId}|${subcategoryId}|${brandId}`, 'u'));

  assert.equal(supplierReviewDisplayLabel(categoryId, []), 'Loading…');
  assert.equal(supplierReviewDisplayLabel(categoryId, [{ id: 'another-category', name: 'Another category' }]), 'Not available');
  assert.equal(supplierReviewDisplayLabel('', []), 'Not available');
  const missingMarkup = renderQuickCard({
    categoryLabel: supplierReviewDisplayLabel(categoryId, []),
    subcategoryLabel: supplierReviewDisplayLabel(subcategoryId, [{ id: 'another-subcategory', name: 'Other' }]),
    brandLabel: supplierReviewDisplayLabel(brandId, []),
  });
  assert.match(missingMarkup, /Loading…/u);
  assert.match(missingMarkup, /Not available/u);
  assert.doesNotMatch(missingMarkup, new RegExp(`${categoryId}|${subcategoryId}|${brandId}`, 'u'));
});

test('rendered quick actions follow ready, invalid, conflict, and removal gates', () => {
  assert.match(renderQuickCard(), /aria-label="Approve Rendered QA product"/u);
  assert.match(renderQuickCard(), /aria-label="Reject Rendered QA product"/u);
  assert.match(renderQuickCard(), />View Details</u);

  const invalid = supplierReviewCanQuickApprove({
    ...readyItem,
    productValidation: { readyToPublish: false, missingFields: ['brand'], errors: [] },
  });
  const conflict = supplierReviewCanQuickApprove({ ...readyItem, status: 'CONFLICT', queueState: 'conflict' });
  const removal = supplierReviewCanQuickApprove({ ...readyItem, comparison: { comparisonStatus: 'SUPPLIER_OFFER_REMOVED' } });
  for (const [name, canQuickApprove] of [['invalid', invalid], ['conflict', conflict], ['removal', removal]] as const) {
    const markup = renderQuickCard({ canQuickApprove, needsResolution: true });
    assert.doesNotMatch(markup, /aria-label="Approve Rendered QA product"/u, `${name} product exposed Quick Approve`);
    assert.match(markup, /aria-label="Reject Rendered QA product"/u);
    assert.match(markup, />Review &amp; Resolve</u);
  }
});

test('successful decisions render terminal state without stale Approve or Reject controls', () => {
  for (const action of ['approved', 'rejected'] as const) {
    const terminalItem = supplierReviewTerminalItem(readyItem, action);
    const terminalState = action === 'approved' ? 'Approved' : 'Rejected';
    assert.equal(supplierReviewDecisionReady(terminalItem), false);
    const markup = renderQuickCard({
      decisionReady: supplierReviewDecisionReady(terminalItem),
      canQuickApprove: supplierReviewCanQuickApprove(terminalItem),
      terminalState,
    });
    assert.match(markup, new RegExp(`Decision recorded: ${terminalState}`, 'u'));
    assert.doesNotMatch(markup, /aria-label="Approve Rendered QA product"/u);
    assert.doesNotMatch(markup, /aria-label="Reject Rendered QA product"/u);
    assert.match(markup, /View decision history/u);
  }

  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const approvalStart = hub.indexOf('const handleApproveReviewItem');
  const approvalEnd = hub.indexOf('const handleRejectReviewItem', approvalStart);
  const approvalHandler = hub.slice(approvalStart, approvalEnd);
  assert.ok(approvalHandler.indexOf("supplierReviewTerminalItem(candidate, 'approved')") >= 0);
  assert.ok(approvalHandler.indexOf("supplierReviewTerminalItem(candidate, 'approved')") < approvalHandler.indexOf('await refreshSupplierQueueViews()'));
  assert.match(approvalHandler, /Queue refresh failed, so this decision remains locked locally/u);

  const rejectionStart = hub.indexOf('const handleRejectReviewItem');
  const rejectionEnd = hub.indexOf('// --- SETTINGS CONFIGURATION HANDLERS ---', rejectionStart);
  const rejectionHandler = hub.slice(rejectionStart, rejectionEnd);
  assert.ok(rejectionHandler.indexOf("supplierReviewTerminalItem(candidate, 'rejected')") >= 0);
  assert.ok(rejectionHandler.indexOf("supplierReviewTerminalItem(candidate, 'rejected')") < rejectionHandler.indexOf('await refreshSupplierQueueViews()'));
  assert.match(rejectionHandler, /Queue refresh failed, so this decision remains locked locally/u);
});

test('launch review UI exposes only individual quick decisions and compact business fields', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const quickCard = projectFile('src/components/SupplierReviewQuickCard.tsx');
  const start = hub.indexOf('Launch-ready quick review list');
  const end = hub.indexOf('End launch-ready quick review list');
  assert.ok(start >= 0 && end > start);
  const quickReview = hub.slice(start, end);
  const launchUi = `${quickReview}\n${quickCard}`;

  for (const label of [
    'Supplier SKU',
    'Selling price',
    'Supplier cost',
    'Profit',
    'Margin',
    'Stock',
    'Category',
    'Subcategory',
    'Brand',
    'Storefront',
    'Supplier/source',
    'Approve',
    'Reject',
    'View Details',
    'Review & Resolve',
  ]) assert.match(launchUi, new RegExp(label.replaceAll('/', '\\/')));

  assert.doesNotMatch(launchUi, />\{item\.(?:supplierId|sourceId|supplierOfferId|id)\}</u);
  assert.doesNotMatch(launchUi, /Description|Detected|Batch ID|SEO|Field Ownership|Supplier Metadata/u);
  assert.doesNotMatch(hub, /Bulk Approve|Bulk Reject|bulk-approve|bulk-reject/u);
  assert.doesNotMatch(hub, />Dismiss</u);
  assert.match(quickReview, /supplierReviewCanQuickApprove\(item\)/u);
  assert.match(quickReview, /supplierReviewManagedImageUrl\(item\)/u);
  assert.match(quickReview, /handleApproveReviewItem\(item, draft\)/u);
  assert.match(hub, /expectedPendingRevision: item\.supplierOfferPendingRevision/u);
});

test('rendered View Details starts read-only and makes editing explicit', () => {
  const modal = projectFile('src/components/SupplierReviewEditorModal.tsx');
  assert.match(modal, /const \[isEditing, setIsEditing\] = useState\(false\)/u);
  assert.match(modal, /<fieldset disabled=\{!isEditing \|\| isPublishing\}/u);
  assert.match(modal, /Details are read-only/u);
  assert.match(modal, /Edit product data/u);
  assert.match(modal, /supplierReviewSpecificationCount\(item\)/u);
  assert.match(modal, /Approve & Publish/u);

  const modalItem = {
    ...readyItem,
    id: 'internal-queue-document-id',
    productName: 'Rendered QA product',
    supplierCode: 'SUP-QA-1',
    costPrice: 1_000,
    marketPrice: 1_500,
    stock: 7,
    productPayload: {
      id: 'internal-product-document-id',
      name: 'Rendered QA product',
      description: 'Rendered product description',
      price: 1_500,
      originalPrice: 1_500,
      costPrice: 1_000,
      marketPrice: 1_500,
      stock: 7,
      category: 'electronics',
      subcategory: 'accessories',
      brand: 'registered-brand',
      imageUrl: managedImage,
      imageUrls: [managedImage],
      specs: { Model: 'QA-1' },
      rating: 0,
      reviewsCount: 0,
      isActive: true,
    },
  };
  const initialDraft = createSupplierReviewDraft(modalItem);
  const markup = renderToStaticMarkup(React.createElement(SupplierReviewEditorModal, {
    item: modalItem,
    initialDraft,
    categories: [{ id: 'electronics', name: 'Electronics', subcategories: [{ id: 'accessories', name: 'Accessories' }], specificationTemplate: [] }],
    brands: [{ id: 'registered-brand', name: 'Registered Brand' }],
    validCategoryIds: ['electronics'],
    isPublishing: false,
    onClose: () => undefined,
    onPublish: async () => undefined,
    offers: [],
    offerSelection: { activeOfferId: null, lockedOfferId: null, failoverEnabled: true },
    offersLoading: false,
    offerActionId: null,
    offerError: null,
    onRefreshOffers: async () => undefined,
    onConfigureOffer: async () => undefined,
    onSelectOffer: async () => undefined,
  }));
  assert.match(markup, /Details are read-only/u);
  assert.match(markup, /<fieldset disabled=""/u);
  assert.match(markup, />Edit product data</u);
  assert.doesNotMatch(markup, /type="submit"/u);
});

test('existing approval API, attribution authority, and audit history remain in use', () => {
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  const quickCard = projectFile('src/components/SupplierReviewQuickCard.tsx');
  const approval = projectFile('functions/src/api/suppliers/supplierApproval.ts');
  assert.match(hub, /\/api\/supplier-review-queue\/\$\{encodeURIComponent\(queueItemId\)\}\/\$\{action\}/u);
  assert.match(approval, /approvedPayload\.supplierId = projectedSupplierOffer\.supplierId/u);
  assert.match(approval, /approvedPayload\.supplierSourceId = projectedSupplierOffer\.sourceId/u);
  assert.match(approval, /approvedPayload\.supplierItemCode = projectedSupplierOffer\.sku/u);
  assert.match(approval, /decisionPendingRevision: queuePendingRevision \|\| null/u);
  assert.match(approval, /createSupplierAuditEvent/u);
  assert.match(quickCard, /View decision history/u);
});
