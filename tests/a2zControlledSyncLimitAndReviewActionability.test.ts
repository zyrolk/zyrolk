import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  supplierReviewCanQuickApprove,
  supplierReviewDecisionReady,
  supplierReviewIsPreparing,
  supplierReviewRawMetadata,
  supplierReviewStatusLabel,
} from '../src/services/supplierHubPresentation';
import { buildSupplierManualSyncRequest } from '../src/services/supplierManualSync';
import {
  runSupplierCatalogTraversal,
} from '../functions/src/scheduled/supplierCatalogTraversal';
import {
  SupplierCatalogPageRequest,
  SupplierCatalogPageResult,
  SupplierConnectorSyncCapabilities,
} from '../functions/src/api/suppliers/types';
import { RawA2ZProduct } from '../functions/src/api/suppliers/a2z/types';

const capabilities: SupplierConnectorSyncCapabilities = {
  incremental: { supported: false, mechanism: 'unsupported', deletionSemantics: 'none' },
  categoryFilter: 'server_side',
  subcategoryFilter: 'server_side',
  searchFilter: 'server_side',
};

function product(overrides: Partial<RawA2ZProduct> = {}): RawA2ZProduct {
  return {
    sku: 'P03129',
    supplierProductId: 'supplier-phone-holder',
    barcode: '479000000129',
    title: 'Wall Mounted Phone Holder',
    brand: 'A2Z Brand',
    supplierCategory: 'Mobile Accessories',
    supplierSubcategory: 'Holders',
    categoryHierarchy: ['Mobile Accessories', 'Holders'],
    longDescription: 'Supplier description',
    mediaGallery: ['https://a2zdropshipping.lk/images/phone-holder.jpg'],
    wholesalePrice: 450,
    recommendedRetailPrice: 890,
    inventoryLevel: 12,
    ...overrides,
  };
}

function pagedConnector(total: number, requests: SupplierCatalogPageRequest[]) {
  return {
    syncCapabilities: capabilities,
    async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
      requests.push(structuredClone(request));
      const offset = Number(request.cursor || 0);
      const count = Math.max(0, Math.min(request.pageSize, total - offset));
      const products = Array.from({ length: count }, (_, index) => product({
        sku: `SKU-${offset + index}`,
        supplierProductId: `product-${offset + index}`,
        title: `Product ${offset + index}`,
      }));
      const nextOffset = offset + products.length;
      return {
        products,
        targetUrl: 'https://a2zdropshipping.lk/catalog',
        complete: nextOffset >= total,
        nextCursor: nextOffset >= total ? null : String(nextOffset),
      };
    },
  };
}

test('controlled sync limit 5 scans and queues at most 5 products', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  let scanned = 0;
  let queued = 0;
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(100, requests),
    pageSize: 20,
    totalProductLimit: 5,
    deletionReconciliationEligible: false,
    processPage: async (page) => {
      scanned += page.products.length;
      queued += page.products.length;
      return { productsScanned: page.products.length, productsImported: page.products.length };
    },
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => {
      throw new Error('Removal reconciliation must not run for a limited sync.');
    },
  });

  assert.equal(scanned, 5);
  assert.equal(queued, 5);
  assert.equal(result.limited, true);
  assert.equal(result.checkpoint.terminationReason, 'limit_reached');
  assert.equal(result.checkpoint.deletionReconciliationEligible, false);
  assert.equal(result.checkpoint.productsObserved, 5);
  assert.ok(requests.every((request) => request.pageSize <= 5));
  assert.ok(requests[0]?.pageSize === 5, 'page size is capped by remaining traversal limit');
});

test('page size remains independent from traversal product limit', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(40, requests),
    pageSize: 10,
    totalProductLimit: 25,
    deletionReconciliationEligible: false,
    processPage: async (page) => ({
      productsScanned: page.products.length,
      productsImported: page.products.length,
    }),
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => {
      throw new Error('Removal reconciliation must not run for a limited sync.');
    },
  });

  assert.deepEqual(requests.map((request) => request.pageSize), [10, 10, 5]);
  assert.equal(result.checkpoint.productsObserved, 25);
  assert.equal(result.checkpoint.terminationReason, 'limit_reached');
  assert.equal(result.checkpoint.deletionReconciliationEligible, false);
});

test('full-catalog sync without product limit still completes and may reconcile', async () => {
  const requests: SupplierCatalogPageRequest[] = [];
  let reconciled = false;
  const result = await runSupplierCatalogTraversal({
    connector: pagedConnector(12, requests),
    pageSize: 5,
    totalProductLimit: null,
    deletionReconciliationEligible: true,
    processPage: async (page) => ({
      productsScanned: page.products.length,
      productsImported: page.products.length,
    }),
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => {
      reconciled = true;
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.limited, false);
  assert.equal(result.checkpoint.productsObserved, 12);
  assert.equal(result.checkpoint.terminationReason, 'catalog_complete');
  assert.equal(reconciled, true);
  assert.deepEqual(requests.map((request) => request.pageSize), [5, 5, 5]);
  assert.equal(requests.length, 3);
});

test('Preparing review cards cannot approve while review_pending can open editor', () => {
  const preparing = {
    status: 'pending',
    queueState: 'processing',
    mediaStatus: 'downloading',
    productValidation: { readyToPublish: false, missingFields: [], errors: [] },
  };
  const ready = {
    status: 'pending',
    queueState: 'review_pending',
    supplierOfferPendingRevision: 'a'.repeat(64),
    productValidation: {
      readyToPublish: true,
      missingFields: [],
      errors: [],
    },
    managedMedia: [{ firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/image.jpg', isPrimary: true, sortOrder: 0 }],
  };

  assert.equal(supplierReviewIsPreparing(preparing), true);
  assert.equal(supplierReviewDecisionReady(preparing), false);
  assert.equal(supplierReviewCanQuickApprove(preparing), false);
  assert.equal(supplierReviewStatusLabel(preparing), 'Preparing');

  assert.equal(supplierReviewIsPreparing(ready), false);
  assert.equal(supplierReviewDecisionReady(ready), true);
  assert.equal(supplierReviewCanQuickApprove(ready), true);
  assert.equal(supplierReviewStatusLabel(ready), 'Ready for Review');
});

test('A2Z raw category and brand metadata remain visible without inventing Zyro mappings', () => {
  const metadata = supplierReviewRawMetadata({
    supplierSnapshot: {
      brand: 'A2Z Brand',
      supplierCategory: 'Mobile Accessories',
      supplierSubcategory: 'Holders',
      categoryHierarchy: ['Mobile Accessories', 'Holders'],
      mediaGallery: ['https://a2zdropshipping.lk/images/phone-holder.jpg'],
      wholesalePrice: 450,
      recommendedRetailPrice: 890,
      inventoryLevel: 12,
      title: 'Wall Mounted Phone Holder',
      sku: 'P03129',
    },
    productPayload: { brand: '' },
  });
  assert.equal(metadata.supplierBrand, 'A2Z Brand');
  assert.equal(metadata.supplierCategory, 'Mobile Accessories');
  assert.equal(metadata.supplierSubcategory, 'Holders');
});

test('Initial Sync opens the controlled dialog and never auto-starts an unbounded full sync', () => {
  const hub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  const dialog = readFileSync('src/components/supplier-management/SupplierManualSyncDialog.tsx', 'utf8');
  const presentation = readFileSync('src/services/supplierHubPresentation.ts', 'utf8');
  const card = readFileSync('src/components/SupplierReviewQuickCard.tsx', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');

  assert.match(hub, /setManualSyncSource\(source\)/);
  assert.doesNotMatch(hub, /runManualSupplierSync\(\{ sourceIds: \[id\], mode: 'full' \}\)/);
  assert.match(hub, /isInitialSync=\{!supplierHasCompletedInitialSync\(manualSyncSource\)\}/);
  assert.match(hub, /Catalog fetch page size/);
  assert.match(dialog, /required for first sync/);
  assert.match(dialog, /is not the catalog fetch page size/);
  assert.match(dialog, /Limited runs never mark unscanned/);
  assert.match(presentation, /supplierReviewIsPreparing/);
  assert.match(presentation, /supplierReviewRawMetadata/);
  assert.match(card, /Media is processing/);
  assert.match(card, /Review Product/);
  assert.match(card, /Supplier raw metadata/);
  assert.match(sync, /!Number\(syncRequest\.totalProductLimit\)/);
  assert.equal(buildSupplierManualSyncRequest({
    sourceId: 'a2z-production',
    mode: 'full',
    totalProductLimit: 5,
  }).totalProductLimit, 5);
});
