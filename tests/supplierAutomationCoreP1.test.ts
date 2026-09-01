import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyApprovedSupplierInventoryObservation,
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
  promoteSupplierOfferPendingObservation,
  resolveActiveSupplierOffer,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import { buildSupplierProductComparison } from '../functions/src/api/suppliers/supplierProductImport';
import {
  removeAutomatedStockChangesFromSupplierComparison,
  shouldDeferNewSupplierProductForZeroStock,
} from '../functions/src/scheduled/supplierSync';
import { suggestSupplierCategory } from '../functions/src/api/suppliers/supplierProductMapping';

type Data = Record<string, unknown>;
type DocRef = { kind: 'doc'; collectionName: string; id: string; key: string };
type QueryRef = {
  kind: 'query';
  collectionName: string;
  field: string;
  value: unknown;
  pageLimit: number;
  limit: (value: number) => QueryRef;
};
type DocSnap = { exists: boolean; id: string; data: () => Data | undefined };
type QuerySnap = { docs: DocSnap[] };

const fakeFirestore = (initial: Record<string, Data>) => {
  const documents = new Map(Object.entries(initial));
  const operations: Array<{ operation: 'set' | 'create'; key: string; data: Data }> = [];
  let generated = 0;
  const docRef = (collectionName: string, id: string): DocRef => ({
    kind: 'doc', collectionName, id, key: `${collectionName}/${id}`,
  });
  const snapshot = (reference: DocRef): DocSnap => ({
    exists: documents.has(reference.key),
    id: reference.id,
    data: () => documents.get(reference.key),
  });
  const query = (collectionName: string, field: string, value: unknown, pageLimit = 100): QueryRef => ({
    kind: 'query', collectionName, field, value, pageLimit,
    limit: (limit) => query(collectionName, field, value, limit),
  });
  const executeQuery = (reference: QueryRef): QuerySnap => ({
    docs: [...documents.entries()]
      .filter(([key, value]) => key.startsWith(`${reference.collectionName}/`) && value[reference.field] === reference.value)
      .slice(0, reference.pageLimit)
      .map(([key]) => snapshot(docRef(reference.collectionName, key.slice(reference.collectionName.length + 1)))),
  });
  const merge = (reference: DocRef, data: Data, shouldMerge = false) => {
    documents.set(reference.key, shouldMerge ? { ...(documents.get(reference.key) || {}), ...data } : data);
  };
  const db = {
    collection: (collectionName: string) => ({
      doc: (id?: string) => docRef(collectionName, id || `generated-${++generated}`),
      where: (field: string, operator: string, value: unknown) => {
        assert.equal(operator, '==');
        return query(collectionName, field, value);
      },
    }),
    runTransaction: async <T>(callback: (transaction: {
      get: (reference: DocRef | QueryRef) => Promise<DocSnap | QuerySnap>;
      set: (reference: DocRef, data: Data, options?: { merge?: boolean }) => void;
      create: (reference: DocRef, data: Data) => void;
    }) => Promise<T>): Promise<T> => callback({
      get: async (reference) => reference.kind === 'query' ? executeQuery(reference) : snapshot(reference),
      set: (reference, data, options) => {
        operations.push({ operation: 'set', key: reference.key, data });
        merge(reference, data, options?.merge === true);
      },
      create: (reference, data) => {
        assert.equal(documents.has(reference.key), false);
        operations.push({ operation: 'create', key: reference.key, data });
        merge(reference, data);
      },
    }),
  };
  return { db, documents, operations };
};

const approvedOffer = (sourceId = 'source-a', stock = 25, overrides: Data = {}) => buildSupplierProductOffer({
  sourceId,
  supplierId: sourceId,
  supplierProductId: `${sourceId}-product`,
  sku: `${sourceId}-sku`,
  productId: 'product-1',
  price: sourceId === 'source-a' ? 100 : 120,
  cost: 80,
  stock,
  stockKnown: true,
  availability: stock > 0 ? 'in_stock' : 'out_of_stock',
  priority: sourceId === 'source-a' ? 100 : 80,
  health: { availability: 'available', sourceAvailability: 'available' },
  lastSyncAt: '2026-09-01T12:00:00.000Z',
  reviewStatus: 'approved',
  catalogPayload: { name: 'Supplier name', originalPrice: 150 },
  supplierSnapshot: { providedFields: ['stock'], inventoryLevel: stock },
  timestamp: '2026-09-01T12:00:00.000Z',
  ...overrides,
});

const inventoryFixture = (offer = approvedOffer(), product: Data = {}) => {
  const initial = {
    'products/product-1': {
      id: 'product-1', name: 'Admin title', description: 'Admin description', imageUrl: 'https://example.test/image.jpg',
      price: 100, originalPrice: 150, stock: offer.stock, availability: offer.availability,
      category: 'kitchen', isActive: true, active: true, visible: true, ...product,
    },
    'product_private/product-1': {
      supplierOfferSelection: { activeOfferId: offer.id, lockedOfferId: null, failoverEnabled: true },
      supplierMetadata: { activeOfferId: offer.id, inventoryLevel: offer.stock },
    },
    [`supplier_product_offers/${offer.id}`]: { ...offer },
  };
  return fakeFirestore(initial);
};

const applyStock = async (stock: number, offer = approvedOffer(), product: Data = {}) => {
  const fixture = inventoryFixture(offer, product);
  const result = await applyApprovedSupplierInventoryObservation(fixture.db as never, {
    offerId: offer.id,
    productId: 'product-1',
    stock,
    observedAt: '2026-09-01T13:00:00.000Z',
    traversalId: 'traversal-1',
    batchId: 'batch-1',
    expectedStateVersion: offer.stateVersion,
  });
  return { ...fixture, result };
};

const categories = [
  { id: 'kitchen', name: 'Kitchen', isActive: true, subcategories: [{ id: 'cookware', name: 'Cookware', isActive: true }] },
  { id: 'inactive-kitchen', name: 'Old Kitchen', isActive: false },
];

test('P1 01 new supplier product with known positive stock remains review eligible', () => {
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 3, providedFields: ['stock'] }, false), false);
});

test('P1 02 new supplier product with explicit zero stock is deferred from Product Review', () => {
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 0, providedFields: ['stock'] }, false), true);
});

test('P1 03 zero-stock deferral retains the supplier offer observation without media work', () => {
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const branch = sync.slice(sync.indexOf('shouldDeferNewSupplierProductForZeroStock(product'), sync.indexOf('if (duplicateFromSameSource)'));
  assert.match(branch, /SUPPLIER_PRODUCT_OFFERS_COLLECTION/);
  assert.match(branch, /reviewStatus: "suppressed"/);
  assert.doesNotMatch(branch, /supplierReviewSourceImageUrls|supplier_review_queue[\s\S]*queueState: "queued"/);
});

test('P1 04 a deferred zero-stock observation becomes review eligible after stock turns positive', () => {
  const comparison = buildSupplierProductComparison({ inventoryLevel: 6, providedFields: ['stock'], mediaGallery: [] } as never, { stock: 0 });
  assert.equal(comparison.status, 'STOCK_CHANGED');
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 6, providedFields: ['stock'] }, false), false);
});

test('P1 05 unknown stock is not treated as explicit zero', () => {
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 0, providedFields: [] }, false), false);
  const unknown = buildSupplierProductOffer({
    sourceId: 'source', supplierId: 'source', supplierProductId: 'unknown', sku: 'unknown', stockKnown: false,
    lastSyncAt: '2026-09-01T00:00:00.000Z', timestamp: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(unknown.stockKnown, false);
  assert.equal(unknown.availability, 'unknown');
});

test('P1 06 approved product stock 25 to 7 updates automatically', async () => {
  const { documents, result } = await applyStock(7);
  assert.equal(result.action, 'STOCK_UPDATED');
  assert.equal(documents.get('products/product-1')?.stock, 7);
});

test('P1 07 approved product stock 7 to 0 becomes out of stock without leaving the catalogue', async () => {
  const { documents, result } = await applyStock(0, approvedOffer('source-a', 7));
  assert.equal(result.action, 'STOCK_BECAME_OUT_OF_STOCK');
  assert.equal(documents.get('products/product-1')?.availability, 'out_of_stock');
  assert.equal(documents.get('products/product-1')?.visible, true);
});

test('P1 08 approved product stock 0 to 14 becomes purchasable again', async () => {
  const { documents, result } = await applyStock(14, approvedOffer('source-a', 0));
  assert.equal(result.action, 'STOCK_RESTORED');
  assert.equal(documents.get('products/product-1')?.stock, 14);
  assert.equal(documents.get('products/product-1')?.availability, 'in_stock');
});

test('P1 09 pure approved stock change creates no Product Review write', async () => {
  const { operations } = await applyStock(7);
  assert.equal(operations.some((operation) => operation.key.startsWith('supplier_review_queue/')), false);
  assert.equal(operations.some((operation) => operation.key.startsWith('supplier_operations_audit/')), true);
});

test('P1 10 stock automation does not overwrite title description image price or category', async () => {
  const { documents } = await applyStock(7);
  const product = documents.get('products/product-1');
  assert.deepEqual({ name: product?.name, description: product?.description, imageUrl: product?.imageUrl, price: product?.price, category: product?.category }, {
    name: 'Admin title', description: 'Admin description', imageUrl: 'https://example.test/image.jpg', price: 100, category: 'kitchen',
  });
  const base = approvedOffer();
  const contentObservation = buildSupplierProductOffer({
    ...base,
    stock: 25,
    catalogPayload: { ...base.catalogPayload, name: 'Reviewed content update' },
    existing: base,
    timestamp: '2026-09-01T12:30:00.000Z',
  });
  const pendingObservation = buildSupplierOfferPendingObservation({
    offer: contentObservation,
    kind: 'catalog_upsert',
    reviewQueueItemId: 'review-content',
    observedAt: '2026-09-01T12:30:00.000Z',
  });
  const promoted = promoteSupplierOfferPendingObservation({
    ...base,
    stock: 7,
    availability: 'in_stock',
    health: { ...base.health, inventoryObservedAt: '2026-09-01T13:00:00.000Z' },
    pendingObservation,
  }, pendingObservation.revision);
  assert.equal(promoted.stock, 7);
  assert.equal(promoted.catalogPayload.name, 'Reviewed content update');
});

test('P1 11 reservation-aware stock delta and transactional checkout validation remain intact', async () => {
  const { documents } = await applyStock(7, approvedOffer('source-a', 25), { stock: 23 });
  assert.equal(documents.get('products/product-1')?.stock, 5);
  const checkout = readFileSync('functions/src/api/routes/checkout.ts', 'utf8');
  assert.match(checkout, /transaction\.get\(productRef\)/);
  assert.match(checkout, /currentStock < item\.quantity/);
});

test('P1 12 a zero-stock offer cannot zero the product when failover selects another in-stock offer', async () => {
  const primary = approvedOffer('source-a', 7);
  const backup = approvedOffer('source-b', 12);
  const fixture = inventoryFixture(primary);
  fixture.documents.set(`supplier_product_offers/${backup.id}`, { ...backup });
  const result = await applyApprovedSupplierInventoryObservation(fixture.db as never, {
    offerId: primary.id, productId: 'product-1', stock: 0, observedAt: '2026-09-01T13:00:00.000Z', expectedStateVersion: primary.stateVersion,
  });
  assert.equal(result.activeOfferId, backup.id);
  assert.equal(fixture.documents.get('products/product-1')?.stock, 12);
});

test('P1 13 locked and failover-disabled offer semantics remain authoritative', () => {
  const zero = approvedOffer('source-a', 0);
  const backup = approvedOffer('source-b', 12);
  assert.equal(resolveActiveSupplierOffer([zero, backup], { lockedOfferId: zero.id, failoverEnabled: true })?.id, zero.id);
  assert.equal(resolveActiveSupplierOffer([zero, backup], { activeOfferId: zero.id, failoverEnabled: false })?.id, zero.id);
});

test('P1 14 exact active supplier category match auto-selects the Zyro category', () => {
  const result = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: ['Kitchen'], categories });
  assert.equal(result.targetCategoryId, 'kitchen');
  assert.equal(result.autoSelected, true);
});

test('P1 15 category matching normalizes case and spacing', () => {
  const result = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: ['  KITCHEN  '], categories });
  assert.equal(result.targetCategoryId, 'kitchen');
  assert.equal(result.mappingType, 'normalized');
});

test('P1 16 persistent supplier category mapping is reused with its valid subcategory', () => {
  const result = suggestSupplierCategory({
    sourceId: 'dropex', supplierCategories: ['Home Cooking'], categories,
    mappings: [{ sourceId: 'dropex', supplierCategory: 'Home Cooking', normalizedCategory: 'home cooking', targetCategoryId: 'kitchen', targetSubcategoryId: 'cookware', confidence: 100, mappingType: 'learned', version: 2, updatedBy: 'admin' }],
  });
  assert.equal(result.targetCategoryId, 'kitchen');
  assert.equal(result.targetSubcategoryId, 'cookware');
});

test('P1 17 repeated supplier category matching is deterministic and needs no repeated mapping', () => {
  const first = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: ['Kitchen'], categories });
  const second = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: [' kitchen '], categories });
  assert.equal(first.targetCategoryId, second.targetCategoryId);
  assert.equal(second.requiresManualSelection, false);
});

test('P1 18 unmatched category does not create uncontrolled taxonomy', () => {
  const result = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: ['Unmapped Department'], categories });
  assert.equal(result.targetCategoryId, '');
  assert.equal(result.requiresManualSelection, true);
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.doesNotMatch(sync, /collection\("categories"\)\.doc\([^)]*\)\.set/);
});

test('P1 19 inactive category is never silently auto-selected', () => {
  const result = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: ['Old Kitchen'], categories });
  assert.equal(result.targetCategoryId, '');
  assert.equal(result.autoSelected, false);
});

test('P1 20 subcategory is never fabricated by exact or normalized category matching', () => {
  const exact = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: ['Kitchen', 'Cookware'], categories });
  const normalized = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: [' kitchen '], productTitle: 'Cookware set', categories });
  assert.equal(exact.targetSubcategoryId, '');
  assert.equal(normalized.targetSubcategoryId, '');
});

test('P1 21 limited traversal remains ineligible for removal reconciliation', () => {
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(sync, /Limited \/ filtered \/ incremental runs must never reconcile removals/);
  assert.match(sync, /fullCatalogCompleted[\s\S]*deletionReconciliationEligible/);
});

test('P1 22 confirmed approved-offer removal never deletes or hides the Zyro product', async () => {
  const offer = approvedOffer('source-a', 7);
  const fixture = inventoryFixture(offer);
  const result = await applyApprovedSupplierInventoryObservation(fixture.db as never, {
    offerId: offer.id, productId: 'product-1', stock: 0, removed: true,
    observedAt: '2026-09-01T13:00:00.000Z', expectedStateVersion: offer.stateVersion,
  });
  assert.equal(result.action, 'SUPPLIER_PRODUCT_REMOVED');
  assert.equal(fixture.documents.get('products/product-1')?.stock, 0);
  assert.equal(fixture.documents.get('products/product-1')?.visible, true);
  assert.equal(fixture.operations.some((operation) => operation.operation === 'set' && operation.data === null), false);
});

test('P1 23 removed active offer recomputes availability through existing failover', async () => {
  const primary = approvedOffer('source-a', 7);
  const backup = approvedOffer('source-b', 9);
  const fixture = inventoryFixture(primary);
  fixture.documents.set(`supplier_product_offers/${backup.id}`, { ...backup });
  const result = await applyApprovedSupplierInventoryObservation(fixture.db as never, {
    offerId: primary.id, productId: 'product-1', stock: 0, removed: true,
    observedAt: '2026-09-01T13:00:00.000Z', expectedStateVersion: primary.stateVersion,
  });
  assert.equal(result.activeOfferId, backup.id);
  assert.equal(fixture.documents.get('products/product-1')?.stock, 9);
});

test('P1 24 Dropex cost and price remain outside automatic inventory field selection', () => {
  const comparison = buildSupplierProductComparison({ inventoryLevel: 7, wholesalePrice: 80, providedFields: ['stock', 'costPrice'], mediaGallery: [] } as never, { stock: 25, costPrice: 80 });
  assert.equal(removeAutomatedStockChangesFromSupplierComparison(comparison), null);
});

test('P1 25 A2Z unknown-stock semantics remain distinguishable from explicit zero', () => {
  const parser = readFileSync('functions/src/api/suppliers/a2z/ProductParser.ts', 'utf8');
  assert.match(parser, /providedFields/);
  assert.match(parser, /inventoryLevel = optionalNumber[\s\S]*\?\? 0/);
  assert.equal(shouldDeferNewSupplierProductForZeroStock({ inventoryLevel: 0, providedFields: [] }, false), false);
});

test('P1 26 managed-media approval gate remains intact', () => {
  const approval = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  const queue = readFileSync('functions/src/scheduled/supplierReviewQueue.ts', 'utf8');
  assert.match(approval, /queueReadyForApproval/);
  assert.match(queue, /supplierReviewQueueMediaIsReady/);
});

test('P1 27 controlled batch continuation remains intact', () => {
  const traversal = readFileSync('functions/src/scheduled/supplierCatalogTraversal.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  assert.match(traversal, /catalogContinuation/);
  assert.match(sync, /terminationReason === "limit_reached"/);
});

test('P1 28 Supplier Portal remains server-authoritative and unchanged by stock automation', () => {
  const portal = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');
  const automation = readFileSync('functions/src/api/suppliers/supplierOfferEngine.ts', 'utf8');
  assert.match(portal, /const authenticate = async/);
  assert.match(portal, /auth\.verifyIdToken/);
  assert.doesNotMatch(automation, /supplierPortal|supplier_product_requests/);
});
