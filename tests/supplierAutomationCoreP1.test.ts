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
import { ProductParser } from '../functions/src/api/suppliers/dropex/ProductParser';
import { buildSupplierProductComparison } from '../functions/src/api/suppliers/supplierProductImport';
import {
  removeAutomatedStockChangesFromSupplierComparison,
  shouldDeferNewSupplierProductForZeroStock,
} from '../functions/src/scheduled/supplierSync';
import {
  buildSupplierTaxonomyCandidateId,
  planSupplierTaxonomyCandidates,
  suggestSupplierCategory,
  validateSupplierProductForApproval,
} from '../functions/src/api/suppliers/supplierProductMapping';
import {
  activateSupplierTaxonomyCandidate,
  upsertSupplierTaxonomyCandidate,
} from '../functions/src/api/suppliers/supplierTaxonomy';

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
  const operations: Array<{ operation: 'set' | 'create' | 'update'; key: string; data: Data }> = [];
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
      update: (reference: DocRef, data: Data) => void;
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
      update: (reference, data) => {
        assert.equal(documents.has(reference.key), true);
        operations.push({ operation: 'update', key: reference.key, data });
        merge(reference, data, true);
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
  const plan = planSupplierTaxonomyCandidates({
    sourceId: 'dropex',
    supplierCategory: 'Unmapped Department',
    supplierCategoryId: '99',
    categories,
    mapping: result,
  });
  assert.equal(plan?.categoryCandidate, true);
  assert.equal(plan?.parentCategoryId, undefined);
});

test('P1 19 inactive category is never silently auto-selected', () => {
  const result = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: ['Old Kitchen'], categories });
  assert.equal(result.targetCategoryId, '');
  assert.equal(result.autoSelected, false);
});

test('P1 20 subcategory is never fabricated by exact or normalized category matching', () => {
  const exact = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: ['Kitchen', 'Cookware'], categories });
  const normalized = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: [' kitchen '], productTitle: 'Cookware set', categories });
  assert.equal(exact.targetSubcategoryId, 'cookware');
  assert.equal(normalized.targetSubcategoryId, '');
});

test('P1 20A Dropex productCategories preserves SHX2924 category provenance without inventing a subcategory', () => {
  const parsed = ProductParser.parseCatalogItem({
    productDetail: {
      id: 4970,
      sku: 'SHX2924',
      name: 'Vehicle Accessory',
      productCategories: [{ id: 29, name: 'Vehicle Accessories' }],
    },
    price: 410,
    sellingPrice: 1400,
    onHandInventory: 1,
  });
  assert.equal(parsed.supplierCategory, 'Vehicle Accessories');
  assert.equal(parsed.supplierSubcategory, undefined);
  assert.deepEqual(parsed.categoryHierarchy, ['Vehicle Accessories']);
  assert.equal(parsed.extraAttributes?.supplierCategoryId, '29');
  assert.equal(parsed.extraAttributes?.supplierCategorySource, 'productDetail.productCategories');
  assert.equal(parsed.extraAttributes?.supplierSubcategoryId, undefined);
});

test('P1 20B exact active supplier subcategory links only under its resolved parent', () => {
  const result = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: ['Kitchen', 'Cookware'], categories });
  assert.equal(result.targetCategoryId, 'kitchen');
  assert.equal(result.targetSubcategoryId, 'cookware');
  assert.equal(result.autoSelected, true);
  const wrongParent = suggestSupplierCategory({
    sourceId: 'dropex',
    supplierCategories: ['Old Kitchen', 'Cookware'],
    categories,
  });
  assert.equal(wrongParent.targetCategoryId, '');
  assert.equal(wrongParent.targetSubcategoryId, '');
  assert.equal(wrongParent.requiresManualSelection, true);
});

test('P1 20C missing supplier taxonomy is deterministic, inactive, pending, and idempotent', async () => {
  const plan = planSupplierTaxonomyCandidates({
    sourceId: 'dropex',
    supplierCategory: 'Vehicle Accessories',
    supplierCategoryId: '29',
    categories,
  });
  assert.ok(plan);
  assert.equal(plan.categoryCandidate, true);
  assert.equal(plan.subcategoryCandidate, false);
  assert.equal(plan.categoryId, buildSupplierTaxonomyCandidateId('dropex', '29', 'Vehicle Accessories'));
  const fixture = fakeFirestore({});
  await upsertSupplierTaxonomyCandidate(fixture.db as never, plan, '2026-09-15T10:00:00.000Z');
  await upsertSupplierTaxonomyCandidate(fixture.db as never, plan, '2026-09-15T11:00:00.000Z');
  const candidate = fixture.documents.get(`categories/${plan.categoryId}`);
  assert.equal(candidate?.isActive, false);
  assert.equal(candidate?.taxonomyStatus, 'pending');
  assert.equal(candidate?.supplierTaxonomySourceId, 'dropex');
  assert.equal(candidate?.supplierTaxonomyId, '29');
  assert.equal(candidate?.firstObservedAt, '2026-09-15T10:00:00.000Z');
  assert.equal(candidate?.lastObservedAt, '2026-09-15T11:00:00.000Z');
  assert.equal([...fixture.documents.keys()].filter((key) => key.startsWith('categories/')).length, 1);
});

test('P1 20D unknown subcategory is created once under a safe active parent and remains inactive', async () => {
  const mapping = suggestSupplierCategory({ sourceId: 'dropex', supplierCategories: ['Kitchen', 'Vehicle Parts'], categories });
  const plan = planSupplierTaxonomyCandidates({
    sourceId: 'dropex',
    supplierCategory: 'Kitchen',
    supplierCategoryId: 'kitchen-source-id',
    supplierSubcategory: 'Vehicle Parts',
    supplierSubcategoryId: 'vp-1',
    categories,
    mapping,
  });
  assert.ok(plan);
  assert.equal(plan.categoryCandidate, false);
  assert.equal(plan.subcategoryCandidate, true);
  assert.equal(plan.parentCategoryId, 'kitchen');
  const fixture = fakeFirestore({
    'categories/kitchen': { ...categories[0] },
  });
  await upsertSupplierTaxonomyCandidate(fixture.db as never, plan, '2026-09-15T10:00:00.000Z');
  await upsertSupplierTaxonomyCandidate(fixture.db as never, plan, '2026-09-15T11:00:00.000Z');
  const stored = fixture.documents.get('categories/kitchen');
  const candidates = (stored?.subcategories as Data[]).filter((subcategory) => subcategory.taxonomyCandidate === true);
  assert.equal(stored?.isActive, true);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.isActive, false);
  assert.equal(candidates[0]?.supplierTaxonomyId, 'vp-1');
});

test('P1 20E ambiguous parent never receives a guessed supplier subcategory', () => {
  const mapping = suggestSupplierCategory({
    sourceId: 'dropex',
    supplierCategories: ['Kitchen Tools', 'Vehicle Parts'],
    productTitle: 'Kitchen Tools Vehicle Parts',
    categories,
  });
  const plan = planSupplierTaxonomyCandidates({
    sourceId: 'dropex',
    supplierCategory: 'Kitchen Tools',
    supplierSubcategory: 'Vehicle Parts',
    categories,
    mapping,
  });
  assert.ok(plan);
  assert.equal(plan.categoryCandidate, true);
  assert.equal(plan.parentCategoryId, undefined);
});

test('P1 20F an inactive supplier taxonomy candidate blocks publication until activation', () => {
  const candidateId = buildSupplierTaxonomyCandidateId('dropex', '29', 'Vehicle Accessories');
  const errors = validateSupplierProductForApproval({
    name: 'Vehicle Accessory',
    imageUrl: 'https://example.test/image.jpg',
    price: 1400,
    costPrice: 410,
    description: 'Description',
    stock: 1,
    isActive: true,
    category: candidateId,
    brand: 'registered-brand',
    supplierMetadata: { supplierCostAvailable: true, supplierStockAvailable: true },
  }, [
    { id: candidateId, name: 'Vehicle Accessories', isActive: false },
  ], [{ id: 'registered-brand', name: 'Registered Brand', isActive: true }]);
  assert.equal(errors.some((error) => error.field === 'category' && error.code === 'invalid'), true);
});

test('P1 20G admin can activate a candidate category and its pending child', async () => {
  const plan = planSupplierTaxonomyCandidates({
    sourceId: 'dropex',
    supplierCategory: 'Vehicle Accessories',
    supplierCategoryId: '29',
    supplierSubcategory: 'Car Mounts',
    supplierSubcategoryId: 'car-mounts',
    categories,
  });
  assert.ok(plan);
  const fixture = fakeFirestore({});
  await upsertSupplierTaxonomyCandidate(fixture.db as never, plan, '2026-09-15T10:00:00.000Z');
  const result = await activateSupplierTaxonomyCandidate(
    fixture.db as never,
    plan.categoryId,
    { uid: 'admin-1', email: 'admin@example.test' },
    plan.subcategoryId,
  );
  assert.equal(result.categoryId, plan.categoryId);
  const activated = fixture.documents.get(`categories/${plan.categoryId}`);
  assert.equal(activated?.isActive, true);
  assert.equal((activated?.subcategories as Data[])[0]?.isActive, true);
});

test('P1 20H admin-owned taxonomy is not overwritten by later supplier observations', async () => {
  const fixture = fakeFirestore({
    'categories/admin-owned': { id: 'admin-owned', name: 'Admin Category', isActive: true, subcategories: [] },
  });
  const plan = planSupplierTaxonomyCandidates({
    sourceId: 'dropex',
    supplierCategory: 'Supplier Category',
    supplierCategoryId: 'supplier-category-id',
    categories: [{ id: 'admin-owned', name: 'Admin Category', isActive: true, subcategories: [] }],
  });
  assert.ok(plan);
  await upsertSupplierTaxonomyCandidate(fixture.db as never, plan, '2026-09-15T10:00:00.000Z');
  const owned = fixture.documents.get('categories/admin-owned');
  assert.deepEqual(owned, { id: 'admin-owned', name: 'Admin Category', isActive: true, subcategories: [] });
  assert.notEqual(plan.categoryId, 'admin-owned');
});

test('P1 20I mixed stock and non-stock observations keep stock automated and non-stock review-gated', () => {
  const incoming = {
    inventoryLevel: 8,
    wholesalePrice: 90,
    recommendedRetailPrice: 180,
    longDescription: 'Supplier description changed',
    categoryHierarchy: ['Vehicle Accessories'],
    supplierCategory: 'Vehicle Accessories',
    providedFields: ['stock', 'costPrice', 'comparePrice', 'longDescription', 'categoryHierarchy', 'supplierCategory'],
    mediaGallery: [],
  } as never;
  const existing = {
    stock: 10,
    costPrice: 80,
    price: 160,
    description: 'Admin description',
    category: 'electronics',
    supplierMetadata: { categoryHierarchy: ['Electronics'], supplierCategory: 'Electronics' },
  };
  const comparison = buildSupplierProductComparison(incoming, existing);
  const fieldNames = comparison.fieldChanges.map((change) => change.field);
  assert.equal(fieldNames.includes('stock'), true);
  assert.equal(fieldNames.includes('categoryHierarchy'), true);
  assert.equal(fieldNames.includes('longDescription'), true);
  assert.equal(fieldNames.includes('costPrice'), true);
  const pending = removeAutomatedStockChangesFromSupplierComparison(comparison);
  assert.ok(pending);
  assert.equal(pending?.fieldChanges.some((change) => change.field === 'stock'), false);
  assert.equal(pending?.fieldChanges.some((change) => change.field === 'categoryHierarchy'), true);
  assert.equal(pending?.fieldChanges.some((change) => change.field === 'longDescription'), true);
  assert.equal(pending?.fieldChanges.some((change) => change.field === 'costPrice'), true);
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
