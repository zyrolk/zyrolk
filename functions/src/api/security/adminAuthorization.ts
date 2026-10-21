export function hasAdminAccess(claims: Record<string, unknown>): boolean {
  return claims.admin === true || claims.role === "admin";
}

export function hasSupplierHubAdminAccess(claims: Record<string, unknown>): boolean {
  return hasAdminAccess(claims) || claims.supplierHubAdmin === true;
}

/**
 * Product review operators are intentionally narrower than Supplier Hub
 * administrators. The claim is minted by trusted Firebase Admin tooling;
 * route middleware decides which review operations it can reach.
 */
export function hasProductReviewOperatorAccess(claims: Record<string, unknown>): boolean {
  return claims.productReviewOperator === true;
}
