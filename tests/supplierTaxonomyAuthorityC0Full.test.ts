import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SupplierReviewEditorModal from '../src/components/SupplierReviewEditorModal';
import {
  createSupplierReviewDraft,
  updateSupplierReviewDraftField,
  validateSupplierReviewDraft,
} from '../src/services/supplierReviewEditor';
import {
  supplierReviewCanQuickApprove,
  supplierReviewRawMetadata,
} from '../src/services/supplierHubPresentation';
import {
  decideSupplierQueueItem,
  hasLegacySupplierDerivedReviewTaxonomy,
  toPublicProductPayload,
} from '../functions/src/api/suppliers/supplierApproval';
import { buildSupplierProductApprovalBaseline } from '../functions/src/api/suppliers/supplierApprovalConcurrency';
import {
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
} from '../functions/src/api/suppliers/supplierOfferEngine';
import { ProductParser } from '../functions/src/api/suppliers/dropex/ProductParser';
import {
  buildSupplierTaxonomyMetadata,
  supplierChildMappingDocumentId,
  supplierMappingDocumentId,
  validateSupplierProductForApproval,
} from '../functions/src/api/suppliers/supplierProductMapping';
import { buildProductPayload } from '../functions/src/scheduled/supplierSync';
import {
  classifySupplierReviewRecordForCounts,
  listSupplierQueuePage,
  projectSupplierReviewLowStockHold,
  reviewRecordMatchesBusinessFilter,
} from '../functions/src/scheduled/supplierReviewQueue';

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

const projectFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const SUPPLIER_CATEGORY = 'Supplier Audio';
const SUPPLIER_SUBCATEGORY = 'Supplier Buds';

const createFakeFirestore = (initial: Record<string, StoredDocument>) => {
  const documents = new Map<string, StoredDocument>(Object.entries(initial));
  const writes: Array<{ operation: 'set' | 'create' | 'update' | 'delete'; key: string; data?: StoredDocument }> = [];
  const reads: string[] = [];
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
    reads.push(reference.key);
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
  return { db, documents, writes, reads };
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

const offer = (sourceId: string, priority: number) => buildSupplierProductOffer({
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

const supplierSnapshot = {
  sourceId: 'source-b',
  supplierId: 'supplier-b',
  supplierProductId: 'source-b-item',
  supplierSku: 'source-b-sku',
  supplierCategory: SUPPLIER_CATEGORY,
  supplierSubcategory: SUPPLIER_SUBCATEGORY,
  categoryHierarchy: [SUPPLIER_CATEGORY, SUPPLIER_SUBCATEGORY],
};

const updateQueueItem = (pendingRevision: string): StoredDocument => ({
  status: 'Pending',
  queueState: 'review_pending',
  sourceId: 'source-b',
  supplierCode: 'source-b-sku',
  canonicalProductId: 'stale-product',
  productId: 'stale-product',
  supplierOfferId: offer('source-a', 100).id,
  supplierOfferPendingRevision: pendingRevision,
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
  categoryMapping: buildSupplierTaxonomyMetadata({ supplierCategories: [SUPPLIER_CATEGORY, SUPPLIER_SUBCATEGORY] }),
  supplierSnapshot,
  mediaSourceImageUrls: ['https://supplier.example/product.jpg'],
  mediaStatus: 'ready',
  mediaFailures: [],
  mediaProcessedAt: '2026-07-26T00:00:00.000Z',
  managedMedia,
  approvalBaseline: buildSupplierProductApprovalBaseline('canonical-product', canonicalProduct, '2026-07-26T00:00:00.000Z'),
  createdAt: '2026-07-26T00:00:00.000Z',
});

const mappingParentId = supplierMappingDocumentId('source-b', 'supplier audio');
const mappingChildId = supplierChildMappingDocumentId('source-b', 'supplier audio', SUPPLIER_SUBCATEGORY);

/** Existing legacy mapping docs point the supplier label at category-2; they must stay inert. */
const legacyMappingDocuments = (): Record<string, StoredDocument> => ({
  [`supplier_category_mappings/${mappingParentId}`]: {
    sourceId: 'source-b', supplierCategory: SUPPLIER_CATEGORY, normalizedCategory: 'supplier audio',
    mappingScope: 'parent', targetCategoryId: 'category-2', targetSubcategoryId: '',
    confidence: 100, mappingType: 'learned', version: 3, updatedBy: 'legacy',
  },
  [`supplier_category_mappings/${mappingChildId}`]: {
    sourceId: 'source-b', supplierCategory: SUPPLIER_CATEGORY, normalizedCategory: 'supplier audio',
    supplierSubcategory: SUPPLIER_SUBCATEGORY, normalizedSupplierSubcategory: 'supplier buds',
    mappingScope: 'child', targetCategoryId: 'category-2', targetSubcategoryId: 'subcategory-2',
    confidence: 100, mappingType: 'learned', version: 3, updatedBy: 'legacy',
  },
  'supplier_settings/config': { categoryMappings: { 'supplier audio': 'category-2' } },
});

const approvalFixture = () => {
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
    pendingRevision: pendingObservation.revision,
    ...createFakeFirestore({
      'supplier_review_queue/review-1': updateQueueItem(pendingObservation.revision),
      'products/canonical-product': { ...canonicalProduct },
      'product_private/canonical-product': {},
      'categories/category-1': {
        name: 'Category', isActive: true,
        subcategories: [{ id: 'subcategory-1', name: 'Subcategory', isActive: true }],
        specificationTemplate: [],
      },
      'categories/category-2': {
        name: 'Category Two', isActive: true,
        subcategories: [{ id: 'subcategory-2', name: 'Subcategory Two', isActive: true }],
        specificationTemplate: [],
      },
      'brands/brand-1': { name: 'Brand', isActive: true },
      [`supplier_product_offers/${sourceA.id}`]: { ...sourceA },
      [`supplier_product_offers/${sourceB.id}`]: { ...sourceB },
      ...legacyMappingDocuments(),
    }),
  };
};

const assertNoCategoryAuthorityWrites = (writes: Array<{ key: string; data?: StoredDocument }>): void => {
  assert.equal(writes.some((write) => write.key.startsWith('supplier_category_mappings/')), false);
  assert.equal(writes.some((write) => write.key.startsWith('supplier_settings/')), false);
  assert.equal(writes.some((write) => write.key.startsWith('categories/')), false);
  assert.equal(
    writes.some((write) => write.key.startsWith('supplier_mapping_audit/') && write.data?.mappingKind === 'category'),
    false,
  );
};

const dropexProduct = (categoryName: string) => ProductParser.parseCatalogItem({
  price: 870,
  productDetail: {
    id: 4990,
    name: 'AZK1690',
    sku: 'AZK1690',
    sellingPrice: 1650,
    onHandInventory: 8,
    productCategories: [{ id: 29, name: categoryName }],
  },
});

const payloadFor = (
  product: ReturnType<typeof ProductParser.parseCatalogItem>,
  match?: StoredDocument,
) => buildProductPayload(
  product,
  match as never,
  buildSupplierTaxonomyMetadata({ supplierCategories: product.categoryHierarchy || [] }),
  { autoSelected: false, mappedBrandId: '' } as never,
  [],
  { status: match ? 'PRICE_CHANGED' : 'NEW_PRODUCT', changedFields: [], fieldChanges: [] },
  {},
  { id: 'dropex' } as never,
);

const newProductQueueItem = (overrides: StoredDocument = {}): StoredDocument => ({
  comparisonStatus: 'NEW_PRODUCT',
  sourceId: 'dropex',
  productName: 'Legacy product',
  productPayload: {
    id: 'legacy-product',
    name: 'Legacy product',
    description: 'Supplier description',
    imageUrl: 'https://storage.example/large.webp',
    imageUrls: ['https://storage.example/large.webp'],
    category: 'category-2',
    subcategory: 'subcategory-2',
    brand: '',
    specs: {},
    price: 1650,
    costPrice: 870,
    stock: 8,
    isActive: false,
  },
  categoryMapping: {
    supplierCategory: SUPPLIER_CATEGORY,
    supplierSubcategory: SUPPLIER_SUBCATEGORY,
    targetCategoryId: 'category-2',
    targetSubcategoryId: 'subcategory-2',
    confidence: 100,
    mappingType: 'learned',
    autoSelected: true,
    requiresManualSelection: false,
  },
  supplierSnapshot,
  mediaSourceImageUrls: ['https://supplier.example/product.jpg'],
  mediaStatus: 'ready',
  mediaFailures: [],
  managedMedia,
  ...overrides,
});

const approvalDraft = (overrides: StoredDocument = {}) => ({
  productName: 'Legacy product',
  sellingPrice: 1650,
  costPrice: 870,
  stock: 8,
  category: 'category-2',
  subcategory: 'subcategory-2',
  brand: '',
  specifications: {},
  isActive: false,
  primaryImageUrl: 'https://storage.example/large.webp',
  galleryImageUrls: [],
  ...overrides,
});

const serverCategories = [
  { id: 'category-2', name: 'Category Two', isActive: true, subcategories: [{ id: 'subcategory-2', name: 'Subcategory Two', isActive: true }] },
  { id: 'retired', name: 'Retired', isActive: false, subcategories: [] },
  { id: 'candidate', name: 'Candidate', isActive: true, taxonomyCandidate: true, subcategories: [] },
];

const clientCategories = [
  { id: 'category-2', name: 'Category Two', isActive: true, subcategories: [{ id: 'subcategory-2', name: 'Subcategory Two', isActive: true }], specificationTemplate: [] },
];

const editorItem = (overrides: StoredDocument = {}) => ({
  id: 'review-legacy',
  status: 'Pending',
  queueState: 'review_pending',
  supplierCode: 'AZK1690',
  supplierName: 'Dropex',
  productName: 'Legacy product',
  supplierOfferPendingRevision: 'a'.repeat(64),
  comparison: { comparisonStatus: 'NEW_PRODUCT' },
  productValidation: { readyToPublish: true, missingFields: [], errors: [] },
  managedMedia: [{ firebaseStorageUrl: 'https://storage.example/large.webp', imageStatus: 'ready', isPrimary: true, sortOrder: 0 }],
  ...newProductQueueItem(),
  ...overrides,
});

const renderEditor = (item: ReturnType<typeof editorItem>) => renderToStaticMarkup(React.createElement(SupplierReviewEditorModal, {
  item: item as never,
  initialDraft: createSupplierReviewDraft(item as never),
  categories: clientCategories,
  brands: [],
  validCategoryIds: ['category-2'],
  isPublishing: false,
  onClose: () => undefined,
  onRemove: () => undefined,
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

test('C0-FULL 01 a new Dropex product with a supplier category gets no Zyro category automatically', () => {
  const product = dropexProduct('Vehicle Accessories');
  const payload = payloadFor(product);
  assert.equal(payload.category, '');
  assert.equal(payload.subcategory, '');
  const metadata = buildSupplierTaxonomyMetadata({ supplierCategories: product.categoryHierarchy || [] });
  assert.equal(metadata.supplierCategory, 'Vehicle Accessories');
  assert.equal(metadata.targetCategoryId, '');
  assert.equal(metadata.autoSelected, false);
  assert.equal(metadata.confidence, 0);
  assert.equal(metadata.requiresManualSelection, true);
});

test('C0-FULL 02 changing only the supplier category label does not change Zyro classification', () => {
  const first = payloadFor(dropexProduct('Vehicle Accessories'));
  const renamed = payloadFor(dropexProduct('Car Electronics'));
  assert.equal(first.category, renamed.category);
  assert.equal(first.subcategory, renamed.subcategory);
  const existing = { id: 'product-1', category: 'category-1', subcategory: 'subcategory-1' };
  assert.equal(payloadFor(dropexProduct('Vehicle Accessories'), existing).category, payloadFor(dropexProduct('Car Electronics'), existing).category);
});

test('C0-FULL 03 update re-observation preserves the approved product taxonomy', () => {
  const payload = payloadFor(dropexProduct('Completely Different Supplier Label'), {
    id: 'product-1', category: 'category-1', subcategory: 'subcategory-1',
  });
  assert.equal(payload.category, 'category-1');
  assert.equal(payload.subcategory, 'subcategory-1');
});

test('C0-FULL 04 admin-owned taxonomy survives re-observation and editor draft creation', () => {
  const payload = payloadFor(dropexProduct('Other Label'), {
    id: 'product-1', category: 'admin-category', subcategory: 'admin-subcategory',
  });
  assert.equal(payload.category, 'admin-category');
  assert.equal(payload.subcategory, 'admin-subcategory');

  const adminOwned = newProductQueueItem({
    productPayload: {
      ...(newProductQueueItem().productPayload as StoredDocument),
      supplierFieldOwnership: { category: { owner: 'admin' }, subcategory: { owner: 'admin' } },
    },
  });
  assert.equal(hasLegacySupplierDerivedReviewTaxonomy(adminOwned), false);
  assert.equal(toPublicProductPayload(adminOwned as never, undefined).category, 'category-2');
  const draft = createSupplierReviewDraft(editorItem(adminOwned) as never);
  assert.equal(draft.category, 'category-2');
  assert.equal(draft.subcategory, 'subcategory-2');
});

const listingFirestore = (
  records: Array<{ id: string; data: StoredDocument }>,
  categories: Record<string, StoredDocument> = {},
) => {
  const touchedCollections = new Set<string>();
  const query = () => ({
    where: () => query(),
    orderBy: () => query(),
    startAfter: () => query(),
    limit: () => query(),
    get: async () => ({
      docs: records.map((record) => ({ exists: true, id: record.id, data: () => record.data })),
      size: records.length,
      empty: records.length === 0,
    }),
  });
  const mappings = legacyMappingDocuments();
  return {
    touchedCollections,
    db: {
      collection: (name: string) => {
        touchedCollections.add(name);
        return {
          doc: (id: string) => ({ get: async () => ({ exists: Boolean(mappings[`${name}/${id}`]), id, data: () => mappings[`${name}/${id}`] }) }),
          where: () => query(),
          orderBy: () => query(),
          get: async () => {
            const docs = name === 'categories'
              ? Object.entries(categories).map(([id, data]) => ({
                exists: true,
                id,
                data: () => data,
              }))
              : [];
            return { docs, size: docs.length, empty: docs.length === 0 };
          },
        };
      },
    },
  };
};

test('C0-FULL 05 and 11 review listing never overlays mapping taxonomy even when mapping documents exist', async () => {
  const unclassified = {
    id: 'review-unclassified',
    data: {
      status: 'Pending', queueState: 'review_pending', createdAt: '2026-09-02', sourceId: 'source-b',
      comparison: { comparisonStatus: 'NEW_PRODUCT' },
      productValidation: { readyToPublish: false, missingFields: ['category'], errors: [] },
      productPayload: { category: '', subcategory: '' },
      categoryMapping: buildSupplierTaxonomyMetadata({ supplierCategories: [SUPPLIER_CATEGORY, SUPPLIER_SUBCATEGORY] }),
      supplierSnapshot,
    },
  };
  const classified = {
    id: 'review-classified',
    data: {
      ...unclassified.data,
      createdAt: '2026-09-01',
      productPayload: { category: 'category-1', subcategory: 'subcategory-1' },
    },
  };
  const fixture = listingFirestore([unclassified, classified]);
  const page = await listSupplierQueuePage(fixture.db as never, { view: 'review', state: 'active', limit: 10 });
  const listedUnclassified = page.items.find((item) => item.id === unclassified.id) as StoredDocument;
  const listedClassified = page.items.find((item) => item.id === classified.id) as StoredDocument;
  assert.deepEqual(listedUnclassified.productPayload, { category: '', subcategory: '' });
  assert.deepEqual(listedClassified.productPayload, { category: 'category-1', subcategory: 'subcategory-1' });
  assert.equal((listedUnclassified.categoryMapping as StoredDocument).targetCategoryId, '');
  assert.equal(fixture.touchedCollections.has('supplier_category_mappings'), false);
  assert.equal(fixture.touchedCollections.has('supplier_settings'), false);
});

test('C0-R1 legacy supplier-derived NEW_PRODUCT projects missing taxonomy at read time without writing', async () => {
  const legacy = {
    id: 'legacy-ready',
    data: {
      ...newProductQueueItem({
        status: 'Pending',
        queueState: 'review_pending',
        productValidation: { readyToPublish: true, missingFields: [], errors: [] },
      }),
    },
  };
  const fixture = listingFirestore([legacy], {
    'category-2': {
      isActive: true,
      subcategories: [{ id: 'subcategory-2', isActive: true }],
    },
  });
  const page = await listSupplierQueuePage(fixture.db as never, {
    view: 'review',
    state: 'active',
    businessFilter: 'needs_attention',
    limit: 10,
  });
  const projected = page.items[0] as StoredDocument;
  const validation = projected.productValidation as StoredDocument;
  assert.equal(projected.id, 'legacy-ready');
  assert.equal(validation.readyToPublish, false);
  assert.deepEqual(validation.missingFields, ['category', 'subcategory']);
  assert.deepEqual((validation.errors as StoredDocument[]).map((error) => error.field), ['category', 'subcategory']);
  assert.equal((projected.productPayload as StoredDocument).category, 'category-2');
  assert.equal(fixture.touchedCollections.has('supplier_category_mappings'), false);
  assert.equal(fixture.touchedCollections.has('supplier_settings'), false);
});

test('C0-R1 list, Needs Attention, Quick Approve, and actionable counts agree for legacy taxonomy', async () => {
  const legacy = {
    id: 'legacy-ready',
    data: {
      ...newProductQueueItem({
        status: 'Pending',
        queueState: 'review_pending',
        productValidation: { readyToPublish: true, missingFields: [], errors: [] },
      }),
    },
  };
  const fixture = listingFirestore([legacy], {
    'category-2': { isActive: true, subcategories: [{ id: 'subcategory-2', isActive: true }] },
  });
  const projectedPage = await listSupplierQueuePage(fixture.db as never, { view: 'review', state: 'active', limit: 10 });
  const projected = projectedPage.items[0] as StoredDocument;
  assert.equal(reviewRecordMatchesBusinessFilter(projected as never, 'needs_attention'), true);
  assert.equal(classifySupplierReviewRecordForCounts(projected as never), 'actionable');
  assert.equal(supplierReviewCanQuickApprove(projected as never), false);
});

test('C0-R1 admin-owned NEW_PRODUCT and approved UPDATE taxonomy are not falsely projected', async () => {
  const adminOwned = {
    id: 'admin-owned',
    data: {
      ...newProductQueueItem({
        status: 'Pending',
        queueState: 'review_pending',
        productValidation: { readyToPublish: true, missingFields: [], errors: [] },
        productPayload: {
          ...(newProductQueueItem().productPayload as StoredDocument),
          supplierFieldOwnership: { category: { owner: 'admin' }, subcategory: { owner: 'admin' } },
        },
      }),
    },
  };
  const update = {
    id: 'approved-update',
    data: {
      ...newProductQueueItem({
        comparisonStatus: 'PRICE_CHANGED',
        status: 'Pending',
        queueState: 'review_pending',
        productValidation: { readyToPublish: true, missingFields: [], errors: [] },
      }),
    },
  };
  const fixture = listingFirestore([adminOwned, update], {
    'category-2': { isActive: true, subcategories: [{ id: 'subcategory-2', isActive: true }] },
  });
  const page = await listSupplierQueuePage(fixture.db as never, { view: 'review', state: 'active', limit: 10 });
  for (const item of page.items) {
    const validation = item.productValidation as StoredDocument;
    assert.equal(validation.readyToPublish, true);
    assert.deepEqual(validation.missingFields, []);
    assert.deepEqual(validation.errors, []);
  }
});

test('C0-R1 Low Stock Hold keeps priority, then recovered stock surfaces missing taxonomy', async () => {
  const held = {
    id: 'legacy-held',
    data: {
      ...newProductQueueItem({
        status: 'Pending',
        queueState: 'review_pending',
        productPayload: { ...(newProductQueueItem().productPayload as StoredDocument), stock: 2 },
        supplierSnapshot: { ...supplierSnapshot, inventoryLevel: 2, providedFields: ['stock'] },
        productValidation: { readyToPublish: true, missingFields: [], errors: [] },
      }),
    },
  };
  const fixture = listingFirestore([held], {
    'category-2': { isActive: true, subcategories: [{ id: 'subcategory-2', isActive: true }] },
  });
  const holdPage = await listSupplierQueuePage(fixture.db as never, {
    view: 'review', state: 'active', businessFilter: 'low_stock_hold', limit: 10,
  });
  assert.equal(holdPage.items.length, 1);
  assert.equal((holdPage.items[0].productValidation as StoredDocument).lowStockHold, true);
  const recovered = projectSupplierReviewLowStockHold({
    ...held.data,
    productPayload: { ...(held.data.productPayload as StoredDocument), stock: 8 },
    supplierSnapshot: { ...supplierSnapshot, inventoryLevel: 8, providedFields: ['stock'] },
  } as never, true) as StoredDocument;
  assert.equal(reviewRecordMatchesBusinessFilter(recovered as never, 'low_stock_hold'), false);
  assert.equal(reviewRecordMatchesBusinessFilter(recovered as never, 'needs_attention'), true);
  assert.deepEqual((recovered.productValidation as StoredDocument).missingFields, ['category', 'subcategory']);
});

test('C0-FULL 06 07 08 19 update approval keeps approved taxonomy and writes no category mapping, legacy entry, or audit', async () => {
  const fixture = approvalFixture();
  const result = await decideSupplierQueueItem(
    fixture.db as never,
    'review-1',
    'approved',
    { uid: 'admin-1', email: 'admin@zyro.lk' },
    { expectedPendingRevision: fixture.pendingRevision },
  );
  assert.equal(result.success, true, JSON.stringify(result));
  const product = fixture.documents.get('products/canonical-product') || {};
  assert.equal(product.category, 'category-1');
  assert.equal(product.subcategory, 'subcategory-1');
  assertNoCategoryAuthorityWrites(fixture.writes);
  assert.equal(fixture.reads.some((key) => key.startsWith('supplier_category_mappings/')), false);
  assert.equal(fixture.reads.some((key) => key.startsWith('supplier_settings/')), false);
  assert.deepEqual(fixture.documents.get('supplier_settings/config'), { categoryMappings: { 'supplier audio': 'category-2' } });
  assert.equal(fixture.documents.get(`supplier_category_mappings/${mappingChildId}`)?.version, 3);
});

test('C0-FULL 09 approval commits the explicit admin draft taxonomy without mapping re-projection', async () => {
  const fixture = approvalFixture();
  const result = await decideSupplierQueueItem(fixture.db as never, 'review-1', 'approved', {
    uid: 'admin-1', email: 'admin@zyro.lk',
  }, {
    draft: {
      productName: 'Canonical product',
      sellingPrice: 145,
      costPrice: 125,
      stock: 20,
      category: 'category-2',
      subcategory: 'subcategory-2',
      brand: 'brand-1',
      specifications: {},
      isActive: true,
      primaryImageUrl: 'https://storage.example/large.webp',
      galleryImageUrls: [],
      fieldOwnership: { category: 'admin', subcategory: 'admin' },
      editedFields: ['category', 'subcategory'],
    },
    expectedPendingRevision: fixture.pendingRevision,
  });
  assert.equal(result.success, true, JSON.stringify(result));
  const product = fixture.documents.get('products/canonical-product') || {};
  assert.equal(product.category, 'category-2');
  assert.equal(product.subcategory, 'subcategory-2');
  assertNoCategoryAuthorityWrites(fixture.writes);
});

test('C0-FULL 10 and 20 raw supplier hierarchy stays stored and visible as read-only source details', () => {
  const product = dropexProduct('Vehicle Accessories');
  assert.deepEqual(product.categoryHierarchy, ['Vehicle Accessories']);
  const metadata = supplierReviewRawMetadata(editorItem() as never);
  assert.equal(metadata.supplierCategory, SUPPLIER_CATEGORY);
  assert.equal(metadata.supplierSubcategory, SUPPLIER_SUBCATEGORY);

  const markup = renderEditor(editorItem());
  assert.match(markup, /Supplier source category/u);
  assert.match(markup, /Supplier source subcategory/u);
  assert.match(markup, new RegExp(SUPPLIER_CATEGORY, 'u'));
  assert.match(markup, new RegExp(SUPPLIER_SUBCATEGORY, 'u'));
  assert.equal((markup.match(/Supplier source category/gu) || []).length, 1);
});

test('C0-FULL 12 and 13 the editor shows no category suggestion, confidence, Apply, or candidate activation', () => {
  const markup = renderEditor(editorItem());
  assert.doesNotMatch(markup, /Suggested Category/u);
  assert.doesNotMatch(markup, /% confidence/u);
  assert.doesNotMatch(markup, /Activate as new canonical category/u);
  assert.doesNotMatch(markup, /Intelligent mapping/u);
  assert.match(markup, /Brand suggestion/u);

  const modal = projectFile('src/components/SupplierReviewEditorModal.tsx');
  const hub = projectFile('src/components/SupplierHubFiveStars.tsx');
  assert.doesNotMatch(modal, /categoryMapping\?\.targetCategoryId|categoryMapping\.confidence|onActivateTaxonomyCandidate/u);
  assert.equal((modal.match(/>Apply<\/button>/gu) || []).length, 1);
  assert.match(modal, /brand: item\.brandMapping\?\.mappedBrandId/u);
  assert.doesNotMatch(hub, /activateSupplierTaxonomyCandidate|onActivateTaxonomyCandidate/u);
});

test('C0-FULL 14 manual category and subcategory selection remains usable', () => {
  const draft = createSupplierReviewDraft(editorItem() as never);
  assert.equal(draft.category, '');
  assert.equal(draft.subcategory, '');
  const selected = updateSupplierReviewDraftField(
    updateSupplierReviewDraftField(draft, 'category', { category: 'category-2', subcategory: '' }),
    'subcategory',
    { subcategory: 'subcategory-2' },
  );
  assert.equal(selected.category, 'category-2');
  assert.equal(selected.subcategory, 'subcategory-2');
  assert.equal(selected.fieldOwnership.category, 'admin');
  assert.ok(selected.editedFields.includes('category'));
  const errors = validateSupplierReviewDraft(selected, ['category-2'], clientCategories, [], { supplierReview: true });
  assert.equal(errors.category, undefined);
  assert.equal(errors.subcategory, undefined);
  const payload = toPublicProductPayload(newProductQueueItem() as never, approvalDraft({
    fieldOwnership: { category: 'admin', subcategory: 'admin' },
    editedFields: ['category', 'subcategory'],
  }) as never);
  assert.equal(payload.category, 'category-2');
  assert.equal(payload.subcategory, 'subcategory-2');
});

test('C0-FULL 15 inactive, candidate, and invalid taxonomy still fail validation', () => {
  const base = toPublicProductPayload(newProductQueueItem() as never, approvalDraft({ editedFields: ['category', 'subcategory'] }) as never);
  const fields = (product: StoredDocument) => validateSupplierProductForApproval(product, serverCategories, [], { supplierReview: true })
    .map((error) => error.field);
  assert.deepEqual(fields(base), []);
  assert.deepEqual(fields({ ...base, category: 'retired', subcategory: '' }), ['category']);
  assert.deepEqual(fields({ ...base, category: 'candidate', subcategory: '' }), ['category']);
  assert.deepEqual(fields({ ...base, category: 'missing-category', subcategory: '' }), ['category']);
  assert.deepEqual(fields({ ...base, subcategory: 'not-a-child' }), ['subcategory']);
});

test('C0-FULL 16 missing required category or subcategory still fails validation', () => {
  const base = toPublicProductPayload(newProductQueueItem() as never, approvalDraft({ editedFields: ['category', 'subcategory'] }) as never);
  const fields = (product: StoredDocument) => validateSupplierProductForApproval(product, serverCategories, [], { supplierReview: true })
    .map((error) => error.field);
  assert.deepEqual(fields({ ...base, category: '', subcategory: '' }), ['category']);
  assert.deepEqual(fields({ ...base, subcategory: '' }), ['subcategory']);
  const clientErrors = validateSupplierReviewDraft(createSupplierReviewDraft(editorItem() as never), ['category-2'], clientCategories, []);
  assert.match(clientErrors.category || '', /required|select/iu);
});

test('C0-FULL 17 legacy supplier-derived NEW_PRODUCT taxonomy is rejected without explicit admin taxonomy', () => {
  const legacy = newProductQueueItem();
  assert.equal(hasLegacySupplierDerivedReviewTaxonomy(legacy), true);

  const withoutDraft = toPublicProductPayload(legacy as never, undefined);
  assert.equal(withoutDraft.category, '');
  assert.equal(withoutDraft.subcategory, '');
  assert.deepEqual(
    validateSupplierProductForApproval(withoutDraft, serverCategories, [], { supplierReview: true }).map((error) => error.field),
    ['category'],
  );

  const echoedDraft = toPublicProductPayload(legacy as never, approvalDraft({
    fieldOwnership: { category: 'supplier', subcategory: 'supplier' },
    editedFields: [],
  }) as never);
  assert.equal(echoedDraft.category, '');
  assert.equal(echoedDraft.subcategory, '');

  const editorDraft = createSupplierReviewDraft(editorItem() as never);
  assert.equal(editorDraft.category, '');
  assert.equal(editorDraft.subcategory, '');

  const explicit = toPublicProductPayload(legacy as never, approvalDraft({ editedFields: ['category', 'subcategory'] }) as never);
  assert.equal(explicit.category, 'category-2');
  assert.equal(explicit.subcategory, 'subcategory-2');

  const manuallyStored = newProductQueueItem({
    categoryMapping: buildSupplierTaxonomyMetadata({ supplierCategories: [SUPPLIER_CATEGORY] }),
  });
  assert.equal(hasLegacySupplierDerivedReviewTaxonomy(manuallyStored), false);
  assert.equal(toPublicProductPayload(manuallyStored as never, undefined).category, 'category-2');

  const update = newProductQueueItem({ comparisonStatus: 'PRICE_CHANGED' });
  assert.equal(hasLegacySupplierDerivedReviewTaxonomy(update), false);
  assert.equal(toPublicProductPayload(update as never, undefined).category, 'category-2');
  assert.equal(createSupplierReviewDraft(editorItem({ comparison: { comparisonStatus: 'PRICE_CHANGED' } }) as never).category, 'category-2');
});

test('C0-FULL 18 sync and refresh use only existing canonical taxonomy mappings', () => {
  const metadata = buildSupplierTaxonomyMetadata({ supplierCategories: ['Brand New Supplier Category', 'Brand New Child'] });
  assert.equal(Object.hasOwn(metadata, 'candidateCategoryId'), false);
  assert.equal(Object.hasOwn(metadata, 'candidateSubcategoryId'), false);
  assert.equal(metadata.mappingType, 'unmapped');

  const sync = projectFile('functions/src/scheduled/supplierSync.ts');
  assert.doesNotMatch(sync, /planSupplierTaxonomyCandidates|upsertSupplierTaxonomyCandidate|taxonomyCandidatePlan/u);
  assert.doesNotMatch(sync, /collection: "categories"/u);
  assert.doesNotMatch(sync, /CATEGORY_AUTO_MATCHED/u);
  assert.match(sync, /supplierCategorySuggestionForProduct/u);
  assert.match(sync, /collection\("supplier_category_mappings"\)/u);
  assert.doesNotMatch(sync, /planSupplierTaxonomyCandidates|upsertSupplierTaxonomyCandidate/u);
});
