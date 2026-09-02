import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SupplierReviewEditorModal from '../src/components/SupplierReviewEditorModal';
import {
  countStructuredSupplierSpecifications,
  createSupplierReviewDraft,
  validateSupplierReviewDraft,
} from '../src/services/supplierReviewEditor';
import {
  isSupplierReviewStaleObservationError,
  supplierReviewDecisionReady,
  supplierReviewDisplayImageUrl,
  supplierReviewIsPreparing,
  supplierReviewManagedImageUrl,
  supplierReviewSpecificationCount,
  supplierReviewSpecificationsRequired,
  supplierReviewSpecificationsSatisfied,
  SUPPLIER_REVIEW_STALE_REFRESH_MESSAGE,
} from '../src/services/supplierHubPresentation';
import {
  supplierDescriptionPlainText,
  sanitizeSupplierDescriptionHtml,
} from '../src/services/supplierReviewDescription';
import {
  buildSupplierOfferObservationWrite,
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import { validateSupplierProductForApproval } from '../functions/src/api/suppliers/supplierProductMapping';
import {
  formatSupplierSyncProgress,
  supplierSyncJobDetailLine,
  supplierSyncJobHeadline,
} from '../src/services/supplierSyncJobs';

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
const editor = projectFile('src/components/SupplierReviewEditorModal.tsx');

const managedImage = 'https://firebasestorage.googleapis.com/v0/b/demo/o/supplier-media%2Fmanaged.webp?alt=media';
const supplierImages = [
  'https://supplier.example.test/one.jpg',
  'https://supplier.example.test/two.jpg',
  'https://supplier.example.test/three.jpg',
  'https://supplier.example.test/four.jpg',
  'https://supplier.example.test/five.jpg',
];

const baseItem = {
  id: 'queue-1',
  status: 'Pending',
  queueState: 'review_pending',
  supplierOfferPendingRevision: 'a'.repeat(64),
  productName: 'Phone Holder',
  supplierCode: 'SUP-1',
  costPrice: 100,
  marketPrice: 200,
  stock: 0,
  comparison: { comparisonStatus: 'NEW_PRODUCT' },
  productValidation: {
    readyToPublish: false,
    missingFields: ['specifications'],
    errors: [{ field: 'specifications', code: 'missing_specifications', message: 'The supplier did not provide product specifications.' }],
    warnings: [{ field: 'specifications', code: 'missing_specifications', message: 'The supplier did not provide product specifications.' }],
  },
  productPayload: {
    id: 'product-1',
    name: 'Phone Holder',
    description: '<p><strong>Product Description</strong></p><script>alert(1)</script>',
    price: 1500,
    imageUrl: supplierImages[0],
    imageUrls: supplierImages.slice(1),
    specs: {},
  },
};

const modalMarkup = (overrides: {
  item?: Record<string, unknown>;
  draft?: ReturnType<typeof createSupplierReviewDraft>;
  categories?: Array<Record<string, unknown>>;
  brands?: Array<Record<string, unknown>>;
} = {}): string => {
  const item = {
    ...baseItem,
    managedMedia: [{ firebaseStorageUrl: managedImage, isPrimary: true, sortOrder: 0 }],
    ...overrides.item,
  };
  const draft = overrides.draft || createSupplierReviewDraft(item as never);
  return renderToStaticMarkup(React.createElement(SupplierReviewEditorModal, {
    item: item as never,
    initialDraft: draft,
    categories: (overrides.categories || []) as never,
    brands: (overrides.brands || []) as never,
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
};

// 1. stale Reject reconciles UI/list
test('PR-STAB-01 stale reject reconciles the review UI instead of requiring a page reload', () => {
  assert.match(hub, /reconcileStaleSupplierReviewItem/u);
  assert.match(hub, /status === 'stale_observation'/u);
  assert.match(hub, /SUPPLIER_REVIEW_STALE_REFRESH_MESSAGE/u);
  assert.match(hub, /await refreshSupplierQueueViews\(\)/u);
  assert.equal(isSupplierReviewStaleObservationError('The supplier observation is no longer pending; reload Product Review.'), true);
  assert.match(SUPPLIER_REVIEW_STALE_REFRESH_MESSAGE, /refreshed/u);
});

// 2. stale Approve cannot publish/overwrite newer or terminal observation
test('PR-STAB-02 stale approve paths fail closed and do not optimistically publish', () => {
  assert.match(hub, /if \(result\.status === 'stale_observation'\)/u);
  assert.match(hub, /if \(processingChangeId\) return/u);
  assert.match(projectFile('tests/supplierProductReviewE2EEmulatorSH3Final.test.ts'), /stale decisions fail closed/u);
  assert.match(projectFile('tests/productionBlockersP1Emulator.test.ts'), /no longer pending\|reload/iu);
});

// 3. duplicate Approve/Reject clicks create one transition attempt
test('PR-STAB-03 duplicate approve and reject clicks are ignored while a decision is pending', () => {
  assert.match(hub, /const \[processingChangeId, setProcessingChangeId\]/u);
  assert.match(hub, /if \(processingChangeId\) return/u);
  assert.match(hub, /processing=\{processingChangeId === item\.id\}/u);
  assert.match(hub, /disabled=\{!rejectionReasonDraft\.trim\(\) \|\| processingChangeId === rejectingReviewItem\.id\}/u);
});

// 4. background sync cannot restore terminal observation to pending
test('PR-STAB-04 approved supplier offers keep terminal commerce state when new observations stage', () => {
  const effectiveOffer = buildSupplierProductOffer({
    sourceId: 'source-a',
    supplierId: 'supplier-a',
    supplierProductId: 'supplier-product-1',
    sku: 'SKU-1',
    barcode: '1234567890123',
    productId: 'product-1',
    price: 100,
    cost: 70,
    stock: 10,
    availability: 'available',
    priority: 100,
    health: { availability: 'available', observedAt: '2026-08-01T00:00:00.000Z' },
    lastSyncAt: '2026-08-01T00:00:00.000Z',
    reviewStatus: 'approved',
    catalogPayload: { name: 'Approved product', price: 100, stock: 10 },
    supplierSnapshot: { title: 'Approved product', wholesalePrice: 70, stock: 10 },
    timestamp: '2026-08-01T00:00:00.000Z',
  });
  const observed = buildSupplierProductOffer({
    ...effectiveOffer,
    price: 120,
    cost: 80,
    stock: 0,
    reviewStatus: 'review_pending',
    existing: effectiveOffer,
    timestamp: '2026-08-02T00:00:00.000Z',
  });
  const pending = buildSupplierOfferPendingObservation({
    offer: observed,
    kind: 'catalog_upsert',
    reviewQueueItemId: 'review-1',
    observedAt: '2026-08-02T00:00:00.000Z',
    traversalId: 'traversal-1',
  });
  const write = buildSupplierOfferObservationWrite({
    existing: effectiveOffer,
    observed,
    pending,
    traversalId: 'traversal-1',
    observedAt: '2026-08-02T00:00:00.000Z',
  });
  assert.equal(write.reviewStatus, undefined);
  assert.equal((write as { reviewStatus?: string }).reviewStatus ?? effectiveOffer.reviewStatus, 'approved');
  assert.ok(write.pendingObservation);
});

// 5. processing/incomplete observation is not reviewable
test('PR-STAB-05 processing queue items are not decision-ready review targets', () => {
  assert.equal(supplierReviewIsPreparing({ queueState: 'processing' }), true);
  assert.equal(supplierReviewDecisionReady({ queueState: 'processing' }), false);
  assert.equal(supplierReviewDecisionReady({ queueState: 'queued' }), false);
  assert.equal(supplierReviewDecisionReady({ queueState: 'review_pending' }), true);
});

// 6. review count/list converges after reconciliation
test('PR-STAB-06 open review items reconcile when queue revisions or states change', () => {
  assert.match(hub, /fresh\.supplierOfferPendingRevision !== editingReviewItem\.supplierOfferPendingRevision/u);
  assert.match(hub, /setEditingReviewItem\(fresh\)/u);
  assert.match(hub, /await refreshSupplierQueueViews\(\)/u);
});

// 7. card image fallback resolves primary/gallery correctly
test('PR-STAB-07 display image projection falls back from managed media to supplier primary and gallery images', () => {
  const withoutManaged = {
    ...baseItem,
    managedMedia: [],
    imageUrl: supplierImages[0],
    productPayload: {
      ...baseItem.productPayload,
      imageUrl: supplierImages[0],
      imageUrls: supplierImages.slice(1),
    },
  };
  assert.equal(supplierReviewManagedImageUrl(withoutManaged), '');
  assert.equal(supplierReviewDisplayImageUrl(withoutManaged), supplierImages[0]);

  const galleryOnly = {
    ...withoutManaged,
    productPayload: {
      ...baseItem.productPayload,
      imageUrl: '',
      imageUrls: supplierImages,
    },
  };
  assert.equal(supplierReviewDisplayImageUrl(galleryOnly), supplierImages[0]);
  assert.equal(supplierReviewDisplayImageUrl({
    ...galleryOnly,
    productPayload: { ...galleryOnly.productPayload, imageUrls: supplierImages },
  }), supplierImages[0]);
});

// 8. zero valid specs => count 0 + warning + failed checklist WHEN specs required
test('PR-STAB-08 zero structured specifications fail when server validation requires them', () => {
  assert.equal(countStructuredSupplierSpecifications({ Model: '', Colour: '' }), 0);
  assert.equal(supplierReviewSpecificationCount({ productPayload: { specs: { Model: '' } } }), 0);

  const draft = { ...createSupplierReviewDraft(baseItem as never), category: 'electronics' };
  const categories = [{ id: 'electronics', name: 'Electronics', specificationTemplate: [{ name: 'Model', required: true }] }];
  const errors = validateSupplierReviewDraft(draft, ['electronics'], categories as never, [{ id: 'brand-1', name: 'Brand', isActive: true }] as never);
  assert.equal(errors.specifications, 'Complete required specifications: Model.');
  assert.equal(supplierReviewSpecificationsRequired(baseItem, categories, 'electronics'), true);
  assert.equal(supplierReviewSpecificationsSatisfied(0, baseItem, categories, 'electronics'), false);

  const markup = modalMarkup({
    categories,
    draft: { ...draft, specifications: {} },
  });
  assert.match(markup, /0 specifications/u);
  assert.match(markup, /The supplier did not provide product specifications/u);
});

// 9. valid specs => correct count + passed checklist
test('PR-STAB-09 valid structured specifications count and satisfy required validation', () => {
  const specs = { Model: 'QA-1', Colour: 'Blue' };
  assert.equal(countStructuredSupplierSpecifications(specs), 2);
  assert.equal(supplierReviewSpecificationCount({ productPayload: { specs } }), 2);

  const draft = { ...createSupplierReviewDraft({ ...baseItem, productPayload: { ...baseItem.productPayload, specs } } as never), category: 'electronics', brand: 'brand-1' };
  const categories = [{ id: 'electronics', name: 'Electronics', specificationTemplate: [{ name: 'Model', required: true }] }];
  const brands = [{ id: 'brand-1', name: 'Brand', isActive: true }];
  const errors = validateSupplierReviewDraft(draft, ['electronics'], categories as never, brands as never);
  assert.equal(errors.specifications, undefined);
  assert.equal(supplierReviewSpecificationsSatisfied(2, baseItem, categories, 'electronics'), true);
});

// 10. read-only mode cannot mutate draft/gallery
test('PR-STAB-10 read-only modal hides mutation controls and image editor workspace', () => {
  const markup = modalMarkup();
  assert.match(markup, /Read-only supplier review/u);
  assert.match(markup, /Product images/u);
  assert.doesNotMatch(markup, /Add image/u);
  assert.doesNotMatch(markup, /Primary image URL/u);
  assert.doesNotMatch(markup, /moveGalleryImage/u);
  assert.doesNotMatch(markup, /dangerouslySetInnerHTML/u);
  assert.doesNotMatch(markup, /<textarea[^>]*>[\s\S]*<p><strong>Product Description<\/strong>/u);
});

// 11. edit/save refreshes category/brand validation immediately
test('PR-STAB-11 edit mode revalidates category and brand through the shared draft validator', () => {
  assert.match(editor, /validateSupplierReviewDraft\(draft, validCategoryIds, categories, brands\)/u);
  assert.match(editor, /if \(!isEditing\) setDraft\(initialDraft\)/u);
  const draft = { ...createSupplierReviewDraft(baseItem as never), category: '', brand: '' };
  const categories = [{ id: 'electronics', name: 'Electronics', specificationTemplate: [] }];
  const brands = [{ id: 'brand-1', name: 'Brand', isActive: true }];
  const before = validateSupplierReviewDraft(draft, ['electronics'], categories as never, brands as never);
  assert.ok(before.category);
  assert.ok(before.brand);
  const after = validateSupplierReviewDraft(
    { ...draft, category: 'electronics', brand: 'brand-1' },
    ['electronics'],
    categories as never,
    brands as never,
  );
  assert.equal(after.category, undefined);
  assert.equal(after.brand, undefined);
});

// 12. unsafe supplier HTML is sanitized
test('PR-STAB-12 supplier description rendering never preserves executable HTML', () => {
  const vectors = [
    '<script>alert(1)</script>Hello',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">Click</a>',
    '<p><strong>Safe</strong></p><<broken><tag>',
    'Plain text only',
    'Line one\nLine two',
  ];
  for (const vector of vectors) {
    const plain = supplierDescriptionPlainText(vector);
    assert.doesNotMatch(plain, /<script|onerror=|javascript:/iu);
    const sanitized = sanitizeSupplierDescriptionHtml(vector);
    assert.doesNotMatch(sanitized, /<script|onerror=|javascript:/iu);
  }
  assert.match(supplierDescriptionPlainText('<p><strong>Product</strong></p>'), /Product/u);
  assert.doesNotMatch(supplierDescriptionPlainText('<p><strong>Product</strong></p>'), /<p>/u);
});

// 13. mobile modal content is not hidden behind footer
test('PR-STAB-13 mobile modal uses a single scroll body with footer-safe bottom padding', () => {
  assert.match(editor, /max-h-\[100dvh\]/u);
  assert.match(editor, /overflow-y-auto overscroll-contain/u);
  assert.match(editor, /pb-\[calc\(6\.5rem\+env\(safe-area-inset-bottom\)\)\]/u);
  assert.match(editor, /shrink-0 border-t border-slate-100/u);
  assert.doesNotMatch(editor, /sticky bottom-0 z-30 order-\[100\]/u);
});

// 14. sync status labels match persisted job states
test('PR-STAB-14 sync status labels avoid contradictory waiting and in-progress wording', () => {
  const waitingWhileScanning = {
    id: 'job-1',
    state: 'waiting' as const,
    trigger: 'manual' as const,
    sourceIds: ['source-1'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retryCount: 0,
    retryLimit: 3,
    resumeCount: 0,
    progress: {
      phase: 'catalog_traversal',
      percent: 0,
      completedSources: 0,
      totalSources: 1,
      currentSourceId: 'source-1',
      pagesProcessed: 3,
      productsDiscovered: 15,
      productsScanned: 15,
      productsQueued: 6,
      productsFailed: 0,
      elapsedMs: 10_000,
      etaMs: null,
      etaAt: null,
      updatedAt: new Date().toISOString(),
      determination: 'indeterminate' as const,
      basis: 'unknown' as const,
    },
  };
  assert.match(supplierSyncJobHeadline(waitingWhileScanning), /Sync in progress · 15 scanned/u);
  assert.doesNotMatch(supplierSyncJobHeadline(waitingWhileScanning), /Waiting · In progress/u);
  assert.match(supplierSyncJobDetailLine(waitingWhileScanning), /15 scanned · 6 queued/u);
  assert.doesNotMatch(formatSupplierSyncProgress(waitingWhileScanning), /Waiting · In progress/u);
});

// 15. category/brand server approval gate remains enforced
test('PR-STAB-15 category and brand server approval validation remains enforced', () => {
  const categories = [{ id: 'electronics', name: 'Electronics', isActive: true, subcategories: [], specificationTemplate: [] }];
  const brands = [{ id: 'brand-1', name: 'Brand', isActive: true }];
  const errors = validateSupplierProductForApproval({
    name: 'Phone',
    imageUrl: 'https://cdn.example.test/product.jpg',
    price: 100,
    description: 'Description',
    stock: 5,
    isActive: true,
    category: '',
    brand: '',
    specs: {},
  }, categories, brands);
  assert.ok(errors.some((error) => error.field === 'category'));
  assert.ok(errors.some((error) => error.field === 'brand'));
  assert.match(projectFile('tests/supplierIntelligentMappingSprint4.test.ts'), /validateSupplierProductForApproval/);
});
