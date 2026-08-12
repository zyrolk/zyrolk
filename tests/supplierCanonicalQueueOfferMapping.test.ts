import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAutoProductSku, decideSupplierQueueItem } from '../functions/src/api/suppliers/supplierApproval';
import { buildSupplierProductApprovalBaseline } from '../functions/src/api/suppliers/supplierApprovalConcurrency';
import {
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
  reconcileSupplierProductOfferFailover,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import {
  getSupplierQueueIdentityCandidate,
  resolveSupplierQueueIdentity,
} from '../functions/src/api/suppliers/supplierQueueIdentity';
import { retryDeadLetterSupplierReviewQueueItem } from '../functions/src/scheduled/supplierReviewQueue';

type StoredDocument = Record<string, unknown>;
type Filter = { field: string; operator: string; value: unknown };
type DocumentReference = {
  kind: 'document';
  collectionName: string;
  id: string;
  key: string;
  get: () => Promise<DocumentSnapshot>;
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

const createFakeFirestore = (initial: Record<string, StoredDocument>) => {
  const documents = new Map<string, StoredDocument>(Object.entries(initial));
  const writes: Array<{ operation: 'set' | 'create' | 'update' | 'delete'; key: string; data?: StoredDocument }> = [];
  let generatedId = 0;

  const documentReference = (collectionName: string, id: string): DocumentReference => {
    const reference = {
      kind: 'document' as const,
      collectionName,
      id,
      key: `${collectionName}/${id}`,
      get: async () => documentSnapshot(reference),
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
  const queryReference = (
    collectionName: string,
    filters: Filter[] = [],
    pageLimit: number | null = null,
  ): QueryReference => ({
    kind: 'query',
    collectionName,
    filters,
    pageLimit,
    where: (field, operator, value) => queryReference(collectionName, [...filters, { field, operator, value }], pageLimit),
    limit: (value) => queryReference(collectionName, filters, value),
  });
  const mergeWrite = (reference: DocumentReference, data: StoredDocument, merge = false): void => {
    documents.set(reference.key, merge ? { ...(documents.get(reference.key) || {}), ...data } : data);
  };
  const transaction = {
    get: async (reference: DocumentReference | QueryReference): Promise<DocumentSnapshot | QuerySnapshot> => reference.kind === 'query'
      ? executeQuery(reference)
      : documentSnapshot(reference),
    set: (reference: DocumentReference, data: StoredDocument, options?: { merge?: boolean }) => {
      writes.push({ operation: 'set' as const, key: reference.key, data });
      mergeWrite(reference, data, options?.merge);
    },
    create: (reference: DocumentReference, data: StoredDocument) => {
      if (documents.has(reference.key)) throw new Error('Document already exists.');
      writes.push({ operation: 'create' as const, key: reference.key, data });
      mergeWrite(reference, data);
    },
    update: (reference: DocumentReference, data: StoredDocument) => {
      writes.push({ operation: 'update' as const, key: reference.key, data });
      mergeWrite(reference, data, true);
    },
    delete: (reference: DocumentReference) => {
      writes.push({ operation: 'delete' as const, key: reference.key });
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
  return { db, documents, writes, transaction };
};

const managedMedia = [{
  assetId: 'a'.repeat(64),
  supplierId: 'supplier-b',
  sourceId: 'source-b',
  productId: 'source-b-item',
  originalSupplierUrl: 'https://supplier.example/product.jpg',
  originalStoragePath: 'supplier-media/supplier-b/source-b-item/original/product.jpg',
  originalStorageUrl: 'https://storage.example/original.jpg',
  firebaseStorageUrl: 'https://storage.example/large.webp',
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
    large: { storagePath: 'large', storageUrl: 'https://storage.example/large.webp', width: 1200, height: 1200, mimeType: 'image/webp', fileSize: 800 },
  },
}];

const offer = (sourceId: string, priority: number, overrides: StoredDocument = {}) => buildSupplierProductOffer({
  sourceId,
  supplierId: sourceId.replace('source', 'supplier'),
  supplierProductId: `${sourceId}-item`,
  sku: `${sourceId}-sku`,
  productId: 'canonical-product',
  price: sourceId === 'source-b' ? 140 : 150,
  cost: 100,
  stock: 20,
  availability: 'available',
  priority,
  health: { availability: 'available', sourceAvailability: 'available' },
  lastSyncAt: '2026-07-26T00:00:00.000Z',
  reviewStatus: sourceId === 'source-b' ? 'review_pending' : 'approved',
  catalogPayload: { originalPrice: 180 },
  supplierSnapshot: {},
  timestamp: '2026-07-26T00:00:00.000Z',
  ...overrides,
});

const canonicalProduct: StoredDocument = {
  id: 'canonical-product',
  name: 'Canonical product',
  description: 'Admin description',
  imageUrl: 'https://storage.example/large.webp',
  imageUrls: ['https://storage.example/large.webp'],
  category: 'category-1',
  subcategory: 'subcategory-1',
  brand: 'brand-1',
  specs: {},
  price: 150,
  originalPrice: 180,
  stock: 20,
  isActive: true,
  active: true,
  visible: true,
};

const queueItem = (queueState = 'review_pending', pendingRevision = ''): StoredDocument => ({
  status: queueState === 'dead_letter' ? 'Failed' : 'Pending',
  queueState,
  sourceId: 'source-b',
  supplierCode: 'source-b-sku',
  canonicalProductId: 'stale-product',
  productId: 'stale-product',
  supplierOfferId: offer('source-a', 100).id,
  ...(pendingRevision ? { supplierOfferPendingRevision: pendingRevision } : {}),
  productName: 'Supplier B product',
  productPayload: {
    id: 'stale-product',
    name: 'Supplier B product',
    description: 'Supplier description',
    imageUrl: 'https://storage.example/large.webp',
    imageUrls: ['https://storage.example/large.webp'],
    category: 'category-1',
    subcategory: 'subcategory-1',
    brand: 'brand-1',
    specs: {},
    price: 140,
    originalPrice: 180,
    stock: 20,
    isActive: true,
  },
  supplierSnapshot: {
    sourceId: 'source-b',
    supplierId: 'supplier-b',
    supplierProductId: 'source-b-item',
    supplierSku: 'source-b-sku',
  },
  managedMedia,
  approvalBaseline: buildSupplierProductApprovalBaseline('canonical-product', canonicalProduct, '2026-07-26T00:00:00.000Z'),
  createdAt: '2026-07-26T00:00:00.000Z',
});

const decisionFixture = (state = 'review_pending') => {
  const sourceA = offer('source-a', 100);
  const observedSourceB = offer('source-b', 200);
  const pendingObservation = buildSupplierOfferPendingObservation({
    offer: observedSourceB,
    kind: 'catalog_upsert',
    reviewQueueItemId: 'review-1',
    observedAt: '2026-07-26T00:00:00.000Z',
    traversalId: 'traversal-1',
  });
  const sourceB = { ...observedSourceB, stateVersion: 1, pendingObservation };
  return {
    sourceA,
    sourceB,
    pendingRevision: pendingObservation.revision,
    ...createFakeFirestore({
      'supplier_review_queue/review-1': queueItem(state, pendingObservation.revision),
      'products/canonical-product': { ...canonicalProduct },
      'product_private/canonical-product': {},
      'categories/category-1': {
        name: 'Category',
        isActive: true,
        subcategories: [{ id: 'subcategory-1', name: 'Subcategory', isActive: true }],
        specificationTemplate: [],
      },
      'brands/brand-1': { name: 'Brand', isActive: true },
      [`supplier_product_offers/${sourceA.id}`]: { ...sourceA },
      [`supplier_product_offers/${sourceB.id}`]: { ...sourceB },
    }),
  };
};

const approvedPendingDecisionFixture = () => {
  const sourceA = offer('source-a', 100, { reviewStatus: 'approved', stock: 8 });
  const effectiveSourceB = offer('source-b', 200, {
    reviewStatus: 'approved',
    price: 100,
    cost: 70,
    stock: 10,
    availability: 'available',
  });
  const observedSourceB = buildSupplierProductOffer({
    sourceId: effectiveSourceB.sourceId,
    supplierId: effectiveSourceB.supplierId,
    supplierProductId: effectiveSourceB.supplierProductId,
    sku: effectiveSourceB.sku,
    barcode: effectiveSourceB.barcode,
    productId: effectiveSourceB.productId,
    price: 120,
    cost: 80,
    stock: 0,
    availability: 'out_of_stock',
    priority: effectiveSourceB.priority,
    health: effectiveSourceB.health,
    lastSyncAt: '2026-07-27T00:00:00.000Z',
    reviewStatus: 'approved',
    catalogPayload: { ...effectiveSourceB.catalogPayload, price: 120, stock: 0 },
    supplierSnapshot: { ...effectiveSourceB.supplierSnapshot, wholesalePrice: 80, stock: 0 },
    existing: effectiveSourceB,
    timestamp: '2026-07-27T00:00:00.000Z',
  });
  const pendingObservation = buildSupplierOfferPendingObservation({
    offer: observedSourceB,
    kind: 'catalog_upsert',
    reviewQueueItemId: 'review-1',
    observedAt: '2026-07-27T00:00:00.000Z',
    traversalId: 'traversal-2',
  });
  const sourceB = { ...effectiveSourceB, stateVersion: 1, pendingObservation };
  const review = {
    ...queueItem('review_pending', pendingObservation.revision),
    supplierOfferId: sourceB.id,
    comparisonStatus: 'PRICE_CHANGED',
    productPayload: {
      ...canonicalProduct,
      id: 'canonical-product',
      price: 120,
      originalPrice: 180,
      stock: 0,
    },
  };
  return {
    sourceA,
    sourceB,
    pendingObservation,
    ...createFakeFirestore({
      'supplier_review_queue/review-1': review,
      'products/canonical-product': { ...canonicalProduct },
      'product_private/canonical-product': {},
      'categories/category-1': {
        name: 'Category',
        isActive: true,
        subcategories: [{ id: 'subcategory-1', name: 'Subcategory', isActive: true }],
        specificationTemplate: [],
      },
      'brands/brand-1': { name: 'Brand', isActive: true },
      [`supplier_product_offers/${sourceA.id}`]: { ...sourceA },
      [`supplier_product_offers/${sourceB.id}`]: { ...sourceB },
    }),
  };
};

const approvedPendingRemovalFixture = () => {
  const fixture = approvedPendingDecisionFixture();
  const removalObserved = buildSupplierProductOffer({
    ...fixture.pendingObservation.effective,
    productId: fixture.sourceB.productId,
    stock: 0,
    availability: 'unavailable',
    reviewStatus: 'approved',
    existing: fixture.sourceB,
    timestamp: '2026-07-29T00:00:00.000Z',
  });
  const pendingObservation = buildSupplierOfferPendingObservation({
    offer: removalObserved,
    kind: 'catalog_removal',
    reviewQueueItemId: 'review-1',
    observedAt: '2026-07-29T00:00:00.000Z',
    traversalId: 'traversal-removal',
  });
  fixture.documents.set(`supplier_product_offers/${fixture.sourceB.id}`, {
    ...fixture.sourceB,
    stateVersion: 2,
    pendingObservation,
  });
  fixture.documents.set('supplier_review_queue/review-1', {
    ...fixture.documents.get('supplier_review_queue/review-1'),
    supplierOfferPendingRevision: pendingObservation.revision,
    comparisonStatus: 'SUPPLIER_OFFER_REMOVED',
    reconciliationAction: 'supplier_offer_unavailable',
    productPayload: {
      ...canonicalProduct,
      id: 'canonical-product',
      stock: 0,
      isActive: false,
      active: false,
      visible: false,
    },
  });
  return { ...fixture, pendingObservation };
};

test('review approval resolves the canonical product through the deterministic Sprint 3 offer', async () => {
  const { db, documents, sourceA, sourceB, pendingRevision } = decisionFixture();

  const result = await decideSupplierQueueItem(db as never, 'review-1', 'approved', { uid: 'admin-1', email: 'admin@zyro.lk' }, { expectedPendingRevision: pendingRevision });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.productId, 'canonical-product');
  assert.equal(documents.has('products/stale-product'), false);
  assert.equal(documents.get(`supplier_product_offers/${sourceB.id}`)?.reviewStatus, 'approved');
  assert.equal(documents.get(`supplier_product_offers/${sourceA.id}`)?.reviewStatus, 'approved');
  assert.equal(documents.get('supplier_review_queue/review-1')?.canonicalProductId, 'canonical-product');
  assert.equal(documents.get('supplier_review_queue/review-1')?.supplierOfferId, sourceB.id);
});

test('approval stores edited commercial values and auto SKU only in the private product record', async () => {
  const { db, documents, pendingRevision } = decisionFixture();
  const result = await decideSupplierQueueItem(db as never, 'review-1', 'approved', { uid: 'admin-1', email: 'admin@zyro.lk' }, {
    draft: {
      productName: 'Canonical product',
      sellingPrice: 145,
      comparePrice: 190,
      costPrice: 125,
      marketPrice: 190,
      stock: 20,
      category: 'category-1',
      subcategory: 'subcategory-1',
      brand: 'brand-1',
      specifications: {},
      isActive: true,
      primaryImageUrl: 'https://storage.example/large.webp',
      galleryImageUrls: [],
      fieldOwnership: { costPrice: 'admin', marketPrice: 'admin' },
      editedFields: ['costPrice', 'marketPrice'],
    },
    expectedPendingRevision: pendingRevision,
  });

  assert.equal(result.success, true, JSON.stringify(result));
  const publicProduct = documents.get('products/canonical-product') || {};
  const privateProduct = documents.get('product_private/canonical-product') || {};
  // The fake Firestore merge keeps FieldValue.delete() sentinels as ordinary
  // values; production Firestore removes these fields atomically.
  assert.notEqual(publicProduct.sku, buildAutoProductSku('canonical-product'));
  assert.notEqual(publicProduct.costPrice, 125);
  assert.notEqual(publicProduct.marketPrice, 190);
  assert.equal(privateProduct.sku, buildAutoProductSku('canonical-product'));
  assert.equal(privateProduct.costPrice, 125);
  assert.equal(privateProduct.marketPrice, 190);
  assert.equal((privateProduct.supplierFieldOwnership as StoredDocument).costPrice && ((privateProduct.supplierFieldOwnership as StoredDocument).costPrice as StoredDocument).owner, 'admin');
});

test('approval preserves an existing legacy Zyro SKU without allocating a replacement claim', async () => {
  const { db, documents, pendingRevision } = decisionFixture();
  const legacySku = 'ZY-LEGACY-0001';
  documents.set('product_private/canonical-product', { sku: legacySku, productId: 'canonical-product' });

  const result = await decideSupplierQueueItem(db as never, 'review-1', 'approved', {
    uid: 'admin-1', email: 'admin@zyro.lk',
  }, { expectedPendingRevision: pendingRevision });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.sku, legacySku);
  assert.equal(documents.get('product_private/canonical-product')?.sku, legacySku);
  assert.equal([...documents.keys()].some((key) => key.startsWith('zyro_sku_claims/')), false);
});

test('approval atomically promotes the exact pending supplier observation', async () => {
  const { db, documents, sourceB, pendingObservation } = approvedPendingDecisionFixture();

  const result = await decideSupplierQueueItem(db as never, 'review-1', 'approved', {
    uid: 'admin-1', email: 'admin@zyro.lk',
  }, { expectedPendingRevision: pendingObservation.revision });

  assert.equal(result.success, true);
  const promoted = documents.get(`supplier_product_offers/${sourceB.id}`) || {};
  assert.equal(promoted.price, 120);
  assert.equal(promoted.stock, 0);
  assert.equal(promoted.reviewStatus, 'approved');
  assert.equal(promoted.pendingObservation, null);
  assert.equal(documents.get('products/canonical-product')?.price, canonicalProduct.price, 'legacy admin-owned price remains protected');
});

test('rejection clears only pending observation and preserves approved effective offer state', async () => {
  const { db, documents, sourceB, pendingObservation } = approvedPendingDecisionFixture();

  const result = await decideSupplierQueueItem(db as never, 'review-1', 'rejected', {
    uid: 'admin-1', email: 'admin@zyro.lk',
  }, { rejectionReason: 'Keep current offer.', expectedPendingRevision: pendingObservation.revision });

  assert.equal(result.success, true);
  const preserved = documents.get(`supplier_product_offers/${sourceB.id}`) || {};
  assert.equal(preserved.price, 100);
  assert.equal(preserved.stock, 10);
  assert.equal(preserved.reviewStatus, 'approved');
  assert.equal(preserved.pendingObservation, null);
  assert.equal(documents.get('products/canonical-product')?.price, canonicalProduct.price);
});

test('approved removal promotes unavailability only through the controlled approval transaction', async () => {
  const { db, documents, sourceA, sourceB, pendingObservation } = approvedPendingRemovalFixture();

  const result = await decideSupplierQueueItem(db as never, 'review-1', 'approved', {
    uid: 'admin-1', email: 'admin@zyro.lk',
  }, { expectedPendingRevision: pendingObservation.revision });

  assert.equal(result.success, true);
  const removed = documents.get(`supplier_product_offers/${sourceB.id}`) || {};
  assert.equal(removed.stock, 0);
  assert.equal(removed.availability, 'unavailable');
  assert.equal(removed.pendingObservation, null);
  assert.equal((documents.get('product_private/canonical-product')?.supplierOfferSelection as StoredDocument).activeOfferId, sourceA.id);
});

test('approved removal without a replacement cannot be undone by legacy admin-ownership defaults', async () => {
  const { db, documents, sourceA, pendingObservation } = approvedPendingRemovalFixture();
  documents.delete(`supplier_product_offers/${sourceA.id}`);

  const result = await decideSupplierQueueItem(db as never, 'review-1', 'approved', {
    uid: 'admin-1', email: 'admin@zyro.lk',
  }, { expectedPendingRevision: pendingObservation.revision });

  assert.equal(result.success, true);
  const product = documents.get('products/canonical-product') || {};
  assert.equal(product.stock, 0);
  assert.equal(product.availability, 'unavailable');
  assert.equal(product.isActive, false);
  assert.equal(product.active, false);
  assert.equal(product.visible, false);
});

test('rejected removal preserves effective availability and live product state', async () => {
  const { db, documents, sourceB, pendingObservation } = approvedPendingRemovalFixture();

  await decideSupplierQueueItem(db as never, 'review-1', 'rejected', {
    uid: 'admin-1', email: 'admin@zyro.lk',
  }, { rejectionReason: 'Supplier removal not accepted.', expectedPendingRevision: pendingObservation.revision });

  const preserved = documents.get(`supplier_product_offers/${sourceB.id}`) || {};
  assert.equal(preserved.stock, 10);
  assert.equal(preserved.availability, 'in_stock');
  assert.equal(preserved.reviewStatus, 'approved');
  assert.equal(documents.get('products/canonical-product')?.stock, canonicalProduct.stock);
});

test('stale approval and rejection cannot decide a newer pending observation', async (t) => {
  for (const action of ['approved', 'rejected'] as const) {
    await t.test(action, async () => {
      const fixture = approvedPendingDecisionFixture();
      const newerObserved = buildSupplierProductOffer({
        ...fixture.sourceB.pendingObservation!.effective,
        productId: fixture.sourceB.productId,
        price: 130,
        stock: 5,
        reviewStatus: 'approved',
        existing: fixture.sourceB,
        timestamp: '2026-07-28T00:00:00.000Z',
      });
      const newerPending = buildSupplierOfferPendingObservation({
        offer: newerObserved,
        kind: 'catalog_upsert',
        reviewQueueItemId: 'review-1',
        observedAt: '2026-07-28T00:00:00.000Z',
        traversalId: 'traversal-3',
      });
      fixture.documents.set(`supplier_product_offers/${fixture.sourceB.id}`, {
        ...fixture.sourceB,
        stateVersion: 2,
        pendingObservation: newerPending,
      });

      await assert.rejects(decideSupplierQueueItem(
        fixture.db as never,
        'review-1',
        action,
        { uid: 'admin-1', email: 'admin@zyro.lk' },
        action === 'approved'
          ? { expectedPendingRevision: fixture.pendingObservation.revision }
          : { rejectionReason: 'Reject old observation.', expectedPendingRevision: fixture.pendingObservation.revision },
      ), /observation changed|reload Product Review/i);
      assert.equal((fixture.documents.get(`supplier_product_offers/${fixture.sourceB.id}`)?.pendingObservation as StoredDocument).revision, newerPending.revision);
    });
  }
});

test('ambiguous legacy pending updates fail closed instead of guessing an approved baseline', async () => {
  const fixture = approvedPendingDecisionFixture();
  fixture.documents.set(`supplier_product_offers/${fixture.sourceB.id}`, {
    ...fixture.sourceB,
    reviewStatus: 'review_pending',
    pendingObservation: null,
    stateVersion: 0,
  });
  const review = { ...(fixture.documents.get('supplier_review_queue/review-1') || {}) };
  delete review.supplierOfferPendingRevision;
  fixture.documents.set('supplier_review_queue/review-1', review);

  await assert.rejects(decideSupplierQueueItem(
    fixture.db as never,
    'review-1',
    'approved',
    { uid: 'admin-1', email: 'admin@zyro.lk' },
  ), /no provable approved baseline/i);
});

for (const action of ['rejected', 'deleted'] as const) {
  test(`review ${action} updates only the deterministic supplier offer`, async () => {
    const { db, documents, sourceA, sourceB, pendingRevision } = decisionFixture();
    if (action === 'deleted') {
      documents.set('supplier_review_queue/review-1', {
        ...(documents.get('supplier_review_queue/review-1') || {}),
        queueState: 'conflict',
        status: 'CONFLICT',
        approvalConflict: { reason: 'Duplicate supplier identity requires an administrator decision.' },
      });
    }
    const options = action === 'rejected'
      ? { rejectionReason: 'Not suitable.', expectedPendingRevision: pendingRevision }
      : { deletionReason: 'Remove queue item.', expectedPendingRevision: pendingRevision };

    const result = await decideSupplierQueueItem(db as never, 'review-1', action, { uid: 'admin-1', email: 'admin@zyro.lk' }, options);

    assert.equal(result.success, true);
    assert.equal(documents.get(`supplier_product_offers/${sourceB.id}`)?.reviewStatus, action === 'rejected' ? 'rejected' : 'suppressed');
    assert.equal(documents.get(`supplier_product_offers/${sourceA.id}`)?.reviewStatus, 'approved');
    assert.equal(documents.get('supplier_review_queue/review-1')?.canonicalProductId, 'canonical-product');
    assert.equal(documents.get('supplier_review_queue/review-1')?.supplierOfferId, sourceB.id);
  });
}

test('ordinary ready reviews cannot be dismissed through the trusted API', async () => {
  const { db, documents, pendingRevision } = decisionFixture();

  await assert.rejects(decideSupplierQueueItem(
    db as never,
    'review-1',
    'deleted',
    { uid: 'admin-1', email: 'admin@zyro.lk' },
    { deletionReason: 'Attempt to bypass a normal review.', expectedPendingRevision: pendingRevision },
  ), /Only conflicts or reviews needing attention can be dismissed/i);

  assert.equal(documents.get('supplier_review_queue/review-1')?.queueState, 'review_pending');
});

test('dead-letter retry repairs stale queue identity before returning the item to workers', async () => {
  const { db, documents, sourceB } = decisionFixture('dead_letter');

  assert.equal(await retryDeadLetterSupplierReviewQueueItem(db as never, 'review-1', Date.UTC(2026, 6, 26), {
    uid: 'admin-1', email: 'admin@zyro.lk',
  }), true);
  assert.equal(documents.get('supplier_review_queue/review-1')?.queueState, 'queued');
  assert.equal(documents.get('supplier_review_queue/review-1')?.canonicalProductId, 'canonical-product');
  assert.equal(documents.get('supplier_review_queue/review-1')?.supplierOfferId, sourceB.id);
  assert.equal((documents.get('supplier_review_queue/review-1')?.productPayload as StoredDocument).id, 'canonical-product');
});

test('multi-supplier failover continues to select only an eligible approved offer after identity repair', async () => {
  const sourceA = offer('source-a', 100, { reviewStatus: 'approved', stock: 15 });
  const sourceB = offer('source-b', 200, { reviewStatus: 'approved', stock: 0, availability: 'out_of_stock' });
  const { db, documents } = createFakeFirestore({
    'products/canonical-product': { ...canonicalProduct, stock: 8 },
    'product_private/canonical-product': {
      supplierOfferSelection: { activeOfferId: sourceB.id, lockedOfferId: null, failoverEnabled: true },
      supplierMetadata: { activeOfferId: sourceB.id, inventoryLevel: 10 },
    },
    [`supplier_product_offers/${sourceA.id}`]: { ...sourceA },
    [`supplier_product_offers/${sourceB.id}`]: { ...sourceB },
  });

  const result = await reconcileSupplierProductOfferFailover(db as never, 'canonical-product', 'active supplier out of stock');

  assert.equal(result.changed, true);
  assert.equal(result.activeOfferId, sourceA.id);
  assert.equal((documents.get('product_private/canonical-product')?.supplierOfferSelection as StoredDocument).activeOfferId, sourceA.id);
  assert.equal(documents.get('product_private/canonical-product')?.supplierSourceId, 'source-a');
  const audit = [...documents.entries()].find(([key]) => key.startsWith('supplier_operations_audit/'))?.[1];
  const publicCommerce = ((audit?.before as StoredDocument)?.publicCommerce || {}) as StoredDocument;
  assert.equal(Object.values(publicCommerce).includes(undefined), false);
  assert.equal(Object.hasOwn(publicCommerce, 'discount'), false);
});

test('ambiguous selected legacy offer state cannot mutate the public product through failover', async (t) => {
  for (const reviewStatus of ['review_pending', 'rejected'] as const) await t.test(reviewStatus, async () => {
    const legacySelected = offer('source-b', 200, { reviewStatus, stock: 0, availability: 'out_of_stock' });
    const { db, documents } = createFakeFirestore({
      'products/canonical-product': { ...canonicalProduct, price: 450, stock: 8, visible: true },
      'product_private/canonical-product': {
        supplierOfferSelection: { activeOfferId: legacySelected.id, lockedOfferId: null, failoverEnabled: true },
        supplierMetadata: { activeOfferId: legacySelected.id, inventoryLevel: 10 },
      },
      [`supplier_product_offers/${legacySelected.id}`]: { ...legacySelected },
    });

    const result = await reconcileSupplierProductOfferFailover(db as never, 'canonical-product', 'legacy ambiguous state');

    assert.equal(result.changed, false);
    assert.equal(result.activeOfferId, legacySelected.id);
    assert.equal(documents.get('products/canonical-product')?.price, 450);
    assert.equal(documents.get('products/canonical-product')?.stock, 8);
    assert.equal(documents.get('products/canonical-product')?.visible, true);
  });
});

test('queue identity candidate derives the same deterministic offer identity used by synchronization', async () => {
  const { db, transaction, sourceB } = decisionFixture();
  const candidate = getSupplierQueueIdentityCandidate(queueItem());
  const resolved = await resolveSupplierQueueIdentity(db as never, transaction as never, queueItem());

  assert.equal(candidate.deterministicOfferId, sourceB.id);
  assert.equal(resolved.supplierOfferId, sourceB.id);
  assert.equal(resolved.canonicalProductId, 'canonical-product');
});
