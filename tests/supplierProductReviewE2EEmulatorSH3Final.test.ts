import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import type { RawA2ZProduct } from "../functions/src/api/suppliers/a2z/types";
import type {
  SupplierCatalogPageRequest,
  SupplierCatalogPageResult,
  SupplierConnector,
  SupplierSourceConfig,
} from "../functions/src/api/suppliers/types";
import {
  createSupplierReviewDraft,
  SupplierReviewDraft,
  SupplierReviewSourceItem,
} from "../src/services/supplierReviewEditor";

// functions/ is a CommonJS package in the Node 20 production runtime. Keep
// stateful Functions modules in one CommonJS cache so the connector registered
// by this test is the same SupplierRegistry instance used by runSupplierSync.
const requireFunctions = createRequire(import.meta.url);
const { adminDb } = requireFunctions("../functions/src/api/firebase.ts") as typeof import("../functions/src/api/firebase");
const {
  decideSupplierQueueItem,
  parseSupplierApprovalDraft,
} = requireFunctions("../functions/src/api/suppliers/supplierApproval.ts") as typeof import("../functions/src/api/suppliers/supplierApproval");
const { SupplierRegistry } = requireFunctions("../functions/src/api/suppliers/SupplierRegistry.ts") as typeof import("../functions/src/api/suppliers/SupplierRegistry");
const { ProductParser } = requireFunctions("../functions/src/api/suppliers/a2z/ProductParser.ts") as typeof import("../functions/src/api/suppliers/a2z/ProductParser");
const { SERVER_FILTERED_FULL_CATALOG_CAPABILITIES } = requireFunctions("../functions/src/api/suppliers/supplierSyncCapabilities.ts") as typeof import("../functions/src/api/suppliers/supplierSyncCapabilities");
const {
  listSupplierQueuePage,
  processSupplierReviewQueueItem,
} = requireFunctions("../functions/src/scheduled/supplierReviewQueue.ts") as typeof import("../functions/src/scheduled/supplierReviewQueue");
const { runSupplierSync } = requireFunctions("../functions/src/scheduled/supplierSync.ts") as typeof import("../functions/src/scheduled/supplierSync");
const { buildZyroSkuClaimId } = requireFunctions("../functions/src/api/suppliers/supplierProductIdentity.ts") as typeof import("../functions/src/api/suppliers/supplierProductIdentity");
const { createAdminProduct } = requireFunctions("../functions/src/api/products/adminProductManagement.ts") as typeof import("../functions/src/api/products/adminProductManagement");

const canRun = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const CONNECTOR_TYPE = "sh3-product-review-e2e";
const TARGET_URL = "https://1.1.1.1/catalog";
const RUN_PREFIX = randomUUID().slice(0, 8);

type PageHandler = (request: SupplierCatalogPageRequest) => SupplierCatalogPageResult;
const connectorFixtures = new Map<string, PageHandler>();

SupplierRegistry.registerConnectorFactory(
  CONNECTOR_TYPE,
  (targetUrl: string, source: SupplierSourceConfig): SupplierConnector => ({
    id: source.id,
    name: source.name,
    connectorType: source.connectorType,
    enabled: source.enabled,
    priority: source.priority,
    capabilities: source.capabilities,
    syncCapabilities: SERVER_FILTERED_FULL_CATALOG_CAPABILITIES,
    async fetchProductPage(request) {
      const page = connectorFixtures.get(source.id);
      if (!page) throw new Error(`Missing SH-3 Product Review connector fixture for ${source.id}.`);
      return page(request);
    },
    async fetchProducts() {
      const page = await this.fetchProductPage({ cursor: null, pageSize: 20, mode: "full" });
      return { products: page.products, targetUrl };
    },
    async testConnection() {
      return { success: true, status: "Connected", productsCount: 1, sampleProduct: null };
    },
  }),
  SERVER_FILTERED_FULL_CATALOG_CAPABILITIES,
);

const identityFor = (label: string): string => `sh3-${RUN_PREFIX}-${label}`;

const barcodeFor = (identity: string): string => Array.from(
  createHash("sha256").update(identity).digest().subarray(0, 13),
  (value) => String(value % 10),
).join("");

const supplierProduct = (
  identity: string,
  overrides: Record<string, unknown> = {},
): RawA2ZProduct => ProductParser.parseJsonPayload({
  supplierProductId: `${identity}-supplier-product`,
  sku: `${identity}-sku`,
  barcode: barcodeFor(identity),
  title: `${identity} supplier product`,
  shortDescription: "Supplier short description.",
  longDescription: "Supplier approved description.",
  mediaGallery: [`https://supplier.example/${identity}.jpg`],
  price: 150,
  costPrice: 100,
  wholesalePrice: 100,
  recommendedRetailPrice: 150,
  inventoryLevel: 12,
  availability: "available",
  brand: "Test Brand",
  supplierCategory: "Electronics",
  supplierSubcategory: "Phones",
  categoryHierarchy: ["Electronics", "Phones"],
  specifications: { Model: identity, Brand: "Test Brand", RAM: "8 GB" },
  ...overrides,
});

const assertApprovedCommerceFieldsUnchanged = (
  actual: Record<string, unknown>,
  baseline: Record<string, unknown>,
): void => {
  assert.equal(actual.name, baseline.name);
  assert.equal(actual.description, baseline.description);
  assert.equal(actual.price, baseline.price);
  assert.equal(actual.category, baseline.category);
  assert.equal(actual.subcategory, baseline.subcategory);
  assert.equal(actual.brand, baseline.brand);
  assert.deepEqual(actual.specs, baseline.specs);
};

const completePage = (products: RawA2ZProduct[]): SupplierCatalogPageResult => ({
  products,
  targetUrl: TARGET_URL,
  nextCursor: null,
  complete: true,
  catalogTotal: { count: products.length, reliability: "exact" },
});

const configureConnector = (sourceId: string, products: RawA2ZProduct[]): void => {
  connectorFixtures.set(sourceId, () => completePage(products));
};

const seedSource = async (identity: string): Promise<{ sourceId: string; supplierId: string }> => {
  const sourceId = `${identity}-source`;
  const supplierId = `${identity}-supplier`;
  await Promise.all([
    adminDb.collection("supplierSources").doc(sourceId).set({
      supplierId,
      supplierAccountId: supplierId,
      supplierName: `${identity} Supplier`,
      connectorType: CONNECTOR_TYPE,
      supplierType: "website",
      sourceStatus: "active",
      enabled: true,
      priority: 100,
      websiteUrl: TARGET_URL,
      endpoint: "",
      authentication: { mode: "none" },
      capabilities: ["catalog.fetch", "connection.test"],
      settings: { autoSync: "Off", productLimit: 20 },
    }),
    adminDb.collection("users").doc(supplierId).set({ role: "supplier", email: `${supplierId}@example.test` }),
    adminDb.collection("supplier_profiles").doc(supplierId).set({
      supplierId,
      companyName: `${identity} Supplier`,
      profileStatus: "active",
    }),
    adminDb.collection("categories").doc("electronics").set({
      name: "Electronics",
      isActive: true,
      keywords: ["electronics"],
      subcategories: [{ id: "phones", name: "Phones", isActive: true }],
      specificationTemplate: [{ name: "Model", required: true }],
    }),
    adminDb.collection("brands").doc("test-brand").set({
      name: "Test Brand",
      isActive: true,
      aliases: ["TEST BRAND"],
    }),
    adminDb.collection("supplier_settings").doc("config").set({
      autoSyncEnabled: false,
      defaultMarkup: 30,
      defaultProfitMargin: 20,
      maxProducts: 200,
      productLimit: 20,
      defaultImageLimit: 10,
      categoryMappings: { electronics: "electronics" },
    }, { merge: true }),
  ]);
  return { sourceId, supplierId };
};

const runFullSync = (sourceId: string, batchLabel: string) => runSupplierSync({
  trigger: "manual",
  sourceIds: [sourceId],
  batchId: `${RUN_PREFIX}-${batchLabel}`,
  syncRequest: { mode: "full", pageSize: 20 },
  maxRuntimeMs: 60_000,
});

const activeReviewForSource = async (sourceId: string) => {
  const snapshot = await adminDb.collection("supplier_review_queue").where("sourceId", "==", sourceId).get();
  const active = snapshot.docs.filter((document) => ![
    "approved",
    "rejected",
    "suppressed",
  ].includes(String(document.data().queueState || "").toLowerCase()));
  assert.equal(active.length, 1, `Expected one active Product Review for ${sourceId}.`);
  return active[0];
};

const managedMedia = (identity: string) => {
  const contentHash = createHash("sha256").update(identity).digest("hex");
  return [{
    assetId: contentHash,
    supplierId: `${identity}-supplier`,
    sourceId: `${identity}-source`,
    productId: `${identity}-product`,
    originalSupplierUrl: `https://supplier.example/${identity}.jpg`,
    originalStoragePath: `supplier-media/${identity}/original/product.jpg`,
    originalStorageUrl: `https://storage.example/${identity}-original.jpg`,
    firebaseStorageUrl: `https://storage.example/${identity}-large.webp`,
    contentHash,
    width: 1200,
    height: 1200,
    mimeType: "image/jpeg",
    fileSize: 1_000,
    uploadTimestamp: "2026-08-02T00:00:00.000Z",
    imageStatus: "ready",
    isPrimary: true,
    sortOrder: 0,
    variants: {
      thumbnail: {
        storagePath: `${identity}/thumbnail.webp`,
        storageUrl: `https://storage.example/${identity}-thumbnail.webp`,
        width: 200,
        height: 200,
        mimeType: "image/webp",
        fileSize: 100,
      },
      medium: {
        storagePath: `${identity}/medium.webp`,
        storageUrl: `https://storage.example/${identity}-medium.webp`,
        width: 800,
        height: 800,
        mimeType: "image/webp",
        fileSize: 500,
      },
      large: {
        storagePath: `${identity}/large.webp`,
        storageUrl: `https://storage.example/${identity}-large.webp`,
        width: 1200,
        height: 1200,
        mimeType: "image/webp",
        fileSize: 800,
      },
    },
  }];
};

const prepareReview = async (reviewId: string, identity: string): Promise<Record<string, unknown>> => {
  await adminDb.collection("supplier_review_queue").doc(reviewId).set({
    managedMedia: managedMedia(identity),
    mediaStatus: "ready",
  }, { merge: true });
  const result = await processSupplierReviewQueueItem(
    adminDb,
    reviewId,
    `sh3-worker-${identity}`,
    Date.now(),
  );
  assert.deepEqual(result, { queueItemId: reviewId, outcome: "completed", state: "review_pending" });
  return (await adminDb.collection("supplier_review_queue").doc(reviewId).get()).data()!;
};

const reviewSourceItem = (id: string, data: Record<string, unknown>): SupplierReviewSourceItem => ({
  id,
  productName: String(data.productName || ""),
  supplierCode: String(data.supplierCode || ""),
  supplierName: String(data.supplierName || ""),
  costPrice: Number(data.costPrice || 0),
  marketPrice: Number(data.marketPrice || 0),
  stock: Number(data.stock || 0),
  imageUrl: String(data.imageUrl || ""),
  sourceId: String(data.sourceId || ""),
  supplierOfferId: String(data.supplierOfferId || ""),
  productPayload: data.productPayload as SupplierReviewSourceItem["productPayload"],
  supplierSnapshot: data.supplierSnapshot as Record<string, unknown>,
  managedMedia: data.managedMedia as Array<Record<string, unknown>>,
  mediaStatus: String(data.mediaStatus || ""),
  categoryMapping: data.categoryMapping as SupplierReviewSourceItem["categoryMapping"],
  brandMapping: data.brandMapping as SupplierReviewSourceItem["brandMapping"],
  productValidation: data.productValidation as SupplierReviewSourceItem["productValidation"],
  comparison: data.comparison as SupplierReviewSourceItem["comparison"],
});

const approvalDraft = (
  reviewId: string,
  data: Record<string, unknown>,
  overrides: Partial<SupplierReviewDraft> = {},
) => {
  const draft = createSupplierReviewDraft(reviewSourceItem(reviewId, data));
  const managedAssets = Array.isArray(data.managedMedia)
    ? data.managedMedia as Array<Record<string, unknown>>
    : [];
  const managedPrimaryUrl = String(managedAssets[0]?.firebaseStorageUrl || "").trim();
  const supplierImageFallback = `https://supplier.example/${String(data.supplierSnapshot && (data.supplierSnapshot as Record<string, unknown>).supplierProductId || reviewId).replace(/-supplier-product$/u, "")}.jpg`;
  return parseSupplierApprovalDraft({
    ...draft,
    ...overrides,
    description: String(overrides.description || draft.description || "").trim() || "Supplier approved description for emulator review.",
    primaryImageUrl: managedPrimaryUrl || supplierImageFallback,
    galleryImageUrls: managedAssets.slice(1).map((asset) => String(asset.firebaseStorageUrl || "").trim()).filter(Boolean),
  })!;
};

const sh4ApprovalDraft = (reviewId: string, data: Record<string, unknown>) => approvalDraft(reviewId, data, {
  category: "electronics",
  subcategory: "phones",
  brand: "test-brand",
  specifications: {
    Model: String((data.supplierSnapshot as Record<string, unknown> | undefined)?.supplierProductId || reviewId),
  },
});

const pendingRevisionForReview = async (review: FirebaseFirestore.QueryDocumentSnapshot): Promise<string> => {
  const offerId = String(review.data().supplierOfferId || "");
  const offer = (await adminDb.collection("supplier_product_offers").doc(offerId).get()).data()!;
  const revision = String((offer.pendingObservation as Record<string, unknown> | undefined)?.revision || "");
  assert.match(revision, /^[a-f0-9]{64}$/u);
  return revision;
};

const auditActions = async (reviewId: string): Promise<string[]> => {
  const audit = await adminDb.collection("supplier_approval_audit")
    .where("queueItemId", "==", reviewId)
    .orderBy("timestamp", "asc")
    .get();
  return audit.docs.map((document) => String(document.data().action || ""));
};

test("SH-3 new and updated products use the real review worker and approval transaction", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
  timeout: 240_000,
}, async (t) => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || "", /^(127\.0\.0\.1|localhost):\d+$/u);

  await t.test("new product remains private until exact-revision approval", async () => {
    const identity = identityFor("new-approve");
    const { sourceId } = await seedSource(identity);
    const observed = supplierProduct(identity);
    configureConnector(sourceId, [observed]);

    const sync = await runFullSync(sourceId, "new-approve-sync");
    assert.equal(sync.status, "Success");
    const review = await activeReviewForSource(sourceId);
    const queued = review.data();
    assert.equal(queued.comparisonStatus, "NEW_PRODUCT");
    assert.equal(queued.supplierCode, observed.sku);
    assert.equal(queued.supplierSnapshot.supplierProductId, observed.supplierProductId);
    assert.equal((await adminDb.collection("products").doc(String(queued.productId)).get()).exists, false);

    const listed = await listSupplierQueuePage(adminDb, {
      view: "review",
      state: "active",
      businessFilter: "new_products",
      limit: 10,
    });
    assert.ok(listed.items.some((item) => item.id === review.id));

    const ready = await prepareReview(review.id, identity);
    const revision = await pendingRevisionForReview(review);
    const originalEvidence = structuredClone(ready.supplierSnapshot);
    const draft = approvalDraft(review.id, ready, {
      productName: `${identity} admin product name`,
      description: "Admin-owned product description.",
      sellingPrice: 175,
      comparePrice: 200,
      costPrice: 105,
      marketPrice: 200,
      category: "electronics",
      subcategory: "phones",
      brand: "test-brand",
      specifications: { Model: identity, RAM: "8 GB" },
      metaDescription: "Admin SEO description for the approved product.",
      keywords: ["electronics", "Sri Lanka"],
      isActive: true,
      isNew: true,
      isFeatured: true,
      isBestSeller: true,
      fieldOwnership: {
        ...createSupplierReviewDraft(reviewSourceItem(review.id, ready)).fieldOwnership,
        name: "admin",
        description: "admin",
        price: "admin",
        originalPrice: "admin",
        costPrice: "admin",
        marketPrice: "admin",
        category: "admin",
        subcategory: "admin",
        brand: "admin",
        specs: "admin",
        metaDescription: "admin",
        keywords: "admin",
        isActive: "admin",
      },
      editedFields: [
        "name", "description", "price", "originalPrice", "costPrice", "marketPrice",
        "category", "subcategory", "brand", "specs", "metaDescription", "keywords",
        "isActive", "isNew", "isFeatured", "isBestSeller",
      ],
    });
    assert.deepEqual((await adminDb.collection("supplier_review_queue").doc(review.id).get()).data()?.supplierSnapshot, originalEvidence);

    const result = await decideSupplierQueueItem(adminDb, review.id, "approved", {
      uid: "sh3-admin",
      email: "admin@example.test",
    }, { draft, expectedPendingRevision: revision });
    assert.equal(result.success, true);
    const product = (await adminDb.collection("products").doc(result.productId!).get()).data()!;
    const privateProduct = (await adminDb.collection("product_private").doc(result.productId!).get()).data()!;
    const approvedReview = (await adminDb.collection("supplier_review_queue").doc(review.id).get()).data()!;
    const offer = (await adminDb.collection("supplier_product_offers").doc(String(queued.supplierOfferId)).get()).data()!;
    assert.equal(product.name, `${identity} admin product name`);
    assert.equal(product.description, "Admin-owned product description.");
    assert.equal(product.price, 175);
    assert.equal(product.originalPrice, 200);
    assert.equal(product.category, "electronics");
    assert.equal(product.brand, "test-brand");
    assert.equal(product.metaDescription, "Admin SEO description for the approved product.");
    assert.deepEqual(product.keywords, ["electronics", "Sri Lanka"]);
    assert.equal(product.isFeatured, true);
    assert.equal(product.isBestSeller, true);
    assert.equal(privateProduct.costPrice, 105);
    assert.equal(privateProduct.marketPrice, 200);
    assert.equal(offer.reviewStatus, "approved");
    assert.equal(offer.pendingObservation, null);
    assert.equal(approvedReview.queueState, "approved");
    const approvedEvidence = { ...(approvedReview.supplierSnapshot as Record<string, unknown>) };
    delete approvedEvidence.supplierOfferId;
    delete approvedEvidence.canonicalProductId;
    assert.deepEqual(approvedEvidence, originalEvidence);
    assert.ok((await auditActions(review.id)).includes("approve"));
  });

  await t.test("new product rejection remains private and records the exact terminal decision", async () => {
    const identity = identityFor("new-reject");
    const { sourceId } = await seedSource(identity);
    configureConnector(sourceId, [supplierProduct(identity)]);

    const sync = await runFullSync(sourceId, "new-reject-sync");
    assert.equal(sync.status, "Success");
    const review = await activeReviewForSource(sourceId);
    const ready = await prepareReview(review.id, identity);
    const revision = await pendingRevisionForReview(review);
    const productId = String(ready.productId || "");
    const offerId = String(ready.supplierOfferId || "");

    const result = await decideSupplierQueueItem(adminDb, review.id, "rejected", {
      uid: "sh3-admin",
      email: "admin@example.test",
    }, {
      rejectionReason: "This supplier product is not suitable for the catalogue.",
      expectedPendingRevision: revision,
    });

    assert.equal(result.success, true);
    assert.equal((await adminDb.collection("products").doc(productId).get()).exists, false);
    const rejectedReview = (await adminDb.collection("supplier_review_queue").doc(review.id).get()).data()!;
    const rejectedOffer = (await adminDb.collection("supplier_product_offers").doc(offerId).get()).data()!;
    assert.equal(rejectedReview.queueState, "rejected");
    assert.equal(rejectedOffer.reviewStatus, "rejected");
    assert.equal(rejectedOffer.pendingObservation, null);
    assert.ok((await auditActions(review.id)).includes("reject"));
  });

  await t.test("supplier update exposes factual changes and stale decisions fail closed", async () => {
    const identity = identityFor("update-stale");
    const { sourceId } = await seedSource(identity);
    const initial = supplierProduct(identity);
    configureConnector(sourceId, [initial]);
    await runFullSync(sourceId, "update-initial-sync");
    const initialReview = await activeReviewForSource(sourceId);
    const initialReady = await prepareReview(initialReview.id, identity);
    const initialRevision = await pendingRevisionForReview(initialReview);
    const initialApproval = await decideSupplierQueueItem(adminDb, initialReview.id, "approved", {
      uid: "sh3-admin",
      email: "admin@example.test",
    }, {
      draft: approvalDraft(initialReview.id, initialReady, {
        category: "electronics",
        subcategory: "phones",
        brand: "test-brand",
        specifications: { Model: identity, RAM: "8 GB" },
      }),
      expectedPendingRevision: initialRevision,
    });
    assert.equal(initialApproval.success, true);
    const productId = initialApproval.productId!;
    const approvedBefore = (await adminDb.collection("products").doc(productId).get()).data()!;

    const observationA = supplierProduct(identity, {
      longDescription: "Supplier proposed description A.",
      wholesalePrice: 115,
      costPrice: 115,
      recommendedRetailPrice: 180,
      price: 180,
      inventoryLevel: 7,
      specifications: { Model: identity, Brand: "Test Brand", RAM: "12 GB" },
    });
    configureConnector(sourceId, [observationA]);
    await runFullSync(sourceId, "update-observation-a");
    const reviewA = await activeReviewForSource(sourceId);
    const readyA = await prepareReview(reviewA.id, identity);
    const revisionA = await pendingRevisionForReview(reviewA);
    const comparisonA = readyA.comparison as Record<string, unknown>;
    const changedFields = new Set((comparisonA.fieldChanges as Array<Record<string, unknown>>).map((change) => String(change.field)));
    assert.ok(changedFields.has("longDescription"));
    assert.ok(changedFields.has("price") || changedFields.has("costPrice"));
    assert.ok(!changedFields.has("stock"), "approved-product stock is automated and omitted from Product Review comparisons");
    assert.ok(changedFields.has("specifications"));
    const productAfterObservationA = (await adminDb.collection("products").doc(productId).get()).data()!;
    assertApprovedCommerceFieldsUnchanged(productAfterObservationA, approvedBefore);
    assert.equal(productAfterObservationA.stock, 7);
    assert.equal(productAfterObservationA.availability, "in_stock");
    const automatedOffer = (await adminDb.collection("supplier_product_offers").doc(String(reviewA.data().supplierOfferId)).get()).data()!;
    assert.equal(automatedOffer.stock, 7);
    assert.equal(automatedOffer.availability, "in_stock");

    const observationB = supplierProduct(identity, {
      longDescription: "Supplier proposed description B.",
      wholesalePrice: 120,
      costPrice: 120,
      recommendedRetailPrice: 190,
      price: 190,
      inventoryLevel: 5,
      specifications: { Model: identity, Brand: "Test Brand", RAM: "16 GB" },
    });
    configureConnector(sourceId, [observationB]);
    await runFullSync(sourceId, "update-observation-b");
    const reviewB = await activeReviewForSource(sourceId);
    await prepareReview(reviewB.id, identity);
    const revisionB = await pendingRevisionForReview(reviewB);
    assert.notEqual(revisionA, revisionB);

    const approvalsBefore = (await auditActions(reviewB.id)).filter((action) => action === "approve").length;
    await assert.rejects(decideSupplierQueueItem(adminDb, reviewB.id, "approved", {
      uid: "sh3-admin",
      email: "admin@example.test",
    }, {
      draft: approvalDraft(reviewA.id, readyA),
      expectedPendingRevision: revisionA,
    }), /changed after it was opened|observation changed/i);
    await assert.rejects(decideSupplierQueueItem(adminDb, reviewB.id, "rejected", {
      uid: "sh3-admin",
      email: "admin@example.test",
    }, {
      rejectionReason: "Reject stale observation A.",
      expectedPendingRevision: revisionA,
    }), /changed after it was opened|observation changed/i);
    assert.equal((await auditActions(reviewB.id)).filter((action) => action === "approve").length, approvalsBefore);
    const productAfterObservationB = (await adminDb.collection("products").doc(productId).get()).data()!;
    assertApprovedCommerceFieldsUnchanged(productAfterObservationB, approvedBefore);
    assert.equal(productAfterObservationB.stock, 5);

    const rejected = await decideSupplierQueueItem(adminDb, reviewB.id, "rejected", {
      uid: "sh3-admin",
      email: "admin@example.test",
    }, {
      rejectionReason: "Keep the approved storefront values.",
      expectedPendingRevision: revisionB,
    });
    assert.equal(rejected.success, true);
    const productAfterRejection = (await adminDb.collection("products").doc(productId).get()).data()!;
    assertApprovedCommerceFieldsUnchanged(productAfterRejection, approvedBefore);
    assert.equal(productAfterRejection.stock, 5);
    const rejectedOffer = (await adminDb.collection("supplier_product_offers").doc(String(reviewB.data().supplierOfferId)).get()).data()!;
    assert.equal(rejectedOffer.reviewStatus, "approved");
    assert.equal(rejectedOffer.pendingObservation, null);
    assert.ok((await auditActions(reviewB.id)).includes("reject"));

    configureConnector(sourceId, [observationB]);
    await runFullSync(sourceId, "update-requeue-after-rejection");
    const reopened = await activeReviewForSource(sourceId);
    assert.equal(reopened.id, reviewB.id);
  });
});

test("SH-3 dismissal, conflicts, attention states, history, and pagination remain server-authoritative", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
  timeout: 240_000,
}, async (t) => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || "", /^(127\.0\.0\.1|localhost):\d+$/u);

  await t.test("ordinary review dismissal is denied while conflict dismissal is audited", async () => {
    const identity = identityFor("dismiss-conflict");
    const { sourceId } = await seedSource(identity);
    const first = supplierProduct(identity);
    const duplicate = supplierProduct(`${identity}-duplicate`, {
      sku: first.sku,
      barcode: first.barcode,
      title: `${identity} duplicate supplier product`,
    });
    configureConnector(sourceId, [first]);
    await runFullSync(sourceId, "dismiss-ordinary");
    const ordinary = await activeReviewForSource(sourceId);
    await prepareReview(ordinary.id, identity);
    await adminDb.collection("supplier_review_queue").doc(ordinary.id).set({
      productValidation: { readyToPublish: true, missingFields: [], errors: [] },
      mediaStatus: "ready",
    }, { merge: true });
    const ordinaryRevision = await pendingRevisionForReview(ordinary);
    await assert.rejects(decideSupplierQueueItem(adminDb, ordinary.id, "deleted", {
      uid: "sh3-admin",
      email: "admin@example.test",
    }, {
      deletionReason: "Attempted ordinary dismissal.",
      expectedPendingRevision: ordinaryRevision,
    }), /Only conflicts or reviews needing attention can be dismissed/i);
    assert.equal((await adminDb.collection("supplier_review_queue").doc(ordinary.id).get()).data()?.queueState, "review_pending");

    configureConnector(sourceId, [first, duplicate]);
    await runFullSync(sourceId, "dismiss-conflict");
    const conflictPage = await listSupplierQueuePage(adminDb, {
      view: "review",
      state: "conflict",
      businessFilter: "conflicts",
      limit: 10,
    });
    const conflict = conflictPage.items.find((item) => item.sourceId === sourceId);
    assert.ok(conflict);
    await adminDb.collection("supplier_review_queue").doc(conflict.id).set({
      managedMedia: managedMedia(`${identity}-duplicate`),
      mediaStatus: "ready",
    }, { merge: true });
    const preparedConflict = (await adminDb.collection("supplier_review_queue").doc(conflict.id).get()).data()!;
    assert.ok(String((conflict.approvalConflict as Record<string, unknown> | undefined)?.reason || conflict.conflictReason || ""));
    assert.equal((await adminDb.collection("products").doc(String(conflict.productId)).get()).exists, false);
    const conflictRecord = await adminDb.collection("supplier_product_conflicts").where("sourceId", "==", sourceId).get();
    assert.ok(conflictRecord.size >= 1);
    await assert.rejects(decideSupplierQueueItem(adminDb, conflict.id, "approved", {
      uid: "sh3-admin",
      email: "admin@example.test",
    }, {
      draft: approvalDraft(conflict.id, preparedConflict, {
        category: "electronics",
        subcategory: "phones",
        brand: "test-brand",
        specifications: { Model: identity },
      }),
      expectedPendingRevision: preparedConflict.supplierOfferPendingRevision,
    }), /requires explicit administrator resolution/i);
    const dismissed = await decideSupplierQueueItem(adminDb, conflict.id, "deleted", {
      uid: "sh3-admin",
      email: "admin@example.test",
    }, {
      deletionReason: "Duplicate identity requires later manual mapping.",
      expectedPendingRevision: preparedConflict.supplierOfferPendingRevision,
    });
    assert.equal(dismissed.success, true);
    const dismissedReview = (await adminDb.collection("supplier_review_queue").doc(conflict.id).get()).data()!;
    assert.equal(dismissedReview.queueState, "suppressed");
    assert.equal(dismissedReview.decisionAction, "deleted");
    assert.ok((await auditActions(conflict.id)).includes("delete"));
    assert.equal(conflictRecord.size, (await adminDb.collection("supplier_product_conflicts").where("sourceId", "==", sourceId).get()).size);
  });

  await t.test("Needs Attention and terminal history pages are bounded and deterministic", async () => {
    const fixturePrefix = identityFor("history-page");
    for (let index = 0; index < 7; index += 1) {
      const id = `${fixturePrefix}-${index}`;
      const terminal = index < 5;
      await adminDb.collection("supplier_review_queue").doc(id).set({
        id,
        sourceId: `${fixturePrefix}-source`,
        supplierCode: `history-${index}`,
        productName: `History product ${index}`,
        status: terminal ? (index % 3 === 0 ? "Approved" : "Rejected") : "Pending",
        queueState: terminal
          ? (index % 3 === 0 ? "approved" : index % 3 === 1 ? "rejected" : "suppressed")
          : "review_pending",
        decisionAction: terminal
          ? (index % 3 === 0 ? "approved" : index % 3 === 1 ? "rejected" : "deleted")
          : null,
        comparison: { comparisonStatus: terminal ? "PRICE_CHANGED" : "DESCRIPTION_CHANGED", fieldChanges: [] },
        productValidation: terminal ? { readyToPublish: true } : { readyToPublish: false, missingFields: ["brand"] },
        mediaStatus: terminal ? "ready" : index === 5 ? "failed" : "partial",
        createdAt: `2026-08-02T02:00:0${index}.000Z`,
        queueCreatedAt: `2026-08-02T02:00:0${index}.000Z`,
      });
    }

    const attention = await listSupplierQueuePage(adminDb, {
      view: "review",
      state: "active",
      businessFilter: "needs_attention",
      limit: 10,
    });
    assert.ok(attention.items.filter((item) => item.sourceId === `${fixturePrefix}-source`).length >= 2);

    const firstPage = await listSupplierQueuePage(adminDb, {
      view: "review",
      state: "history",
      businessFilter: "approved_history",
      limit: 2,
    });
    assert.equal(firstPage.items.length, 2);
    assert.ok(firstPage.nextCursor);
    const secondPage = await listSupplierQueuePage(adminDb, {
      view: "review",
      state: "history",
      businessFilter: "approved_history",
      after: firstPage.nextCursor!,
      limit: 2,
    });
    assert.equal(secondPage.items.length, 2);
    assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size, 4);
    assert.ok([...firstPage.items, ...secondPage.items].every((item) => ["approved", "rejected", "suppressed"].includes(String(item.queueState))));
  });

  await t.test("review-specific audit cursors cannot cross review identities", async () => {
    const reviewA = `${identityFor("audit-a")}-review`;
    const reviewB = `${identityFor("audit-b")}-review`;
    for (const [reviewId, label] of [[reviewA, "a"], [reviewB, "b"]] as const) {
      for (let index = 0; index < 3; index += 1) {
        await adminDb.collection("supplier_approval_audit").doc(`${reviewId}-${index}`).set({
          queueItemId: reviewId,
          action: index === 2 ? "approve" : "queued",
          previousState: index === 0 ? null : "queued",
          newState: index === 2 ? "approved" : "queued",
          reason: `${label}-${index}`,
          adminUserId: index === 2 ? "sh3-admin" : null,
          adminEmail: index === 2 ? "admin@example.test" : null,
          timestamp: `2026-08-02T03:00:0${index}.000Z`,
        });
      }
    }

    const queryPage = async (reviewId: string, after?: string) => {
      const collection = adminDb.collection("supplier_approval_audit");
      let query: FirebaseFirestore.Query = collection.where("queueItemId", "==", reviewId).orderBy("timestamp", "asc");
      if (after) {
        const cursor = await collection.doc(after).get();
        assert.equal(cursor.data()?.queueItemId, reviewId, "A history cursor must belong to the requested review.");
        query = query.startAfter(cursor);
      }
      const snapshot = await query.limit(2).get();
      return { ids: snapshot.docs.map((document) => document.id), cursor: snapshot.docs.length === 2 ? snapshot.docs.at(-1)!.id : null };
    };

    const pageA1 = await queryPage(reviewA);
    const pageA2 = await queryPage(reviewA, pageA1.cursor!);
    assert.deepEqual([...pageA1.ids, ...pageA2.ids], [`${reviewA}-0`, `${reviewA}-1`, `${reviewA}-2`]);
    assert.ok([...pageA1.ids, ...pageA2.ids].every((id) => id.startsWith(reviewA)));
    await assert.rejects(queryPage(reviewA, `${reviewB}-0`), /cursor must belong/i);
  });
});

test("SH-3 approval drafts are allowlisted and invalid values fail closed", () => {
  const parsed = parseSupplierApprovalDraft({
    productName: "Allowlisted product",
    description: "Description",
    metaDescription: "SEO description",
    keywords: ["safe"],
    sellingPrice: 100,
    comparePrice: 120,
    costPrice: 70,
    marketPrice: 120,
    stock: 2,
    category: "electronics",
    subcategory: "phones",
    brand: "test-brand",
    specifications: { Model: "A" },
    isActive: true,
    primaryImageUrl: "https://supplier.example/product.jpg",
    galleryImageUrls: [],
    pendingObservation: { injected: true },
    reviewStatus: "approved",
    stateVersion: 999,
  }) as unknown as Record<string, unknown>;
  assert.equal(Object.hasOwn(parsed, "pendingObservation"), false);
  assert.equal(Object.hasOwn(parsed, "reviewStatus"), false);
  assert.equal(Object.hasOwn(parsed, "stateVersion"), false);

  assert.throws(() => parseSupplierApprovalDraft({
    ...parsed,
    sellingPrice: -1,
  }), /Selling price is invalid/i);
  assert.throws(() => parseSupplierApprovalDraft({
    ...parsed,
    category: "",
  }), /Category is required/i);
  assert.throws(() => parseSupplierApprovalDraft({
    ...parsed,
    keywords: Array.from({ length: 41 }, (_, index) => `keyword-${index}`),
  }), /SEO keywords is invalid/i);
});

test("SH-4 approval atomically owns Zyro identity and remains idempotent under contention", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
  timeout: 240_000,
}, async (t) => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || "", /^(127\.0\.0\.1|localhost):\d+$/u);

  await t.test("concurrent same-review approval creates one opaque product, SKU claim, mapping, and audit", async () => {
    const identity = identityFor("sh4-same-review");
    const { sourceId } = await seedSource(identity);
    const observed = supplierProduct(identity);
    configureConnector(sourceId, [observed]);
    await runFullSync(sourceId, "sh4-same-review-sync");
    const review = await activeReviewForSource(sourceId);
    const provisionalProductId = String(review.data().productId || "");
    const ready = await prepareReview(review.id, identity);
    const revision = await pendingRevisionForReview(review);
    const draft = sh4ApprovalDraft(review.id, ready);
    assert.equal((await adminDb.collection("products").doc(provisionalProductId).get()).exists, false);

    const [left, right] = await Promise.all([
      decideSupplierQueueItem(adminDb, review.id, "approved", {
        uid: "sh4-admin-a", email: "admin-a@example.test",
      }, { draft, expectedPendingRevision: revision }),
      decideSupplierQueueItem(adminDb, review.id, "approved", {
        uid: "sh4-admin-b", email: "admin-b@example.test",
      }, { draft, expectedPendingRevision: revision }),
    ]);

    assert.equal(left.success, true);
    assert.equal(right.success, true);
    assert.equal(left.productId, right.productId);
    assert.equal(left.sku, right.sku);
    assert.equal([left.idempotent, right.idempotent].filter(Boolean).length, 1);
    assert.match(left.productId || "", /^zyro-[a-f0-9]{32}$/u);
    assert.notEqual(left.productId, provisionalProductId);
    assert.match(left.sku || "", /^ZY-[A-F0-9]{12}$/u);
    assert.notEqual(left.sku, observed.sku);

    const productId = left.productId!;
    const product = (await adminDb.collection("products").doc(productId).get()).data()!;
    const privateProduct = (await adminDb.collection("product_private").doc(productId).get()).data()!;
    const offer = (await adminDb.collection("supplier_product_offers").doc(String(review.data().supplierOfferId)).get()).data()!;
    const terminalReview = (await adminDb.collection("supplier_review_queue").doc(review.id).get()).data()!;
    const claim = (await adminDb.collection("zyro_sku_claims").doc(buildZyroSkuClaimId(left.sku)).get()).data()!;
    assert.equal(product.id, productId);
    assert.equal(Object.hasOwn(product, "sku"), false);
    assert.equal(privateProduct.sku, left.sku);
    assert.equal(privateProduct.supplierItemCode, observed.sku);
    assert.equal(offer.productId, productId);
    assert.equal(offer.reviewStatus, "approved");
    assert.equal(terminalReview.canonicalProductId, productId);
    assert.equal(terminalReview.zyroSku, left.sku);
    assert.equal(claim.productId, productId);
    assert.equal((await auditActions(review.id)).filter((action) => action === "approve").length, 1);
    const approvalAudit = await adminDb.collection("supplier_approval_audit")
      .where("queueItemId", "==", review.id)
      .get();
    const approvalAuditData = approvalAudit.docs.find((document) => document.data().action === "approve")?.data();
    assert.equal(approvalAuditData?.productId, productId);
    assert.equal(approvalAuditData?.zyroSku, left.sku);

    const retried = await decideSupplierQueueItem(adminDb, review.id, "approved", {
      uid: "sh4-admin-a", email: "admin-a@example.test",
    }, { draft, expectedPendingRevision: revision });
    if (retried.success === false) assert.fail(retried.error);
    assert.equal(retried.idempotent, true);
    assert.equal(retried.productId, productId);
    assert.equal(retried.sku, left.sku);
    assert.equal((await auditActions(review.id)).filter((action) => action === "approve").length, 1);
  });

  await t.test("forced concurrent SKU collision assigns one candidate owner and one deterministic fallback", async () => {
    const identityA = identityFor("sh4-sku-a");
    const identityB = identityFor("sh4-sku-b");
    const sourceA = await seedSource(identityA);
    const sourceB = await seedSource(identityB);
    configureConnector(sourceA.sourceId, [supplierProduct(identityA)]);
    configureConnector(sourceB.sourceId, [supplierProduct(identityB)]);
    await runFullSync(sourceA.sourceId, "sh4-sku-a-sync");
    await runFullSync(sourceB.sourceId, "sh4-sku-b-sync");
    const reviewA = await activeReviewForSource(sourceA.sourceId);
    const reviewB = await activeReviewForSource(sourceB.sourceId);
    const readyA = await prepareReview(reviewA.id, identityA);
    const readyB = await prepareReview(reviewB.id, identityB);
    const revisionA = await pendingRevisionForReview(reviewA);
    const revisionB = await pendingRevisionForReview(reviewB);
    const sharedCandidate = "ZY-COLLISION001";
    const fallbackA = "ZY-FALLBACKA001";
    const fallbackB = "ZY-FALLBACKB001";

    const [approvalA, approvalB] = await Promise.all([
      decideSupplierQueueItem(adminDb, reviewA.id, "approved", {
        uid: "sh4-admin", email: "admin@example.test",
      }, {
        draft: sh4ApprovalDraft(reviewA.id, readyA),
        expectedPendingRevision: revisionA,
      }, { buildSkuCandidates: () => [sharedCandidate, fallbackA] }),
      decideSupplierQueueItem(adminDb, reviewB.id, "approved", {
        uid: "sh4-admin", email: "admin@example.test",
      }, {
        draft: sh4ApprovalDraft(reviewB.id, readyB),
        expectedPendingRevision: revisionB,
      }, { buildSkuCandidates: () => [sharedCandidate, fallbackB] }),
    ]);

    assert.equal(approvalA.success, true);
    assert.equal(approvalB.success, true);
    assert.notEqual(approvalA.productId, approvalB.productId);
    assert.notEqual(approvalA.sku, approvalB.sku);
    assert.ok([approvalA.sku, approvalB.sku].includes(sharedCandidate));
    assert.ok([approvalA.sku, approvalB.sku].some((sku) => sku === fallbackA || sku === fallbackB));
    const claims = await adminDb.collection("zyro_sku_claims")
      .where("sku", "in", [sharedCandidate, fallbackA, fallbackB])
      .get();
    assert.equal(claims.size, 2);
    assert.equal(new Set(claims.docs.map((document) => document.data().productId)).size, 2);
  });

  await t.test("manual creation racing Supplier Review approval shares the same SKU reservation namespace", async () => {
    const identity = identityFor("sh4a-cross-path");
    const { sourceId } = await seedSource(identity);
    configureConnector(sourceId, [supplierProduct(identity)]);
    await runFullSync(sourceId, "sh4a-cross-path-sync");
    const review = await activeReviewForSource(sourceId);
    const ready = await prepareReview(review.id, identity);
    const revision = await pendingRevisionForReview(review);
    const sharedCandidate = `ZY-X${RUN_PREFIX.toUpperCase()}001`;
    const supplierFallback = `ZY-S${RUN_PREFIX.toUpperCase()}001`;
    const manualFallback = `ZY-M${RUN_PREFIX.toUpperCase()}001`;

    const [supplierApproval, manualProduct] = await Promise.all([
      decideSupplierQueueItem(adminDb, review.id, "approved", {
        uid: "sh4a-admin", email: "admin@example.test",
      }, {
        draft: sh4ApprovalDraft(review.id, ready),
        expectedPendingRevision: revision,
      }, { buildSkuCandidates: () => [sharedCandidate, supplierFallback] }),
      createAdminProduct(adminDb, {
        uid: "sh4a-admin", email: "admin@example.test",
      }, randomUUID(), {
        name: `${identity} manual product`,
        description: "Manual product competing for the same SKU candidate.",
        price: 250,
        imageUrl: `https://supplier.example/${identity}-manual.jpg`,
        imageUrls: [`https://supplier.example/${identity}-manual.jpg`],
        category: "electronics",
        subcategory: "phones",
        brand: "test-brand",
        model: `${identity}-manual-model`,
        barcode: barcodeFor(`${identity}-manual`),
        stock: 5,
        specs: { Model: `${identity}-manual-model` },
        isActive: true,
      }, { buildSkuCandidates: () => [sharedCandidate, manualFallback] }),
    ]);

    assert.equal(supplierApproval.success, true);
    assert.notEqual(supplierApproval.productId, manualProduct.productId);
    assert.notEqual(supplierApproval.sku, manualProduct.sku);
    assert.ok([supplierApproval.sku, manualProduct.sku].includes(sharedCandidate));
    assert.ok([supplierApproval.sku, manualProduct.sku]
      .some((sku) => sku === supplierFallback || sku === manualFallback));
  });

  await t.test("a manual product created after review queueing fences late duplicate-barcode publication", async () => {
    const identity = identityFor("sh4-late-barcode");
    const { sourceId } = await seedSource(identity);
    const observed = supplierProduct(identity);
    configureConnector(sourceId, [observed]);
    await runFullSync(sourceId, "sh4-late-barcode-sync");
    const review = await activeReviewForSource(sourceId);
    const ready = await prepareReview(review.id, identity);
    const revision = await pendingRevisionForReview(review);

    const manual = await createAdminProduct(adminDb, {
      uid: "sh4-admin", email: "admin@example.test",
    }, randomUUID(), {
      name: `${identity} canonical manual product`,
      description: "Manual product committed after the Supplier review was queued.",
      price: 320,
      imageUrl: `https://supplier.example/${identity}-manual.jpg`,
      imageUrls: [`https://supplier.example/${identity}-manual.jpg`],
      category: "electronics",
      subcategory: "phones",
      brand: "test-brand",
      model: `${identity}-manual-model`,
      barcode: observed.barcode,
      stock: 4,
      specs: { Model: `${identity}-manual-model` },
      isActive: true,
    });

    await assert.rejects(decideSupplierQueueItem(adminDb, review.id, "approved", {
      uid: "sh4-admin", email: "admin@example.test",
    }, {
      draft: sh4ApprovalDraft(review.id, ready),
      expectedPendingRevision: revision,
    }), /already uses this barcode/i);
    assert.equal((await adminDb.collection("products").where("barcode", "==", observed.barcode).get()).size, 1);
    assert.equal((await adminDb.collection("products").doc(manual.productId).get()).exists, true);
    assert.equal((await adminDb.collection("supplier_review_queue").doc(review.id).get()).data()?.queueState, "review_pending");
    assert.equal((await auditActions(review.id)).filter((action) => action === "approve").length, 0);
  });

  await t.test("an unclaimed legacy SKU cannot be taken by Supplier approval", async () => {
    const legacyProductId = identityFor("sh4-legacy-product");
    const legacySku = `ZY-LG${RUN_PREFIX.toUpperCase()}01`;
    await Promise.all([
      adminDb.collection("products").doc(legacyProductId).set({
        id: legacyProductId,
        name: "Legacy Product",
        sku: legacySku,
        price: 100,
        stock: 1,
        isActive: true,
      }),
      adminDb.collection("product_private").doc(legacyProductId).set({ productId: legacyProductId }),
    ]);

    const identity = identityFor("sh4-legacy-collision");
    const { sourceId } = await seedSource(identity);
    configureConnector(sourceId, [supplierProduct(identity)]);
    await runFullSync(sourceId, "sh4-legacy-collision-sync");
    const review = await activeReviewForSource(sourceId);
    const ready = await prepareReview(review.id, identity);
    const revision = await pendingRevisionForReview(review);
    const fallback = `ZY-LF${RUN_PREFIX.toUpperCase()}01`;
    const approval = await decideSupplierQueueItem(adminDb, review.id, "approved", {
      uid: "sh4-admin", email: "admin@example.test",
    }, {
      draft: sh4ApprovalDraft(review.id, ready),
      expectedPendingRevision: revision,
    }, { buildSkuCandidates: () => [legacySku, fallback] });
    if (approval.success === false) assert.fail(approval.error);
    assert.equal(approval.sku, fallback);
    assert.equal((await adminDb.collection("products").doc(legacyProductId).get()).data()?.sku, legacySku);
    assert.equal((await adminDb.collection("zyro_sku_claims").doc(buildZyroSkuClaimId(legacySku)).get()).exists, false);
  });

  await t.test("a second review cannot approve the same deterministic supplier offer identity", async () => {
    const identity = identityFor("sh4-duplicate-identity");
    const { sourceId } = await seedSource(identity);
    configureConnector(sourceId, [supplierProduct(identity)]);
    await runFullSync(sourceId, "sh4-duplicate-identity-sync");
    const review = await activeReviewForSource(sourceId);
    const ready = await prepareReview(review.id, identity);
    const revision = await pendingRevisionForReview(review);
    const duplicateReviewId = `${review.id}-duplicate`;
    await adminDb.collection("supplier_review_queue").doc(duplicateReviewId).set({
      ...ready,
      id: duplicateReviewId,
      correlationId: duplicateReviewId,
      status: "Pending",
      queueState: "review_pending",
    });

    const results = await Promise.allSettled([
      decideSupplierQueueItem(adminDb, review.id, "approved", {
        uid: "sh4-admin", email: "admin@example.test",
      }, { draft: sh4ApprovalDraft(review.id, ready), expectedPendingRevision: revision }),
      decideSupplierQueueItem(adminDb, duplicateReviewId, "approved", {
        uid: "sh4-admin", email: "admin@example.test",
      }, { draft: sh4ApprovalDraft(duplicateReviewId, ready), expectedPendingRevision: revision }),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const products = await adminDb.collection("product_private").where("supplierSourceId", "==", sourceId).get();
    assert.equal(products.size, 1);
    assert.equal((await auditActions(review.id)).filter((action) => action === "approve").length, 1);
  });
});

test("SH-4 duplicate signals remain approval-gated while explicit multi-supplier attachment reuses one product", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
  timeout: 240_000,
}, async () => {
  const identityA = identityFor("sh4-primary-offer");
  const sourceA = await seedSource(identityA);
  const productA = supplierProduct(identityA);
  configureConnector(sourceA.sourceId, [productA]);
  await runFullSync(sourceA.sourceId, "sh4-primary-sync");
  const reviewA = await activeReviewForSource(sourceA.sourceId);
  const readyA = await prepareReview(reviewA.id, identityA);
  const revisionA = await pendingRevisionForReview(reviewA);
  const approvalA = await decideSupplierQueueItem(adminDb, reviewA.id, "approved", {
    uid: "sh4-admin", email: "admin@example.test",
  }, { draft: sh4ApprovalDraft(reviewA.id, readyA), expectedPendingRevision: revisionA });
  assert.equal(approvalA.success, true);
  const canonicalProductId = approvalA.productId!;
  const zyroSku = approvalA.sku!;

  const identityB = identityFor("sh4-barcode-offer");
  const sourceB = await seedSource(identityB);
  const productB = supplierProduct(identityB, {
    barcode: productA.barcode,
    title: `${identityA} supplier product`,
    wholesalePrice: 110,
    costPrice: 110,
    price: 165,
    recommendedRetailPrice: 165,
  });
  configureConnector(sourceB.sourceId, [productB]);
  await runFullSync(sourceB.sourceId, "sh4-barcode-sync");
  const conflictReview = await activeReviewForSource(sourceB.sourceId);
  const conflictData = conflictReview.data();
  assert.equal(conflictData.queueState, "conflict");
  assert.equal((conflictData.approvalConflict as Record<string, unknown>).reason, "duplicate_barcode");
  assert.equal(conflictData.canonicalProductId, canonicalProductId);
  assert.equal((await adminDb.collection("products").where("barcode", "==", productA.barcode).get()).size, 1);

  await adminDb.collection("supplier_review_queue").doc(conflictReview.id).set({
    managedMedia: managedMedia(identityB),
    mediaStatus: "ready",
  }, { merge: true });
  const refreshedConflict = (await adminDb.collection("supplier_review_queue").doc(conflictReview.id).get()).data()!;
  const revisionB = await pendingRevisionForReview(conflictReview);
  await assert.rejects(decideSupplierQueueItem(adminDb, conflictReview.id, "approved", {
    uid: "sh4-admin", email: "admin@example.test",
  }, {
    draft: sh4ApprovalDraft(conflictReview.id, refreshedConflict),
    expectedPendingRevision: revisionB,
  }), /requires explicit administrator resolution/i);

  const approvalB = await decideSupplierQueueItem(adminDb, conflictReview.id, "approved", {
    uid: "sh4-admin", email: "admin@example.test",
  }, {
    draft: sh4ApprovalDraft(conflictReview.id, refreshedConflict),
    expectedPendingRevision: revisionB,
    resolveConflict: true,
  });
  if (approvalB.success === false) assert.fail(approvalB.error);
  assert.equal(approvalB.productId, canonicalProductId);
  assert.equal(approvalB.sku, zyroSku);
  const approvedOffers = await adminDb.collection("supplier_product_offers")
    .where("productId", "==", canonicalProductId)
    .get();
  assert.equal(approvedOffers.docs.filter((document) => document.data().reviewStatus === "approved").length, 2);
  assert.equal((await adminDb.collection("products").doc(canonicalProductId).get()).exists, true);

  const identityC = identityFor("sh4-sku-hijack");
  const sourceC = await seedSource(identityC);
  const productC = supplierProduct(identityC, {
    sku: zyroSku,
    barcode: barcodeFor(identityC),
    title: "Unrelated supplier product attempting an SKU match",
  });
  configureConnector(sourceC.sourceId, [productC]);
  await runFullSync(sourceC.sourceId, "sh4-sku-hijack-sync");
  const skuConflict = await activeReviewForSource(sourceC.sourceId);
  assert.equal(skuConflict.data().queueState, "conflict");
  assert.equal((skuConflict.data().approvalConflict as Record<string, unknown>).reason, "duplicate_sku");
  assert.equal(skuConflict.data().canonicalProductId, canonicalProductId);
  assert.equal((await adminDb.collection("products").get()).docs.filter((document) => (
    document.id === canonicalProductId
    || document.data().name === "Unrelated supplier product attempting an SKU match"
  )).length, 1);
});
