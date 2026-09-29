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

// Keep stateful Functions modules in one CommonJS cache so the connector
// registered here is the same SupplierRegistry instance used by runSupplierSync.
const requireFunctions = createRequire(import.meta.url);
const { adminDb } = requireFunctions("../functions/src/api/firebase.ts") as typeof import("../functions/src/api/firebase");
const {
  decideSupplierQueueItem,
  parseSupplierApprovalDraft,
} = requireFunctions("../functions/src/api/suppliers/supplierApproval.ts") as typeof import("../functions/src/api/suppliers/supplierApproval");
const { SupplierRegistry } = requireFunctions("../functions/src/api/suppliers/SupplierRegistry.ts") as typeof import("../functions/src/api/suppliers/SupplierRegistry");
const { ProductParser } = requireFunctions("../functions/src/api/suppliers/a2z/ProductParser.ts") as typeof import("../functions/src/api/suppliers/a2z/ProductParser");
const { SERVER_FILTERED_FULL_CATALOG_CAPABILITIES } = requireFunctions("../functions/src/api/suppliers/supplierSyncCapabilities.ts") as typeof import("../functions/src/api/suppliers/supplierSyncCapabilities");
const { buildSupplierProductOffer } = requireFunctions("../functions/src/api/suppliers/supplierOfferEngine.ts") as typeof import("../functions/src/api/suppliers/supplierOfferEngine");
const {
  processSupplierReviewQueueItem,
  projectSupplierReviewLowStockHold,
  reviewRecordIsActionable,
  reviewRecordIsTerminalDecision,
} = requireFunctions("../functions/src/scheduled/supplierReviewQueue.ts") as typeof import("../functions/src/scheduled/supplierReviewQueue");
const {
  refreshActiveSupplierReviewItem,
  runSupplierSync,
} = requireFunctions("../functions/src/scheduled/supplierSync.ts") as typeof import("../functions/src/scheduled/supplierSync");
const { runDropexInventoryRefresh } = requireFunctions("../functions/src/scheduled/supplierInventoryRefresh.ts") as typeof import("../functions/src/scheduled/supplierInventoryRefresh");

const canRun = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const CONNECTOR_TYPE = "b1-dropex-low-stock-review";
const SOURCE_ID = "dropex";
const TARGET_URL = "https://1.1.1.1/catalog";
const RUN_PREFIX = randomUUID().slice(0, 8);
const ADMIN = { uid: "b1-admin", email: "admin@example.test" };

const catalog = new Map<string, RawA2ZProduct>();
const createdOfferIds = new Set<string>();

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
    async fetchProductPage(_request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
      const products = [...catalog.values()];
      return {
        products,
        targetUrl: TARGET_URL,
        nextCursor: null,
        complete: true,
        catalogTotal: { count: products.length, reliability: "exact" },
      };
    },
    async fetchProducts() {
      return { products: [...catalog.values()], targetUrl };
    },
    async testConnection() {
      return { success: true, status: "Connected", productsCount: catalog.size, sampleProduct: null };
    },
    async fetchExactProductForRefresh(target: { supplierProductId: string; sku: string }) {
      const product = [...catalog.values()].find((candidate) => (
        candidate.supplierProductId === target.supplierProductId && candidate.sku === target.sku
      ));
      if (!product) throw new Error("Missing exact B1 fixture.");
      return product;
    },
  } as SupplierConnector & {
    fetchExactProductForRefresh(target: { supplierProductId: string; sku: string }): Promise<RawA2ZProduct>;
  }),
  SERVER_FILTERED_FULL_CATALOG_CAPABILITIES,
);

const identityFor = (label: string): string => `b1-${RUN_PREFIX}-${label}`;

const barcodeFor = (identity: string): string => Array.from(
  createHash("sha256").update(identity).digest().subarray(0, 13),
  (value) => String(value % 10),
).join("");

const setCatalogProduct = (identity: string, overrides: Record<string, unknown> = {}): void => {
  catalog.set(identity, ProductParser.parseJsonPayload({
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
    specifications: { Model: identity, Brand: "Test Brand" },
    ...overrides,
  }));
};

const seedSource = async (): Promise<void> => {
  await Promise.all([
    adminDb.collection("supplierSources").doc(SOURCE_ID).set({
      supplierId: SOURCE_ID,
      supplierAccountId: SOURCE_ID,
      supplierName: "Dropex",
      connectorType: CONNECTOR_TYPE,
      supplierType: "website",
      sourceStatus: "active",
      enabled: true,
      currentlySyncing: false,
      priority: 100,
      websiteUrl: TARGET_URL,
      endpoint: "",
      authentication: { mode: "none" },
      capabilities: ["catalog.fetch", "connection.test"],
      settings: { autoSync: "Off", productLimit: 200 },
    }, { merge: true }),
    adminDb.collection("users").doc(SOURCE_ID).set({ role: "supplier", email: "dropex@example.test" }, { merge: true }),
    adminDb.collection("supplier_profiles").doc(SOURCE_ID).set({
      supplierId: SOURCE_ID,
      companyName: "Dropex",
      profileStatus: "active",
    }, { merge: true }),
    adminDb.collection("categories").doc("electronics").set({
      name: "Electronics",
      isActive: true,
      keywords: ["electronics"],
      subcategories: [{ id: "phones", name: "Phones", isActive: true }],
      specificationTemplate: [{ name: "Model", required: true }],
    }),
    adminDb.collection("brands").doc("test-brand").set({ name: "Test Brand", isActive: true, aliases: ["TEST BRAND"] }),
    adminDb.collection("supplier_settings").doc("config").set({
      autoSyncEnabled: false,
      defaultMarkup: 30,
      defaultProfitMargin: 20,
      maxProducts: 200,
      productLimit: 200,
      defaultImageLimit: 10,
      categoryMappings: { electronics: "electronics" },
    }, { merge: true }),
  ]);
};

let syncCounter = 0;
const runSync = async () => {
  syncCounter += 1;
  const result = await runSupplierSync({
    trigger: "manual",
    sourceIds: [SOURCE_ID],
    batchId: `${RUN_PREFIX}-b1-sync-${syncCounter}`,
    syncRequest: { mode: "full", pageSize: 50 },
    maxRuntimeMs: 60_000,
  });
  assert.equal(result.status, "Success", JSON.stringify((result as { errors?: unknown }).errors ?? result));
  return result;
};

const reviewForIdentity = async (identity: string) => {
  const snapshot = await adminDb.collection("supplier_review_queue").where("supplierCode", "==", `${identity}-sku`).get();
  assert.equal(snapshot.size, 1, `Expected exactly one Product Review document for ${identity}.`);
  return snapshot.docs[0];
};

const reviewData = async (reviewId: string): Promise<Record<string, any>> => (
  (await adminDb.collection("supplier_review_queue").doc(reviewId).get()).data() || {}
);

const managedMedia = (identity: string) => {
  const contentHash = createHash("sha256").update(identity).digest("hex");
  const variant = (name: string, size: number) => ({
    storagePath: `${identity}/${name}.webp`,
    storageUrl: `https://storage.example/${identity}-${name}.webp`,
    width: size,
    height: size,
    mimeType: "image/webp",
    fileSize: size,
  });
  return [{
    assetId: contentHash,
    supplierId: SOURCE_ID,
    sourceId: SOURCE_ID,
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
    uploadTimestamp: "2026-09-01T00:00:00.000Z",
    imageStatus: "ready",
    isPrimary: true,
    sortOrder: 0,
    variants: { thumbnail: variant("thumbnail", 200), medium: variant("medium", 800), large: variant("large", 1200) },
  }];
};

const prepareReview = async (reviewId: string, identity: string): Promise<Record<string, any>> => {
  const current = await reviewData(reviewId);
  if (current.queueState !== "review_pending") {
    await adminDb.collection("supplier_review_queue").doc(reviewId).set({
      managedMedia: managedMedia(identity),
      mediaStatus: "ready",
    }, { merge: true });
    const result = await processSupplierReviewQueueItem(adminDb, reviewId, `b1-worker-${identity}`, Date.now());
    assert.deepEqual(result, { queueItemId: reviewId, outcome: "completed", state: "review_pending" });
  }
  return reviewData(reviewId);
};

const pendingRevision = async (review: Record<string, any>): Promise<string> => {
  const offer = (await adminDb.collection("supplier_product_offers").doc(String(review.supplierOfferId)).get()).data()!;
  const revision = String(offer.pendingObservation?.revision || "");
  assert.match(revision, /^[a-f0-9]{64}$/u);
  assert.equal(review.supplierOfferPendingRevision, revision);
  return revision;
};

const approvalDraft = (reviewId: string, data: Record<string, any>, overrides: Partial<SupplierReviewDraft> = {}) => {
  const sourceItem: SupplierReviewSourceItem = {
    id: reviewId,
    productName: String(data.productName || ""),
    supplierCode: String(data.supplierCode || ""),
    supplierName: String(data.supplierName || ""),
    costPrice: Number(data.costPrice || 0),
    marketPrice: Number(data.marketPrice || 0),
    stock: Number(data.stock || 0),
    imageUrl: String(data.imageUrl || ""),
    sourceId: String(data.sourceId || ""),
    supplierOfferId: String(data.supplierOfferId || ""),
    productPayload: data.productPayload,
    supplierSnapshot: data.supplierSnapshot,
    managedMedia: data.managedMedia,
    mediaStatus: String(data.mediaStatus || ""),
    categoryMapping: data.categoryMapping,
    brandMapping: data.brandMapping,
    productValidation: data.productValidation,
    comparison: data.comparison,
  };
  const draft = createSupplierReviewDraft(sourceItem);
  const managedAssets = Array.isArray(data.managedMedia) ? data.managedMedia : [];
  return parseSupplierApprovalDraft({
    ...draft,
    category: "electronics",
    subcategory: "phones",
    brand: "test-brand",
    specifications: { Model: String(data.supplierSnapshot?.supplierProductId || reviewId) },
    ...overrides,
    description: String(draft.description || "").trim() || "Supplier approved description for emulator review.",
    primaryImageUrl: String(managedAssets[0]?.firebaseStorageUrl || ""),
    galleryImageUrls: managedAssets.slice(1).map((asset: any) => String(asset.firebaseStorageUrl || "")).filter(Boolean),
  })!;
};

const productCount = async (): Promise<number> => (await adminDb.collection("products").get()).size;

const auditCount = async (reviewId: string): Promise<number> => (
  await adminDb.collection("supplier_approval_audit").where("queueItemId", "==", reviewId).get()
).size;

const assertLowStockRejection = async (promise: Promise<unknown>) => assert.rejects(promise, (error: any) => {
  assert.equal(error?.statusCode, 422);
  assert.equal(error?.details?.validationErrors?.[0]?.code, "LOW_SUPPLIER_STOCK_FOR_PUBLICATION");
  return true;
});

const rememberOffer = (review: Record<string, any>) => {
  if (review.supplierOfferId) createdOfferIds.add(String(review.supplierOfferId));
};

test("B1 emulator: low-stock hold, authoritative approval safety and revision-scoped decisions", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
  timeout: 300_000,
}, async (t) => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  await seedSource();
  const suppressed = identityFor("suppressed");
  let suppressedReviewId = "";
  let suppressedCreatedAt = "";
  let staleDecisionRevision = "";

  try {
    await t.test("A: a suppressed unpublished offer re-observed at stock 0 with a price change is held and actionable", async () => {
      setCatalogProduct(suppressed);
      await runSync();
      const initial = await reviewForIdentity(suppressed);
      suppressedReviewId = initial.id;
      const ready = await prepareReview(initial.id, suppressed);
      rememberOffer(ready);
      suppressedCreatedAt = String(ready.createdAt || "");
      staleDecisionRevision = await pendingRevision(ready);
      const dismissed = await decideSupplierQueueItem(adminDb, initial.id, "deleted", ADMIN, {
        deletionReason: "B1 emulator dismissal before re-observation.",
        expectedPendingRevision: staleDecisionRevision,
      });
      assert.equal(dismissed.success, true);
      const dismissedData = await reviewData(initial.id);
      assert.equal(dismissedData.decisionAction, "deleted");
      assert.equal(dismissedData.decisionPendingRevision, staleDecisionRevision);
      const offerAfterDismissal = (await adminDb.collection("supplier_product_offers").doc(String(ready.supplierOfferId)).get()).data()!;
      assert.equal(offerAfterDismissal.reviewStatus, "suppressed");
      const auditsBefore = await auditCount(initial.id);
      const productsBefore = await productCount();

      setCatalogProduct(suppressed, { price: 180, recommendedRetailPrice: 180, inventoryLevel: 0 });
      await runSync();
      const requeued = await reviewForIdentity(suppressed);
      assert.equal(requeued.id, suppressedReviewId);
      const data = await prepareReview(requeued.id, suppressed);
      assert.equal(data.queueState, "review_pending");
      assert.equal(data.status, "Pending");
      assert.equal(data.comparisonStatus, "PRICE_CHANGED");
      assert.notEqual(data.supplierOfferPendingRevision, staleDecisionRevision);
      assert.equal(data.productValidation.lowStockHold, true);
      assert.equal(data.productValidation.readyToPublish, false);
      assert.equal(data.comparison.matchedProductLive, false);
      assert.equal(reviewRecordIsTerminalDecision(data), false);
      assert.equal(reviewRecordIsActionable(data), true);
      for (const field of ["decisionAction", "decisionPendingRevision", "decisionCompletedAt", "decisionCompletedBy", "decisionAuditId"]) {
        assert.equal(Object.hasOwn(data, field), false, `${field} must be cleared on requeue`);
      }
      assert.ok(await auditCount(requeued.id) >= auditsBefore, "audit history is never erased");
      const deleteAudit = await adminDb.collection("supplier_approval_audit").doc(String(dismissedData.decisionAuditId)).get();
      assert.equal(deleteAudit.exists, true);
      assert.equal(deleteAudit.data()?.action, "delete");
      assert.equal(await productCount(), productsBefore);
      suppressedCreatedAt = String(data.createdAt || "");
    });

    await t.test("F: a legacy stale decision on a pending record is not terminal and is cleared by the next requeue", async () => {
      await adminDb.collection("supplier_review_queue").doc(suppressedReviewId).set({
        decisionAction: "rejected",
        decisionPendingRevision: staleDecisionRevision,
        systemDecision: "LEGACY_STALE_DECISION",
      }, { merge: true });
      const legacy = await reviewData(suppressedReviewId);
      assert.notEqual(legacy.supplierOfferPendingRevision, staleDecisionRevision);
      assert.equal(reviewRecordIsTerminalDecision(legacy), false);
      assert.equal(reviewRecordIsActionable(legacy), true);
      assert.equal((projectSupplierReviewLowStockHold(legacy).productValidation as Record<string, unknown>).lowStockHold, true);
    });

    await t.test("C: approval at stock 0 is rejected and creates no product", async () => {
      const data = await reviewData(suppressedReviewId);
      const revision = await pendingRevision(data);
      const productsBefore = await productCount();
      await assertLowStockRejection(decideSupplierQueueItem(adminDb, suppressedReviewId, "approved", ADMIN, {
        draft: approvalDraft(suppressedReviewId, data),
        expectedPendingRevision: revision,
      }));
      assert.equal(await productCount(), productsBefore);
      const after = await reviewData(suppressedReviewId);
      assert.equal(after.queueState, "review_pending");
      assert.equal(after.supplierOfferPendingRevision, revision);
    });

    await t.test("B: the same record at stock 5 releases the hold, keeps pending changes and clears the legacy decision", async () => {
      setCatalogProduct(suppressed, { price: 180, recommendedRetailPrice: 180, inventoryLevel: 5 });
      await runSync();
      const recovered = await reviewForIdentity(suppressed);
      assert.equal(recovered.id, suppressedReviewId);
      const data = await prepareReview(recovered.id, suppressed);
      assert.equal(data.queueState, "review_pending");
      assert.equal(data.productValidation.lowStockHold, false);
      assert.equal(data.productValidation.errors.some((error: any) => error.code === "LOW_SUPPLIER_STOCK_FOR_PUBLICATION"), false);
      assert.equal(data.comparisonStatus, "PRICE_CHANGED");
      assert.ok(data.comparison.fieldChanges.some((change: any) => change.field === "price"), "pending price change is preserved");
      const pendingChange = data.pendingChangePayload
        || (await adminDb.collection("supplier_pending_changes").doc(`change-${suppressedReviewId}`).get()).data();
      assert.ok(pendingChange, "pending change record is preserved");
      assert.ok(pendingChange.fieldChanges.some((change: any) => change.field === "price"));
      assert.equal(data.productPayload.price, 180);
      assert.equal(String(data.createdAt || ""), suppressedCreatedAt);
      for (const field of ["decisionAction", "decisionPendingRevision", "systemDecision"]) {
        assert.equal(Object.hasOwn(data, field), false, `${field} must be cleared on requeue`);
      }
      const snapshot = await adminDb.collection("supplier_review_queue").where("supplierCode", "==", `${suppressed}-sku`).get();
      assert.equal(snapshot.size, 1);
      assert.equal((await adminDb.collection("supplier_product_offers").doc(String(data.supplierOfferId)).get()).data()?.reviewStatus, "review_pending");
    });

    await t.test("D: approval at stock 5 creates exactly one zyro- product with correct linkage", async () => {
      const data = await reviewData(suppressedReviewId);
      const revision = await pendingRevision(data);
      const productsBefore = await productCount();
      const result = await decideSupplierQueueItem(adminDb, suppressedReviewId, "approved", ADMIN, {
        draft: approvalDraft(suppressedReviewId, data),
        expectedPendingRevision: revision,
      });
      assert.equal(result.success, true);
      assert.match(String(result.productId || ""), /^zyro-[a-f0-9]{32}$/u);
      assert.equal(await productCount(), productsBefore + 1);
      const product = (await adminDb.collection("products").doc(result.productId!).get()).data()!;
      const offer = (await adminDb.collection("supplier_product_offers").doc(String(data.supplierOfferId)).get()).data()!;
      const decided = await reviewData(suppressedReviewId);
      assert.equal(product.isActive, true);
      assert.equal(product.stock, 5);
      assert.equal(offer.productId, result.productId);
      assert.equal(offer.reviewStatus, "approved");
      assert.equal(decided.canonicalProductId, result.productId);
      assert.equal(decided.decisionAction, "approved");
      assert.equal(decided.decisionPendingRevision, revision);
      assert.equal(reviewRecordIsTerminalDecision(decided), true);
    });

    await t.test("E: an inactive product at stock 0 cannot be reactivated; at stock 5 the same product is updated", async () => {
      const data = await reviewData(suppressedReviewId);
      const productId = String(data.canonicalProductId);
      await adminDb.collection("products").doc(productId).set({ isActive: false, active: false, visible: false }, { merge: true });

      setCatalogProduct(suppressed, { price: 190, recommendedRetailPrice: 190, inventoryLevel: 0 });
      await runSync();
      const requeued = await reviewForIdentity(suppressed);
      assert.equal(requeued.id, suppressedReviewId);
      const held = await prepareReview(requeued.id, suppressed);
      assert.equal(held.queueState, "review_pending");
      assert.equal(held.comparison.matchFound, true);
      assert.equal(held.comparison.matchedProductLive, false);
      assert.equal(held.productValidation.lowStockHold, true);
      assert.equal(Object.hasOwn(held, "decisionAction"), false);
      const heldRevision = await pendingRevision(held);
      const productsBefore = await productCount();
      await assertLowStockRejection(decideSupplierQueueItem(adminDb, suppressedReviewId, "approved", ADMIN, {
        draft: approvalDraft(suppressedReviewId, held, { isActive: true, editedFields: ["isActive"] }),
        expectedPendingRevision: heldRevision,
      }));
      assert.equal(await productCount(), productsBefore);
      assert.equal((await adminDb.collection("products").doc(productId).get()).data()?.isActive, false);

      setCatalogProduct(suppressed, { price: 190, recommendedRetailPrice: 190, inventoryLevel: 5 });
      const refreshed = await refreshActiveSupplierReviewItem(suppressedReviewId, ADMIN);
      assert.equal(refreshed.item.id, suppressedReviewId);
      const refreshedData = await reviewData(suppressedReviewId);
      assert.equal(refreshedData.productValidation.lowStockHold, false);
      assert.equal(refreshedData.comparison.matchedProductLive, false);

      await runSync();
      const recovered = await prepareReview(suppressedReviewId, suppressed);
      assert.equal(recovered.productValidation.lowStockHold, false);
      assert.equal(recovered.comparison.matchedProductLive, false);
      const recoveredRevision = await pendingRevision(recovered);
      const reactivationDraft = approvalDraft(suppressedReviewId, recovered, { isActive: true, editedFields: ["isActive"] });
      let approved = await decideSupplierQueueItem(adminDb, suppressedReviewId, "approved", ADMIN, {
        draft: reactivationDraft,
        expectedPendingRevision: recoveredRevision,
      });
      if (approved.status === "conflict") {
        // Inventory automation moved the hidden product's availability after the
        // baseline was captured; the administrator resolves that conflict explicitly.
        assert.equal(approved.conflict?.reason, "product_changed_after_queue");
        assert.equal(await productCount(), productsBefore);
        approved = await decideSupplierQueueItem(adminDb, suppressedReviewId, "approved", ADMIN, {
          draft: reactivationDraft,
          expectedPendingRevision: recoveredRevision,
          resolveConflict: true,
        });
      }
      assert.equal(approved.success, true, JSON.stringify(approved));
      assert.equal(approved.productId, productId);
      assert.equal(await productCount(), productsBefore);
      const product = (await adminDb.collection("products").doc(productId).get()).data()!;
      assert.equal(product.isActive, true);
      assert.notEqual(product.visible, false);
      const decided = await reviewData(suppressedReviewId);
      assert.equal(decided.decisionProductId, productId);
      assert.equal(decided.decisionPendingRevision, recoveredRevision);
      const offer = (await adminDb.collection("supplier_product_offers").doc(String(decided.supplierOfferId)).get()).data()!;
      assert.equal(offer.productId, productId);
      assert.equal(offer.stock, 5);
      const productsForOffer = await adminDb.collection("products").where("supplierItemCode", "==", `${suppressed}-sku`).get();
      assert.ok(productsForOffer.size <= 1, "no duplicate product for the supplier offer");
    });

    await t.test("G: a live Dropex product at stock 2 is still updated by the inventory refresher without a hold", async () => {
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const productId = `b1-live-product-${suffix}`;
      const supplierProductId = `b1-live-supplier-${suffix}`;
      const sku = `B1-LIVE-${suffix}`;
      const liveOffer = buildSupplierProductOffer({
        sourceId: SOURCE_ID,
        supplierId: SOURCE_ID,
        supplierProductId,
        sku,
        productId,
        price: 1_500,
        cost: 900,
        stock: 2,
        stockKnown: true,
        availability: "in_stock",
        reviewStatus: "approved",
        enabled: true,
        health: { availability: "available", sourceAvailability: "available" },
        supplierSnapshot: { providedFields: ["stock"], inventoryLevel: 2 },
        lastSyncAt: "2026-09-25T00:00:00.000Z",
        stateVersion: 1,
        timestamp: "2026-09-25T00:00:00.000Z",
      });
      createdOfferIds.add(liveOffer.id);
      await Promise.all([
        adminDb.collection("supplier_product_offers").doc(liveOffer.id).set(liveOffer),
        adminDb.collection("products").doc(productId).set({
          id: productId,
          name: "B1 live low-stock fixture",
          isActive: true,
          stock: 2,
          availability: "in_stock",
          price: 1_500,
          supplierSourceId: SOURCE_ID,
          supplierItemCode: sku,
        }),
        adminDb.collection("product_private").doc(productId).set({
          supplierId: SOURCE_ID,
          supplierSourceId: SOURCE_ID,
          supplierOfferSelection: { activeOfferId: liveOffer.id, lockedOfferId: null },
          supplierMetadata: {
            activeOfferId: liveOffer.id,
            supplierProductId,
            sku,
            inventoryLevel: 2,
            localDemand: { version: 1, quantity: 0, status: "tracked" },
          },
        }),
      ]);
      const result = await runDropexInventoryRefresh(Date.now(), adminDb, 20, async () => ({
        id: SOURCE_ID,
        name: "Dropex",
        connectorType: "dropex",
        enabled: true,
        priority: 100,
        capabilities: ["inventory.read"],
        fetchProducts: async () => ({ products: [], targetUrl: "" }),
        fetchProductPage: async () => ({ products: [], targetUrl: "", nextCursor: null, complete: true }),
        testConnection: async () => ({ success: true, status: "Connected" as const, productsCount: 0, sampleProduct: null }),
        fetchExactInventoryForRefresh: async (target: { supplierProductId: string; sku: string }) => ({
          ...target,
          stock: target.sku === sku ? 1 : 5,
        }),
      }) as never);
      assert.equal(result.skipped, false);
      assert.ok(result.updated >= 1);
      assert.equal((await adminDb.collection("supplier_product_offers").doc(liveOffer.id).get()).data()?.stock, 1);
      assert.equal((await adminDb.collection("products").doc(productId).get()).data()?.stock, 1);
      assert.equal((await adminDb.collection("supplier_review_queue").where("canonicalProductId", "==", productId).get()).empty, true);
    });
  } finally {
    await Promise.all([...createdOfferIds].map((offerId) => (
      adminDb.collection("supplier_product_offers").doc(offerId).set({ enabled: false }, { merge: true })
    )));
  }
});
