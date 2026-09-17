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
} from '../functions/src/api/suppliers/supplierOfferEngine';
import { buildSupplierProductApprovalBaseline } from '../functions/src/api/suppliers/supplierApprovalConcurrency';
import { refreshActiveSupplierReviewItem } from '../functions/src/scheduled/supplierSync';

const requireFunctions = createRequire(import.meta.url);
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
  assert.equal(product.supplierCategory, 'Vehicle Accessories');
  assert.equal(calls.filter((url) => url.includes('/products/')).length, 1);
  assert.equal(calls.some((url) => url.includes('/products/unrelated/dto')), false);
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
    assert.equal(result.item.costPrice, 720);
    assert.equal(result.item.marketPrice, 1650);
    assert.equal(resultPayload.category, 'vehicle-accessories');
    assert.equal(resultPayload.description, 'Fresh supplier description');
    assert.deepEqual(result.item.supplierSnapshot && (result.item.supplierSnapshot as Record<string, unknown>).categoryHierarchy, ['Vehicle Accessories']);
    assert.equal(resultPayload.published, true);
    assert.equal((result.item.productValidation as Record<string, unknown>).readyToPublish, false);
    assert.equal(result.stockAutomated, false);
    assert.equal(refreshedOffer.id, offerId);
    assert.equal(refreshedOffer.productId, null);
    assert.equal(refreshedOffer.cost, 720);
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
            content: Array.from({ length: 100 }, (_, index) => ({
              productDetail: { id: `other-${page}-${index}`, sku: `OTHER-${page}-${index}` },
              price: 720,
            })),
            number: Number(page),
            totalElements: 5_000,
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
  assert.match(connector, /REFRESH_MAX_RECORDS = 2_000/u);
  assert.match(connector, /REFRESH_MAX_ELAPSED_MS = 30_000/u);
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
