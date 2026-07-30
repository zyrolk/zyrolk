export function hasAdminAccess(claims: Record<string, unknown>): boolean {
  return claims.admin === true || claims.role === 'admin';
}
