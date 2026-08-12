import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  buildCollisionSafeSupplierReviewQueueId,
  buildLegacySupplierReviewQueueId,
  canonicalSupplierReviewIdentity,
  planSupplierReviewQueueIds,
  supplierReviewQueueRecordMatchesIdentity,
  SupplierReviewQueueIdentityInput,
} from "../functions/src/api/suppliers/supplierQueueIdentity";
import {
  buildSupplierOfferObservationWrite,
  buildSupplierOfferPendingObservation,
  buildSupplierProductOffer,
  supplierOfferStateExpectation,
  supplierOfferStateMatchesExpectation,
} from "../functions/src/api/suppliers/supplierOfferEngine";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const canRun = Boolean(emulator);
const functionsRequire = createRequire(new URL("../functions/package.json", import.meta.url));
const { deleteApp, initializeApp } = functionsRequire("firebase-admin/app") as typeof import("firebase-admin/app");
const { getFirestore } = functionsRequire("firebase-admin/firestore") as typeof import("firebase-admin/firestore");

test("Firestore transaction contention preserves punctuation-colliding Product Review ownership", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
}, async () => {
  const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-zyro-sh2-collision-gate" }, `collision-${Date.now()}`);
  const db = getFirestore(app);
  const identityA: SupplierReviewQueueIdentityInput = {
    sourceId: "supplier-a",
    supplierProductId: "ABC.123",
    supplierCode: "ABC.123",
    productName: "Collision A",
  };
  const identityB: SupplierReviewQueueIdentityInput = {
    sourceId: "supplier-a",
    supplierProductId: "ABC123",
    supplierCode: "ABC123",
    productName: "Collision B",
  };
  const legacyId = buildLegacySupplierReviewQueueId(identityA);
  assert.equal(legacyId, buildLegacySupplierReviewQueueId(identityB));

  // This mirrors production ordering: each bounded page plans deterministic
  // IDs first, then the fenced transaction reads both offer state and queue
  // ownership before it merge-writes the review record.
  let ready = 0;
  let release!: () => void;
  const bothPlanned = new Promise<void>((resolve) => { release = resolve; });
  const processIdentity = async (input: SupplierReviewQueueIdentityInput, synchronizePlanning: boolean): Promise<string> => {
    const base = db.collection("supplier_review_queue").doc(legacyId);
    const existing = await base.get();
    const records = new Map<string, unknown>();
    if (existing.exists) records.set(existing.id, existing.data());
    const queueId = planSupplierReviewQueueIds([input], records).get(canonicalSupplierReviewIdentity(input));
    assert.ok(queueId);
    if (synchronizePlanning) {
      ready += 1;
      if (ready === 2) release();
      await bothPlanned;
    }
    const offerId = `offer-${canonicalSupplierReviewIdentity(input).replaceAll("|", "-")}`;
    const offer = db.collection("supplier_product_offers").doc(offerId);
    await offer.set({ stateVersion: 0, pendingObservation: null });
    await db.runTransaction(async (transaction) => {
      const queue = db.collection("supplier_review_queue").doc(queueId);
      const [, currentReview] = await Promise.all([
        transaction.get(offer),
        transaction.get(queue),
      ]);
      if (currentReview.exists && !supplierReviewQueueRecordMatchesIdentity(currentReview.data(), input)) {
        throw new Error("A deterministic Product Review ID is already owned by a different supplier product identity.");
      }
      transaction.set(queue, {
        sourceId: input.sourceId,
        supplierProductId: input.supplierProductId,
        supplierCode: input.supplierCode,
        supplierSnapshot: {
          sourceId: input.sourceId,
          supplierProductId: input.supplierProductId,
        },
      }, { merge: true });
    });
    return queueId;
  };

  try {
    const firstAttempts = await Promise.allSettled([
      processIdentity(identityA, true),
      processIdentity(identityB, true),
    ]);
    const succeeded = firstAttempts.filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled");
    const rejectedIndex = firstAttempts.findIndex((result) => result.status === "rejected");
    assert.equal(succeeded.length, 1, "one concurrent claimant must win the legacy ID");
    assert.notEqual(rejectedIndex, -1, "the competing identity must fail closed");
    const retriedIdentity = rejectedIndex === 0 ? identityA : identityB;
    const retryId = await processIdentity(retriedIdentity, false);
    const ids = [succeeded[0].value, retryId];
    assert.notEqual(ids[0], ids[1], "retry must use the collision-safe deterministic ID");
    assert.deepEqual(new Set(ids), new Set([
      legacyId,
      buildCollisionSafeSupplierReviewQueueId(retriedIdentity),
    ]));
  } finally {
    await deleteApp(app);
  }
});

test("Firestore transaction contention preserves the latest concurrent supplier observation", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
}, async () => {
  const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-zyro-sh2-observation-gate" }, `observation-${Date.now()}`);
  const db = getFirestore(app);
  const offerReference = db.collection("supplier_product_offers").doc(`offer-concurrent-${Date.now()}`);
  const effective = buildSupplierProductOffer({
    sourceId: "supplier-a",
    supplierId: "supplier-a",
    supplierProductId: "product-a",
    sku: "SKU-A",
    productId: "product-a",
    price: 100,
    cost: 70,
    stock: 10,
    availability: "available",
    health: { availability: "available" },
    lastSyncAt: "2026-08-02T00:00:00.000Z",
    reviewStatus: "approved",
    catalogPayload: { price: 100 },
    supplierSnapshot: { supplierProductId: "product-a" },
    timestamp: "2026-08-02T00:00:00.000Z",
  });
  const observed = (price: number, observedAt: string) => buildSupplierProductOffer({
    ...effective,
    price,
    existing: effective,
    reviewStatus: "approved",
    catalogPayload: { price },
    lastSyncAt: observedAt,
    timestamp: observedAt,
  });
  const earlier = observed(120, "2026-08-02T01:00:00.000Z");
  const latest = observed(130, "2026-08-02T02:00:00.000Z");
  const pendingFor = (offer: typeof effective, observedAt: string) => buildSupplierOfferPendingObservation({
    offer,
    kind: "catalog_upsert",
    reviewQueueItemId: "review-concurrent-a",
    observedAt,
    traversalId: "traversal-concurrent",
  });
  const baseExpectation = supplierOfferStateExpectation(effective);
  await offerReference.set(effective);
  const commit = async (offer: typeof effective, observedAt: string, expectation = baseExpectation): Promise<void> => {
    const pending = pendingFor(offer, observedAt);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(offerReference);
      if (!supplierOfferStateMatchesExpectation(snapshot.data(), expectation, snapshot.exists)) {
        throw new Error("Supplier offer state changed while its observation was being committed.");
      }
      transaction.set(offerReference, buildSupplierOfferObservationWrite({
        existing: snapshot.data() as typeof effective,
        observed: offer,
        pending,
        traversalId: "traversal-concurrent",
        observedAt,
      }), { merge: true });
    });
  };

  try {
    const results = await Promise.allSettled([
      commit(earlier, "2026-08-02T01:00:00.000Z"),
      commit(latest, "2026-08-02T02:00:00.000Z"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const latestWasRejected = results[1].status === "rejected";
    if (latestWasRejected) {
      const current = (await offerReference.get()).data()!;
      await commit(latest, "2026-08-02T02:00:00.000Z", supplierOfferStateExpectation(current));
    }
    const finalOffer = (await offerReference.get()).data()!;
    assert.equal(finalOffer.price, 100, "effective approved price must remain unchanged");
    assert.equal(finalOffer.pendingObservation.effective.price, 130);
    assert.equal(finalOffer.pendingObservation.reviewQueueItemId, "review-concurrent-a");
  } finally {
    await deleteApp(app);
  }
});
