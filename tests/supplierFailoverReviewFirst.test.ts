import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decideSupplierQueueItem, parseSupplierApprovalDraft } from '../functions/src/api/suppliers/supplierApproval';
import {
  applyApprovedSupplierInventoryObservation,
  buildSupplierProductOffer,
  configureSupplierProductOffer,
  reconcileSupplierProductOfferFailover,
  selectSupplierProductOffer,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import { resolveCustomerPromotion } from '../src/services/products/promotionPolicy';
import {
  buildSupplierFailoverProposalSummary,
  createSupplierReviewDraft,
  SupplierReviewDraft,
  SupplierReviewSourceItem,
  updateSupplierReviewDraftField,
} from '../src/services/supplierReviewEditor';

type StoredDocument = Record<string, unknown>;
type Filter = { field: string; operator: string; value: unknown };
type DocumentReference = {
  kind: 'document';
  collectionName: string;
  id: string;
  key: string;
  get: () => Promise<DocumentSnapshot>;
  set: (data: StoredDocument, options?: { merge?: boolean }) => Promise<void>;
};
type QueryReference = {
  kind: 'query';
  collectionName: string;
  filters: Filter[];
  pageLimit: number | null;
  where: (field: string, operator: string, value: unknown) => QueryReference;
  limit: (value: number) => QueryReference;
};
type DocumentSnapshot = { exists: boolean; id: string; ref: DocumentReference; data: () => StoredDocument | undefined };
type QuerySnapshot = { docs: DocumentSnapshot[]; size: number; empty: boolean };
type Write = { operation: 'set' | 'create' | 'update' | 'delete'; key: string; data?: StoredDocument };

const createFakeFirestore = (initial: Record<string, StoredDocument>) => {
  const documents = new Map<string, StoredDocument>(Object.entries(initial));
  const writes: Write[] = [];
  let generatedId = 0;
  const documentReference = (collectionName: string, id: string): DocumentReference => {
    const reference = {
      kind: 'document' as const,
      collectionName,
      id,
      key: `${collectionName}/${id}`,
      get: async () => documentSnapshot(reference),
      set: async (data: StoredDocument, options?: { merge?: boolean }) => {
        writes.push({ operation: 'set', key: reference.key, data });
        mergeWrite(reference, data, options?.merge === true);
      },
    };
    return reference;
  };
  const documentSnapshot = (reference: DocumentReference): DocumentSnapshot => {
    const data = documents.get(reference.key);
    return { exists: data !== undefined, id: reference.id, ref: reference, data: () => data };
  };
  const executeQuery = (query: QueryReference): QuerySnapshot => {
    let entries = [...documents.entries()]
      .filter(([key]) => key.startsWith(`${query.collectionName}/`))
      .map(([key, data]) => ({ id: key.slice(query.collectionName.length + 1), data }));
    for (const filter of query.filters) {
      entries = entries.filter((entry) => filter.operator === '==' && entry.data[filter.field] === filter.value);
    }
    if (query.pageLimit !== null) entries = entries.slice(0, query.pageLimit);
    const docs = entries.map((entry) => documentSnapshot(documentReference(query.collectionName, entry.id)));
    return { docs, size: docs.length, empty: docs.length === 0 };
  };
  const queryReference = (collectionName: string, filters: Filter[] = [], pageLimit: number | null = null): QueryReference => ({
    kind: 'query',
    collectionName,
    filters,
    pageLimit,
    where: (field, operator, value) => queryReference(collectionName, [...filters, { field, operator, value }], pageLimit),
    limit: (value) => queryReference(collectionName, filters, value),
  });
  const mergeWrite = (reference: DocumentReference, data: StoredDocument, merge = false): void => {
    if (!merge) {
      documents.set(reference.key, data);
      return;
    }
    const merged = { ...(documents.get(reference.key) || {}) };
    Object.entries(data).forEach(([field, value]) => {
      const constructorName = value && typeof value === 'object'
        ? (value as { constructor?: { name?: string } }).constructor?.name
        : undefined;
      if (constructorName === 'DeleteTransform') delete merged[field];
      else merged[field] = value;
    });
    documents.set(reference.key, merged);
  };
  const transaction = {
    get: async (reference: DocumentReference | QueryReference): Promise<DocumentSnapshot | QuerySnapshot> => reference.kind === 'query'
      ? executeQuery(reference)
      : documentSnapshot(reference),
    set: (reference: DocumentReference, data: StoredDocument, options?: { merge?: boolean }) => {
      writes.push({ operation: 'set', key: reference.key, data });
      mergeWrite(reference, data, options?.merge);
    },
    create: (reference: DocumentReference, data: StoredDocument) => {
      if (documents.has(reference.key)) throw new Error('Document already exists.');
      writes.push({ operation: 'create', key: reference.key, data });
      mergeWrite(reference, data);
    },
    update: (reference: DocumentReference, data: StoredDocument) => {
      writes.push({ operation: 'update', key: reference.key, data });
      mergeWrite(reference, data, true);
    },
    delete: (reference: DocumentReference) => {
      writes.push({ operation: 'delete', key: reference.key });
      documents.delete(reference.key);
    },
  };
  const db = {
    collection: (collectionName: string) => ({
      doc: (id?: string) => documentReference(collectionName, id || `generated-${++generatedId}`),
      where: (field: string, operator: string, value: unknown) => queryReference(collectionName).where(field, operator, value),
    }),
    runTransaction: async <T>(operation: (value: typeof transaction) => Promise<T>) => operation(transaction),
  };
  return { db, documents, writes };
};

const PRODUCT_ID = 'canonical-product';
const IMAGE_URL = 'https://storage.example/large.webp';
const NON_STOCK_FIELDS = ['price', 'originalPrice', 'discount', 'promotionEnabled', 'name', 'description', 'imageUrl', 'imageUrls', 'category', 'subcategory', 'brand', 'specs'];
const admin = { uid: 'admin-1', email: 'admin@zyro.lk' };

const managedMedia = [{
  assetId: 'a'.repeat(64),
  supplierId: 'supplier-b',
  sourceId: 'source-b',
  productId: 'source-b-item',
  originalSupplierUrl: 'https://supplier.example/product.jpg',
  originalStoragePath: 'supplier-media/supplier-b/source-b-item/original/product.jpg',
  originalStorageUrl: 'https://storage.example/original.jpg',
  firebaseStorageUrl: IMAGE_URL,
  contentHash: 'a'.repeat(64),
  width: 1200,
  height: 1200,
  mimeType: 'image/jpeg',
  fileSize: 1000,
  uploadTimestamp: '2026-07-26T00:00:00.000Z',
  imageStatus: 'ready',
  isPrimary: true,
  sortOrder: 0,
  variants: {
    thumbnail: { storagePath: 'thumbnail', storageUrl: 'https://storage.example/thumbnail.webp', width: 200, height: 200, mimeType: 'image/webp', fileSize: 100 },
    medium: { storagePath: 'medium', storageUrl: 'https://storage.example/medium.webp', width: 800, height: 800, mimeType: 'image/webp', fileSize: 500 },
    large: { storagePath: 'large', storageUrl: IMAGE_URL, width: 1200, height: 1200, mimeType: 'image/webp', fileSize: 800 },
  },
}];

const offer = (sourceId: string, overrides: StoredDocument = {}) => buildSupplierProductOffer({
  sourceId,
  supplierId: sourceId.replace('source', 'supplier'),
  supplierProductId: `${sourceId}-item`,
  sku: `${sourceId}-sku`,
  productId: PRODUCT_ID,
  price: 900,
  cost: 600,
  stock: 20,
  availability: 'in_stock',
  priority: 100,
  health: { availability: 'available', sourceAvailability: 'available' },
  lastSyncAt: '2026-09-20T00:00:00.000Z',
  reviewStatus: 'approved',
  catalogPayload: {},
  supplierSnapshot: {},
  timestamp: '2026-09-20T00:00:00.000Z',
  ...overrides,
});

const liveProduct: StoredDocument = {
  id: PRODUCT_ID,
  name: 'Live product',
  description: 'Admin description',
  imageUrl: IMAGE_URL,
  imageUrls: [IMAGE_URL],
  category: 'category-1',
  subcategory: 'subcategory-1',
  brand: 'brand-1',
  specs: {},
  price: 900,
  originalPrice: 1000,
  discount: 10,
  promotionEnabled: true,
  stock: 8,
  availability: 'in_stock',
  isActive: true,
  active: true,
  visible: true,
};

/** Active offer A has just become unavailable; approved offer B can serve at `replacementPrice`. */
const failoverFixture = (replacementPrice = 850, productOverrides: StoredDocument = {}) => {
  const active = offer('source-a', { priority: 200, stock: 0, availability: 'out_of_stock' });
  const replacement = offer('source-b', { priority: 100, price: replacementPrice, supplierSnapshot: { supplierName: 'Supplier B' } });
  const fixture = createFakeFirestore({
    [`products/${PRODUCT_ID}`]: { ...liveProduct, ...productOverrides },
    [`product_private/${PRODUCT_ID}`]: {
      supplierOfferSelection: { activeOfferId: active.id, lockedOfferId: null, failoverEnabled: true },
      supplierMetadata: {
        activeOfferId: active.id,
        inventoryLevel: 10,
        localDemand: { version: 1, quantity: 2, status: 'tracked' },
      },
    },
    'categories/category-1': {
      name: 'Category',
      isActive: true,
      subcategories: [{ id: 'subcategory-1', name: 'Subcategory', isActive: true }],
      specificationTemplate: [],
    },
    'brands/brand-1': { name: 'Brand', isActive: true },
    [`supplier_product_offers/${active.id}`]: { ...active },
    [`supplier_product_offers/${replacement.id}`]: { ...replacement },
  });
  return { ...fixture, active, replacement, reviewId: `reconcile-offer-${active.id}` };
};

/** The existing queue worker moves a queued review to review_pending once managed media is ready. */
const markReviewReady = (documents: Map<string, StoredDocument>, reviewId: string, media: StoredDocument[] = managedMedia) => {
  documents.set(`supplier_review_queue/${reviewId}`, {
    ...documents.get(`supplier_review_queue/${reviewId}`),
    queueState: 'review_pending',
    mediaSourceImageUrls: ['https://supplier.example/product.jpg'],
    mediaStatus: 'ready',
    mediaFailures: [],
    mediaProcessedAt: '2026-09-20T00:00:00.000Z',
    managedMedia: media,
  });
};

/** Managed media owned by the review's own supplier offer, as the editor-draft approval path requires. */
const reviewSupplierMedia = managedMedia.map((asset) => ({
  ...asset,
  supplierId: 'supplier-a',
  sourceId: 'source-a',
  productId: 'source-a-item',
  originalStoragePath: 'supplier-media/supplier-a/source-a-item/original/product.jpg',
}));

const productWrites = (writes: Write[]) => writes.filter((write) => write.key === `products/${PRODUCT_ID}`);
const reviewDocuments = (documents: Map<string, StoredDocument>) => [...documents.keys()].filter((key) => key.startsWith('supplier_review_queue/'));
const selectionOf = (documents: Map<string, StoredDocument>) => documents.get(`product_private/${PRODUCT_ID}`)?.supplierOfferSelection as StoredDocument;

test('Step 2A A: automatic failover fails closed, keeps live price/promotion, and queues the replacement for review', async () => {
  const { db, documents, writes, active, replacement, reviewId } = failoverFixture(850);

  const result = await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'active offer out of stock');

  assert.equal(result.changed, true);
  assert.equal(result.activeOfferId, null);
  assert.equal(result.proposedOfferId, replacement.id);
  assert.equal(result.reviewQueueItemId, reviewId);
  const product = documents.get(`products/${PRODUCT_ID}`) || {};
  assert.equal(product.price, 900);
  assert.equal(product.originalPrice, 1000);
  assert.equal(product.discount, 10);
  assert.equal(product.promotionEnabled, true);
  assert.equal(product.stock, 0);
  assert.equal(product.availability, 'unavailable');
  assert.equal(product.isActive, false);
  assert.equal(product.visible, false);
  for (const write of productWrites(writes)) {
    for (const field of NON_STOCK_FIELDS) assert.equal(Object.hasOwn(write.data || {}, field), false, `automatic failover wrote ${field}`);
  }
  assert.equal(selectionOf(documents).activeOfferId, active.id);
  const privateMetadata = documents.get(`product_private/${PRODUCT_ID}`)?.supplierMetadata as StoredDocument;
  assert.equal(privateMetadata.supplierFailoverDeactivated, true);
  assert.deepEqual(privateMetadata.localDemand, { version: 1, quantity: 2, status: 'tracked' });
  assert.equal(documents.get(`supplier_product_offers/${active.id}`)?.stock, 0);

  const review = documents.get(`supplier_review_queue/${reviewId}`) || {};
  assert.equal(review.status, 'Pending');
  assert.equal(review.queueState, 'queued');
  assert.equal(review.reconciliationAction, 'supplier_offer_unavailable');
  assert.equal(review.supplierOfferId, active.id);
  assert.equal(review.canonicalProductId, PRODUCT_ID);
  assert.equal((review.supplierSnapshot as StoredDocument).failoverReplacementOfferId, replacement.id);
  const fieldChanges = ((review.comparison as StoredDocument).fieldChanges as StoredDocument[]);
  assert.deepEqual(fieldChanges.find((change) => change.field === 'price')?.after, 850);
  assert.equal((review.productPayload as StoredDocument).visible, true);
  const audit = [...documents.entries()].find(([key, value]) => key.startsWith('supplier_operations_audit/') && value.action === 'automatic_offer_failover')?.[1];
  assert.ok(audit);
  const auditPublic = ((audit.after as StoredDocument).publicCommerce || {}) as StoredDocument;
  for (const field of ['price', 'originalPrice', 'discount', 'promotionEnabled']) assert.equal(Object.hasOwn(auditPublic, field), false);
});

test('Step 2A B: repeated failover signals keep one active review and stale proposals cannot be approved', async () => {
  const { db, documents, writes, active, replacement, reviewId } = failoverFixture(850);

  await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'signal 1');
  const productWriteCount = productWrites(writes).length;
  const second = await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'signal 2');
  const third = await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'signal 3');

  assert.equal(second.changed, false);
  assert.equal(third.changed, false);
  assert.deepEqual(reviewDocuments(documents), [`supplier_review_queue/${reviewId}`]);
  assert.equal(productWrites(writes).length, productWriteCount);
  assert.equal([...documents.keys()].filter((key) => key.startsWith('supplier_approval_audit/')).length, 1);

  // The recorded replacement becomes unavailable and a different offer could serve.
  const other = offer('source-c', { priority: 50, price: 880 });
  documents.set(`supplier_product_offers/${other.id}`, { ...other });
  documents.set(`supplier_product_offers/${replacement.id}`, { ...replacement, stock: 0, availability: 'out_of_stock' });
  markReviewReady(documents, reviewId);
  await assert.rejects(
    decideSupplierQueueItem(db as never, reviewId, 'approved', admin),
    /proposed replacement supplier offer changed/i,
  );
  assert.equal(documents.get(`products/${PRODUCT_ID}`)?.price, 900);
  assert.equal(selectionOf(documents).activeOfferId, active.id);

  // The next failover signal refreshes the same review with the new replacement identity.
  const refreshed = await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'replacement changed');
  assert.equal(refreshed.proposedOfferId, other.id);
  assert.deepEqual(reviewDocuments(documents), [`supplier_review_queue/${reviewId}`]);
  const review = documents.get(`supplier_review_queue/${reviewId}`) || {};
  assert.equal((review.supplierSnapshot as StoredDocument).failoverReplacementOfferId, other.id);
  assert.equal(review.queueState, 'review_pending');

  // A live-product edit after the proposal is caught by the existing approval baseline.
  documents.set(`products/${PRODUCT_ID}`, { ...documents.get(`products/${PRODUCT_ID}`), name: 'Admin renamed' });
  const conflicted = await decideSupplierQueueItem(db as never, reviewId, 'approved', admin);
  assert.equal(conflicted.success, false);
  assert.equal(documents.get(`supplier_review_queue/${reviewId}`)?.queueState, 'conflict');
  assert.equal(documents.get(`products/${PRODUCT_ID}`)?.price, 900);
});

test('Step 2A B: recovery of the configured offer restores stock and visibility only and retires the proposal', async () => {
  const { db, documents, writes, active, reviewId } = failoverFixture(850);
  await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'out of stock');
  documents.set(`supplier_product_offers/${active.id}`, { ...active, stock: 12, availability: 'in_stock' });
  const before = productWrites(writes).length;

  const recovered = await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'recovered');

  assert.equal(recovered.activeOfferId, active.id);
  const product = documents.get(`products/${PRODUCT_ID}`) || {};
  assert.equal(product.price, 900);
  assert.equal(product.originalPrice, 1000);
  assert.equal(product.stock, 10);
  assert.equal(product.visible, true);
  assert.equal(product.isActive, true);
  for (const write of productWrites(writes).slice(before)) {
    for (const field of NON_STOCK_FIELDS) assert.equal(Object.hasOwn(write.data || {}, field), false, `recovery wrote ${field}`);
  }
  assert.equal(documents.get(`supplier_review_queue/${reviewId}`)?.queueState, 'suppressed');
  assert.equal((documents.get(`product_private/${PRODUCT_ID}`)?.supplierMetadata as StoredDocument).supplierFailoverDeactivated, false);
});

test('Step 2A B: a rejected proposal is respected until the supplier offer state changes', async () => {
  const { db, documents, active, reviewId } = failoverFixture(850);
  await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'out of stock');
  documents.set(`supplier_review_queue/${reviewId}`, {
    ...documents.get(`supplier_review_queue/${reviewId}`),
    status: 'Rejected',
    queueState: 'rejected',
  });
  documents.set(`supplier_review_queue/reconcile-offer-${active.id}-v${active.stateVersion}`, {
    status: 'Rejected', queueState: 'rejected', supplierOfferId: 'other-offer',
  });

  const repeated = await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'repeat after rejection');

  assert.equal(repeated.changed, false);
  assert.equal(repeated.reviewQueueItemId, null);
  assert.equal(documents.get(`products/${PRODUCT_ID}`)?.visible, false);
});

for (const scenario of [
  { label: 'keeps promotion within 20%', replacementPrice: 850, expectedOriginalPrice: 1000, expectedDiscount: 15 },
  { label: 'would push promotion above 20%', replacementPrice: 750, expectedOriginalPrice: undefined, expectedDiscount: undefined },
]) {
  test(`Step 2A C: failover replacement that ${scenario.label} is deferred, then approval applies the capped projection`, async () => {
    const { db, documents, replacement, reviewId } = failoverFixture(scenario.replacementPrice);

    await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'active offer out of stock');
    const deferred = documents.get(`products/${PRODUCT_ID}`) || {};
    assert.equal(deferred.price, 900);
    assert.equal(deferred.originalPrice, 1000);
    assert.equal(deferred.discount, 10);

    markReviewReady(documents, reviewId);
    const result = await decideSupplierQueueItem(db as never, reviewId, 'approved', admin);

    assert.equal(result.success, true, JSON.stringify(result));
    const product = documents.get(`products/${PRODUCT_ID}`) || {};
    assert.equal(product.price, scenario.replacementPrice);
    assert.equal(product.originalPrice, scenario.expectedOriginalPrice);
    assert.equal(product.discount, scenario.expectedDiscount);
    const customerPromotion = resolveCustomerPromotion(product as never);
    assert.equal(customerPromotion?.discountPercent ?? null, scenario.expectedDiscount ?? null);
    assert.equal(product.visible, true);
    assert.equal(product.isActive, true);
    assert.equal(Number(product.stock) > 0, true);
    assert.equal(selectionOf(documents).activeOfferId, replacement.id);
    assert.equal((documents.get(`product_private/${PRODUCT_ID}`)?.supplierMetadata as StoredDocument).supplierFailoverDeactivated, false);
    assert.equal(documents.get(`supplier_review_queue/${reviewId}`)?.queueState, 'approved');
  });
}

for (const scenario of [
  { label: 'within the 20% cap', replacementPrice: 850, expectedOriginalPrice: 1000, expectedDiscount: 15 },
  { label: 'above the 20% cap', replacementPrice: 750, expectedOriginalPrice: undefined, expectedDiscount: undefined },
]) {
  test(`Step 2A D: explicit admin offer selection still switches immediately with a promotion ${scenario.label}`, async () => {
    const { db, documents, replacement } = failoverFixture(scenario.replacementPrice);

    const selected = await selectSupplierProductOffer(db as never, PRODUCT_ID, { offerId: replacement.id }, admin);

    assert.equal(selected.activeOffer?.id, replacement.id);
    const product = documents.get(`products/${PRODUCT_ID}`) || {};
    assert.equal(product.price, scenario.replacementPrice);
    assert.equal(product.originalPrice, scenario.expectedOriginalPrice);
    assert.equal(product.discount, scenario.expectedDiscount);
    assert.equal(selectionOf(documents).activeOfferId, replacement.id);
  });
}

test('Step 2A D: explicit admin offer configuration applies the capped replacement projection', async () => {
  const { db, documents, active, replacement } = failoverFixture(750);

  await configureSupplierProductOffer(db as never, PRODUCT_ID, active.id, { enabled: false }, admin);

  const product = documents.get(`products/${PRODUCT_ID}`) || {};
  assert.equal(selectionOf(documents).activeOfferId, replacement.id);
  assert.equal(product.price, 750);
  assert.equal(Object.hasOwn(product, 'originalPrice'), false);
  assert.equal(Object.hasOwn(product, 'discount'), false);
});

test('Step 2A E: 15-minute stock-only refresh writes only stock, availability, and private inventory state', async () => {
  const active = offer('source-a', { priority: 200, stock: 12 });
  const backup = offer('source-b', { priority: 300, price: 700, stock: 40 });
  const { db, documents, writes } = createFakeFirestore({
    [`products/${PRODUCT_ID}`]: { ...liveProduct, stock: 10 },
    [`product_private/${PRODUCT_ID}`]: {
      supplierOfferSelection: { activeOfferId: active.id, lockedOfferId: null, failoverEnabled: true },
      supplierMetadata: { activeOfferId: active.id, inventoryLevel: 12, localDemand: { version: 1, quantity: 2, status: 'tracked' } },
    },
    [`supplier_product_offers/${active.id}`]: { ...active },
    [`supplier_product_offers/${backup.id}`]: { ...backup },
  });

  for (const [stock, expectedStock, expectedAvailability] of [[5, 3, 'in_stock'], [0, 0, 'out_of_stock']] as const) {
    const result = await applyApprovedSupplierInventoryObservation(db as never, {
      offerId: active.id,
      productId: PRODUCT_ID,
      stock,
      observedAt: `2026-09-27T00:0${stock}:00.000Z`,
      stockOnly: true,
    });
    assert.equal(result.applied, true);
    assert.equal(result.activeOfferId, active.id);
    const product = documents.get(`products/${PRODUCT_ID}`) || {};
    assert.equal(product.stock, expectedStock);
    assert.equal(product.availability, expectedAvailability);
  }
  for (const write of productWrites(writes)) {
    assert.deepEqual(Object.keys(write.data || {}).sort(), ['availability', 'stock', 'updatedAt']);
  }
  for (const write of writes.filter((entry) => entry.key === `product_private/${PRODUCT_ID}`)) {
    assert.deepEqual(Object.keys(write.data || {}).sort(), ['supplierMetadata', 'updatedAt']);
  }
  const product = documents.get(`products/${PRODUCT_ID}`) || {};
  assert.equal(product.price, 900);
  assert.equal(product.originalPrice, 1000);
  assert.equal(product.promotionEnabled, true);
  assert.equal(product.visible, true);
  assert.equal(selectionOf(documents).activeOfferId, active.id);
  assert.deepEqual(
    (documents.get(`product_private/${PRODUCT_ID}`)?.supplierMetadata as StoredDocument).localDemand,
    { version: 1, quantity: 2, status: 'tracked' },
  );
  assert.equal(writes.some((write) => write.key.startsWith('supplier_review_queue/')), false);
  assert.match(readFileSync('functions/src/scheduled/supplierInventoryRefresh.ts', 'utf8'), /stockOnly: true/);
});

test('Step 2A E: catalogue inventory observations never switch offers or write non-stock product fields', async () => {
  const active = offer('source-a', { priority: 100, stock: 12 });
  const backup = offer('source-b', { priority: 300, price: 700, stock: 40 });
  const { db, documents, writes } = createFakeFirestore({
    [`products/${PRODUCT_ID}`]: { ...liveProduct, stock: 10 },
    [`product_private/${PRODUCT_ID}`]: {
      supplierOfferSelection: { activeOfferId: active.id, lockedOfferId: null, failoverEnabled: true },
      supplierMetadata: { activeOfferId: active.id, inventoryLevel: 12, localDemand: { version: 1, quantity: 2, status: 'tracked' } },
    },
    [`supplier_product_offers/${active.id}`]: { ...active },
    [`supplier_product_offers/${backup.id}`]: { ...backup },
  });

  await applyApprovedSupplierInventoryObservation(db as never, {
    offerId: backup.id, productId: PRODUCT_ID, stock: 35, observedAt: '2026-09-27T01:00:00.000Z',
  });
  assert.equal(productWrites(writes).length, 0);
  await applyApprovedSupplierInventoryObservation(db as never, {
    offerId: active.id, productId: PRODUCT_ID, stock: 0, removed: true, observedAt: '2026-09-27T01:01:00.000Z',
  });

  for (const write of productWrites(writes)) {
    assert.deepEqual(Object.keys(write.data || {}).sort(), ['availability', 'stock', 'updatedAt']);
  }
  const product = documents.get(`products/${PRODUCT_ID}`) || {};
  assert.equal(product.price, 900);
  assert.equal(product.stock, 0);
  assert.equal(product.availability, 'unavailable');
  assert.equal(selectionOf(documents).activeOfferId, active.id);
});

/** Live 850 / 1000 (15%) product whose active offer fails over to `replacementPrice`, ready for Product Review. */
const reviewedFailover = async (replacementPrice: number) => {
  const fixture = failoverFixture(replacementPrice, { price: 850, originalPrice: 1000, discount: 15 });
  await reconcileSupplierProductOfferFailover(fixture.db as never, PRODUCT_ID, 'active offer out of stock');
  markReviewReady(fixture.documents, fixture.reviewId, reviewSupplierMedia);
  const reviewItem = () => ({
    id: fixture.reviewId,
    ...fixture.documents.get(`supplier_review_queue/${fixture.reviewId}`),
  }) as unknown as SupplierReviewSourceItem;
  const approve = async (draft: SupplierReviewDraft) => decideSupplierQueueItem(
    fixture.db as never,
    fixture.reviewId,
    'approved',
    admin,
    { draft: parseSupplierApprovalDraft(JSON.parse(JSON.stringify(draft))) },
  );
  const approveUnparsed = async (draft: SupplierReviewDraft) => decideSupplierQueueItem(
    fixture.db as never,
    fixture.reviewId,
    'approved',
    admin,
    { draft: JSON.parse(JSON.stringify(draft)) },
  );
  return { ...fixture, reviewItem, approve, approveUnparsed };
};

const editCommercialFields = (draft: SupplierReviewDraft, patch: Partial<SupplierReviewDraft>): SupplierReviewDraft => {
  let next = draft;
  if (patch.sellingPrice !== undefined) next = updateSupplierReviewDraftField(next, 'price', { sellingPrice: patch.sellingPrice });
  if (patch.comparePrice !== undefined || patch.promotionEnabled !== undefined) {
    next = updateSupplierReviewDraftField(next, 'originalPrice', {
      ...(patch.comparePrice !== undefined ? { comparePrice: patch.comparePrice } : {}),
      ...(patch.promotionEnabled !== undefined ? { promotionEnabled: patch.promotionEnabled } : {}),
    });
  }
  return next;
};

const assertPublishedWithoutPromotion = (product: StoredDocument, price: number) => {
  assert.equal(product.price, price);
  assert.equal(product.promotionEnabled, false);
  assert.equal(Object.hasOwn(product, 'originalPrice'), false);
  assert.equal(Object.hasOwn(product, 'discount'), false);
  assert.equal(resolveCustomerPromotion(product as never), null);
};

test('Step 2B A: a 25% replacement proposes 750 with the promotion removed, and approval publishes exactly that', async () => {
  const { documents, replacement, reviewId, reviewItem, approve } = await reviewedFailover(750);

  const item = reviewItem();
  const draft = createSupplierReviewDraft(item);
  assert.equal(draft.sellingPrice, 750);
  assert.equal(draft.comparePrice, 0);
  assert.equal(draft.promotionEnabled, false);
  assert.equal(draft.costPrice, 600);
  assert.equal(item.productPayload?.promotionEnabled, false);
  assert.equal(item.productPayload?.originalPrice ?? null, null);
  assert.equal(item.productPayload?.discount ?? null, null);
  const summary = buildSupplierFailoverProposalSummary(item);
  assert.equal(summary?.replacementOffer.offerId, replacement.id);
  assert.equal(summary?.replacementOffer.supplierName, 'Supplier B');
  assert.equal(summary?.replacementOffer.sku, 'source-b-sku');
  assert.equal(summary?.previousPrice, 850);
  assert.equal(summary?.proposedPrice, 750);
  assert.equal(summary?.promotionOutcome, 'removed_cap');
  assert.equal(summary?.promotionMessage, 'Promotion removed — proposed price would exceed the 20% maximum.');

  const result = await approve(draft);

  assert.equal(result.success, true, JSON.stringify(result));
  assertPublishedWithoutPromotion(documents.get(`products/${PRODUCT_ID}`) || {}, 750);
  assert.equal(documents.get(`products/${PRODUCT_ID}`)?.visible, true);
  assert.equal(selectionOf(documents).activeOfferId, replacement.id);
  assert.equal(documents.get(`supplier_review_queue/${reviewId}`)?.queueState, 'approved');
});

test('Step 2B B: an 18% replacement keeps the promotion in the draft and publishes 820 / 1000 / 18%', async () => {
  const { documents, reviewItem, approve } = await reviewedFailover(820);

  const item = reviewItem();
  const draft = createSupplierReviewDraft(item);
  assert.equal(draft.sellingPrice, 820);
  assert.equal(draft.comparePrice, 1000);
  assert.equal(draft.promotionEnabled, true);
  const summary = buildSupplierFailoverProposalSummary(item);
  assert.equal(summary?.promotionOutcome, 'kept');
  assert.equal(summary?.proposedDiscountPercent, 18);
  assert.equal(summary?.promotionMessage, 'Promotion kept — 18% off the regular price.');

  const result = await approve(draft);

  assert.equal(result.success, true, JSON.stringify(result));
  const product = documents.get(`products/${PRODUCT_ID}`) || {};
  assert.equal(product.price, 820);
  assert.equal(product.originalPrice, 1000);
  assert.equal(product.discount, 18);
  assert.equal(product.promotionEnabled, true);
  assert.equal(resolveCustomerPromotion(product as never)?.discountPercent, 18);
});

test('Step 2B C: reviewer edits to 800 / 1000 with promotion win over the replacement price', async () => {
  const { documents, replacement, reviewItem, approve } = await reviewedFailover(750);

  const draft = editCommercialFields(createSupplierReviewDraft(reviewItem()), {
    sellingPrice: 800,
    comparePrice: 1000,
    promotionEnabled: true,
  });
  const result = await approve(draft);

  assert.equal(result.success, true, JSON.stringify(result));
  const product = documents.get(`products/${PRODUCT_ID}`) || {};
  assert.equal(product.price, 800);
  assert.equal(product.originalPrice, 1000);
  assert.equal(product.discount, 20);
  assert.equal(product.promotionEnabled, true);
  assert.equal(selectionOf(documents).activeOfferId, replacement.id);
});

test('Step 2B D: a reviewer-enabled 25% promotion is rejected and the review stays pending without mutation', async () => {
  const { documents, writes, active, reviewId, reviewItem, approve, approveUnparsed } = await reviewedFailover(750);
  const draft = editCommercialFields(createSupplierReviewDraft(reviewItem()), {
    sellingPrice: 750,
    comparePrice: 1000,
    promotionEnabled: true,
  });
  const productBefore = { ...documents.get(`products/${PRODUCT_ID}`) };
  const writeCount = writes.length;

  await assert.rejects(approve(draft), /Launch promotions cannot exceed 20%\./);
  await assert.rejects(approveUnparsed(draft), /Launch promotions cannot exceed 20%\./);

  assert.equal(writes.length, writeCount);
  assert.deepEqual(documents.get(`products/${PRODUCT_ID}`), productBefore);
  assert.equal(documents.get(`supplier_review_queue/${reviewId}`)?.queueState, 'review_pending');
  assert.equal(selectionOf(documents).activeOfferId, active.id);
});

test('Step 2B E: a reviewer turning a kept promotion off publishes 750 with promotionEnabled false and no compare price', async () => {
  const { documents, reviewItem, approve } = await reviewedFailover(820);
  const draft = editCommercialFields(createSupplierReviewDraft(reviewItem()), {
    sellingPrice: 750,
    promotionEnabled: false,
  });

  const result = await approve(draft);

  assert.equal(result.success, true, JSON.stringify(result));
  assertPublishedWithoutPromotion(documents.get(`products/${PRODUCT_ID}`) || {}, 750);
});

test('Step 2B F: a changed replacement identity returns 409 for the reviewed draft with no mutation', async () => {
  const { documents, writes, active, replacement, reviewId, reviewItem, approve } = await reviewedFailover(820);
  const draft = createSupplierReviewDraft(reviewItem());
  const other = offer('source-c', { priority: 50, price: 880 });
  documents.set(`supplier_product_offers/${other.id}`, { ...other });
  documents.set(`supplier_product_offers/${replacement.id}`, { ...replacement, stock: 0, availability: 'out_of_stock' });
  const productBefore = { ...documents.get(`products/${PRODUCT_ID}`) };
  const writeCount = writes.length;

  await assert.rejects(approve(draft), (error: unknown) => (
    (error as { statusCode?: number; status?: number }).statusCode === 409
      || (error as { status?: number }).status === 409
      || /proposed replacement supplier offer changed/i.test(String((error as Error).message))
  ));

  assert.equal(writes.length, writeCount);
  assert.deepEqual(documents.get(`products/${PRODUCT_ID}`), productBefore);
  assert.equal(documents.get(`supplier_review_queue/${reviewId}`)?.queueState, 'review_pending');
  assert.equal(selectionOf(documents).activeOfferId, active.id);
});

test('Step 2B G: once the configured offer recovers, the stale failover review cannot be approved', async () => {
  const { db, documents, active, reviewId, reviewItem, approve } = await reviewedFailover(750);
  const draft = createSupplierReviewDraft(reviewItem());
  documents.set(`supplier_product_offers/${active.id}`, { ...active, stock: 12, availability: 'in_stock' });
  await reconcileSupplierProductOfferFailover(db as never, PRODUCT_ID, 'recovered');
  assert.equal(documents.get(`supplier_review_queue/${reviewId}`)?.queueState, 'suppressed');
  const productBefore = { ...documents.get(`products/${PRODUCT_ID}`) };

  await assert.rejects(approve(draft));

  assert.deepEqual(documents.get(`products/${PRODUCT_ID}`), productBefore);
  assert.equal(productBefore.price, 850);
  assert.equal(productBefore.originalPrice, 1000);
  assert.equal(selectionOf(documents).activeOfferId, active.id);
  assert.equal(documents.get(`supplier_review_queue/${reviewId}`)?.queueState, 'suppressed');
});
