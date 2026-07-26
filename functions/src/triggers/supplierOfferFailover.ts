import { logger } from "firebase-functions";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../api/firebase";
import {
  reconcileSupplierProductOfferFailover,
  SUPPLIER_PRODUCT_OFFERS_COLLECTION,
  supplierOfferEligibilityChanged,
} from "../api/suppliers/supplierOfferEngine";

const normalized = (value: unknown): string => typeof value === "string" ? value.trim().toLowerCase() : "";

export function isSupplierSourceAvailableForCommerce(value: unknown): boolean {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const health = source.syncHealth && typeof source.syncHealth === "object" && !Array.isArray(source.syncHealth)
    ? source.syncHealth as Record<string, unknown>
    : {};
  const healthScore = Number(health.healthScore ?? source.healthScore);
  return source.enabled !== false
    && !["inactive", "disabled"].includes(normalized(source.sourceStatus))
    && !["paused", "disabled"].includes(normalized(source.operationalState))
    && normalized(source.connectionStatus) !== "failed"
    && normalized(health.availability) !== "unavailable"
    && (!Number.isFinite(healthScore) || healthScore >= 40);
}

export function supplierSourceEligibilityChanged(before: unknown, after: unknown): boolean {
  return isSupplierSourceAvailableForCommerce(before) !== isSupplierSourceAvailableForCommerce(after);
}

async function projectSupplierSourceAvailability(sourceId: string, available: boolean): Promise<number> {
  const pageSize = 400;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let updated = 0;
  while (true) {
    let query = adminDb.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION)
      .where("sourceId", "==", sourceId)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    const batch = adminDb.batch();
    snapshot.docs.forEach((document) => {
      batch.update(document.ref, {
        "health.sourceAvailability": available ? "available" : "unavailable",
        "health.sourceAvailabilityObservedAt": FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
    updated += snapshot.size;
    cursor = snapshot.docs.at(-1) || null;
    if (snapshot.size < pageSize) break;
  }
  return updated;
}

/**
 * Supplier-offer writes remain approval-gated. This trigger only reacts when
 * eligibility changes and projects an already-approved replacement offer.
 */
export const reconcileSupplierOfferFailover = onDocumentWritten(
  "supplier_product_offers/{offerId}",
  async (event) => {
    const before = event.data?.before.data() || null;
    const after = event.data?.after.data() || null;
    if (!supplierOfferEligibilityChanged(before, after)) return;

    const productIds = [...new Set([before?.productId, after?.productId]
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter(Boolean))];
    for (const productId of productIds) {
      const result = await reconcileSupplierProductOfferFailover(
        adminDb,
        productId,
        `Supplier offer ${event.params.offerId} eligibility changed.`,
      );
      if (result.changed) {
        logger.info("Supplier product offer failed over.", {
          productId,
          previousOfferId: result.previousOfferId,
          activeOfferId: result.activeOfferId,
        });
      }
    }
  },
);

/**
 * Source health is projected onto each independent offer. Offer-write events
 * then use the same approval-gated atomic failover path as stock and offer
 * availability changes.
 */
export const reconcileSupplierSourceOfferAvailability = onDocumentWritten({
  document: "supplierSources/{sourceId}",
  timeoutSeconds: 540,
  memory: "1GiB",
}, async (event) => {
  const before = event.data?.before.data() || null;
  const after = event.data?.after.data() || null;
  if (!supplierSourceEligibilityChanged(before, after)) return;
  const available = isSupplierSourceAvailableForCommerce(after);
  const updatedOffers = await projectSupplierSourceAvailability(event.params.sourceId, available);
  logger.info("Supplier source availability projected to offers.", {
    sourceId: event.params.sourceId,
    available,
    updatedOffers,
  });
});
