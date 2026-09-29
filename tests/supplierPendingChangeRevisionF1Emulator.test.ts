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
const { processSupplierReviewQueueItem } = requireFunctions("../functions/src/scheduled/supplierReviewQueue.ts") as typeof import("../functions/src/scheduled/supplierReviewQueue");
const {
  refreshActiveSupplierReviewItem,
  runSupplierSync,
} = requireFunctions("../functions/src/scheduled/supplierSync.ts") as typeof import("../functions/src/scheduled/supplierSync");

const canRun = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const CONNECTOR_TYPE = "f1-dropex-pending-revision";
const SOURCE_ID = "dropex";
const TARGET_URL = "https://1.1.1.1/catalog";
const RUN_PREFIX = randomUUID().slice(0, 8);
const ADMIN = { uid: "f1-admin", email: "admin@example.test" };

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
      if (!product) throw new Error("Missing exact F1 fixture.");
      return product;
    },
  } as SupplierConnector & {
    fetchExactProductForRefresh(target: { supplierProductId: string; sku: string }): Promise<RawA2ZProduct>;
  }),
  SERVER_FILTERED_FULL_CATALOG_CAPABILITIES,
);

const identityFor = (label: string): string => `f1-${RUN_PREFIX}-${label}`;

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
      subcategories: [
        { id: "phones", name: "Phones", isActive: true },
        { id: "tablets", name: "Tablets", isActive: true },
      ],
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
    batchId: `${RUN_PREFIX}-f1-sync-${syncCounter}`,
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

const pendingChange = async (reviewId: string): Promise<Record<string, any> | undefined> => (
  (await adminDb.collection("supplier_pending_changes").doc(`change-${reviewId}`).get()).data()
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

/** Runs the queue worker only when the record is not already review_pending. */
const prepareReview = async (reviewId: string, identity: string): Promise<Record<string, any>> => {
  const current = await reviewData(reviewId);
  if (current.queueState !== "review_pending") {
    await adminDb.collection("supplier_review_queue").doc(reviewId).set({
      managedMedia: managedMedia(identity),
      mediaStatus: "ready",
    }, { merge: true });
    const result = await processSupplierReviewQueueItem(adminDb, reviewId, `f1-worker-${identity}`, Date.now());
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

const rememberOffer = (review: Record<string, any>) => {
  if (review.supplierOfferId) createdOfferIds.add(String(review.supplierOfferId));
};

const assertLowStockRejection = async (promise: Promise<unknown>) => assert.rejects(promise, (error: any) => {
  assert.equal(error?.statusCode, 422);
  assert.equal(error?.details?.validationErrors?.[0]?.code, "LOW_SUPPLIER_STOCK_FOR_PUBLICATION");
  return true;
});

/**
 * Approves, resolving only the inventory-baseline conflict the administrator
 * would explicitly resolve; any other outcome is returned unchanged.
 */
const approve = async (reviewId: string, options: Parameters<typeof decideSupplierQueueItem>[4]) => {
  const result = await decideSupplierQueueItem(adminDb, reviewId, "approved", ADMIN, options);
  if (result.status === "conflict" && result.conflict?.reason === "product_changed_after_queue") {
    return decideSupplierQueueItem(adminDb, reviewId, "approved", ADMIN, { ...options, resolveConflict: true });
  }
  return result;
};

/** Re-observes an approved live product so the worker writes a pending change at a first revision. */
const queuePriceChange = async (identity: string, reviewId: string, price: number) => {
  setCatalogProduct(identity, { price, recommendedRetailPrice: price });
  await runSync();
  const requeued = await reviewForIdentity(identity);
  assert.equal(requeued.id, reviewId, "the Product Review ID is stable across re-observations");
  const data = await prepareReview(reviewId, identity);
  assert.equal(data.queueState, "review_pending");
  assert.equal(data.comparisonStatus, "PRICE_CHANGED");
  const revision = await pendingRevision(data);
  const pending = await pendingChange(reviewId);
  assert.equal(pending?.supplierOfferPendingRevision, revision, "the worker writes the pending change at the queue revision");
  return { data, revision };
};

test("F1 emulator: pending-change revision consistency after re-observation", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
  timeout: 300_000,
}, async (t) => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  await seedSource();
  const live = identityFor("live");
  let liveReviewId = "";
  let liveProductId = "";

  try {
    await t.test("setup: a live Dropex product is published through Product Review", async () => {
      setCatalogProduct(live);
      await runSync();
      const initial = await reviewForIdentity(live);
      liveReviewId = initial.id;
      const ready = await prepareReview(initial.id, live);
      rememberOffer(ready);
      const result = await approve(initial.id, {
        draft: approvalDraft(initial.id, ready),
        expectedPendingRevision: await pendingRevision(ready),
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.match(String(result.productId || ""), /^zyro-[a-f0-9]{32}$/u);
      liveProductId = String(result.productId);
    });

    await t.test("refresh path: a review_pending re-observation with healthy media approves at the new revision", async () => {
      const { revision: revisionA } = await queuePriceChange(live, liveReviewId, 170);
      const auditsBefore = await auditCount(liveReviewId);
      const productsBefore = await productCount();

      setCatalogProduct(live, { price: 190, recommendedRetailPrice: 190 });
      const refreshed = await refreshActiveSupplierReviewItem(liveReviewId, ADMIN);
      assert.equal(refreshed.item.id, liveReviewId);
      const data = await reviewData(liveReviewId);
      assert.equal(data.queueState, "review_pending", "healthy media keeps the record review_pending without a worker pass");
      const revisionB = await pendingRevision(data);
      assert.notEqual(revisionB, revisionA);
      const stale = await pendingChange(liveReviewId);
      assert.equal(stale?.supplierOfferPendingRevision, revisionA, "no worker pass rewrote the pending change");
      assert.notEqual(stale?.productPayload?.price, data.productPayload.price, "the pending change carries the older supplier price");

      const draft = approvalDraft(liveReviewId, data, { productName: "F1 admin title", editedFields: ["name"] });
      const result = await approve(liveReviewId, { draft, expectedPendingRevision: revisionB });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.productId, liveProductId, "the same live product is updated");
      assert.equal(await productCount(), productsBefore, "no duplicate product");
      const product = (await adminDb.collection("products").doc(liveProductId).get()).data()!;
      assert.equal(product.name, "F1 admin title", "the administrator title override is published");
      assert.equal(product.price, draft.sellingPrice, "the administrator price from the current draft is published");
      const decided = await reviewData(liveReviewId);
      assert.equal(decided.decisionAction, "approved");
      assert.equal(decided.decisionPendingRevision, revisionB);
      assert.equal(decided.productPayload.price, data.productPayload.price, "the decision records the fresh supplier payload");
      assert.notEqual(decided.productPayload.price, stale?.productPayload?.price, "the stale pending-change payload never wins");
      assert.equal(decided.supplierSnapshot?.price ?? decided.supplierSnapshot?.recommendedRetailPrice, data.supplierSnapshot?.price ?? data.supplierSnapshot?.recommendedRetailPrice);
      assert.equal(await pendingChange(liveReviewId), undefined, "approval removes the pending change");
      assert.ok(await auditCount(liveReviewId) > auditsBefore, "audit history grows and is never erased");
    });

    await t.test("normal sync path: a review_pending re-observation approves at the new revision with admin category edits", async () => {
      const { revision: revisionA } = await queuePriceChange(live, liveReviewId, 210);
      const pendingAtA = await pendingChange(liveReviewId);
      assert.equal(pendingAtA?.supplierOfferPendingRevision, revisionA);
      setCatalogProduct(live, { price: 230, recommendedRetailPrice: 230 });
      await runSync();
      const resynced = await reviewForIdentity(live);
      assert.equal(resynced.id, liveReviewId);
      const synced = await reviewData(liveReviewId);
      const revisionB = await pendingRevision(synced);
      assert.notEqual(revisionB, revisionA);
      const preserved = synced.queueState === "review_pending";
      t.diagnostic(`normal sync kept review_pending without a worker pass: ${preserved}`);
      if (preserved) {
        assert.equal((await pendingChange(liveReviewId))?.supplierOfferPendingRevision, revisionA);
      }
      const ready = await prepareReview(liveReviewId, live);
      assert.equal(ready.supplierOfferPendingRevision, revisionB);
      if (!preserved) {
        assert.equal((await pendingChange(liveReviewId))?.supplierOfferPendingRevision, revisionB, "a worker pass rewrites the pending change at the new revision");
      }
      // Pending changes written before the fix can still hold an older revision.
      await adminDb.collection("supplier_pending_changes").doc(`change-${liveReviewId}`).set(pendingAtA!);
      const result = await approve(liveReviewId, {
        draft: approvalDraft(liveReviewId, ready, { subcategory: "tablets", editedFields: ["subcategory"] }),
        expectedPendingRevision: revisionB,
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.productId, liveProductId);
      const product = (await adminDb.collection("products").doc(liveProductId).get()).data()!;
      assert.equal(product.subcategory ?? product.subcategoryId, "tablets", "the administrator subcategory override is published");
      const decided = await reviewData(liveReviewId);
      assert.equal(decided.productPayload.price, ready.productPayload.price, "the decision records the fresh supplier payload");
      assert.notEqual(decided.productPayload.price, pendingAtA?.productPayload?.price, "the stale pending change never overlays the current observation");
      assert.equal(decided.decisionPendingRevision, revisionB);
      assert.equal(await pendingChange(liveReviewId), undefined, "approval removes the stale pending change");
      const snapshot = await adminDb.collection("supplier_review_queue").where("supplierCode", "==", `${live}-sku`).get();
      assert.equal(snapshot.size, 1, "no duplicate Product Review document");
    });

    await t.test("true concurrency: a newer observation than the one the admin opened still fails closed", async () => {
      const { revision: openedRevision } = await queuePriceChange(live, liveReviewId, 250);
      const opened = await reviewData(liveReviewId);
      setCatalogProduct(live, { price: 270, recommendedRetailPrice: 270 });
      await refreshActiveSupplierReviewItem(liveReviewId, ADMIN);
      const advanced = await reviewData(liveReviewId);
      const advancedRevision = await pendingRevision(advanced);
      assert.notEqual(advancedRevision, openedRevision);
      const productBefore = (await adminDb.collection("products").doc(liveProductId).get()).data()!;

      await assert.rejects(approve(liveReviewId, {
        draft: approvalDraft(liveReviewId, opened),
        expectedPendingRevision: openedRevision,
      }), (error: any) => {
        assert.equal(error?.statusCode, 409);
        return true;
      });

      const offerReference = adminDb.collection("supplier_product_offers").doc(String(advanced.supplierOfferId));
      const offer = (await offerReference.get()).data()!;
      await offerReference.set({
        pendingObservation: { ...offer.pendingObservation, revision: "c".repeat(64) },
      }, { merge: true });
      await assert.rejects(approve(liveReviewId, {
        draft: approvalDraft(liveReviewId, advanced),
        expectedPendingRevision: advancedRevision,
      }), (error: any) => {
        assert.equal(error?.statusCode, 409);
        assert.match(String(error?.message || ""), /supplier observation/u);
        return true;
      });
      const productAfter = (await adminDb.collection("products").doc(liveProductId).get()).data()!;
      assert.equal(productAfter.price, productBefore.price, "no product write on a real observation conflict");
      assert.equal((await reviewData(liveReviewId)).queueState, "review_pending");
    });

    await t.test("B1 hold recovery: stock 0 -> 5 through refresh approves without a false 409 and keeps the guard", async () => {
      const held = identityFor("held");
      setCatalogProduct(held);
      await runSync();
      const initial = await reviewForIdentity(held);
      const heldReviewId = initial.id;
      const first = await prepareReview(heldReviewId, held);
      rememberOffer(first);
      const dismissed = await decideSupplierQueueItem(adminDb, heldReviewId, "deleted", ADMIN, {
        deletionReason: "F1 emulator dismissal before re-observation.",
        expectedPendingRevision: await pendingRevision(first),
      });
      assert.equal(dismissed.success, true);

      setCatalogProduct(held, { price: 180, recommendedRetailPrice: 180, inventoryLevel: 0 });
      await runSync();
      const heldData = await prepareReview(heldReviewId, held);
      assert.equal(heldData.comparisonStatus, "PRICE_CHANGED");
      assert.equal(heldData.productValidation.lowStockHold, true);
      const revisionA = await pendingRevision(heldData);
      assert.equal((await pendingChange(heldReviewId))?.supplierOfferPendingRevision, revisionA);
      const productsBefore = await productCount();
      await assertLowStockRejection(approve(heldReviewId, {
        draft: approvalDraft(heldReviewId, heldData),
        expectedPendingRevision: revisionA,
      }));

      setCatalogProduct(held, { price: 180, recommendedRetailPrice: 180, inventoryLevel: 3 });
      await refreshActiveSupplierReviewItem(heldReviewId, ADMIN);
      const lowData = await reviewData(heldReviewId);
      assert.equal(lowData.queueState, "review_pending");
      assert.equal(lowData.productValidation.lowStockHold, true);
      await assertLowStockRejection(approve(heldReviewId, {
        draft: approvalDraft(heldReviewId, lowData),
        expectedPendingRevision: await pendingRevision(lowData),
      }));

      setCatalogProduct(held, { price: 180, recommendedRetailPrice: 180, inventoryLevel: 5 });
      await refreshActiveSupplierReviewItem(heldReviewId, ADMIN);
      const recovered = await reviewData(heldReviewId);
      assert.equal(recovered.queueState, "review_pending");
      assert.equal(recovered.productValidation.lowStockHold, false);
      assert.ok(recovered.comparison.fieldChanges.some((change: any) => change.field === "price"), "accumulated price change is kept");
      const revisionB = await pendingRevision(recovered);
      assert.equal((await pendingChange(heldReviewId))?.supplierOfferPendingRevision, revisionA, "the pending change is from the held revision");

      const result = await approve(heldReviewId, {
        draft: approvalDraft(heldReviewId, recovered, { productName: "F1 recovered title" }),
        expectedPendingRevision: revisionB,
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.match(String(result.productId || ""), /^zyro-[a-f0-9]{32}$/u);
      assert.equal(await productCount(), productsBefore + 1, "exactly one product is created");
      const product = (await adminDb.collection("products").doc(String(result.productId)).get()).data()!;
      assert.equal(product.name, "F1 recovered title");
      assert.equal(product.stock, 5);
      const reviews = await adminDb.collection("supplier_review_queue").where("supplierCode", "==", `${held}-sku`).get();
      assert.equal(reviews.size, 1);
      assert.equal(reviews.docs[0].id, heldReviewId);
    });
  } finally {
    await Promise.all([...createdOfferIds].map((offerId) => (
      adminDb.collection("supplier_product_offers").doc(offerId).set({ enabled: false }, { merge: true })
    )));
  }
});
