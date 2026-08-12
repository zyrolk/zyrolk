import { createHash } from "node:crypto";
import { FieldValue, Firestore, Transaction } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { PRODUCT_PRIVATE_COLLECTION } from "../products/productCommercialData";

export const ZYRO_SKU_CLAIMS_COLLECTION = "zyro_sku_claims";
const MAX_SKU_CANDIDATES = 8;

const text = (value: unknown, maximum: number): string => typeof value === "string"
  ? value.normalize("NFKC").trim().slice(0, maximum)
  : "";

const canonicalIdentityPart = (value: unknown, maximum: number): string => text(value, maximum).toLocaleLowerCase("en");

export interface ZyroProductIdentityInput {
  offerId?: unknown;
  sourceId?: unknown;
  supplierId?: unknown;
  supplierProductId?: unknown;
  portalRequestId?: unknown;
  manualRequestId?: unknown;
}

/**
 * Creates an opaque Zyro-owned identifier from a stable server-validated
 * supplier identity. Supplier titles, slugs, SKUs and barcodes never become the
 * product document ID directly.
 */
export function buildZyroProductId(input: ZyroProductIdentityInput): string {
  const offerId = canonicalIdentityPart(input.offerId, 180);
  const sourceId = canonicalIdentityPart(input.sourceId, 160);
  const supplierId = canonicalIdentityPart(input.supplierId, 160);
  const supplierProductId = canonicalIdentityPart(input.supplierProductId, 300);
  const portalRequestId = canonicalIdentityPart(input.portalRequestId, 160);
  const manualRequestId = canonicalIdentityPart(input.manualRequestId, 300);
  const stableIdentity = offerId
    || (manualRequestId ? `manual|${manualRequestId}` : [sourceId, supplierId, supplierProductId, portalRequestId].join("|"));
  if (!offerId && !manualRequestId && (!sourceId || !supplierId || (!supplierProductId && !portalRequestId))) {
    throw new ApiError("A stable supplier identity is required to create a Zyro product.", 409);
  }
  const digest = createHash("sha256").update(`zyro-product-v1|${stableIdentity}`).digest("hex").slice(0, 32);
  return `zyro-${digest}`;
}

export function buildZyroSkuCandidates(productIdValue: unknown): string[] {
  const productId = canonicalIdentityPart(productIdValue, 180);
  if (!productId) throw new ApiError("A Zyro product ID is required to allocate a SKU.", 409);
  return Array.from({ length: MAX_SKU_CANDIDATES }, (_, attempt) => {
    const seed = attempt === 0 ? productId : `${productId}|collision-${attempt}`;
    const digest = createHash("sha256").update(seed).digest("hex").slice(0, 12).toUpperCase();
    return `ZY-${digest}`;
  });
}

export function normalizeZyroSku(value: unknown): string {
  const sku = text(value, 40).toUpperCase();
  if (!/^ZY-[A-Z0-9-]{4,32}$/u.test(sku)) throw new ApiError("The generated Zyro SKU is invalid.", 409);
  return sku;
}

export function buildZyroSkuClaimId(skuValue: unknown): string {
  const sku = normalizeZyroSku(skuValue);
  return createHash("sha256").update(`zyro-sku-v1|${sku}`).digest("hex");
}

export interface ZyroSkuReservation {
  sku: string;
  claimId: string;
  reused: boolean;
}

/**
 * Rechecks a strong catalogue duplicate signal inside the same transaction
 * that creates or publishes a product. Sync-time detection alone is not a
 * sufficient fence because another trusted creation path can commit after a
 * Product Review was queued.
 */
export async function assertZyroBarcodeAvailable(
  db: Firestore,
  transaction: Transaction,
  productIdValue: unknown,
  barcodeValue: unknown,
): Promise<void> {
  const productId = text(productIdValue, 180);
  const barcode = text(barcodeValue, 32);
  if (!barcode) return;
  if (!productId) throw new ApiError("A Zyro product ID is required to validate its barcode.", 409);

  const matches = await transaction.get(
    db.collection("products").where("barcode", "==", barcode).limit(2),
  );
  if (matches.docs.some((document) => document.id !== productId)) {
    throw new ApiError(
      "Another Zyro product already uses this barcode. Resolve the duplicate before publishing.",
      409,
    );
  }
}

/**
 * Reserves one bounded deterministic candidate in the same transaction that
 * publishes the product. The exact product/private lookups preserve legacy SKU
 * compatibility; the claim document provides contention-safe uniqueness for
 * Supplier approvals and trusted manual product creation share the same claim
 * namespace after SH-4A.
 */
export async function reserveZyroSku(
  db: Firestore,
  transaction: Transaction,
  productIdValue: unknown,
  candidateValues?: readonly string[],
): Promise<ZyroSkuReservation> {
  const productId = text(productIdValue, 180);
  if (!productId) throw new ApiError("A Zyro product ID is required to reserve a SKU.", 409);
  const candidates = [...new Set((candidateValues || buildZyroSkuCandidates(productId)).map(normalizeZyroSku))];
  if (candidates.length === 0 || candidates.length > MAX_SKU_CANDIDATES) {
    throw new ApiError("Zyro SKU candidate allocation is invalid.", 409);
  }

  const claimReferences = candidates.map((sku) => db.collection(ZYRO_SKU_CLAIMS_COLLECTION).doc(buildZyroSkuClaimId(sku)));
  // Keep transaction reads ordered. Parallel streaming query reads can leave a
  // contending transaction invalid after Firestore retries a claim collision.
  // The set is bounded to MAX_SKU_CANDIDATES, so serialization remains bounded.
  const claimSnapshots: FirebaseFirestore.DocumentSnapshot[] = [];
  for (const reference of claimReferences) {
    claimSnapshots.push(await transaction.get(reference));
  }
  const privateSkuSnapshot = await transaction.get(
    db.collection(PRODUCT_PRIVATE_COLLECTION).where("sku", "in", candidates).limit(candidates.length + 1),
  );
  const legacyPublicSkuSnapshot = await transaction.get(
    db.collection("products").where("sku", "in", candidates).limit(candidates.length + 1),
  );

  const ownersBySku = new Map<string, Set<string>>();
  [...privateSkuSnapshot.docs, ...legacyPublicSkuSnapshot.docs].forEach((document) => {
    const sku = normalizeZyroSku(document.data().sku);
    ownersBySku.set(sku, new Set([...(ownersBySku.get(sku) || []), document.id]));
  });

  for (let index = 0; index < candidates.length; index += 1) {
    const sku = candidates[index];
    const claim = claimSnapshots[index];
    const claimOwner = claim.exists ? text(claim.data()?.productId, 180) : "";
    const catalogOwners = ownersBySku.get(sku) || new Set<string>();
    const hasForeignCatalogOwner = [...catalogOwners].some((owner) => owner !== productId);
    if (hasForeignCatalogOwner || (claimOwner && claimOwner !== productId)) continue;

    if (!claim.exists) {
      transaction.create(claimReferences[index], {
        productId,
        sku,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return { sku, claimId: claimReferences[index].id, reused: claim.exists || catalogOwners.has(productId) };
  }

  throw new ApiError("A unique Zyro SKU could not be reserved safely.", 409);
}
