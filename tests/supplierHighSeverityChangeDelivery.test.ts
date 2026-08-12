import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ProductParser } from '../functions/src/api/suppliers/a2z/ProductParser';
import {
  accumulateSupplierProductComparison,
  buildSupplierProductComparison,
} from '../functions/src/api/suppliers/supplierProductImport';
import { buildSupplierProductOffer } from '../functions/src/api/suppliers/supplierOfferEngine';
import { buildPreApprovalSupplierRemovalQueueItem } from '../functions/src/scheduled/supplierSync';

const liveProduct = {
  id: 'phone-1',
  name: 'Phone',
  description: 'Original description',
  price: 100,
  originalPrice: 100,
  stock: 5,
  isActive: true,
  active: true,
  visible: true,
  supplierMetadata: {
    sku: 'PHONE-1',
    title: 'Phone',
    longDescription: 'Original description',
    price: 100,
    costPrice: 80,
    inventoryLevel: 5,
  },
};

test('pending supplier changes accumulate from the approved baseline before review', () => {
  const firstSupplierVersion = ProductParser.parseJsonPayload({
    sku: 'PHONE-1', title: 'Phone', description: 'Original description', price: 120, costPrice: 90, stock: 5,
  });
  const firstComparison = buildSupplierProductComparison(firstSupplierVersion, liveProduct);
  const pendingOfferBaseline = {
    ...liveProduct,
    price: 120,
    costPrice: 90,
    supplierMetadata: {
      ...liveProduct.supplierMetadata,
      price: 120,
      costPrice: 90,
    },
  };
  const secondSupplierVersion = ProductParser.parseJsonPayload({
    sku: 'PHONE-1', title: 'Phone', description: 'Updated description', price: 120, costPrice: 90, stock: 5,
  });
  const secondComparison = buildSupplierProductComparison(secondSupplierVersion, pendingOfferBaseline);
  const accumulated = accumulateSupplierProductComparison(firstComparison, secondComparison);

  assert.equal(accumulated.status, 'PRICE_CHANGED');
  assert.deepEqual(new Set(accumulated.fieldChanges.map((change) => change.field)), new Set([
    'price', 'costPrice', 'longDescription',
  ]));
  assert.equal(accumulated.fieldChanges.find((change) => change.field === 'price')?.before, 100);
  assert.equal(accumulated.fieldChanges.find((change) => change.field === 'price')?.after, 120);
  assert.equal(accumulated.fieldChanges.find((change) => change.field === 'longDescription')?.before, 'Original description');
  assert.equal(accumulated.fieldChanges.find((change) => change.field === 'longDescription')?.after, 'Updated description');
});

test('repeated changes retain the earliest before value and latest supplier value', () => {
  const first = buildSupplierProductComparison(ProductParser.parseJsonPayload({
    sku: 'PHONE-1', title: 'Phone', description: 'Original description', price: 120, costPrice: 80, stock: 5,
  }), liveProduct);
  const latest = buildSupplierProductComparison(ProductParser.parseJsonPayload({
    sku: 'PHONE-1', title: 'Phone', description: 'Original description', price: 140, costPrice: 80, stock: 5,
  }), {
    ...liveProduct,
    price: 120,
    supplierMetadata: { ...liveProduct.supplierMetadata, price: 120 },
  });
  const accumulated = accumulateSupplierProductComparison(first, latest);
  const price = accumulated.fieldChanges.find((change) => change.field === 'price');

  assert.equal(price?.before, 100);
  assert.equal(price?.after, 140);
});

test('an active new-product review remains a new product after later supplier changes', () => {
  const initialProduct = ProductParser.parseJsonPayload({
    sku: 'NEW-1', title: 'New Phone', description: 'Initial', price: 100, costPrice: 80, stock: 5,
  });
  const initial = buildSupplierProductComparison(initialProduct);
  const latestProduct = ProductParser.parseJsonPayload({
    sku: 'NEW-1', title: 'New Phone', description: 'Updated', price: 100, costPrice: 80, stock: 5,
  });
  const latest = buildSupplierProductComparison(latestProduct, {
    supplierMetadata: {
      sku: 'NEW-1', title: 'New Phone', longDescription: 'Initial', price: 100, costPrice: 80, inventoryLevel: 5,
    },
    costPrice: 80,
    stock: 5,
  });

  assert.equal(accumulateSupplierProductComparison(initial, latest).status, 'NEW_PRODUCT');
});

test('pre-approval removal updates the existing deterministic review item without a public product', () => {
  const detectedAt = '2026-07-28T10:00:00.000Z';
  const approvalBaseline = { productId: 'new-phone', exists: false, capturedAt: '2026-07-28T09:00:00.000Z' };
  const offer = buildSupplierProductOffer({
    sourceId: 'a2z-traders',
    supplierId: 'a2z-traders',
    supplierProductId: 'A2Z-100',
    sku: 'A2Z-100',
    productId: 'new-phone',
    price: 120,
    cost: 90,
    stock: 5,
    availability: 'in_stock',
    priority: 100,
    health: { availability: 'available' },
    lastSyncAt: detectedAt,
    reviewStatus: 'review_pending',
    supplierSnapshot: { title: 'New Phone', mediaGallery: ['https://supplier.example/new-phone.jpg'] },
    timestamp: detectedAt,
  });
  const currentQueueItem = {
    id: 'a2z-traders-a2z-100',
    queueState: 'review_pending',
    status: 'Pending',
    supplierOfferId: offer.id,
    productName: 'New Phone',
    approvalBaseline,
    createdAt: '2026-07-28T09:00:00.000Z',
    productPayload: {
      id: 'new-phone', name: 'New Phone', price: 120, stock: 5, isActive: true, active: true, visible: true,
      imageUrl: 'https://supplier.example/new-phone.jpg',
    },
    supplierSnapshot: { title: 'New Phone' },
  };
  const removal = buildPreApprovalSupplierRemovalQueueItem({
    queueItemId: currentQueueItem.id,
    queueItem: currentQueueItem,
    offer,
    source: { id: 'a2z-traders', supplierName: 'A2Z Traders', connectorType: 'a2z' },
    traversal: {
      traversalId: 'traversal-2', cursor: null, pagesProcessed: 2, productsScanned: 100, productsObserved: 100, productsImported: 0,
      invalidProducts: 0, deletionReconciliationEligible: true, resumeCount: 0,
      startedAt: detectedAt, lastCheckpointAt: detectedAt, lastPageFingerprint: 'fingerprint', syncMode: 'full',
      requestFingerprint: null, syncJobId: 'manual-2', totalProductLimit: null,
      catalogTotalProducts: null, catalogTotalReliability: 'unknown', deltaToken: null,
      terminationReason: null, status: 'reconciling',
    },
    batchId: 'manual-2',
    detectedAt,
  });

  assert.ok(removal);
  assert.equal(removal.id, currentQueueItem.id);
  assert.equal(removal.data.comparisonStatus, 'SUPPLIER_OFFER_REMOVED');
  assert.equal(removal.data.reconciliationAction, 'supplier_offer_unavailable');
  assert.equal((removal.data.productPayload as Record<string, unknown>).stock, 0);
  assert.equal((removal.data.productPayload as Record<string, unknown>).visible, false);
  assert.deepEqual(removal.data.approvalBaseline, approvalBaseline);
  const repeatedRemoval = buildPreApprovalSupplierRemovalQueueItem({
    queueItemId: removal.id,
    queueItem: removal.data,
    offer,
    source: { id: 'a2z-traders' },
    traversal: {
      traversalId: 'traversal-2', cursor: null, pagesProcessed: 2, productsScanned: 100, productsObserved: 100, productsImported: 0,
      invalidProducts: 0, deletionReconciliationEligible: true, resumeCount: 0,
      startedAt: detectedAt, lastCheckpointAt: detectedAt, lastPageFingerprint: 'fingerprint', syncMode: 'full',
      requestFingerprint: null, syncJobId: 'manual-2', totalProductLimit: null,
      catalogTotalProducts: null, catalogTotalReliability: 'unknown', deltaToken: null,
      terminationReason: null, status: 'reconciling',
    },
    batchId: 'manual-2',
    detectedAt,
  });
  assert.ok(repeatedRemoval);
  assert.equal(repeatedRemoval.id, removal.id);
  assert.deepEqual(repeatedRemoval.data.approvalBaseline, approvalBaseline);
});

test('full traversal reconnects a missing pre-approval offer to its existing review item atomically', () => {
  const syncSource = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(syncSource, /where\("supplierOfferId", "in", offerIds\)/u);
  assert.match(syncSource, /const atomicGroup = activePreApprovalReview\?\.id \|\| queueItemId/u);
  assert.match(syncSource, /buildPreApprovalSupplierRemovalQueueItem\(\{/u);
  assert.match(syncSource, /collection: "supplier_review_queue", id: removal\.id, data: removal\.data, atomicGroup: removal\.id/u);
  assert.match(syncSource, /where\("canonicalProductId", "in", productIds\)\.limit\(300\)/u);
  assert.match(syncSource, /const queueItemId = activeRemovalReview\?\.id \|\| \(stableIsTerminal/u);
  assert.match(syncSource, /approvalBaseline: activeRemovalData\.approvalBaseline/u);
});
