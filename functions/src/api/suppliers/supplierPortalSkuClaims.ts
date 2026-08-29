import { ApiError } from "../errors";

export type SupplierPortalProductRequestType = "new_product" | "product_change";

export interface SupplierSkuClaimRequestEvidence {
  id: string;
  data: Record<string, unknown>;
}

export interface SupplierSkuClaimResolution {
  requestId: string;
  canonicalProductId?: string;
}

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

const claimConflict = (): never => {
  throw new ApiError("Supplier SKU is already in use", 409);
};

export function resolveSupplierPortalSkuClaim(input: {
  claim?: Record<string, unknown> | null;
  requestId: string;
  requestType: SupplierPortalProductRequestType;
  supplierId: string;
  canonicalProductId?: string;
  owningRequest?: SupplierSkuClaimRequestEvidence | null;
}): SupplierSkuClaimResolution {
  const canonicalProductId = text(input.canonicalProductId);
  if (!input.claim) {
    return {
      requestId: input.requestId,
      ...(input.requestType === "product_change" && canonicalProductId ? { canonicalProductId } : {}),
    };
  }

  const claimSupplierId = text(input.claim.supplierId);
  const claimRequestId = text(input.claim.requestId);
  if (!claimSupplierId || claimSupplierId !== input.supplierId) claimConflict();

  if (input.requestType === "new_product") {
    if (!claimRequestId || claimRequestId !== input.requestId) claimConflict();
    return { requestId: input.requestId };
  }

  if (!canonicalProductId) claimConflict();
  const claimedCanonicalProductId = text(input.claim.canonicalProductId);
  if (claimedCanonicalProductId) {
    if (claimedCanonicalProductId !== canonicalProductId) claimConflict();
    return { requestId: claimRequestId || input.requestId, canonicalProductId };
  }

  const owningRequest = input.owningRequest;
  if (
    !claimRequestId
    || !owningRequest
    || owningRequest.id !== claimRequestId
    || text(owningRequest.data.supplierId) !== input.supplierId
    || text(owningRequest.data.status) !== "approved"
    || text(owningRequest.data.productId) !== canonicalProductId
  ) claimConflict();

  return { requestId: claimRequestId, canonicalProductId };
}

export function isNewSupplierPortalProductRequest(queueItem: Record<string, unknown>): boolean {
  const explicitType = text(queueItem.portalRequestType);
  if (explicitType) return explicitType === "new_product";
  return Boolean(text(queueItem.productFingerprintClaimId))
    || text(queueItem.comparisonStatus) === "NEW_PRODUCT"
    || text(queueItem.changeType) === "NEW_PRODUCT";
}

export function shouldReleaseSupplierPortalSkuClaim(
  queueItem: Record<string, unknown>,
  action: "approved" | "rejected" | "deleted",
): boolean {
  return action !== "approved" && isNewSupplierPortalProductRequest(queueItem);
}
