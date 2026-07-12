export const PRODUCTION_ADMIN_EMAIL = 'zyrolkofficial@gmail.com';

export const isProductionAdminEmail = (email: string | null | undefined): boolean =>
  (email || '').trim().toLowerCase() === PRODUCTION_ADMIN_EMAIL;
