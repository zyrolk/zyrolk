import { createHash } from "node:crypto";
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

const normalizedIdentityPart = (value: unknown, maximum: number): string => text(value, maximum).toLocaleLowerCase();

const queueSlug = (value: unknown): string => text(value, 500)
  .toLocaleLowerCase()
  .replace(/[^\w\s-]/gu, "")
  .replace(/[\s_]+/gu, "-")
  .replace(/-+/gu, "-")
  .replace(/^-+|-+$/gu, "");

export interface SupplierReviewQueueIdentityInput {
  sourceId: unknown;
  supplierProductId?: unknown;
  supplierCode: unknown;
  productName?: unknown;
}

/** Stable raw supplier identity used by both offer and Product Review routing. */
export function canonicalSupplierReviewIdentity(input: SupplierReviewQueueIdentityInput): string {
  const sourceId = normalizedIdentityPart(input.sourceId, 160);
  const supplierProductId = normalizedIdentityPart(input.supplierProductId, 300)
    || normalizedIdentityPart(input.supplierCode, 300);
  if (!sourceId || !supplierProductId) throw new Error("A Product Review identity requires a source and supplier product identity.");
  return `${sourceId}|${supplierProductId}`;
}

/** Existing deterministic ID contract retained for every compatible legacy record. */
export function buildLegacySupplierReviewQueueId(input: SupplierReviewQueueIdentityInput): string {
  const sourcePart = queueSlug(input.sourceId) || "supplier";
  const productPart = queueSlug(input.supplierCode) || queueSlug(input.productName) || "product";
  return `${sourcePart}-${productPart}`;
}

/** Deterministic alternative used only when a legacy/base ID belongs to another identity. */
export function buildCollisionSafeSupplierReviewQueueId(input: SupplierReviewQueueIdentityInput): string {
  const baseId = buildLegacySupplierReviewQueueId(input);
  const suffix = `-${createHash("sha256").update(canonicalSupplierReviewIdentity(input)).digest("hex").slice(0, 20)}`;
  return `${baseId.slice(0, Math.max(1, 180 - suffix.length))}${suffix}`;
}

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

export function supplierReviewQueueRecordMatchesIdentity(
  value: unknown,
  input: SupplierReviewQueueIdentityInput,
): boolean {
  const candidate = getSupplierQueueIdentityCandidate(value);
  if (!candidate.sourceId || !candidate.supplierProductId) return false;
  return canonicalSupplierReviewIdentity({
    sourceId: candidate.sourceId,
    supplierProductId: candidate.supplierProductId,
    supplierCode: candidate.supplierProductId,
  }) === canonicalSupplierReviewIdentity(input);
}

/**
 * Plans one queue ID per canonical supplier product for a bounded catalog page.
 * An existing compatible legacy record wins. For a new in-page collision, the
 * lexicographically first raw identity retains the legacy ID so page order or a
 * retry cannot change which identity receives the deterministic fallback.
 */
export function planSupplierReviewQueueIds(
  inputs: readonly SupplierReviewQueueIdentityInput[],
  existingRecords: ReadonlyMap<string, unknown>,
): Map<string, string> {
  const uniqueInputs = new Map<string, SupplierReviewQueueIdentityInput>();
  inputs.forEach((input) => {
    const identity = canonicalSupplierReviewIdentity(input);
    const current = uniqueInputs.get(identity);
    if (!current || buildLegacySupplierReviewQueueId(input).localeCompare(buildLegacySupplierReviewQueueId(current)) < 0) {
      uniqueInputs.set(identity, input);
    }
  });
  const identitiesByLegacyId = new Map<string, string[]>();
  uniqueInputs.forEach((input, identity) => {
    const legacyId = buildLegacySupplierReviewQueueId(input);
    identitiesByLegacyId.set(legacyId, [...(identitiesByLegacyId.get(legacyId) || []), identity]);
  });

  const result = new Map<string, string>();
  identitiesByLegacyId.forEach((identityValues, legacyId) => {
    const identities = [...identityValues].sort((left, right) => left.localeCompare(right));
    const existingLegacy = existingRecords.get(legacyId);
    const legacyOwner = existingLegacy === undefined
      ? identities[0]
      : identities.find((identity) => supplierReviewQueueRecordMatchesIdentity(existingLegacy, uniqueInputs.get(identity)!));

    identities.forEach((identity) => {
      const input = uniqueInputs.get(identity)!;
      const queueId = identity === legacyOwner ? legacyId : buildCollisionSafeSupplierReviewQueueId(input);
      const existing = existingRecords.get(queueId);
      if (existing !== undefined && !supplierReviewQueueRecordMatchesIdentity(existing, input)) {
        throw new Error("A deterministic Product Review ID is already owned by a different supplier product identity.");
      }
      result.set(identity, queueId);
    });
  });
  return result;
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
