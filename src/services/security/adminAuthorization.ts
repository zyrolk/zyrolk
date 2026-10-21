export function hasAdminAccess(claims: Record<string, unknown>): boolean {
  return claims.admin === true || claims.role === 'admin';
}

/** A deliberately narrow claim used only for the Product Review operator portal. */
export function hasProductReviewOperatorAccess(claims: Record<string, unknown>): boolean {
  return claims.productReviewOperator === true;
}
