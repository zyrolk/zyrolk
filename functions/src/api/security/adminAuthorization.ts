export function hasAdminAccess(claims: Record<string, unknown>): boolean {
  return claims.admin === true || claims.role === "admin";
}

export function hasSupplierHubAdminAccess(claims: Record<string, unknown>): boolean {
  return hasAdminAccess(claims) || claims.supplierHubAdmin === true;
}
