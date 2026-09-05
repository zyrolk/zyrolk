import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Firestore } from 'firebase-admin/firestore';
import { ProductParser } from '../functions/src/api/suppliers/a2z/ProductParser';
import {
  buildSupplierLifecycleFieldChange,
  buildSupplierProductComparison,
  detectSupplierProductFieldChanges,
} from '../functions/src/api/suppliers/supplierProductImport';
import { createSupplierSyncJob } from '../functions/src/api/suppliers/supplierSyncJobs';
import {
  buildSupplierReactivationComparison,
  generateQueueDocId,
  resolveSupplierProductReviewVisibility,
} from '../functions/src/scheduled/supplierSync';
import { selectSupplierComparisonForReview } from '../functions/src/scheduled/supplierSyncSettings';
import { supplierReviewChangeLabel } from '../src/services/supplierHubPresentation';

interface FakeReference { id: string; path: string }

class FakeFirestore {
  readonly documents = new Map<string, Record<string, unknown>>();

  collection(name: string) {
    return { doc: (id = 'generated'): FakeReference => ({ id, path: `${name}/${id}` }) };
  }

  async runTransaction<T>(callback: (transaction: {
    get(reference: FakeReference): Promise<{ id: string; exists: boolean; data(): Record<string, unknown> | undefined }>;
    create(reference: FakeReference, data: Record<string, unknown>): void;
  }) => Promise<T>): Promise<T> {
    const writes: Array<() => void> = [];
    const transaction = {
      get: async (reference: FakeReference) => ({
        id: reference.id,
        exists: this.documents.has(reference.path),
        data: () => this.documents.get(reference.path),
      }),
      create: (reference: FakeReference, data: Record<string, unknown>) => writes.push(() => {
        this.documents.set(reference.path, { ...data });
      }),
    };
    const result = await callback(transaction);
    writes.forEach((write) => write());
    return result;
  }
}

test('Sprint 3 detects new products plus price and stock updates as reviewable supplier changes', () => {
  const newProduct = ProductParser.parseJsonPayload({
    sku: 'AUTO-1', title: 'Automatic sync product', cost_price: 100, price: 150, stock: 8,
  }, 'https://supplier.example');
  assert.equal(buildSupplierProductComparison(newProduct).status, 'NEW_PRODUCT');

  const priceProduct = ProductParser.parseJsonPayload({ sku: 'AUTO-1', title: 'Automatic sync product', cost_price: 120 });
  const priceComparison = buildSupplierProductComparison(priceProduct, { supplierMetadata: { costPrice: 100 } });
  assert.equal(priceComparison.status, 'PRICE_CHANGED');
  assert.ok(priceComparison.fieldChanges.some((change) => change.field === 'costPrice' && change.before === 100 && change.after === 120));

  const stockProduct = ProductParser.parseJsonPayload({ sku: 'AUTO-1', title: 'Automatic sync product', stock: 3 });
  const stockComparison = buildSupplierProductComparison(stockProduct, { supplierMetadata: { inventoryLevel: 8 } });
  assert.equal(stockComparison.status, 'STOCK_CHANGED');
  assert.ok(stockComparison.fieldChanges.some((change) => change.field === 'stock' && change.before === 8 && change.after === 3));
});

test('Sprint 3 captures description, image, specification, category, and brand changes without coarse-label loss', () => {
  const product = ProductParser.parseJsonPayload({
    sku: 'DETAIL-1',
    title: 'Detailed product',
    description: 'New description',
    images: ['https://supplier.example/new.jpg'],
    categories: ['Phones'],
    brand: 'Samsung',
    specifications: { RAM: '8 GB' },
  }, 'https://supplier.example');
  const fields = detectSupplierProductFieldChanges(product, {});
  for (const field of ['longDescription', 'mediaGallery', 'categoryHierarchy', 'brand', 'specifications']) {
    assert.ok(fields.some((change) => change.field === field), `${field} must reach Product Review`);
  }
  assert.equal(supplierReviewChangeLabel({
    comparisonStatus: 'DESCRIPTION_CHANGED',
    changedFields: fields.map((change) => change.label),
    fieldChanges: fields,
  }), `${fields.length} supplier changes`);
});

test('Sprint 3 product removal and reactivation carry canonical before/after values and remain approval-gated', () => {
  const removalAvailability = buildSupplierLifecycleFieldChange('availability', 'in_stock', 'unavailable');
  const removalStock = buildSupplierLifecycleFieldChange('stock', 12, 0);
  assert.deepEqual([removalAvailability.before, removalAvailability.after], ['in_stock', 'unavailable']);
  assert.deepEqual([removalStock.before, removalStock.after], [12, 0]);

  const reactivation = buildSupplierReactivationComparison(
    { status: 'UNCHANGED', changedFields: [], fieldChanges: [] },
    'unavailable',
    'in_stock',
  );
  assert.equal(reactivation.reactivating, true);
  assert.equal(reactivation.comparison.status, 'STOCK_CHANGED');
  assert.deepEqual(reactivation.comparison.fieldChanges[0].before, 'unavailable');
  assert.deepEqual(reactivation.comparison.fieldChanges[0].after, 'in_stock');
  assert.deepEqual(resolveSupplierProductReviewVisibility({ isActive: false, active: false, visible: false }, false, true), {
    isActive: true,
    visible: true,
  });

  const syncSource = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(syncSource, /queueMissingSupplierProductsForReview/);
  assert.match(syncSource, /supplier_review_queue/);
  assert.doesNotMatch(syncSource, /reconciliationAction:[\s\S]{0,300}collection: "products"/);
});

test('Sprint 3 prevents duplicate review documents and active duplicate review reopening', () => {
  assert.equal(generateQueueDocId('a2z-traders', 'SKU-100', 'Product A'), generateQueueDocId('a2z-traders', 'SKU-100', 'Product A'));
  assert.notEqual(generateQueueDocId('supplier-b', 'SKU-100', 'Product A'), generateQueueDocId('a2z-traders', 'SKU-100', 'Product A'));
  assert.equal(selectSupplierComparisonForReview(
    { status: 'UNCHANGED', changedFields: [], fieldChanges: [] },
    {},
    'rejected',
    true,
  ), null);
  const syncSource = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(syncSource, /if \(activeReviewQueueDoc\) queueItemId = activeReviewQueueDoc\.id/);
  assert.match(syncSource, /reviewRecordIsTerminalDecision/);
  assert.match(syncSource, /queueState\", \"status\", \"reviewStatus\", \"decisionAction/);
  assert.match(syncSource, /reconciliationAction: "supplier_offer_reactivated"/);
});

test('Sprint 3 scheduled sync job identity prevents duplicate scheduled execution while triggers share one worker', async () => {
  const db = new FakeFirestore();
  const input = {
    trigger: 'scheduled' as const,
    sourceIds: ['a2z-traders'],
    requestedBy: { uid: 'system' },
    dedupeKey: 'scheduled-2026-07-27T10',
  };
  const first = await createSupplierSyncJob(db as unknown as Firestore, input, 1_000);
  const duplicate = await createSupplierSyncJob(db as unknown as Firestore, input, 1_001);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, first.job.id);

  const apiRoutes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const scheduledSync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const worker = readFileSync('functions/src/scheduled/supplierSyncWorker.ts', 'utf8');
  assert.match(apiRoutes, /createSupplierSyncJob/);
  assert.match(scheduledSync, /createSupplierSyncJob/);
  assert.match(worker, /runSupplierSync\(\{/);
  assert.match(worker, /trigger: lease\.job\.trigger/);
});
