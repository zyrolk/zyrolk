import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { adminDb } from '../functions/src/api/firebase';
import { DropexConnectorService } from '../functions/src/api/suppliers/dropex/DropexConnectorService';
import { ProductParser } from '../functions/src/api/suppliers/dropex/ProductParser';
import {
  buildSupplierOfferId,
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
  parseSupplierOfferPendingObservation,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import { buildSupplierProductApprovalBaseline } from '../functions/src/api/suppliers/supplierApprovalConcurrency';
import { refreshActiveSupplierReviewItem } from '../functions/src/scheduled/supplierSync';

const requireFunctions = createRequire(import.meta.url);
const requireFunctionDependencies = createRequire(new URL('../functions/package.json', import.meta.url));
const { GeoPoint, Timestamp } = requireFunctionDependencies('firebase-admin/firestore') as typeof import('firebase-admin/firestore');
const { SupplierRegistry } = requireFunctions('../functions/src/api/suppliers/SupplierRegistry.ts') as typeof import('../functions/src/api/suppliers/SupplierRegistry');

const read = (path: string): string => readFileSync(path, 'utf8');

type FakeDocument = {
  exists: boolean;
  id: string;
  data: () => Record<string, unknown> | undefined;
};

type FakeReference = {
  collectionName: string;
  id: string;
  get: () => Promise<FakeDocument>;
};

type FakeQuery = {
  where: (...args: unknown[]) => FakeQuery;
  select: (...args: unknown[]) => FakeQuery;
  limit: (...args: unknown[]) => FakeQuery;
  get: () => Promise<{ docs: FakeDocument[]; forEach: (callback: (document: FakeDocument) => void) => void }>;
  forEach?: (callback: (document: FakeDocument) => void) => void;
};

type FakeCollection = FakeQuery & {
  doc: (id?: string) => FakeReference;
};

type FakeTransaction = {
  get: (reference: FakeReference) => Promise<FakeDocument>;
  set: (reference: FakeReference, data: Record<string, unknown>, options?: { merge?: boolean }) => void;
  create: (reference: FakeReference, data: Record<string, unknown>) => void;
};

type PatchableAdminDb = {
  collection: (name: string) => FakeCollection;
  batch: () => { set: () => void; create: () => void; update: () => void; delete: () => void; commit: () => Promise<void> };
  runTransaction: (callback: (transaction: FakeTransaction) => Promise<unknown>) => Promise<unknown>;
};

const createFakeAdminDb = () => {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const getCollection = (name: string): Map<string, Record<string, unknown>> => {
    const existing = collections.get(name);
    if (existing) return existing;
    const created = new Map<string, Record<string, unknown>>();
    collections.set(name, created);
    return created;
  };
  const snapshotFor = (name: string, id: string): FakeDocument => {
    const data = getCollection(name).get(id);
    return { exists: Boolean(data), id, data: () => data };
  };
  const queryFor = (name: string): FakeQuery => {
    const query = {} as FakeQuery;
    query.where = () => query;
    query.select = () => query;
    query.limit = () => query;
    query.get = async () => {
      const docs = [...getCollection(name)].map(([id, data]) => ({
        exists: true,
        id,
        data: () => data,
      }));
      return {
        docs,
        forEach: (callback) => docs.forEach(callback),
      };
    };
    query.forEach = (callback) => {
      [...getCollection(name)].forEach(([id, data]) => callback({ exists: true, id, data: () => data }));
    };
    return query;
  };
  const collection = (name: string): FakeCollection => {
    const query = queryFor(name) as FakeCollection;
    query.doc = (id = `generated-${Date.now()}`): FakeReference => ({
      collectionName: name,
      id,
      get: async () => snapshotFor(name, id),
    });
    return query;
  };
  const write = (reference: FakeReference, data: Record<string, unknown>, merge = true): void => {
    const existing = getCollection(reference.collectionName).get(reference.id) || {};
    getCollection(reference.collectionName).set(reference.id, merge ? { ...existing, ...data } : { ...data });
  };
  const db = {
    collections,
    collection,
    batch: () => ({
      set: () => undefined,
      create: () => undefined,
      update: () => undefined,
      delete: () => undefined,
      commit: async () => undefined,
    }),
    runTransaction: async (callback: (transaction: FakeTransaction) => Promise<unknown>) => callback({
      get: (reference) => reference.get(),
      set: (reference, data, options) => write(reference, data, options?.merge !== false),
      create: (reference, data) => write(reference, data, false),
    }),
  };
  return db;
};

const createRefreshGuardFixture = (options: {
  sourceId?: string;
  rawPending?: unknown;
  omitRawPending?: boolean;
  queuePatch?: Record<string, unknown>;
  offerPatch?: Record<string, unknown>;
} = {}) => {
  const db = createFakeAdminDb();
  const queueItemId = 'refresh-legacy-envelope';
  const sourceId = options.sourceId || 'dropex';
  const supplierProductId = '4990';
  const supplierSku = 'AZK1690';
  const offerId = buildSupplierOfferId(sourceId, supplierProductId, supplierSku);
  const observedAt = '2026-09-17T00:00:00.000Z';
  const initialOffer = buildSupplierProductOffer({
    sourceId,
    supplierId: sourceId,
    supplierProductId,
    sku: supplierSku,
    price: 1173,
    cost: 870,
    stock: 8,
    stockKnown: true,
    availability: 'in_stock',
    priority: 100,
    lastSyncAt: observedAt,
    reviewStatus: 'review_pending',
    catalogPayload: { name: 'Legacy AZK1690', costPrice: 870, stock: 8 },
    supplierSnapshot: { supplierProductId, supplierSku, sku: supplierSku },
    timestamp: observedAt,
  });
  const initialPending = buildSupplierOfferPendingObservation({
    offer: initialOffer,
    kind: 'catalog_upsert',
    reviewQueueItemId: queueItemId,
    observedAt,
    traversalId: 'legacy-traversal',
  });
  const queueItem = {
    id: queueItemId,
    queueState: 'review_pending',
    status: 'Pending',
    sourceId,
    supplierId: sourceId,
    supplierCode: supplierSku,
    supplierSnapshot: { sourceId, supplierProductId, supplierSku, sku: supplierSku },
    supplierOfferId: offerId,
    supplierOfferPendingRevision: initialPending.revision,
    productPayload: { name: 'Legacy AZK1690', costPrice: 870, stock: 8 },
    comparisonStatus: 'NEW_PRODUCT',
    comparison: { comparisonStatus: 'NEW_PRODUCT', status: 'NEW_PRODUCT', matchFound: false },
    createdAt: observedAt,
    queueCreatedAt: observedAt,
    ...options.queuePatch,
  };
  const source = {
    supplierId: sourceId,
    supplierName: sourceId === 'dropex' ? 'Dropex' : 'Other supplier',
    connectorType: sourceId,
    supplierType: sourceId,
    sourceStatus: 'active',
    enabled: true,
    websiteUrl: 'https://supplier.example',
    endpoint: '',
    authentication: { credentialProfile: 'test-profile' },
    syncSchedule: 'Off',
  };
  const offer = {
    ...initialOffer,
    stateVersion: 1,
    ...options.offerPatch,
  } as Record<string, unknown>;
  if (!options.omitRawPending) offer.pendingObservation = options.rawPending === undefined
    ? initialPending
    : options.rawPending;

  db.collections.set('supplierSources', new Map([[sourceId, source]]));
  db.collections.set('supplier_settings', new Map([['config', { defaultMarkup: 0, defaultProfitMargin: 0, defaultImageLimit: 10 }]]));
  db.collections.set('categories', new Map([['vehicle-accessories', { name: 'Vehicle Accessories', isActive: true, subcategories: [] }]]));
  db.collections.set('brands', new Map());
  db.collections.set('supplier_product_offers', new Map([[offerId, offer]]));
  db.collections.set('supplier_review_queue', new Map([[queueItemId, queueItem]]));

  return { db, queueItemId, supplierProductId, supplierSku, offerId, initialPending };
};

const withPatchedAdminDb = async <T>(
  db: ReturnType<typeof createFakeAdminDb>,
  action: () => Promise<T>,
): Promise<T> => {
  const patchedDb = adminDb as unknown as PatchableAdminDb;
  const originalCollection = patchedDb.collection;
  const originalBatch = patchedDb.batch;
  const originalRunTransaction = patchedDb.runTransaction;
  try {
    patchedDb.collection = db.collection;
    patchedDb.batch = db.batch;
    patchedDb.runTransaction = db.runTransaction;
    return await action();
  } finally {
    patchedDb.collection = originalCollection;
    patchedDb.batch = originalBatch;
    patchedDb.runTransaction = originalRunTransaction;
  }
};

const response = (body: unknown, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(),
  text: async () => JSON.stringify(body),
  json: async <T>() => body as T,
});

const jwtForAccount = (accountId: string): string => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ account: { id: accountId }, exp: Math.floor(Date.now() / 1000) + 3_600 })}.signature`;
};

test('pending observations canonicalize optional nested values before revision generation and persistence', () => {
  const observedAt = '2026-09-18T10:55:26.359Z';
  const timestamp = Timestamp.fromMillis(Date.parse('2026-09-18T10:00:00.123Z'));
  const date = new Date('2026-09-18T10:01:00.456Z');
  const geoPoint = new GeoPoint(6.9271, 79.8612);
  const bytes = Buffer.from([0, 1, 2, 254, 255]);
  const offer = buildSupplierProductOffer({
    sourceId: 'dropex',
    supplierId: 'dropex',
    supplierProductId: '4502',
    sku: 'AZK1571',
    barcode: '',
    price: 4_750,
    cost: 4_050,
    stock: 4,
    stockKnown: true,
    availability: 'in_stock',
    priority: 100,
    health: {
      available: true,
      retryCount: 0,
      optionalMessage: undefined,
    },
    lastSyncAt: observedAt,
    reviewStatus: 'review_pending',
    catalogPayload: {
      name: 'R19 Pro Gaming Earbuds',
      price: 4_750,
      costPrice: 4_050,
      stock: 4,
      isActive: false,
      category: '',
      supplierCategory: 'Speakers/Blutooth/Headset',
      optionalBrand: undefined,
      nested: {
        numericZero: 0,
        booleanFalse: false,
        emptyString: '',
        nullValue: null,
        optionalValue: undefined,
      },
      values: [0, false, '', undefined, { retained: true, optionalValue: undefined }],
      firestoreValues: { timestamp, date, geoPoint, bytes },
    },
    supplierSnapshot: {
      supplierProductId: '4502',
      supplierSku: 'AZK1571',
      brand: undefined,
      specifications: {
        ProductType: undefined,
        StockManaged: false,
      },
    },
    timestamp: observedAt,
  });
  const pending = buildSupplierOfferPendingObservation({
    offer,
    kind: 'catalog_upsert',
    reviewQueueItemId: 'dropex-azk1571',
    observedAt,
    traversalId: 'review-refresh-regression',
  });
  const queueRevision = pending.revision;
  const persisted = {
    ...pending,
    effective: {
      ...pending.effective,
      catalogPayload: {
        ...pending.effective.catalogPayload,
        firestoreValues: {
          timestamp: Timestamp.fromMillis(timestamp.toMillis()),
          // Firestore stores a JavaScript Date and returns a Timestamp.
          date: Timestamp.fromDate(date),
          geoPoint: new GeoPoint(geoPoint.latitude, geoPoint.longitude),
          bytes: Buffer.from(bytes),
        },
      },
    },
  };
  const parsed = parseSupplierOfferPendingObservation(persisted);

  assert.ok(parsed);
  assert.equal(queueRevision, pending.revision);
  assert.equal(parsed.revision, pending.revision);
  assert.deepEqual(parsed.effective, persisted.effective);
  assert.equal(pending.effective.price, 4_750);
  assert.equal(pending.effective.cost, 4_050);
  assert.equal(pending.effective.stock, 4);
  assert.equal(pending.effective.stockKnown, true);
  assert.equal(pending.effective.catalogPayload.isActive, false);
  assert.equal(pending.effective.catalogPayload.category, '');
  assert.equal(Object.hasOwn(pending.effective.catalogPayload, 'optionalBrand'), false);
  assert.equal(Object.hasOwn(pending.effective.health, 'optionalMessage'), false);
  assert.deepEqual(pending.effective.catalogPayload.nested, {
    numericZero: 0,
    booleanFalse: false,
    emptyString: '',
    nullValue: null,
  });
  assert.deepEqual(pending.effective.catalogPayload.values, [0, false, '', { retained: true }]);
  const firestoreValues = pending.effective.catalogPayload.firestoreValues as Record<string, unknown>;
  assert.strictEqual(firestoreValues.timestamp, timestamp);
  assert.strictEqual(firestoreValues.date, date);
  assert.strictEqual(firestoreValues.geoPoint, geoPoint);
  assert.strictEqual(firestoreValues.bytes, bytes);
  assert.deepEqual(pending.effective.supplierSnapshot.specifications, { StockManaged: false });
});

test('Dropex exact refresh reads raw reseller price before enriching only the exact row', async () => {
  const calls: string[] = [];
  const service = new DropexConnectorService(
    { supplierId: 'dropex', sourceId: 'dropex', credentialReference: 'test-profile' },
    {
      fetchOutbound: async (url) => {
        calls.push(url);
        if (url.includes('/auth/login')) return response({ access_token: jwtForAccount('reseller-1') });
        if (url.includes('/re-seller-products/get')) {
          return response({
            content: [
              { productDetail: { id: 'unrelated', sku: 'OTHER-1', name: 'Other' }, price: 999 },
              { productDetail: { id: '4970', sku: 'SHX2924', productCategoryId: 29, name: 'Target' }, price: 720 },
            ],
            last: true,
          });
        }
        if (url.includes('/product-categories')) return response([{ id: 29, name: 'Vehicle Accessories' }]);
        if (url.includes('/products/4970/dto')) {
          return response({ data: { description: 'Current description', sellingPrice: 1400, onHandInventory: 1 } });
        }
        throw new Error(`Unexpected supplier endpoint in exact refresh test: ${url}`);
      },
    },
  );

  const product = await service.fetchExactProductForRefresh(
    { username: 'test-user', password: 'test-password' },
    { approvedHosts: ['inventory.dropex.lk', 'user.dropex.lk'], connector: 'dropex' },
    { supplierProductId: '4970', sku: 'SHX2924' },
  );

  assert.equal(product.supplierProductId, '4970');
  assert.equal(product.sku, 'SHX2924');
  assert.equal(product.wholesalePrice, 720);
  assert.equal(product.recommendedRetailPrice, 1400);
  assert.equal(product.price, 1400);
  assert.equal(product.supplierCategory, 'Vehicle Accessories');
  assert.equal(calls.filter((url) => url.includes('/products/')).length, 1);
  assert.equal(calls.some((url) => url.includes('/products/unrelated/dto')), false);
});

test('Dropex exact refresh uses 500-row pages to find a target beyond 3,000 records', async () => {
  const cataloguePages: number[] = [];
  const dtoCalls: string[] = [];
  const service = new DropexConnectorService(
    { supplierId: 'dropex', sourceId: 'dropex', credentialReference: 'test-profile' },
    {
      fetchOutbound: async (url) => {
        if (url.includes('/auth/login')) return response({ access_token: jwtForAccount('reseller-1') });
        if (url.includes('/re-seller-products/get')) {
          const page = Number(new URL(url).searchParams.get('page') || '0');
          const size = Number(new URL(url).searchParams.get('size') || '0');
          assert.equal(size, 500);
          cataloguePages.push(page);
          const content: Array<{ productDetail: { id: string; sku: string; name?: string }; price: number }> = Array.from({ length: 500 }, (_, index) => ({
            productDetail: { id: `other-${page}-${index}`, sku: `OTHER-${page}-${index}` },
            price: 720,
          }));
          if (page === 6) {
            content[0] = {
              productDetail: { id: '4990', sku: 'AZK1690', name: 'Target' },
              price: 870,
            };
          }
          return response({ content, number: page, totalElements: 8_038, last: false });
        }
        if (url.includes('/product-categories')) return response([{ id: 29, name: 'Vehicle Accessories' }]);
        if (url.includes('/products/4990/dto')) {
          dtoCalls.push(url);
          return response({ data: { description: 'Current description', sellingPrice: 1650, onHandInventory: 8 } });
        }
        throw new Error(`Unexpected supplier endpoint in deep refresh test: ${url}`);
      },
    },
  );

  const product = await service.fetchExactProductForRefresh(
    { username: 'test-user', password: 'test-password' },
    { approvedHosts: ['inventory.dropex.lk', 'user.dropex.lk'], connector: 'dropex' },
    { supplierProductId: '4990', sku: 'AZK1690' },
  );

  assert.deepEqual(cataloguePages, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(product.supplierProductId, '4990');
  assert.equal(product.sku, 'AZK1690');
  assert.equal(product.wholesalePrice, 870);
  assert.equal(product.recommendedRetailPrice, 1650);
  assert.equal(product.price, 1650);
  assert.deepEqual(dtoCalls.map((url) => new URL(url).pathname), ['/api/v1/products/4990/dto']);
});

test('active NEW_PRODUCT refresh reuses the review and offer without creating a canonical product', async () => {
  const db = createFakeAdminDb();
  const patchedDb = adminDb as unknown as PatchableAdminDb;
  const originalCollection = patchedDb.collection;
  const originalBatch = patchedDb.batch;
  const originalRunTransaction = patchedDb.runTransaction;
  const originalCreateConnector = SupplierRegistry.createConnectorForSourceRecord;
  const queueItemId = 'refresh-new-product-no-canonical';
  const supplierProductId = '4990';
  const supplierSku = 'AZK1690';
  const offerId = buildSupplierOfferId('dropex', supplierProductId, supplierSku);
  const plannedProductId = 'pending-azk1690';
  const observedAt = '2026-09-17T00:00:00.000Z';
  const source = {
    supplierId: 'dropex',
    supplierName: 'Dropex',
    connectorType: 'dropex',
    supplierType: 'dropex',
    sourceStatus: 'active',
    enabled: true,
    websiteUrl: 'https://inventory.dropex.lk',
    endpoint: '',
    authentication: { credentialProfile: 'test-profile' },
    syncSchedule: 'Off',
  };
  const initialOffer = buildSupplierProductOffer({
    sourceId: 'dropex',
    supplierId: 'dropex',
    supplierProductId,
    sku: supplierSku,
    price: 900,
    cost: 450,
    stock: 8,
    stockKnown: true,
    availability: 'in_stock',
    priority: 100,
    lastSyncAt: observedAt,
    reviewStatus: 'review_pending',
    catalogPayload: { name: 'Old AZK1690', costPrice: 450, stock: 8 },
    supplierSnapshot: { supplierProductId, supplierSku, sku: supplierSku },
    timestamp: observedAt,
  });
  const initialPending = buildSupplierOfferPendingObservation({
    offer: initialOffer,
    kind: 'catalog_upsert',
    reviewQueueItemId: queueItemId,
    observedAt,
    traversalId: 'old-traversal',
  });
  const queueItem = {
    id: queueItemId,
    queueState: 'review_pending',
    status: 'Pending',
    sourceId: 'dropex',
    supplierId: 'dropex',
    supplierCode: supplierSku,
    supplierSnapshot: { sourceId: 'dropex', supplierProductId, supplierSku, sku: supplierSku },
    supplierOfferId: offerId,
    supplierOfferPendingRevision: initialPending.revision,
    productPayload: { name: 'Old AZK1690', costPrice: 450, stock: 8 },
    comparisonStatus: 'NEW_PRODUCT',
    comparison: { comparisonStatus: 'NEW_PRODUCT', status: 'NEW_PRODUCT', matchFound: false },
    approvalBaseline: buildSupplierProductApprovalBaseline(plannedProductId, undefined, observedAt),
    createdAt: observedAt,
    queueCreatedAt: observedAt,
  };
  const freshProduct = {
    supplierProductId,
    sku: supplierSku,
    title: 'Fresh AZK1690',
    longDescription: 'Fresh supplier description',
    mediaGallery: ['https://supplier.example/azk1690.jpg'],
    wholesalePrice: 720,
    recommendedRetailPrice: 1650,
    price: 1650,
    inventoryLevel: 8,
    availability: 'in_stock',
    supplierCategory: 'Vehicle Accessories',
    categoryHierarchy: ['Vehicle Accessories'],
    specifications: { Model: 'AZK1690' },
    providedFields: [
      'costPrice', 'wholesalePrice', 'stock', 'inventoryLevel', 'title', 'longDescription',
      'mediaGallery', 'price', 'comparePrice', 'categoryHierarchy', 'specifications',
    ],
  };
  db.collections.set('supplierSources', new Map([['dropex', source]]));
  db.collections.set('supplier_settings', new Map([['config', { defaultMarkup: 0, defaultProfitMargin: 0, defaultImageLimit: 10 }]]));
  db.collections.set('categories', new Map([['vehicle-accessories', { name: 'Vehicle Accessories', isActive: true, subcategories: [] }]]));
  db.collections.set('supplier_product_offers', new Map([[offerId, {
    ...initialOffer,
    stateVersion: 1,
    pendingObservation: initialPending,
  }]]));
  db.collections.set('supplier_review_queue', new Map([[queueItemId, queueItem]]));

  let lookupTarget: { supplierProductId: string; sku: string } | null = null;
  try {
    patchedDb.collection = db.collection;
    patchedDb.batch = db.batch;
    patchedDb.runTransaction = db.runTransaction;
    SupplierRegistry.createConnectorForSourceRecord = async () => ({
      id: 'dropex',
      name: 'Dropex',
      connectorType: 'dropex',
      enabled: true,
      priority: 100,
      capabilities: [],
      fetchProducts: async () => ({ products: [], targetUrl: '' }),
      fetchProductPage: async () => ({ products: [], targetUrl: '', nextCursor: null, complete: true }),
      testConnection: async () => ({ success: true, status: 'Connected', productsCount: 0, sampleProduct: null }),
      fetchExactProductForRefresh: async (target: { supplierProductId: string; sku: string }) => {
        lookupTarget = target;
        return freshProduct;
      },
    } as never);

    const result = await refreshActiveSupplierReviewItem(queueItemId);
    const resultComparison = result.item.comparison as Record<string, unknown>;
    const resultPayload = result.item.productPayload as Record<string, unknown>;
    const refreshedOffer = db.collections.get('supplier_product_offers')?.get(offerId) as Record<string, unknown>;
    const refreshedPending = refreshedOffer.pendingObservation as Record<string, unknown>;

    assert.equal(result.queueItemId, queueItemId);
    assert.deepEqual(lookupTarget, { supplierProductId, sku: supplierSku });
    assert.equal(result.item.comparisonStatus, 'NEW_PRODUCT');
    assert.equal(resultComparison.matchFound, false);
    assert.equal(result.item.matchedProductId, null);
    assert.equal(result.item.canonicalProductId, undefined);
    assert.equal(result.item.productId, undefined);
    assert.equal(resultPayload.name, 'Fresh AZK1690');
    assert.equal(resultPayload.costPrice, 720);
    assert.equal(resultPayload.price, 1650);
    assert.equal(result.item.costPrice, 720);
    assert.equal(result.item.marketPrice, 0);
    assert.equal(resultPayload.category, 'vehicle-accessories');
    assert.equal(resultPayload.description, 'Fresh supplier description');
    assert.deepEqual(result.item.supplierSnapshot && (result.item.supplierSnapshot as Record<string, unknown>).categoryHierarchy, ['Vehicle Accessories']);
    assert.equal(resultPayload.published, true);
    assert.equal(Object.hasOwn(resultPayload, 'originalPrice'), false);
    assert.equal(Object.hasOwn(resultPayload, 'discount'), false);
    assert.equal((result.item.productValidation as Record<string, unknown>).readyToPublish, true);
    assert.equal(result.stockAutomated, false);
    assert.equal(refreshedOffer.id, offerId);
    assert.equal(refreshedOffer.productId, null);
    assert.equal(refreshedOffer.cost, 720);
    assert.equal(refreshedOffer.price, 1650);
    assert.equal(refreshedOffer.reviewStatus, 'review_pending');
    assert.equal(refreshedPending.reviewQueueItemId, queueItemId);
    assert.notEqual(refreshedPending.revision, initialPending.revision);
    assert.equal(db.collections.get('products')?.size || 0, 0);
    assert.equal(db.collections.get('product_private')?.size || 0, 0);
    assert.equal(db.collections.get('supplier_sync_jobs')?.size || 0, 0);
    assert.equal(db.collections.get('supplier_import_queue')?.size || 0, 0);
    assert.deepEqual(db.collections.get('supplierSources')?.get('dropex'), source);
  } finally {
    patchedDb.collection = originalCollection;
    patchedDb.batch = originalBatch;
    patchedDb.runTransaction = originalRunTransaction;
    SupplierRegistry.createConnectorForSourceRecord = originalCreateConnector;
  }
});

test('legacy stale canonical revision still authorizes one fresh refresh in place', async () => {
  const fixture = createRefreshGuardFixture();
  const stalePending = {
    ...fixture.initialPending,
    effective: { ...fixture.initialPending.effective, price: fixture.initialPending.effective.price - 1 },
  };
  const offer = fixture.db.collections.get('supplier_product_offers')?.get(fixture.offerId);
  assert.ok(offer);
  offer.pendingObservation = stalePending;
  assert.equal(parseSupplierOfferPendingObservation(stalePending), null);

  const freshProduct = {
    supplierProductId: fixture.supplierProductId,
    sku: fixture.supplierSku,
    title: 'Fresh AZK1690',
    longDescription: 'Fresh supplier description',
    mediaGallery: ['https://supplier.example/azk1690.jpg'],
    wholesalePrice: 720,
    recommendedRetailPrice: 1650,
    price: 1650,
    inventoryLevel: 8,
    availability: 'in_stock',
    supplierCategory: 'Vehicle Accessories',
    categoryHierarchy: ['Vehicle Accessories'],
    specifications: { Model: 'AZK1690' },
    providedFields: ['costPrice', 'wholesalePrice', 'stock', 'inventoryLevel', 'title', 'longDescription', 'mediaGallery', 'price', 'comparePrice', 'categoryHierarchy', 'specifications'],
  };
  const originalCreateConnector = SupplierRegistry.createConnectorForSourceRecord;
  let lookupCount = 0;
  try {
    SupplierRegistry.createConnectorForSourceRecord = async () => ({
      id: 'dropex',
      name: 'Dropex',
      connectorType: 'dropex',
      enabled: true,
      priority: 100,
      capabilities: [],
      fetchProducts: async () => ({ products: [], targetUrl: '' }),
      fetchProductPage: async () => ({ products: [], targetUrl: '', nextCursor: null, complete: true }),
      testConnection: async () => ({ success: true, status: 'Connected', productsCount: 0, sampleProduct: null }),
      fetchExactProductForRefresh: async (target: { supplierProductId: string; sku: string }) => {
        assert.deepEqual(target, { supplierProductId: fixture.supplierProductId, sku: fixture.supplierSku });
        lookupCount += 1;
        return freshProduct;
      },
    } as never);

    const result = await withPatchedAdminDb(fixture.db, () => refreshActiveSupplierReviewItem(fixture.queueItemId));
    const refreshedOffer = fixture.db.collections.get('supplier_product_offers')?.get(fixture.offerId) as Record<string, unknown>;
    const refreshedPending = refreshedOffer.pendingObservation as Record<string, unknown>;
    const refreshedPayload = result.item.productPayload as Record<string, unknown>;

    assert.equal(lookupCount, 1);
    assert.equal(result.queueItemId, fixture.queueItemId);
    assert.equal(result.item.supplierOfferId, fixture.offerId);
    assert.equal(refreshedPayload.costPrice, 720);
    assert.equal(refreshedPayload.price, 1650);
    assert.equal(refreshedOffer.cost, 720);
    assert.equal(refreshedOffer.price, 1650);
    assert.equal(result.item.marketPrice, 0);
    assert.equal(refreshedPending.reviewQueueItemId, fixture.queueItemId);
    assert.notEqual(refreshedPending.revision, stalePending.revision);
    assert.equal(fixture.db.collections.get('products')?.size || 0, 0);
  } finally {
    SupplierRegistry.createConnectorForSourceRecord = originalCreateConnector;
  }
});

test('legacy refresh compatibility remains fail closed for invalid envelopes and identities', async () => {
  const cases: Array<{
    name: string;
    fixture: ReturnType<typeof createRefreshGuardFixture>;
    error: RegExp;
  }> = [
    {
      name: 'missing raw pending observation',
      fixture: createRefreshGuardFixture({ omitRawPending: true }),
      error: /current pending supplier observation/u,
    },
    {
      name: 'raw pending queue mismatch',
      fixture: createRefreshGuardFixture({ rawPending: {
        ...createRefreshGuardFixture().initialPending,
        reviewQueueItemId: 'different-queue-item',
      } }),
      error: /current pending supplier observation/u,
    },
    {
      name: 'raw pending revision mismatch',
      fixture: createRefreshGuardFixture({ rawPending: {
        ...createRefreshGuardFixture().initialPending,
        revision: 'different-revision',
      } }),
      error: /current pending supplier observation/u,
    },
    {
      name: 'raw pending revision empty',
      fixture: createRefreshGuardFixture({ rawPending: {
        ...createRefreshGuardFixture().initialPending,
        revision: '',
      } }),
      error: /current pending supplier observation/u,
    },
    {
      name: 'raw pending revision malformed',
      fixture: createRefreshGuardFixture({ rawPending: {
        ...createRefreshGuardFixture().initialPending,
        revision: 123,
      } }),
      error: /current pending supplier observation/u,
    },
    {
      name: 'supplier offer identity mismatch',
      fixture: createRefreshGuardFixture({ offerPatch: { sku: 'OTHER-SKU' } }),
      error: /identities are inconsistent/u,
    },
    {
      name: 'non-Dropex source',
      fixture: createRefreshGuardFixture({ sourceId: 'a2z' }),
      error: /supported only for Dropex reviews/u,
    },
    {
      name: 'non-review-pending queue',
      fixture: createRefreshGuardFixture({ queuePatch: { queueState: 'approved' } }),
      error: /Only an active supplier review_pending item can be refreshed/u,
    },
  ];

  for (const testCase of cases) {
    await withPatchedAdminDb(testCase.fixture.db, async () => {
      await assert.rejects(
        refreshActiveSupplierReviewItem(testCase.fixture.queueItemId),
        testCase.error,
        testCase.name,
      );
    });
  }
});

test('Dropex commercial parser never falls back to DTO price aliases for fulfillment cost', () => {
  const parsed = ProductParser.parseCatalogItem({
    productDetail: { id: '4970', sku: 'SHX2924', sellingPrice: 1400 },
    buyingPrice: 410,
    reSellingPrice: 720,
  });
  assert.equal(parsed.wholesalePrice, 0);
  assert.equal(parsed.recommendedRetailPrice, 1400);
});

test('Dropex exact refresh rejects duplicate identities before any enrichment', async () => {
  const calls: string[] = [];
  const service = new DropexConnectorService(
    { supplierId: 'dropex', sourceId: 'dropex', credentialReference: 'test-profile' },
    {
      fetchOutbound: async (url) => {
        calls.push(url);
        if (url.includes('/auth/login')) return response({ access_token: jwtForAccount('reseller-1') });
        if (url.includes('/re-seller-products/get')) {
          return response({
            content: [
              { productDetail: { id: '4970', sku: 'SHX2924' }, price: 720 },
              { productDetail: { id: '4970', sku: 'SHX2924' }, price: 720 },
            ],
            last: true,
          });
        }
        throw new Error(`Unexpected enrichment request for ambiguous identity: ${url}`);
      },
    },
  );

  await assert.rejects(
    service.fetchExactProductForRefresh(
      { username: 'test-user', password: 'test-password' },
      { approvedHosts: ['inventory.dropex.lk', 'user.dropex.lk'], connector: 'dropex' },
      { supplierProductId: '4970', sku: 'SHX2924' },
    ),
    /multiple catalogue rows/u,
  );
  assert.equal(calls.filter((url) => url.includes('/products/')).length, 0);
  assert.equal(calls.some((url) => url.includes('/product-categories')), false);
});

test('Dropex exact refresh fails closed at its page and record bounds when the target is absent', async () => {
  const catalogCalls: string[] = [];
  const service = new DropexConnectorService(
    { supplierId: 'dropex', sourceId: 'dropex', credentialReference: 'test-profile' },
    {
      fetchOutbound: async (url) => {
        if (url.includes('/auth/login')) return response({ access_token: jwtForAccount('reseller-1') });
        if (url.includes('/re-seller-products/get')) {
          const page = new URL(url).searchParams.get('page') || '0';
          catalogCalls.push(page);
          return response({
            content: Array.from({ length: 500 }, (_, index) => ({
              productDetail: { id: `other-${page}-${index}`, sku: `OTHER-${page}-${index}` },
              price: 720,
            })),
            number: Number(page),
            totalElements: 50_000,
            last: false,
          });
        }
        throw new Error(`Unexpected enrichment request for absent identity: ${url}`);
      },
    },
  );

  await assert.rejects(
    service.fetchExactProductForRefresh(
      { username: 'test-user', password: 'test-password' },
      { approvedHosts: ['inventory.dropex.lk', 'user.dropex.lk'], connector: 'dropex' },
      { supplierProductId: '4970', sku: 'SHX2924' },
    ),
    /within the refresh bounds/u,
  );
  assert.equal(catalogCalls.length, 20);
  assert.equal(catalogCalls.at(-1), '19');
});

test('Dropex exact refresh fails closed at the 10,000-record cap', async () => {
  const catalogCalls: string[] = [];
  const service = new DropexConnectorService(
    { supplierId: 'dropex', sourceId: 'dropex', credentialReference: 'test-profile' },
    {
      fetchOutbound: async (url) => {
        if (url.includes('/auth/login')) return response({ access_token: jwtForAccount('reseller-1') });
        if (url.includes('/re-seller-products/get')) {
          const page = new URL(url).searchParams.get('page') || '0';
          catalogCalls.push(page);
          return response({
            content: Array.from({ length: 1_001 }, (_, index) => ({
              productDetail: { id: `other-${page}-${index}`, sku: `OTHER-${page}-${index}` },
              price: 720,
            })),
            number: Number(page),
            totalElements: 50_000,
            last: false,
          });
        }
        throw new Error(`Unexpected enrichment request for record-bound test: ${url}`);
      },
    },
  );

  await assert.rejects(
    service.fetchExactProductForRefresh(
      { username: 'test-user', password: 'test-password' },
      { approvedHosts: ['inventory.dropex.lk', 'user.dropex.lk'], connector: 'dropex' },
      { supplierProductId: '4970', sku: 'SHX2924' },
    ),
    /exceeded its record bound/u,
  );
  assert.equal(catalogCalls.length, 10);
  assert.equal(catalogCalls.at(-1), '9');
});

test('Dropex exact refresh fails closed at the 30-second elapsed-time cap', async () => {
  const catalogCalls: string[] = [];
  let now = 0;
  const service = new DropexConnectorService(
    { supplierId: 'dropex', sourceId: 'dropex', credentialReference: 'test-profile' },
    {
      now: () => now,
      fetchOutbound: async (url) => {
        if (url.includes('/auth/login')) return response({ access_token: jwtForAccount('reseller-1') });
        if (url.includes('/re-seller-products/get')) {
          catalogCalls.push(new URL(url).searchParams.get('page') || '0');
          now = 30_000;
          return response({
            content: Array.from({ length: 500 }, (_, index) => ({
              productDetail: { id: `other-${index}`, sku: `OTHER-${index}` },
              price: 720,
            })),
            number: 0,
            totalElements: 50_000,
            last: false,
          });
        }
        throw new Error(`Unexpected enrichment request for time-bound test: ${url}`);
      },
    },
  );

  await assert.rejects(
    service.fetchExactProductForRefresh(
      { username: 'test-user', password: 'test-password' },
      { approvedHosts: ['inventory.dropex.lk', 'user.dropex.lk'], connector: 'dropex' },
      { supplierProductId: '4970', sku: 'SHX2924' },
    ),
    /exceeded its time bound/u,
  );
  assert.deepEqual(catalogCalls, ['0']);
});

test('normal Dropex catalogue traversal keeps its caller-provided page size', async () => {
  const calls: string[] = [];
  const service = new DropexConnectorService(
    { supplierId: 'dropex', sourceId: 'dropex', credentialReference: 'test-profile' },
    {
      fetchOutbound: async (url) => {
        calls.push(url);
        if (url.includes('/auth/login')) return response({ access_token: jwtForAccount('reseller-1') });
        if (url.includes('/re-seller-products/get')) {
          assert.equal(new URL(url).searchParams.get('size'), '100');
          return response({ content: [], last: true });
        }
        if (url.includes('/product-categories')) return response([]);
        throw new Error(`Unexpected supplier endpoint in normal traversal test: ${url}`);
      },
    },
  );

  await service.fetchCatalogPage(
    { username: 'test-user', password: 'test-password' },
    { approvedHosts: ['inventory.dropex.lk', 'user.dropex.lk'], connector: 'dropex' },
    { cursor: '0', pageSize: 100 },
  );

  assert.equal(calls.filter((url) => url.includes('/re-seller-products/get')).length, 1);
});

test('refresh route and sync helper are identity-bound, bounded, and use the current review pipeline', () => {
  const routes = read('functions/src/api/routes/supplier.ts');
  const sync = read('functions/src/scheduled/supplierSync.ts');
  const connector = read('functions/src/api/suppliers/dropex/DropexConnectorService.ts');

  assert.match(routes, /app\.post\("\/api\/supplier-review-queue\/:queueItemId\/refresh", requireSupplierHubAdmin/u);
  assert.match(routes, /refreshActiveSupplierReviewItem\(queueItemId, reviewerFor\(res\)\)/u);
  assert.match(sync, /Only an active supplier review_pending item can be refreshed/u);
  assert.match(sync, /reviewRecordIsTerminalDecision\(queueItem\)/u);
  assert.match(sync, /refreshReviewIsNewProduct\(queueItem\)/u);
  assert.match(sync, /buildSupplierOfferId\(sourceId, supplierProductId, supplierSku\)/u);
  assert.match(sync, /The canonical product for this review item could not be found/u);
  assert.match(sync, /buildSupplierProductComparison\(\s*product,\s*currentProduct \? \{ \.\.\.currentProduct \} : undefined/u);
  assert.match(sync, /buildProductPayload\(/u);
  assert.match(sync, /planSupplierTaxonomyCandidates\(/u);
  assert.match(sync, /stageSupplierOfferObservation\(/u);
  assert.match(sync, /commitQueuedItems\(queuedWrites\)/u);
  assert.match(connector, /REFRESH_MAX_PAGES = 20/u);
  assert.match(connector, /REFRESH_MAX_RECORDS = 10_000/u);
  assert.match(connector, /REFRESH_MAX_ELAPSED_MS = 30_000/u);
  assert.match(connector, /REFRESH_PAGE_SIZE = 500/u);
  assert.match(connector, /const pageSize = Math\.max\(1, request\.pageSize\)/u);
  assert.match(connector, /catalogUrl\.searchParams\.set\("size", String\(pageSize\)\)/u);
  assert.match(connector, /productId !== expectedProductId \|\| sku !== expectedSku/u);
  assert.match(connector, /ProductParser\.parseCatalogItem\(match, \{ categoryLookup, enrichment \}\)/u);
});

test('supplier review refresh UI is visible only for eligible Dropex reviews and cannot approve automatically', () => {
  const modal = read('src/components/SupplierReviewEditorModal.tsx');
  const hub = read('src/components/SupplierHubFiveStars.tsx');

  assert.match(modal, /Refresh from Supplier/u);
  assert.match(modal, /Refreshing…/u);
  assert.match(modal, /refreshEligible && onRefreshSupplier/u);
  assert.match(hub, /state === 'review_pending'/u);
  assert.match(hub, /connector === 'dropex' \|\| source === 'dropex'/u);
  assert.match(hub, /\/refresh`/u);
  assert.match(hub, /No approval or publication was performed/u);
  assert.doesNotMatch(hub.slice(hub.indexOf('const handleRefreshSupplierReviewItem'), hub.indexOf('const handleRetryDeadLetterMedia')), /decideSupplierReviewQueueItem/u);
});

test('supplier review refresh reconciles the modal and list immediately with one request and visible result', () => {
  const modal = read('src/components/SupplierReviewEditorModal.tsx');
  const hub = read('src/components/SupplierHubFiveStars.tsx');
  const start = hub.indexOf('const handleRefreshSupplierReviewItem');
  const end = hub.indexOf('const handleRetryDeadLetterMedia', start);
  const handler = hub.slice(start, end);
  assert.ok(start >= 0 && end > start);

  assert.equal((handler.match(/postSupplierApi\(/gu) || []).length, 1);
  assert.match(handler, /refreshingReviewItemIdRef\.current/u);
  assert.match(handler, /setReviewQueue\(\(current\) => current\.map\(.*refreshedItem/su);
  assert.match(handler, /setEditingReviewItem\(refreshedItem\)/u);
  assert.match(handler, /showRefreshFeedback\(\{ kind: 'success', message: refreshMessage \}\)/u);
  assert.match(handler, /showRefreshFeedback\(\{ kind: 'error', message: refreshMessage \}\)/u);
  assert.match(handler, /finally \{[\s\S]*setRefreshingReviewItemId\(null\)/u);
  assert.ok(handler.indexOf('setReviewQueue((current)') < handler.indexOf('setRefreshingReviewItemId(null)'));
  assert.ok(handler.indexOf('setRefreshingReviewItemId(null)') < handler.indexOf('showRefreshFeedback({ kind: \'success\''));
  assert.match(handler, /void Promise\.all\(\[loadSupplierOffers\(refreshedItem\), refreshSupplierQueueViews\(\)\]\)/u);
  assert.doesNotMatch(handler, /window\.location\.reload|decideSupplierReviewQueueItem/u);

  assert.match(modal, /refreshFeedback\?: \{ kind: 'success' \| 'error'; message: string \} \| null/u);
  assert.match(modal, /role=\{refreshFeedback\.kind === 'error' \? 'alert' : 'status'\}/u);
  assert.match(modal, /\{refreshFeedback\.message\}/u);
  assert.match(modal, /if \(refreshFeedback\?\.kind === 'success'\)/u);
  assert.match(modal, /if \(refreshFeedback\?\.kind === 'success'\) \{[\s\S]*setSubmitted\(false\)/u);
  assert.match(hub, /refreshFeedback=\{refreshFeedback\}/u);
});
