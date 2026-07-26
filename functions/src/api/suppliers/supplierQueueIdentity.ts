import { Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import {
  buildSupplierOfferId,
  projectSupplierOfferForAdmin,
  SupplierProductOffer,
  SUPPLIER_PRODUCT_OFFERS_COLLECTION,
} from "./supplierOfferEngine";

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

const text = (value: unknown, maximum = 300): string => typeof value === "string"
  ? value.normalize("NFKC").trim().slice(0, maximum)
  : "";

export interface SupplierQueueIdentityCandidate {
  sourceId: string;
  supplierProductId: string;
  claimedOfferId: string;
  deterministicOfferId: string;
  claimedProductId: string;
}

export interface ResolvedSupplierQueueIdentity extends SupplierQueueIdentityCandidate {
  canonicalProductId: string;
  supplierOfferId: string;
  offer: SupplierProductOffer | null;
  offerReference: FirebaseFirestore.DocumentReference | null;
}

/**
 * Reads every legacy/current queue identity location without trusting any one
 * duplicated copy. The deterministic offer ID is derived from the same Sprint
 * 3 function used by synchronization.
 */
export function getSupplierQueueIdentityCandidate(value: unknown): SupplierQueueIdentityCandidate {
  const queueItem = asRecord(value);
  const payload = asRecord(queueItem.productPayload);
  const snapshot = asRecord(queueItem.supplierSnapshot);
  const sourceId = text(queueItem.sourceId || snapshot.sourceId, 160);
  const supplierProductId = text(
    snapshot.supplierProductId
      || snapshot.supplierSku
      || queueItem.supplierProductId
      || queueItem.supplierCode,
    300,
  );
  let deterministicOfferId = "";
  if (sourceId && supplierProductId) {
    try {
      deterministicOfferId = buildSupplierOfferId(sourceId, supplierProductId, queueItem.supplierCode);
    } catch {
      deterministicOfferId = "";
    }
  }
  return {
    sourceId,
    supplierProductId,
    claimedOfferId: text(queueItem.supplierOfferId, 180),
    deterministicOfferId,
    claimedProductId: text(
      queueItem.canonicalProductId
        || queueItem.productId
        || payload.id
        || queueItem.matchedProductId,
      180,
    ),
  };
}

const offerMatchesItsDeterministicIdentity = (offer: SupplierProductOffer): boolean => {
  try {
    return offer.id === buildSupplierOfferId(offer.sourceId, offer.supplierProductId, offer.sku);
  } catch {
    return false;
  }
};

/**
 * Resolves the queue item through the actual deterministic offer document. An
 * obsolete queue copy may be repaired, but an arbitrary/non-deterministic offer
 * can never be substituted.
 */
export async function resolveSupplierQueueIdentity(
  db: Firestore,
  transaction: FirebaseFirestore.Transaction,
  value: unknown,
): Promise<ResolvedSupplierQueueIdentity> {
  const candidate = getSupplierQueueIdentityCandidate(value);
  const offerIds = [...new Set([candidate.deterministicOfferId, candidate.claimedOfferId].filter(Boolean))];
  const references = offerIds.map((offerId) => db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(offerId));
  const snapshots = await Promise.all(references.map((reference) => transaction.get(reference)));
  const offers = snapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => ({
      documentId: snapshot.id,
      offer: projectSupplierOfferForAdmin({ id: snapshot.id, ...snapshot.data() }),
    }))
    .filter((entry): entry is { documentId: string; offer: SupplierProductOffer } => Boolean(
      entry.offer
      && entry.documentId === entry.offer.id
      && offerMatchesItsDeterministicIdentity(entry.offer),
    ))
    .map((entry) => entry.offer);
  const deterministicOffer = offers.find((offer) => offer.id === candidate.deterministicOfferId) || null;
  const claimedOffer = offers.find((offer) => offer.id === candidate.claimedOfferId) || null;
  const offer = candidate.deterministicOfferId ? deterministicOffer : claimedOffer;
  if (offer && candidate.sourceId && offer.sourceId !== candidate.sourceId) {
    throw new ApiError("Supplier queue source does not match its deterministic offer.", 409);
  }
  if (candidate.claimedOfferId && !offer) {
    throw new ApiError("The deterministic supplier offer for this review item could not be found.", 409);
  }
  const canonicalProductId = text(offer?.productId, 180) || candidate.claimedProductId;
  if (!canonicalProductId) {
    throw new ApiError("The canonical product for this supplier review item could not be resolved.", 409);
  }
  const supplierOfferId = offer?.id || "";
  return {
    ...candidate,
    canonicalProductId,
    supplierOfferId,
    offer,
    offerReference: supplierOfferId
      ? db.collection(SUPPLIER_PRODUCT_OFFERS_COLLECTION).doc(supplierOfferId)
      : null,
  };
}

/** Creates the canonical identity projection persisted on every queue copy. */
export function buildSupplierQueueIdentityProjection(
  value: unknown,
  identity: Pick<ResolvedSupplierQueueIdentity, "canonicalProductId" | "supplierOfferId">,
): Record<string, unknown> {
  const queueItem = asRecord(value);
  const productPayload = asRecord(queueItem.productPayload);
  const supplierSnapshot = asRecord(queueItem.supplierSnapshot);
  return {
    canonicalProductId: identity.canonicalProductId,
    productId: identity.canonicalProductId,
    ...(identity.supplierOfferId ? { supplierOfferId: identity.supplierOfferId } : {}),
    productPayload: {
      ...productPayload,
      id: identity.canonicalProductId,
    },
    supplierSnapshot: {
      ...supplierSnapshot,
      canonicalProductId: identity.canonicalProductId,
      ...(identity.supplierOfferId ? { supplierOfferId: identity.supplierOfferId } : {}),
    },
  };
}
