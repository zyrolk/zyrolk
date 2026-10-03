import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { adminDb } from "../functions/src/api/firebase";
import { decideSupplierQueueItem } from "../functions/src/api/suppliers/supplierApproval";
import {
  parseSupplierReviewDraftInput,
  saveSupplierReviewDraft,
} from "../functions/src/api/suppliers/supplierReviewDraft";
import { buildSupplierOfferId, buildSupplierOfferPendingObservation, buildSupplierProductOffer } from "../functions/src/api/suppliers/supplierOfferEngine";
import { refreshActiveSupplierReviewItem, preserveAdminOwnedReviewTaxonomy } from "../functions/src/scheduled/supplierSync";
import { SupplierRegistry } from "../functions/src/api/suppliers/SupplierRegistry";

const requireFunctions = createRequire(import.meta.url);
const { buildSupplierProductApprovalBaseline } = requireFunctions("../functions/src/api/suppliers/supplierApprovalConcurrency.ts") as typeof import("../functions/src/api/suppliers/supplierApprovalConcurrency");

type Stored = Record<string, unknown>;

const REVISION = "a".repeat(64);
const UPDATED_AT = "2026-10-02T02:00:00.000Z";

const createFakeDb = (queue: Stored, categories: Record<string, Stored>) => {
  const collections = new Map<string, Map<string, Stored>>([
    ["supplier_review_queue", new Map([["review-1", queue]])],
    ["categories", new Map(Object.entries(categories))],
  ]);
  const collection = (name: string) => {
    const documents = collections.get(name) || new Map<string, Stored>();
    collections.set(name, documents);
    return {
      doc: (id: string) => ({
        get: async () => ({
          exists: documents.has(id),
          id,
          data: () => documents.get(id),
        }),
      }),
    };
  };
  const db = {
    collection,
    runTransaction: async (callback: (transaction: {
      get: (reference: { get: () => Promise<unknown> }) => Promise<unknown>;
      update: (reference: { get: () => Promise<unknown> }, value: Stored) => void;
    }) => Promise<void>) => callback({
      get: (reference) => reference.get(),
      update: async (reference, value) => {
        const queueDocuments = collections.get("supplier_review_queue")!;
        const snapshot = await reference.get() as { id: string };
        queueDocuments.set(snapshot.id, { ...(queueDocuments.get(snapshot.id) || {}), ...value });
      },
    }),
  };
  return { db, collections };
};

const queueFixture = (overrides: Stored = {}): Stored => ({
  queueState: "review_pending",
  status: "Pending",
  supplierSourceId: "dropex",
  supplierSku: "ATF0081",
  supplierProductId: "supplier-1",
  supplierOfferPendingRevision: REVISION,
  availability: "in_stock",
  supplierSnapshot: {
    sourceId: "dropex",
    supplierProductId: "supplier-1",
    supplierSku: "ATF0081",
    wholesalePrice: 1310,
    recommendedRetailPrice: 1999,
    inventoryLevel: 4,
  },
  updatedAt: UPDATED_AT,
  title: "Magic Pad",
  description: "Original review description",
  images: ["https://example.test/magic-pad.jpg"],
  promotion: { enabled: false },
  localDemand: { quantity: 2 },
  checkpoint: "offset:40",
  productPayload: {
    name: "Magic Pad",
    description: "Original review description",
    category: "supplier-derived",
    subcategory: "",
    costPrice: 1310,
    price: 1999,
    stock: 4,
    imageUrl: "https://example.test/magic-pad.jpg",
    imageUrls: ["https://example.test/magic-pad.jpg"],
    isActive: true,
    active: true,
    visible: true,
    supplierFieldOwnership: {
      category: { owner: "supplier", sourceId: "dropex" },
      subcategory: { owner: "supplier", sourceId: "dropex" },
    },
  },
  productValidation: {
    readyToPublish: false,
    missingFields: ["category", "subcategory"],
    errors: [
      { field: "category", code: "invalid", message: "Select a category." },
      { field: "subcategory", code: "required", message: "Select a subcategory." },
    ],
  },
  ...overrides,
});

const categories = {
  "baby-kids": {
    isActive: true,
    subcategories: [{ id: "baby-toys", name: "Baby Toys", isActive: true }],
  },
  candidate: {
    isActive: true,
    taxonomyCandidate: true,
    subcategories: [],
  },
  "home-kitchen": {
    isActive: true,
    subcategories: [{ id: "kitchen-tools", name: "Kitchen Tools", isActive: true }],
  },
  "home-garden": {
    isActive: true,
    subcategories: [{ id: "household", name: "Household", isActive: true }],
  },
};

type FlowReference = {
  collectionName: string;
  id: string;
  get: () => Promise<{ exists: boolean; id: string; data: () => Stored | undefined }>;
};

const createReviewFlowDb = () => {
  const collections = new Map<string, Map<string, Stored>>();
  const getCollection = (name: string): Map<string, Stored> => {
    const existing = collections.get(name);
    if (existing) return existing;
    const created = new Map<string, Stored>();
    collections.set(name, created);
    return created;
  };
  const snapshotFor = (name: string, id: string) => {
    const data = getCollection(name).get(id);
    return { exists: Boolean(data), id, data: () => data };
  };
  const queryFor = (name: string) => {
    const query = {
      where: () => query,
      select: () => query,
      limit: () => query,
      get: async () => {
        const docs = [...getCollection(name)].map(([id, data]) => ({ exists: true, id, data: () => data }));
        return { docs, forEach: (callback: (document: typeof docs[number]) => void) => docs.forEach(callback) };
      },
    };
    return query;
  };
  const collection = (name: string) => {
    const query = queryFor(name) as ReturnType<typeof queryFor> & { doc: (id?: string) => FlowReference };
    query.doc = (id = `generated-${Date.now()}`): FlowReference => ({
      collectionName: name,
      id,
      get: async () => snapshotFor(name, id),
    });
    return query;
  };
  const write = (reference: FlowReference, value: Stored, merge = true): void => {
    const existing = getCollection(reference.collectionName).get(reference.id) || {};
    getCollection(reference.collectionName).set(reference.id, merge ? { ...existing, ...value } : { ...value });
  };
  const db = {
    collections,
    collection,
    batch: () => {
      const writes: Array<{ reference: FlowReference; value: Stored; merge: boolean }> = [];
      return {
        set: (reference: FlowReference, value: Stored, options?: { merge?: boolean }) => writes.push({ reference, value, merge: options?.merge !== false }),
        create: (reference: FlowReference, value: Stored) => writes.push({ reference, value, merge: false }),
        update: (reference: FlowReference, value: Stored) => writes.push({ reference, value, merge: true }),
        delete: (reference: FlowReference) => writes.push({ reference, value: {}, merge: false }),
        commit: async () => writes.forEach(({ reference, value, merge }) => write(reference, value, merge)),
      };
    },
    runTransaction: async (callback: (transaction: {
      get: (reference: FlowReference | { get: () => Promise<unknown> }) => Promise<unknown>;
      set: (reference: FlowReference, value: Stored, options?: { merge?: boolean; mergeFields?: string[] }) => void;
      create: (reference: FlowReference, value: Stored) => void;
      update: (reference: FlowReference, value: Stored) => void;
      delete: (reference: FlowReference) => void;
    }) => Promise<unknown>) => callback({
      get: (reference) => reference.get(),
      set: (reference, value, options) => write(reference, value, options?.merge !== false),
      create: (reference, value) => write(reference, value, false),
      update: (reference, value) => write(reference, value, true),
      delete: (reference) => getCollection(reference.collectionName).delete(reference.id),
    }),
  };
  return db;
};

const createReviewFlowFixture = () => {
  const db = createReviewFlowDb();
  const queueItemId = "taxonomy-flow-1";
  const sourceId = "dropex";
  const supplierProductId = "4990";
  const supplierSku = "AZK1690";
  const offerId = buildSupplierOfferId(sourceId, supplierProductId, supplierSku);
  const observedAt = "2026-10-02T02:00:00.000Z";
  const mediaUrl = "https://supplier.example/azk1690.jpg";
  const mediaAsset = {
    assetId: "media-1",
    contentHash: "hash-1",
    imageStatus: "ready",
    isPrimary: true,
    originalSupplierUrl: mediaUrl,
    firebaseStorageUrl: "https://storage.example/azk1690.jpg",
    variants: { large: { storagePath: "supplier-review/taxonomy-flow-1/large.jpg" } },
  };
  const initialOffer = buildSupplierProductOffer({
    sourceId,
    supplierId: sourceId,
    supplierProductId,
    sku: supplierSku,
    price: 1173,
    cost: 870,
    stock: 8,
    stockKnown: true,
    availability: "in_stock",
    priority: 100,
    lastSyncAt: observedAt,
    reviewStatus: "review_pending",
    catalogPayload: { id: "taxonomy-flow-product", name: "Legacy AZK1690", price: 1173, costPrice: 870, stock: 8 },
    supplierSnapshot: { sourceId, supplierProductId, supplierSku, sku: supplierSku, wholesalePrice: 870, recommendedRetailPrice: 1173, inventoryLevel: 8 },
    timestamp: observedAt,
  });
  const initialPending = buildSupplierOfferPendingObservation({
    offer: initialOffer,
    kind: "catalog_upsert",
    reviewQueueItemId: queueItemId,
    observedAt,
    traversalId: "taxonomy-flow-traversal",
  });
  const queueItem: Stored = {
    id: queueItemId,
    queueState: "review_pending",
    status: "Pending",
    sourceId,
    supplierId: sourceId,
    supplierCode: supplierSku,
    supplierSku,
    supplierProductId,
    supplierOfferId: offerId,
    supplierOfferPendingRevision: initialPending.revision,
    supplierSnapshot: { sourceId, supplierProductId, supplierSku, sku: supplierSku, wholesalePrice: 870, recommendedRetailPrice: 1173, inventoryLevel: 8 },
    productPayload: {
      id: "taxonomy-flow-provisional",
      name: "Legacy AZK1690",
      description: "Legacy description",
      category: "",
      subcategory: "",
      costPrice: 870,
      price: 1173,
      stock: 8,
      imageUrl: mediaUrl,
      imageUrls: [mediaUrl],
      isActive: true,
      active: true,
      visible: true,
      supplierFieldOwnership: {
        category: { owner: "supplier", sourceId },
        subcategory: { owner: "supplier", sourceId },
      },
    },
    managedMedia: [mediaAsset],
    mediaStatus: "ready",
    mediaReadiness: "ready",
    mediaFailures: [],
    mediaSourceImageUrls: [mediaUrl],
    comparisonStatus: "NEW_PRODUCT",
    comparison: { comparisonStatus: "NEW_PRODUCT", status: "NEW_PRODUCT", matchFound: false },
    approvalBaseline: buildSupplierProductApprovalBaseline("taxonomy-flow-product", undefined, observedAt),
    createdAt: observedAt,
    queueCreatedAt: observedAt,
    updatedAt: UPDATED_AT,
  };
  const source: Stored = {
    supplierId: sourceId,
    supplierName: "Dropex",
    connectorType: sourceId,
    supplierType: sourceId,
    sourceStatus: "active",
    enabled: true,
    websiteUrl: "https://supplier.example",
    endpoint: "",
    authentication: { credentialProfile: "test-profile" },
    syncSchedule: "Off",
  };
  db.collections.set("supplierSources", new Map([[sourceId, source]]));
  db.collections.set("supplier_settings", new Map([["config", { defaultMarkup: 0, defaultProfitMargin: 0, defaultImageLimit: 10 }]]));
  db.collections.set("categories", new Map([["baby-kids", { name: "Baby & Kids", isActive: true, subcategories: [{ id: "baby-toys", name: "Baby Toys", isActive: true }] }]]));
  db.collections.set("brands", new Map());
  db.collections.set("supplier_product_offers", new Map([[offerId, { ...initialOffer, stateVersion: 1, pendingObservation: initialPending }]]));
  db.collections.set("supplier_review_queue", new Map([[queueItemId, queueItem]]));
  return { db, queueItemId, sourceId, supplierProductId, supplierSku, offerId, initialPending, mediaAsset, mediaUrl };
};

const withPatchedAdminDb = async <T>(db: ReturnType<typeof createReviewFlowDb>, action: () => Promise<T>): Promise<T> => {
  const patchedDb = adminDb as unknown as ReturnType<typeof createReviewFlowDb>;
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

test("taxonomy draft parser accepts only taxonomy and concurrency fields", () => {
  const parsed = parseSupplierReviewDraftInput({
    categoryId: "baby-kids",
    subcategoryId: "baby-toys",
    expectedPendingRevision: REVISION,
    expectedUpdatedAt: UPDATED_AT,
  });
  assert.deepEqual(parsed, {
    categoryId: "baby-kids",
    subcategoryId: "baby-toys",
    expectedPendingRevision: REVISION,
    expectedUpdatedAt: UPDATED_AT,
  });
  assert.throws(
    () => parseSupplierReviewDraftInput({
      categoryId: "baby-kids",
      subcategoryId: "baby-toys",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
      costPrice: 1,
    }),
    /unsupported fields/u,
  );
  assert.throws(() => parseSupplierReviewDraftInput({
    categoryId: "baby-kids",
    subcategoryId: "baby-toys",
    expectedPendingRevision: "stale",
    expectedUpdatedAt: UPDATED_AT,
  }), /expectedPendingRevision is invalid/u);
});

test("taxonomy draft save persists admin taxonomy and leaves review pending/commercial data unchanged", async () => {
  const fixture = createFakeDb(queueFixture(), categories);
  fixture.collections.set("supplier_product_offers", new Map([["offer-1", {
    sourceId: "dropex",
    supplierProductId: "supplier-1",
    sku: "ATF0081",
    cost: 1310,
    price: 1999,
    stock: 4,
  }]]));
  const beforeOffer = structuredClone(fixture.collections.get("supplier_product_offers")!.get("offer-1"));
  const result = await saveSupplierReviewDraft(
    fixture.db as never,
    "review-1",
    parseSupplierReviewDraftInput({
      categoryId: "baby-kids",
      subcategoryId: "baby-toys",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
    }),
    { uid: "admin-1", email: "admin@example.test" },
  );
  const saved = fixture.collections.get("supplier_review_queue")!.get("review-1")!;
  const payload = saved.productPayload as Stored;
  assert.equal(saved.status, "Pending");
  assert.equal(saved.queueState, "review_pending");
  assert.equal(payload.category, "baby-kids");
  assert.equal(payload.subcategory, "baby-toys");
  assert.equal(payload.costPrice, 1310);
  assert.equal(payload.price, 1999);
  assert.equal(payload.stock, 4);
  assert.equal(saved.title, "Magic Pad");
  assert.equal(saved.description, "Original review description");
  assert.deepEqual(saved.images, ["https://example.test/magic-pad.jpg"]);
  assert.deepEqual(saved.promotion, { enabled: false });
  assert.deepEqual(saved.localDemand, { quantity: 2 });
  assert.equal(saved.checkpoint, "offset:40");
  assert.equal(saved.supplierSourceId, "dropex");
  assert.equal(saved.supplierSku, "ATF0081");
  assert.equal(saved.supplierProductId, "supplier-1");
  assert.equal(saved.supplierOfferPendingRevision, REVISION);
  assert.equal(saved.availability, "in_stock");
  assert.deepEqual(saved.supplierSnapshot, {
    sourceId: "dropex",
    supplierProductId: "supplier-1",
    supplierSku: "ATF0081",
    wholesalePrice: 1310,
    recommendedRetailPrice: 1999,
    inventoryLevel: 4,
  });
  assert.equal((payload.supplierFieldOwnership as Stored).category && ((payload.supplierFieldOwnership as Stored).category as Stored).owner, "admin");
  assert.equal((payload.supplierFieldOwnership as Stored).subcategory && ((payload.supplierFieldOwnership as Stored).subcategory as Stored).owner, "admin");
  assert.equal((result.item.productPayload as Stored).category, "baby-kids");
  assert.equal((result.item.productPayload as Stored).subcategory, "baby-toys");
  assert.deepEqual(saved.productValidation, {
    readyToPublish: true,
    missingFields: [],
    errors: [],
  });
  assert.equal(saved.publicProductId, undefined);
  assert.deepEqual(fixture.collections.get("supplier_product_offers")!.get("offer-1"), beforeOffer);
});

test("SHX1092-like taxonomy save clears stale subcategory validation metadata", async () => {
  const base = queueFixture();
  const fixture = createFakeDb(queueFixture({
    title: "Meileyi Vegetable Slicer",
    supplierSku: "SHX1092",
    supplierProductId: "4096",
    productPayload: {
      ...(base.productPayload as Stored),
      name: "Meileyi Vegetable Slicer",
      category: "supplier-derived",
      subcategory: "",
    },
    productValidation: {
      readyToPublish: false,
      missingFields: ["subcategory"],
      errors: [{ field: "subcategory", code: "invalid", message: "Select an active subcategory belonging to the category." }],
    },
  }), categories);

  await saveSupplierReviewDraft(
    fixture.db as never,
    "review-1",
    parseSupplierReviewDraftInput({
      categoryId: "home-kitchen",
      subcategoryId: "kitchen-tools",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
    }),
    { uid: "admin-1", email: "admin@example.test" },
  );

  const saved = fixture.collections.get("supplier_review_queue")!.get("review-1")!;
  assert.equal((saved.productPayload as Stored).category, "home-kitchen");
  assert.equal((saved.productPayload as Stored).subcategory, "kitchen-tools");
  assert.deepEqual(saved.productValidation, { readyToPublish: true, missingFields: [], errors: [] });
  assert.equal(saved.queueState, "review_pending");
  assert.equal(saved.publicProductId, undefined);
});

test("SHX2063-like taxonomy save clears stale subcategory validation metadata", async () => {
  const base = queueFixture();
  const fixture = createFakeDb(queueFixture({
    title: "Folding Multifunction Storage Laundry Basket",
    supplierSku: "SHX2063",
    supplierProductId: "4097",
    productPayload: {
      ...(base.productPayload as Stored),
      name: "Folding Multifunction Storage Laundry Basket",
      category: "supplier-derived",
      subcategory: "",
    },
    productValidation: {
      readyToPublish: false,
      missingFields: ["subcategory"],
      errors: [{ field: "subcategory", code: "invalid", message: "Select an active subcategory belonging to the category." }],
    },
  }), categories);

  await saveSupplierReviewDraft(
    fixture.db as never,
    "review-1",
    parseSupplierReviewDraftInput({
      categoryId: "home-garden",
      subcategoryId: "household",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
    }),
    { uid: "admin-1", email: "admin@example.test" },
  );

  const saved = fixture.collections.get("supplier_review_queue")!.get("review-1")!;
  assert.equal((saved.productPayload as Stored).category, "home-garden");
  assert.equal((saved.productPayload as Stored).subcategory, "household");
  assert.deepEqual(saved.productValidation, { readyToPublish: true, missingFields: [], errors: [] });
  assert.equal(saved.queueState, "review_pending");
  assert.equal(saved.publicProductId, undefined);
});

test("taxonomy draft save preserves an unrelated blocker and its warning", async () => {
  const base = queueFixture();
  const fixture = createFakeDb(queueFixture({
    productPayload: {
      ...(base.productPayload as Stored),
      description: "",
      category: "supplier-derived",
      subcategory: "",
    },
    productValidation: {
      readyToPublish: false,
      missingFields: ["subcategory", "description"],
      errors: [
        { field: "subcategory", code: "invalid", message: "Select an active subcategory belonging to the category." },
        { field: "description", code: "required", message: "Full description is required." },
      ],
      warnings: [{ code: "brand_missing", message: "Brand is not set." }],
    },
  }), categories);

  await saveSupplierReviewDraft(
    fixture.db as never,
    "review-1",
    parseSupplierReviewDraftInput({
      categoryId: "home-kitchen",
      subcategoryId: "kitchen-tools",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
    }),
    { uid: "admin-1", email: "admin@example.test" },
  );

  const validation = fixture.collections.get("supplier_review_queue")!.get("review-1")!.productValidation as Stored;
  assert.equal(validation.readyToPublish, false);
  assert.deepEqual(validation.missingFields, ["description"]);
  assert.deepEqual(validation.errors, [{ field: "description", code: "required", message: "Full description is required." }]);
  assert.deepEqual(validation.warnings, [{ code: "brand_missing", message: "Brand is not set." }]);
});

test("taxonomy draft save reconciles resolved current errors instead of preserving stale history", async () => {
  const base = queueFixture();
  const fixture = createFakeDb(queueFixture({
    productPayload: {
      ...(base.productPayload as Stored),
      category: "supplier-derived",
      subcategory: "",
      description: "Now present",
      price: 1999,
      costPrice: 1310,
    },
    productValidation: {
      readyToPublish: false,
      missingFields: ["subcategory", "description"],
      errors: [
        { field: "subcategory", code: "invalid", message: "Select an active subcategory belonging to the category." },
        { field: "description", code: "required", message: "Full description is required." },
        { field: "price", code: "below_supplier_cost", message: "Selling price must be at least the supplier cost." },
      ],
    },
  }), categories);

  await saveSupplierReviewDraft(
    fixture.db as never,
    "review-1",
    parseSupplierReviewDraftInput({
      categoryId: "home-kitchen",
      subcategoryId: "kitchen-tools",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
    }),
    { uid: "admin-1", email: "admin@example.test" },
  );

  const validation = fixture.collections.get("supplier_review_queue")!.get("review-1")!.productValidation as Stored;
  assert.deepEqual(validation.missingFields, []);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.readyToPublish, true);
});

test("taxonomy draft save removes resolved taxonomy warnings but keeps current import warnings", async () => {
  const fixture = createFakeDb(queueFixture({
    productValidation: {
      readyToPublish: false,
      missingFields: ["category", "subcategory"],
      errors: [{ field: "category", code: "invalid", message: "Select an active canonical Zyro category." }],
      warnings: [
        { field: "category", code: "missing_category", message: "The supplier category still requires an approved category mapping." },
        { field: "brand", code: "missing_brand", message: "The supplier did not provide a brand." },
      ],
    },
  }), categories);

  await saveSupplierReviewDraft(
    fixture.db as never,
    "review-1",
    parseSupplierReviewDraftInput({
      categoryId: "home-kitchen",
      subcategoryId: "kitchen-tools",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
    }),
    { uid: "admin-1", email: "admin@example.test" },
  );

  const validation = fixture.collections.get("supplier_review_queue")!.get("review-1")!.productValidation as Stored;
  assert.deepEqual(validation.warnings, [{ field: "brand", code: "missing_brand", message: "The supplier did not provide a brand." }]);
  assert.equal(validation.readyToPublish, true);
});

test("taxonomy draft save derives a real current blocker even when old metadata omitted it", async () => {
  const base = queueFixture();
  const fixture = createFakeDb(queueFixture({
    productPayload: {
      ...(base.productPayload as Stored),
      category: "supplier-derived",
      subcategory: "",
      description: "",
    },
    productValidation: {
      readyToPublish: false,
      missingFields: ["subcategory"],
      errors: [{ field: "subcategory", code: "invalid", message: "Select an active subcategory belonging to the category." }],
    },
  }), categories);

  await saveSupplierReviewDraft(
    fixture.db as never,
    "review-1",
    parseSupplierReviewDraftInput({
      categoryId: "home-kitchen",
      subcategoryId: "kitchen-tools",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
    }),
    { uid: "admin-1", email: "admin@example.test" },
  );

  const validation = fixture.collections.get("supplier_review_queue")!.get("review-1")!.productValidation as Stored;
  assert.deepEqual(validation.missingFields, ["description"]);
  assert.deepEqual(validation.errors, [{ field: "description", code: "required", message: "Full description is required." }]);
  assert.equal(validation.readyToPublish, false);
});

test("taxonomy draft save recomputes low-stock hold in both directions", async () => {
  const holdFixture = createFakeDb(queueFixture({
    sourceId: "dropex",
    supplierSnapshot: {
      ...(queueFixture().supplierSnapshot as Stored),
      providedFields: ["stock"],
    },
    productPayload: {
      ...(queueFixture().productPayload as Stored),
      stock: 5,
      category: "supplier-derived",
      subcategory: "",
    },
    productValidation: {
      readyToPublish: false,
      missingFields: ["stock", "subcategory"],
      errors: [
        { field: "stock", code: "LOW_SUPPLIER_STOCK_FOR_PUBLICATION", message: "Supplier stock must be at least 4 units before publication." },
        { field: "subcategory", code: "invalid", message: "Select an active subcategory belonging to the category." },
      ],
      lowStockHold: true,
    },
  }), categories);
  await saveSupplierReviewDraft(
    holdFixture.db as never,
    "review-1",
    parseSupplierReviewDraftInput({
      categoryId: "home-kitchen",
      subcategoryId: "kitchen-tools",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
    }),
    { uid: "admin-1", email: "admin@example.test" },
  );
  const released = holdFixture.collections.get("supplier_review_queue")!.get("review-1")!.productValidation as Stored;
  assert.equal(released.lowStockHold, false);
  assert.deepEqual(released.missingFields, []);
  assert.deepEqual(released.errors, []);
  assert.equal(released.readyToPublish, true);

  const newHoldFixture = createFakeDb(queueFixture({
    sourceId: "dropex",
    supplierSnapshot: {
      ...(queueFixture().supplierSnapshot as Stored),
      providedFields: ["stock"],
    },
    productPayload: {
      ...(queueFixture().productPayload as Stored),
      stock: 2,
      category: "supplier-derived",
      subcategory: "",
    },
    productValidation: {
      readyToPublish: true,
      missingFields: ["subcategory"],
      errors: [{ field: "subcategory", code: "invalid", message: "Select an active subcategory belonging to the category." }],
      lowStockHold: false,
    },
  }), categories);
  await saveSupplierReviewDraft(
    newHoldFixture.db as never,
    "review-1",
    parseSupplierReviewDraftInput({
      categoryId: "home-kitchen",
      subcategoryId: "kitchen-tools",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
    }),
    { uid: "admin-1", email: "admin@example.test" },
  );
  const held = newHoldFixture.collections.get("supplier_review_queue")!.get("review-1")!.productValidation as Stored;
  assert.equal(held.lowStockHold, true);
  assert.deepEqual(held.missingFields, ["stock"]);
  assert.deepEqual(held.errors, [{ field: "stock", code: "LOW_SUPPLIER_STOCK_FOR_PUBLICATION", message: "Supplier stock must be at least 4 units before publication." }]);
  assert.equal(held.readyToPublish, false);
});

test("taxonomy-only blocker becomes ready metadata without changing pending state", async () => {
  const base = queueFixture();
  const fixture = createFakeDb(queueFixture({
    productPayload: {
      ...(base.productPayload as Stored),
      category: "supplier-derived",
      subcategory: "",
    },
    productValidation: {
      readyToPublish: false,
      missingFields: ["category", "subcategory"],
      errors: [
        { field: "category", code: "invalid", message: "Select a category." },
        { field: "subcategory", code: "required", message: "Select a subcategory." },
      ],
    },
  }), categories);

  await saveSupplierReviewDraft(
    fixture.db as never,
    "review-1",
    parseSupplierReviewDraftInput({
      categoryId: "home-garden",
      subcategoryId: "household",
      expectedPendingRevision: REVISION,
      expectedUpdatedAt: UPDATED_AT,
    }),
    { uid: "admin-1", email: "admin@example.test" },
  );

  const saved = fixture.collections.get("supplier_review_queue")!.get("review-1")!;
  assert.deepEqual(saved.productValidation, { readyToPublish: true, missingFields: [], errors: [] });
  assert.equal(saved.queueState, "review_pending");
  assert.equal(saved.status, "Pending");
  assert.equal(fixture.collections.get("products")?.size || 0, 0);
});

test("taxonomy draft save rejects invalid taxonomy and stale queue tokens", async () => {
  const invalidCategory = createFakeDb(queueFixture(), categories);
  await assert.rejects(
    saveSupplierReviewDraft(
      invalidCategory.db as never,
      "review-1",
      parseSupplierReviewDraftInput({
        categoryId: "candidate",
        subcategoryId: "",
        expectedPendingRevision: REVISION,
        expectedUpdatedAt: UPDATED_AT,
      }),
      { uid: "admin-1", email: "admin@example.test" },
    ),
    /active canonical Zyro category/u,
  );

  const invalidSubcategory = createFakeDb(queueFixture(), categories);
  await assert.rejects(
    saveSupplierReviewDraft(
      invalidSubcategory.db as never,
      "review-1",
      parseSupplierReviewDraftInput({
        categoryId: "baby-kids",
        subcategoryId: "wrong-parent",
        expectedPendingRevision: REVISION,
        expectedUpdatedAt: UPDATED_AT,
      }),
      { uid: "admin-1", email: "admin@example.test" },
    ),
    /subcategory belonging to the category/u,
  );

  const stale = createFakeDb(queueFixture(), categories);
  const staleBefore = structuredClone(stale.collections.get("supplier_review_queue")!.get("review-1"));
  await assert.rejects(
    saveSupplierReviewDraft(
      stale.db as never,
      "review-1",
      parseSupplierReviewDraftInput({
        categoryId: "baby-kids",
        subcategoryId: "baby-toys",
        expectedPendingRevision: REVISION,
        expectedUpdatedAt: "2026-10-02T01:00:00.000Z",
      }),
      { uid: "admin-1", email: "admin@example.test" },
    ),
    /changed after it was opened/u,
  );
  assert.deepEqual(stale.collections.get("supplier_review_queue")!.get("review-1"), staleBefore);

  for (const field of [
    "costPrice",
    "price",
    "stock",
    "supplierProductId",
    "supplierOfferPendingRevision",
    "status",
    "approvalState",
    "published",
    "productId",
    "promotion",
    "title",
    "images",
  ]) {
    assert.throws(
      () => parseSupplierReviewDraftInput({
        categoryId: "baby-kids",
        subcategoryId: "baby-toys",
        expectedPendingRevision: REVISION,
        expectedUpdatedAt: UPDATED_AT,
        [field]: "smuggled",
      }),
      /unsupported fields/u,
      `payload field ${field} must be rejected`,
    );
  }

  const terminal = createFakeDb(queueFixture({ queueState: "approved", status: "Approved" }), categories);
  const terminalBefore = structuredClone(terminal.collections.get("supplier_review_queue")!.get("review-1"));
  await assert.rejects(
    saveSupplierReviewDraft(
      terminal.db as never,
      "review-1",
      parseSupplierReviewDraftInput({
        categoryId: "baby-kids",
        subcategoryId: "baby-toys",
        expectedPendingRevision: REVISION,
        expectedUpdatedAt: UPDATED_AT,
      }),
      { uid: "admin-1", email: "admin@example.test" },
    ),
    /Only a pending supplier review item/u,
  );
  assert.deepEqual(terminal.collections.get("supplier_review_queue")!.get("review-1"), terminalBefore);
});

test("taxonomy draft save rejects an inactive canonical category without mutation", async () => {
  const fixture = createFakeDb(queueFixture(), {
    ...categories,
    "inactive-category": {
      isActive: false,
      subcategories: [],
    },
  });
  const before = structuredClone(fixture.collections.get("supplier_review_queue")!.get("review-1"));
  await assert.rejects(
    saveSupplierReviewDraft(
      fixture.db as never,
      "review-1",
      parseSupplierReviewDraftInput({
        categoryId: "inactive-category",
        subcategoryId: "",
        expectedPendingRevision: REVISION,
        expectedUpdatedAt: UPDATED_AT,
      }),
      { uid: "admin-1", email: "admin@example.test" },
    ),
    /active canonical Zyro category/u,
  );
  assert.deepEqual(fixture.collections.get("supplier_review_queue")!.get("review-1"), before);
  assert.equal(fixture.collections.get("products")?.size || 0, 0);
  assert.equal(fixture.collections.get("supplier_product_offers")?.size || 0, 0);
});

test("taxonomy draft save rejects an inactive subcategory without mutation", async () => {
  const fixture = createFakeDb(queueFixture(), {
    ...categories,
    "baby-kids": {
      ...categories["baby-kids"],
      subcategories: [
        ...categories["baby-kids"].subcategories,
        { id: "inactive-toy", name: "Inactive Toy", isActive: false },
      ],
    },
  });
  const before = structuredClone(fixture.collections.get("supplier_review_queue")!.get("review-1"));
  await assert.rejects(
    saveSupplierReviewDraft(
      fixture.db as never,
      "review-1",
      parseSupplierReviewDraftInput({
        categoryId: "baby-kids",
        subcategoryId: "inactive-toy",
        expectedPendingRevision: REVISION,
        expectedUpdatedAt: UPDATED_AT,
      }),
      { uid: "admin-1", email: "admin@example.test" },
    ),
    /subcategory belonging to the category/u,
  );
  assert.deepEqual(fixture.collections.get("supplier_review_queue")!.get("review-1"), before);
});

test("taxonomy draft save rejects a missing required subcategory without ownership mutation", async () => {
  const fixture = createFakeDb(queueFixture(), categories);
  const before = structuredClone(fixture.collections.get("supplier_review_queue")!.get("review-1"));
  await assert.rejects(
    saveSupplierReviewDraft(
      fixture.db as never,
      "review-1",
      parseSupplierReviewDraftInput({
        categoryId: "baby-kids",
        subcategoryId: "",
        expectedPendingRevision: REVISION,
        expectedUpdatedAt: UPDATED_AT,
      }),
      { uid: "admin-1", email: "admin@example.test" },
    ),
    /subcategory belonging to the category/u,
  );
  assert.deepEqual(fixture.collections.get("supplier_review_queue")!.get("review-1"), before);
  assert.deepEqual(
    ((fixture.collections.get("supplier_review_queue")!.get("review-1")!.productPayload as Stored).supplierFieldOwnership),
    (before?.productPayload as Stored).supplierFieldOwnership,
  );
});

test("taxonomy draft save rejects a valid-looking stale expectedPendingRevision independently", async () => {
  const fixture = createFakeDb(queueFixture({ supplierOfferPendingRevision: "b".repeat(64) }), categories);
  const before = structuredClone(fixture.collections.get("supplier_review_queue")!.get("review-1"));
  await assert.rejects(
    saveSupplierReviewDraft(
      fixture.db as never,
      "review-1",
      parseSupplierReviewDraftInput({
        categoryId: "baby-kids",
        subcategoryId: "baby-toys",
        expectedPendingRevision: REVISION,
        expectedUpdatedAt: UPDATED_AT,
      }),
      { uid: "admin-1", email: "admin@example.test" },
    ),
    /changed after it was opened/u,
  );
  assert.deepEqual(fixture.collections.get("supplier_review_queue")!.get("review-1"), before);
});

test("supplier refresh preserves only admin-owned taxonomy", () => {
  const preserved = preserveAdminOwnedReviewTaxonomy(
    {
      category: "supplier-category",
      subcategory: "supplier-subcategory",
      price: 2750,
      stock: 4,
    },
    {
      category: "baby-kids",
      subcategory: "baby-toys",
      supplierFieldOwnership: {
        category: { owner: "admin", sourceId: null },
        subcategory: { owner: "admin", sourceId: null },
      },
    },
  );
  assert.equal(preserved.category, "baby-kids");
  assert.equal(preserved.subcategory, "baby-toys");
  assert.equal(preserved.price, 2750);
  assert.equal(preserved.stock, 4);

  const supplierOwned = preserveAdminOwnedReviewTaxonomy(
    { category: "fresh-supplier-category", subcategory: "fresh-supplier-subcategory" },
    {
      category: "old-admin-category",
      subcategory: "old-admin-subcategory",
      supplierFieldOwnership: {
        category: { owner: "supplier", sourceId: "dropex" },
        subcategory: { owner: "supplier", sourceId: "dropex" },
      },
    },
  );
  assert.equal(supplierOwned.category, "fresh-supplier-category");
  assert.equal(supplierOwned.subcategory, "fresh-supplier-subcategory");

  const mixedCategoryAdmin = preserveAdminOwnedReviewTaxonomy(
    { category: "fresh-supplier-category", subcategory: "fresh-supplier-subcategory", price: 1700, stock: 5 },
    {
      category: "baby-kids",
      subcategory: "old-supplier-subcategory",
      supplierFieldOwnership: {
        category: { owner: "admin", sourceId: null },
        subcategory: { owner: "supplier", sourceId: "dropex" },
      },
    },
  );
  assert.equal(mixedCategoryAdmin.category, "baby-kids");
  assert.equal(mixedCategoryAdmin.subcategory, "fresh-supplier-subcategory");
  assert.equal(mixedCategoryAdmin.price, 1700);
  assert.equal(mixedCategoryAdmin.stock, 5);

  const mixedSubcategoryAdmin = preserveAdminOwnedReviewTaxonomy(
    { category: "fresh-supplier-category", subcategory: "fresh-supplier-subcategory" },
    {
      category: "old-supplier-category",
      subcategory: "baby-toys",
      supplierFieldOwnership: {
        category: { owner: "supplier", sourceId: "dropex" },
        subcategory: { owner: "admin", sourceId: null },
      },
    },
  );
  assert.equal(mixedSubcategoryAdmin.category, "fresh-supplier-category");
  assert.equal(mixedSubcategoryAdmin.subcategory, "baby-toys");

  const clearedSubcategory = preserveAdminOwnedReviewTaxonomy(
    { category: "fresh-supplier-category", subcategory: "stale-supplier-subcategory", price: 1700, stock: 5 },
    {
      category: "baby-kids",
      subcategory: "",
      supplierFieldOwnership: {
        category: { owner: "admin", sourceId: null },
        subcategory: { owner: "admin", sourceId: null },
      },
    },
  );
  assert.equal(clearedSubcategory.category, "baby-kids");
  assert.equal(clearedSubcategory.subcategory, "");
  assert.equal(clearedSubcategory.price, 1700);
  assert.equal(clearedSubcategory.stock, 5);
});

test("real draft save, supplier refresh, and approval preserve Admin taxonomy while updating R2 commerce", async () => {
  const fixture = createReviewFlowFixture();
  const reviewer = { uid: "admin-1", email: "admin@example.test" };
  await saveSupplierReviewDraft(
    fixture.db as never,
    fixture.queueItemId,
    parseSupplierReviewDraftInput({
      categoryId: "baby-kids",
      subcategoryId: "baby-toys",
      expectedPendingRevision: fixture.initialPending.revision,
      expectedUpdatedAt: UPDATED_AT,
    }),
    reviewer,
  );

  const afterDraft = fixture.db.collections.get("supplier_review_queue")!.get(fixture.queueItemId)!;
  const afterDraftPayload = afterDraft.productPayload as Stored;
  assert.equal(afterDraft.queueState, "review_pending");
  assert.equal(afterDraftPayload.category, "baby-kids");
  assert.equal(afterDraftPayload.subcategory, "baby-toys");
  assert.equal((afterDraftPayload.supplierFieldOwnership as Stored).category && ((afterDraftPayload.supplierFieldOwnership as Stored).category as Stored).owner, "admin");
  assert.equal(afterDraft.supplierOfferPendingRevision, fixture.initialPending.revision);

  const freshProduct = {
    supplierProductId: fixture.supplierProductId,
    sku: fixture.supplierSku,
    title: "Fresh AZK1690",
    longDescription: "Fresh supplier description",
    mediaGallery: [fixture.mediaUrl],
    wholesalePrice: 1000,
    recommendedRetailPrice: 1700,
    price: 1700,
    inventoryLevel: 5,
    availability: "in_stock",
    supplierCategory: "Fresh Supplier Category",
    categoryHierarchy: ["Fresh Supplier Category", "Fresh Supplier Subcategory"],
    specifications: { Model: "AZK1690" },
    providedFields: [
      "costPrice", "wholesalePrice", "stock", "inventoryLevel", "title", "longDescription",
      "mediaGallery", "price", "comparePrice", "categoryHierarchy", "specifications",
    ],
  };
  const originalCreateConnector = SupplierRegistry.createConnectorForSourceRecord;
  let lookupCount = 0;
  try {
    SupplierRegistry.createConnectorForSourceRecord = async () => ({
      id: "dropex",
      name: "Dropex",
      connectorType: "dropex",
      enabled: true,
      priority: 100,
      capabilities: [],
      fetchProducts: async () => ({ products: [], targetUrl: "" }),
      fetchProductPage: async () => ({ products: [], targetUrl: "", nextCursor: null, complete: true }),
      testConnection: async () => ({ success: true, status: "Connected", productsCount: 0, sampleProduct: null }),
      fetchExactProductForRefresh: async (target: { supplierProductId: string; sku: string }) => {
        lookupCount += 1;
        assert.deepEqual(target, { supplierProductId: fixture.supplierProductId, sku: fixture.supplierSku });
        return freshProduct;
      },
    } as never);

    const refreshed = await withPatchedAdminDb(fixture.db, () => refreshActiveSupplierReviewItem(
      fixture.queueItemId,
      reviewer,
      {},
      fixture.db as never,
    ));
    const refreshedPayload = refreshed.item.productPayload as Stored;
    const refreshedOffer = fixture.db.collections.get("supplier_product_offers")!.get(fixture.offerId)!;
    assert.equal(lookupCount, 1);
    assert.equal(refreshed.item.queueState, "review_pending");
    assert.notEqual(refreshed.item.supplierOfferPendingRevision, fixture.initialPending.revision);
    assert.equal(refreshedPayload.category, "baby-kids");
    assert.equal(refreshedPayload.subcategory, "baby-toys");
    assert.equal(refreshedPayload.costPrice, 1000);
    assert.equal(refreshedPayload.price, 1700);
    assert.equal(refreshedPayload.stock, 5);
    assert.deepEqual((refreshedPayload.supplierFieldOwnership as Stored).category, (afterDraftPayload.supplierFieldOwnership as Stored).category);
    assert.equal(refreshedOffer.cost, 1000);
    assert.equal(refreshedOffer.price, 1700);
    assert.equal(refreshedOffer.stock, 5);
    assert.equal(fixture.db.collections.get("products")?.size || 0, 0);

    const approved = await withPatchedAdminDb(fixture.db, () => decideSupplierQueueItem(
      fixture.db as never,
      fixture.queueItemId,
      "approved",
      reviewer,
      { expectedPendingRevision: refreshed.item.supplierOfferPendingRevision },
    ));
    assert.equal("idempotent" in approved ? approved.idempotent : undefined, undefined);
    assert.ok("productId" in approved && approved.productId);
    assert.equal(fixture.db.collections.get("products")?.size, 1);
    const published = [...fixture.db.collections.get("products")!.values()][0];
    assert.equal(published.category, "baby-kids");
    assert.equal(published.subcategory, "baby-toys");
    assert.equal(fixture.db.collections.get("supplier_review_queue")!.get(fixture.queueItemId)!.status, "Approved");
  } finally {
    SupplierRegistry.createConnectorForSourceRecord = originalCreateConnector;
  }
});

test("NEW_PRODUCT provisional payload ids do not become canonical linkage claims", async () => {
  const fixture = createReviewFlowFixture();
  const originalCreateConnector = SupplierRegistry.createConnectorForSourceRecord;
  try {
    SupplierRegistry.createConnectorForSourceRecord = async () => ({
      id: "dropex",
      name: "Dropex",
      connectorType: "dropex",
      enabled: true,
      priority: 100,
      capabilities: [],
      fetchProducts: async () => ({ products: [], targetUrl: "" }),
      fetchProductPage: async () => ({ products: [], targetUrl: "", nextCursor: null, complete: true }),
      testConnection: async () => ({ success: true, status: "Connected", productsCount: 0, sampleProduct: null }),
      fetchExactProductForRefresh: async () => ({
        supplierProductId: fixture.supplierProductId,
        sku: fixture.supplierSku,
        title: "Fresh AZK1690",
        longDescription: "Fresh supplier description",
        mediaGallery: [fixture.mediaUrl],
        wholesalePrice: 1000,
        recommendedRetailPrice: 1700,
        price: 1700,
        inventoryLevel: 5,
        availability: "in_stock",
        providedFields: ["wholesalePrice", "price", "inventoryLevel"],
      }),
    } as never);
    const refreshed = await withPatchedAdminDb(fixture.db, () => refreshActiveSupplierReviewItem(
      fixture.queueItemId,
      { uid: "admin-1", email: "admin@example.test" },
      {},
      fixture.db as never,
    ));
    assert.equal(refreshed.item.queueState, "review_pending");
    assert.equal((refreshed.item.productPayload as Stored).costPrice, 1000);
    assert.equal((refreshed.item.productPayload as Stored).price, 1700);
    assert.equal((refreshed.item.productPayload as Stored).id, "fresh-azk1690");
    assert.equal(refreshed.item.canonicalProductId, undefined);
    assert.equal(refreshed.item.productId, undefined);
  } finally {
    SupplierRegistry.createConnectorForSourceRecord = originalCreateConnector;
  }
});

test("explicit and partial canonical claims remain fail-closed for refresh", async () => {
  const scenarios: Array<{ name: string; mutate: (queue: Stored, offer: Stored) => void }> = [
    {
      name: "explicit canonicalProductId mismatch",
      mutate: (queue) => { queue.canonicalProductId = "claimed-canonical"; },
    },
    {
      name: "existing linked product mismatch",
      mutate: (queue, offer) => {
        queue.comparisonStatus = "EXISTING_PRODUCT";
        queue.comparison = { comparisonStatus: "EXISTING_PRODUCT", status: "EXISTING_PRODUCT", matchFound: true };
        queue.canonicalProductId = "claimed-canonical";
        offer.productId = "different-canonical";
      },
    },
    {
      name: "explicit matchedProductId mismatch",
      mutate: (queue) => { queue.matchedProductId = "claimed-matched-product"; },
    },
    {
      name: "ambiguous partial product linkage",
      mutate: (queue) => { queue.productId = "partial-canonical"; },
    },
    {
      name: "ambiguous comparison matchedProductId linkage",
      mutate: (queue) => {
        queue.comparison = {
          comparisonStatus: "NEW_PRODUCT",
          status: "NEW_PRODUCT",
          matchFound: false,
          matchedProductId: "partial-comparison-canonical",
        };
      },
    },
  ];

  for (const scenario of scenarios) {
    const fixture = createReviewFlowFixture();
    const queue = fixture.db.collections.get("supplier_review_queue")!.get(fixture.queueItemId)!;
    const offer = fixture.db.collections.get("supplier_product_offers")!.get(fixture.offerId)!;
    scenario.mutate(queue, offer);
    const beforeQueue = structuredClone(queue);
    await assert.rejects(
      withPatchedAdminDb(fixture.db, () => refreshActiveSupplierReviewItem(
        fixture.queueItemId,
        { uid: "admin-1", email: "admin@example.test" },
        {},
        fixture.db as never,
      )),
      /review item and supplier offer identities are inconsistent/u,
      scenario.name,
    );
    assert.deepEqual(fixture.db.collections.get("supplier_review_queue")!.get(fixture.queueItemId), beforeQueue, scenario.name);
    assert.equal(fixture.db.collections.get("products")?.size || 0, 0, scenario.name);
  }
});

test("ATF0081-style taxonomy save remains fail closed when supplier truth is unresolved", async () => {
  const fixture = createReviewFlowFixture();
  const reviewer = { uid: "admin-1", email: "admin@example.test" };
  await saveSupplierReviewDraft(
    fixture.db as never,
    fixture.queueItemId,
    parseSupplierReviewDraftInput({
      categoryId: "baby-kids",
      subcategoryId: "baby-toys",
      expectedPendingRevision: fixture.initialPending.revision,
      expectedUpdatedAt: UPDATED_AT,
    }),
    reviewer,
  );
  const beforeApproval = structuredClone(fixture.db.collections.get("supplier_review_queue")!.get(fixture.queueItemId));
  const originalCreateConnector = SupplierRegistry.createConnectorForSourceRecord;
  try {
    SupplierRegistry.createConnectorForSourceRecord = async () => ({
      id: "dropex",
      name: "Dropex",
      connectorType: "dropex",
      enabled: true,
      priority: 100,
      capabilities: [],
      fetchProducts: async () => ({ products: [], targetUrl: "" }),
      fetchProductPage: async () => ({ products: [], targetUrl: "", nextCursor: null, complete: true }),
      testConnection: async () => ({ success: true, status: "Connected", productsCount: 0, sampleProduct: null }),
      fetchExactProductForRefresh: async () => ({
        supplierProductId: fixture.supplierProductId,
        sku: fixture.supplierSku,
        title: "Unresolved AZK1690",
        wholesalePrice: undefined,
        price: undefined,
        inventoryLevel: undefined,
        availability: "unknown",
        mediaGallery: [fixture.mediaUrl],
        providedFields: [],
      }),
    } as never);

    await assert.rejects(
      withPatchedAdminDb(fixture.db, () => decideSupplierQueueItem(
        fixture.db as never,
        fixture.queueItemId,
        "approved",
        reviewer,
        { expectedPendingRevision: fixture.initialPending.revision },
      )),
      /Current supplier data could not be verified/u,
    );
    assert.deepEqual(fixture.db.collections.get("supplier_review_queue")!.get(fixture.queueItemId), beforeApproval);
    assert.equal(fixture.db.collections.get("products")?.size || 0, 0);
  } finally {
    SupplierRegistry.createConnectorForSourceRecord = originalCreateConnector;
  }
});

test("Save Changes is separate from approval and sends the narrow draft route", () => {
  const editor = readFileSync("src/components/SupplierReviewEditorModal.tsx", "utf8");
  const hub = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");
  assert.match(editor, /Save Changes/u);
  assert.match(editor, /onSaveDraft\(\{ category: draft\.category, subcategory: String\(draft\.subcategory \|\| ''\) \}\)/u);
  assert.match(hub, /patchSupplierApi\(`\/api\/supplier-review-queue\/\$\{encodeURIComponent\(item\.id\)\}\/draft`/u);
  assert.match(hub, /expectedPendingRevision: item\.supplierOfferPendingRevision/u);
  assert.match(hub, /expectedUpdatedAt: item\.updatedAt/u);
  const routes = readFileSync("functions/src/api/routes/supplier.ts", "utf8");
  assert.match(routes, /app\.patch\("\/api\/supplier-review-queue\/:queueItemId\/draft", requireSupplierHubAdmin/u);
  assert.match(routes, /status: "review_pending"/u);
  assert.doesNotMatch(hub.slice(hub.indexOf("const handleSaveSupplierReviewDraft"), hub.indexOf("const handleRefreshPendingReviewBatch")), /decideSupplierReviewQueueItem/u);
});
