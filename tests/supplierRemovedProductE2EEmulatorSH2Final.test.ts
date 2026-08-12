import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import type { RawA2ZProduct } from "../functions/src/api/suppliers/a2z/types";
import type {
  SupplierCatalogPageRequest,
  SupplierCatalogPageResult,
  SupplierConnector,
  SupplierSourceConfig,
} from "../functions/src/api/suppliers/types";

// functions/ is a CommonJS package in the Node 20 production runtime. Keep
// stateful Functions modules in one CommonJS cache so the connector registered
// by this test is the same SupplierRegistry instance used by runSupplierSync.
const requireFunctions = createRequire(import.meta.url);
const { adminDb } = requireFunctions("../functions/src/api/firebase.ts") as typeof import("../functions/src/api/firebase");
const { decideSupplierQueueItem } = requireFunctions("../functions/src/api/suppliers/supplierApproval.ts") as typeof import("../functions/src/api/suppliers/supplierApproval");
const {
  buildSupplierProductOffer,
  reconcileSupplierProductOfferFailover,
} = requireFunctions("../functions/src/api/suppliers/supplierOfferEngine.ts") as typeof import("../functions/src/api/suppliers/supplierOfferEngine");
const { SupplierRegistry } = requireFunctions("../functions/src/api/suppliers/SupplierRegistry.ts") as typeof import("../functions/src/api/suppliers/SupplierRegistry");
const { ProductParser } = requireFunctions("../functions/src/api/suppliers/a2z/ProductParser.ts") as typeof import("../functions/src/api/suppliers/a2z/ProductParser");
const { mergeSupplierProductMetadata } = requireFunctions("../functions/src/api/suppliers/supplierProductImport.ts") as typeof import("../functions/src/api/suppliers/supplierProductImport");
const { SERVER_FILTERED_FULL_CATALOG_CAPABILITIES } = requireFunctions("../functions/src/api/suppliers/supplierSyncCapabilities.ts") as typeof import("../functions/src/api/suppliers/supplierSyncCapabilities");
const { processSupplierReviewQueueItem } = requireFunctions("../functions/src/scheduled/supplierReviewQueue.ts") as typeof import("../functions/src/scheduled/supplierReviewQueue");
const { runSupplierSync } = requireFunctions("../functions/src/scheduled/supplierSync.ts") as typeof import("../functions/src/scheduled/supplierSync");

const canRun = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const CONNECTOR_TYPE = "sh2-removal-e2e";
const TARGET_URL = "https://1.1.1.1/catalog";

type PageHandler = (request: SupplierCatalogPageRequest) => SupplierCatalogPageResult;

interface ConnectorFixtureState {
  requests: SupplierCatalogPageRequest[];
  page: PageHandler;
}

const connectorFixtures = new Map<string, ConnectorFixtureState>();

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
      const fixture = connectorFixtures.get(source.id);
      if (!fixture) throw new Error(`Missing SH-2 removal connector fixture for ${source.id}.`);
      fixture.requests.push({ ...request, filters: request.filters ? { ...request.filters } : undefined });
      return fixture.page(request);
    },
    async fetchProducts() {
      const page = await this.fetchProductPage({ cursor: null, pageSize: 200, mode: "full" });
      return { products: page.products, targetUrl };
    },
    async testConnection() {
      const result = await this.fetchProducts();
      return {
        success: true,
        status: "Connected",
        productsCount: result.products.length,
        sampleProduct: result.products[0] || null,
      };
    },
  }),
  SERVER_FILTERED_FULL_CATALOG_CAPABILITIES,
);

const supplierBarcode = (identity: string): string => Array.from(
  createHash("sha256").update(identity).digest().subarray(0, 13),
  (value) => String(value % 10),
).join("");

const rawProduct = (identity: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  supplierProductId: `${identity}-supplier-product`,
  sku: `${identity}-sku`,
  barcode: supplierBarcode(identity),
  title: `${identity} approved product`,
  longDescription: "Approved supplier description.",
  mediaGallery: [`https://storage.example/${identity}.jpg`],
  price: 100,
  costPrice: 70,
  wholesalePrice: 70,
  recommendedRetailPrice: 100,
  inventoryLevel: 10,
  availability: "available",
  brand: "Test Brand",
  supplierCategory: "Electronics",
  supplierSubcategory: "Phones",
  categoryHierarchy: ["Electronics", "Phones"],
  specifications: { Model: identity, Brand: "Test Brand" },
  ...overrides,
});

const completePage = (products: RawA2ZProduct[] | Record<string, unknown>[]): SupplierCatalogPageResult => ({
  products,
  targetUrl: TARGET_URL,
  nextCursor: null,
  complete: true,
  catalogTotal: { count: products.length, reliability: "exact" },
});

const configureConnector = (sourceId: string, page: PageHandler): ConnectorFixtureState => {
  const fixture = { requests: [], page };
  connectorFixtures.set(sourceId, fixture);
  return fixture;
};

interface ApprovedFixture {
  sourceId: string;
  supplierId: string;
  productId: string;
  offerId: string;
  product: Record<string, unknown>;
  supplierProduct: RawA2ZProduct;
}

const managedMedia = (fixture: Pick<ApprovedFixture, "sourceId" | "supplierId" | "productId">) => {
  const contentHash = createHash("sha256").update(fixture.productId).digest("hex");
  return [{
    assetId: contentHash,
    supplierId: fixture.supplierId,
    sourceId: fixture.sourceId,
    productId: fixture.productId,
    originalSupplierUrl: `https://supplier.example/${fixture.productId}.jpg`,
    originalStoragePath: `supplier-media/${fixture.supplierId}/${fixture.productId}/original/product.jpg`,
    originalStorageUrl: `https://storage.example/${fixture.productId}-original.jpg`,
    firebaseStorageUrl: `https://storage.example/${fixture.productId}-large.webp`,
    contentHash,
    width: 1200,
    height: 1200,
    mimeType: "image/jpeg",
    fileSize: 1000,
    uploadTimestamp: "2026-08-02T00:00:00.000Z",
    imageStatus: "ready",
    isPrimary: true,
    sortOrder: 0,
    variants: {
      thumbnail: {
        storagePath: `${fixture.productId}/thumbnail.webp`,
        storageUrl: `https://storage.example/${fixture.productId}-thumbnail.webp`,
        width: 200,
        height: 200,
        mimeType: "image/webp",
        fileSize: 100,
      },
      medium: {
        storagePath: `${fixture.productId}/medium.webp`,
        storageUrl: `https://storage.example/${fixture.productId}-medium.webp`,
        width: 800,
        height: 800,
        mimeType: "image/webp",
        fileSize: 500,
      },
      large: {
        storagePath: `${fixture.productId}/large.webp`,
        storageUrl: `https://storage.example/${fixture.productId}-large.webp`,
        width: 1200,
        height: 1200,
        mimeType: "image/webp",
        fileSize: 800,
      },
    },
  }];
};

const seedApprovedFixture = async (identity: string): Promise<ApprovedFixture> => {
  const sourceId = `${identity}-source`;
  const supplierId = `${identity}-supplier`;
  const productId = `${identity}-product`;
  const supplierProduct = ProductParser.parseJsonPayload(rawProduct(identity));
  const supplierMetadata = mergeSupplierProductMetadata(supplierProduct);
  const product = {
    id: productId,
    sku: `${identity}-zyro-sku`,
    name: supplierProduct.title,
    description: supplierProduct.longDescription,
    imageUrl: `https://storage.example/${productId}-large.webp`,
    imageUrls: [`https://storage.example/${productId}-large.webp`],
    category: "electronics",
    subcategory: "phones",
    brand: "test-brand",
    specs: { Model: identity, Brand: "Test Brand" },
    price: 100,
    originalPrice: 120,
    discount: 16.67,
    stock: 10,
    availability: "in_stock",
    isActive: true,
    active: true,
    visible: true,
    supplierMetadata,
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
  const offer = buildSupplierProductOffer({
    sourceId,
    supplierId,
    supplierProductId: supplierProduct.supplierProductId || supplierProduct.sku,
    sku: supplierProduct.sku,
    barcode: supplierProduct.barcode,
    productId,
    price: 100,
    cost: 70,
    stock: 10,
    availability: "available",
    priority: 100,
    health: { availability: "available", observedAt: "2026-08-02T00:00:00.000Z" },
    lastSyncAt: "2026-08-02T00:00:00.000Z",
    reviewStatus: "approved",
    catalogPayload: { ...product },
    supplierSnapshot: { ...supplierProduct, supplierMetadata },
    timestamp: "2026-08-02T00:00:00.000Z",
  });
  const fixture = { sourceId, supplierId, productId, offerId: offer.id, product, supplierProduct };
  const media = managedMedia(fixture);

  await Promise.all([
    adminDb.collection("supplierSources").doc(sourceId).set({
      supplierId,
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
      settings: { autoSync: "Off", productLimit: 2 },
    }),
    adminDb.collection("products").doc(productId).set(product),
    adminDb.collection("product_private").doc(productId).set({
      productId,
      supplierId,
      supplierSourceId: sourceId,
      supplierItemCode: supplierProduct.sku,
      supplierItemCodeNormalized: supplierProduct.sku.toLowerCase(),
      costPrice: 70,
      marketPrice: 120,
      inventoryLevel: 10,
      supplierMetadata,
      supplierMedia: media,
      supplierCatalogTraversalId: "approved-baseline",
      supplierOfferSelection: {
        activeOfferId: offer.id,
        lockedOfferId: null,
        failoverEnabled: true,
      },
    }),
    adminDb.collection("supplier_product_offers").doc(offer.id).set({
      ...offer,
      supplierCatalogTraversalId: "approved-baseline",
      supplierCatalogSeenAt: "2026-08-02T00:00:00.000Z",
    }),
    adminDb.collection("categories").doc("electronics").set({
      name: "Electronics",
      isActive: true,
      subcategories: [{ id: "phones", name: "Phones" }],
      specificationTemplate: [],
      keywords: ["electronics"],
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
      productLimit: 2,
      defaultImageLimit: 10,
    }, { merge: true }),
  ]);
  return fixture;
};

const runFullSync = (
  sourceIds: string[],
  batchId: string,
  syncRequest: Record<string, unknown> = { mode: "full", pageSize: 2 },
  control?: { reportProgress(): Promise<void>; shouldCancel(): boolean },
) => runSupplierSync({
  trigger: "manual",
  sourceIds,
  batchId,
  syncRequest: syncRequest as never,
  maxRuntimeMs: 60_000,
  ...(control ? { control } : {}),
});

const removalReviews = async (offerId: string) => {
  const snapshot = await adminDb.collection("supplier_review_queue")
    .where("supplierOfferId", "==", offerId)
    .get();
  return snapshot.docs.filter((document) => document.data().reconciliationAction === "supplier_offer_unavailable");
};

const activeRemovalReviews = async (offerId: string) => (await removalReviews(offerId)).filter((document) => {
  const state = String(document.data().queueState || document.data().status || "").toLowerCase();
  return !["approved", "rejected", "suppressed"].includes(state);
});

const publicProduct = async (productId: string) => (await adminDb.collection("products").doc(productId).get()).data()!;
const supplierOffer = async (offerId: string) => (await adminDb.collection("supplier_product_offers").doc(offerId).get()).data()!;
const sourceRecord = async (sourceId: string) => (await adminDb.collection("supplierSources").doc(sourceId).get()).data()!;

const assertApprovedBoundary = async (fixture: ApprovedFixture): Promise<void> => {
  const offer = await supplierOffer(fixture.offerId);
  const product = await publicProduct(fixture.productId);
  assert.equal(offer.reviewStatus, "approved");
  assert.equal(offer.stock, 10);
  assert.equal(offer.availability, "in_stock");
  assert.equal(offer.pendingObservation.kind, "catalog_removal");
  assert.equal(offer.pendingObservation.effective.stock, 0);
  assert.equal(offer.pendingObservation.effective.availability, "unavailable");
  assert.equal(product.stock, 10);
  assert.equal(product.availability, "in_stock");
  assert.equal(product.isActive, true);
  assert.equal(product.visible, true);
};

const addManagedReviewMedia = async (fixture: ApprovedFixture, queueItemId: string): Promise<void> => {
  await adminDb.collection("supplier_review_queue").doc(queueItemId).set({
    managedMedia: managedMedia(fixture),
  }, { merge: true });
};

const prepareRemovalReviewForDecision = async (
  fixture: ApprovedFixture,
  queueItemId: string,
): Promise<void> => {
  await addManagedReviewMedia(fixture, queueItemId);
  const processed = await processSupplierReviewQueueItem(
    adminDb,
    queueItemId,
    `sh2-removal-worker-${fixture.sourceId}`,
    Date.now(),
  );
  assert.deepEqual(processed, {
    queueItemId,
    outcome: "completed",
    state: "review_pending",
  });
};

test("SH-2 removed-product detection uses the real sync orchestration and remains approval-gated", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
  timeout: 240_000,
}, async (t) => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || "", /^(127\.0\.0\.1|localhost):\d+$/u);

  await t.test("present, absent, and repeated-absence traversals preserve one pending removal", async () => {
    const fixture = await seedApprovedFixture("removal-lifecycle");
    configureConnector(fixture.sourceId, () => completePage([fixture.supplierProduct]));
    const present = await runFullSync([fixture.sourceId], "removal-present");
    assert.equal(present.status, "Success");
    const presentSource = await sourceRecord(fixture.sourceId);
    const presentOffer = await supplierOffer(fixture.offerId);
    assert.equal(presentSource.catalogSync.status, "completed");
    assert.equal(presentSource.catalogSync.terminationReason, "catalog_complete");
    assert.equal(presentOffer.supplierCatalogTraversalId, presentSource.catalogSync.traversalId);
    assert.equal(presentOffer.pendingObservation, null);
    assert.equal((await activeRemovalReviews(fixture.offerId)).length, 0);
    assert.deepEqual(await publicProduct(fixture.productId), fixture.product);

    configureConnector(fixture.sourceId, () => completePage([]));
    const absent = await runFullSync([fixture.sourceId], "removal-absent-1");
    assert.equal(absent.status, "Success");
    const absentSource = await sourceRecord(fixture.sourceId);
    const firstReviews = await activeRemovalReviews(fixture.offerId);
    assert.equal(absentSource.catalogSync.status, "completed");
    assert.equal(absentSource.catalogSync.terminationReason, "catalog_complete");
    assert.equal(firstReviews.length, 1);
    assert.equal(firstReviews[0].data().supplierSnapshot.missingFromTraversalId, absentSource.catalogSync.traversalId);
    await assertApprovedBoundary(fixture);
    assert.equal((await reconcileSupplierProductOfferFailover(adminDb, fixture.productId, "pending removal validation")).changed, false);
    assert.deepEqual(await publicProduct(fixture.productId), fixture.product);

    const firstReviewId = firstReviews[0].id;
    const firstTraversalId = absentSource.catalogSync.traversalId;
    const repeated = await runFullSync([fixture.sourceId], "removal-absent-2");
    assert.equal(repeated.status, "Success");
    const repeatedSource = await sourceRecord(fixture.sourceId);
    const repeatedReviews = await activeRemovalReviews(fixture.offerId);
    assert.equal(repeatedReviews.length, 1);
    assert.equal(repeatedReviews[0].id, firstReviewId);
    assert.notEqual(repeatedSource.catalogSync.traversalId, firstTraversalId);
    assert.equal(repeatedReviews[0].data().supplierSnapshot.missingFromTraversalId, repeatedSource.catalogSync.traversalId);
    assert.equal((await supplierOffer(fixture.offerId)).pendingObservation.traversalId, repeatedSource.catalogSync.traversalId);
    await assertApprovedBoundary(fixture);
  });

  await t.test("rejection preserves approved state and a later present traversal remains safe", async () => {
    const fixture = await seedApprovedFixture("removal-reject");
    configureConnector(fixture.sourceId, () => completePage([]));
    await runFullSync([fixture.sourceId], "removal-reject-absent");
    const [review] = await activeRemovalReviews(fixture.offerId);
    assert.ok(review);
    await prepareRemovalReviewForDecision(fixture, review.id);
    const revision = (await supplierOffer(fixture.offerId)).pendingObservation.revision;
    const result = await decideSupplierQueueItem(adminDb, review.id, "rejected", {
      uid: "emulator-admin",
      email: "admin@example.test",
    }, {
      rejectionReason: "Supplier removal rejected during SH-2 validation.",
      expectedPendingRevision: revision,
    });
    assert.equal(result.success, true);
    const rejectedOffer = await supplierOffer(fixture.offerId);
    assert.equal(rejectedOffer.reviewStatus, "approved");
    assert.equal(rejectedOffer.stock, 10);
    assert.equal(rejectedOffer.availability, "in_stock");
    assert.equal(rejectedOffer.pendingObservation, null);
    assert.deepEqual(await publicProduct(fixture.productId), fixture.product);
    assert.equal((await adminDb.collection("supplier_review_queue").doc(review.id).get()).data()?.queueState, "rejected");

    const audit = await adminDb.collection("supplier_approval_audit").where("queueItemId", "==", review.id).get();
    assert.ok(audit.docs.some((document) => document.data().action === "reject"));
    configureConnector(fixture.sourceId, () => completePage([fixture.supplierProduct]));
    await runFullSync([fixture.sourceId], "removal-reject-present");
    assert.equal((await supplierOffer(fixture.offerId)).pendingObservation, null);
    assert.equal((await activeRemovalReviews(fixture.offerId)).length, 0);
  });

  await t.test("approval promotes the exact pending removal through the existing decision transaction", async () => {
    const fixture = await seedApprovedFixture("removal-approve");
    configureConnector(fixture.sourceId, () => completePage([]));
    await runFullSync([fixture.sourceId], "removal-approve-absent");
    const [review] = await activeRemovalReviews(fixture.offerId);
    assert.ok(review);
    await prepareRemovalReviewForDecision(fixture, review.id);
    const revision = (await supplierOffer(fixture.offerId)).pendingObservation.revision;
    const result = await decideSupplierQueueItem(adminDb, review.id, "approved", {
      uid: "emulator-admin",
      email: "admin@example.test",
    }, { expectedPendingRevision: revision });
    assert.equal(result.success, true);
    const approvedOffer = await supplierOffer(fixture.offerId);
    const approvedProduct = await publicProduct(fixture.productId);
    const approvedReview = (await adminDb.collection("supplier_review_queue").doc(review.id).get()).data()!;
    assert.equal(approvedOffer.stock, 0);
    assert.equal(approvedOffer.availability, "unavailable");
    assert.equal(approvedOffer.pendingObservation, null);
    assert.equal(approvedReview.queueState, "approved");
    assert.equal(approvedProduct.stock, 0);
    assert.equal(approvedProduct.isActive, false);
    assert.equal(approvedProduct.visible, false);
    const audit = await adminDb.collection("supplier_approval_audit").where("queueItemId", "==", review.id).get();
    assert.ok(audit.docs.some((document) => document.data().action === "approve"));
    assert.equal((await activeRemovalReviews(fixture.offerId)).length, 0);
  });

  for (const filter of [
    { label: "category", filters: { category: "Fashion" } },
    { label: "search", filters: { search: "not-this-product" } },
  ] as const) {
    await t.test(`${filter.label} filtering sights retrieved products without removal`, async () => {
      const fixture = await seedApprovedFixture(`removal-filter-${filter.label}`);
      configureConnector(fixture.sourceId, () => completePage([fixture.supplierProduct]));
      await runFullSync([fixture.sourceId], `removal-filter-${filter.label}-run`, {
        mode: "full",
        pageSize: 2,
        filters: filter.filters,
      });
      const source = await sourceRecord(fixture.sourceId);
      const offer = await supplierOffer(fixture.offerId);
      assert.equal(source.catalogSync.status, "completed");
      assert.equal(source.catalogSync.deletionReconciliationEligible, false);
      assert.equal(offer.supplierCatalogTraversalId, source.catalogSync.traversalId);
      assert.equal(offer.pendingObservation, null);
      assert.equal((await activeRemovalReviews(fixture.offerId)).length, 0);
      assert.deepEqual(await publicProduct(fixture.productId), fixture.product);
    });
  }

  await t.test("totalProductLimit prevents incomplete catalogue evidence from reconciling removals", async () => {
    const fixture = await seedApprovedFixture("removal-limit");
    const unrelated = rawProduct("removal-limit-unrelated");
    configureConnector(fixture.sourceId, () => ({
      products: [unrelated],
      targetUrl: TARGET_URL,
      nextCursor: "next-page",
      complete: false,
    }));
    await runFullSync([fixture.sourceId], "removal-limit-run", {
      mode: "full",
      pageSize: 2,
      totalProductLimit: 1,
    });
    const source = await sourceRecord(fixture.sourceId);
    assert.equal(source.catalogSync.status, "limited");
    assert.equal(source.catalogSync.terminationReason, "limit_reached");
    assert.equal(source.catalogSync.deletionReconciliationEligible, false);
    assert.equal((await activeRemovalReviews(fixture.offerId)).length, 0);
    assert.deepEqual(await publicProduct(fixture.productId), fixture.product);
  });

  await t.test("pagination integrity failure cannot reconcile a missing product", async () => {
    const fixture = await seedApprovedFixture("removal-pagination");
    configureConnector(fixture.sourceId, (request) => ({
      products: [],
      targetUrl: TARGET_URL,
      nextCursor: request.cursor || "same-cursor",
      complete: false,
    }));
    const result = await runFullSync([fixture.sourceId], "removal-pagination-run");
    const source = await sourceRecord(fixture.sourceId);
    assert.equal(result.status, "Failed");
    assert.notEqual(source.catalogSync.status, "completed");
    assert.equal((await activeRemovalReviews(fixture.offerId)).length, 0);
    assert.deepEqual(await publicProduct(fixture.productId), fixture.product);
  });

  await t.test("paused traversal reconciles only after the same traversal resumes and completes", async () => {
    const fixture = await seedApprovedFixture("removal-resume");
    const pageOne = rawProduct("removal-resume-page-one");
    const pageTwo = rawProduct("removal-resume-page-two");
    const connector = configureConnector(fixture.sourceId, (request) => request.cursor === null ? {
      products: [pageOne],
      targetUrl: TARGET_URL,
      nextCursor: "resume-cursor",
      complete: false,
    } : completePage([pageTwo]));
    const batchId = "removal-resume-job";
    const first = await runFullSync([fixture.sourceId], batchId, { mode: "full", pageSize: 1 }, {
      async reportProgress() {},
      shouldCancel: () => connector.requests.length >= 1,
    });
    const pausedSource = await sourceRecord(fixture.sourceId);
    assert.equal(first.status, "Partial");
    assert.equal(pausedSource.catalogSync.status, "paused");
    assert.equal((await activeRemovalReviews(fixture.offerId)).length, 0);

    const traversalId = pausedSource.catalogSync.traversalId;
    const resumed = await runFullSync([fixture.sourceId], batchId, { mode: "full", pageSize: 1 });
    const completedSource = await sourceRecord(fixture.sourceId);
    assert.equal(resumed.status, "Success");
    assert.equal(completedSource.catalogSync.status, "completed");
    assert.equal(completedSource.catalogSync.traversalId, traversalId);
    assert.equal(completedSource.catalogSync.resumeCount, 1);
    assert.equal((await activeRemovalReviews(fixture.offerId)).length, 1);
    await assertApprovedBoundary(fixture);
  });

  await t.test("complete traversal removal is isolated per supplier source", async () => {
    const sourceA = await seedApprovedFixture("removal-multi-a");
    const sourceB = await seedApprovedFixture("removal-multi-b");
    configureConnector(sourceA.sourceId, () => completePage([]));
    configureConnector(sourceB.sourceId, () => completePage([sourceB.supplierProduct]));
    const productBBefore = await publicProduct(sourceB.productId);
    const result = await runFullSync(
      [sourceA.sourceId, sourceB.sourceId],
      "removal-multi-run",
      { mode: "full", pageSize: 2 },
    );
    assert.equal(result.status, "Success");
    assert.equal((await activeRemovalReviews(sourceA.offerId)).length, 1);
    assert.equal((await activeRemovalReviews(sourceB.offerId)).length, 0);
    await assertApprovedBoundary(sourceA);
    const offerB = await supplierOffer(sourceB.offerId);
    const sourceBRecord = await sourceRecord(sourceB.sourceId);
    assert.equal(offerB.pendingObservation, null);
    assert.equal(offerB.supplierCatalogTraversalId, sourceBRecord.catalogSync.traversalId);
    assert.deepEqual(await publicProduct(sourceB.productId), productBBefore);
  });
});
