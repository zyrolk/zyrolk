import { Product } from '../../types';

export type AccountSection = 'overview' | 'profile' | 'addresses' | 'security' | 'settings';

export interface CustomerNotificationSettings {
  orderUpdates: boolean;
  wishlistUpdates: boolean;
  promotions: boolean;
  marketingEmail: boolean;
}

export interface CustomerAddress {
  id: string;
  label: string;
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  district: string;
  postalCode: string;
  isDefault: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type CustomerAddressDraft = Omit<CustomerAddress, 'id' | 'createdAt' | 'updatedAt'>;

export interface CustomerOrderSummary {
  id: string;
  orderNumber?: string;
  totalPrice: number;
  status: string;
  createdAt?: string;
  itemsCount: number;
}

export const DEFAULT_NOTIFICATION_SETTINGS: CustomerNotificationSettings = {
  orderUpdates: true,
  wishlistUpdates: true,
  promotions: false,
  marketingEmail: false,
};

export const EMPTY_ADDRESS_DRAFT: CustomerAddressDraft = {
  label: 'Home',
  fullName: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  district: 'Colombo',
  postalCode: '',
  isDefault: false,
};

export const ACCOUNT_PAGE_TO_SECTION: Record<string, AccountSection> = {
  account: 'overview',
  'account-profile': 'profile',
  'account-addresses': 'addresses',
  'account-security': 'security',
  'account-settings': 'settings',
};

export const ACCOUNT_SECTION_TO_PAGE: Record<AccountSection, string> = {
  overview: 'account',
  profile: 'account-profile',
  addresses: 'account-addresses',
  security: 'account-security',
  settings: 'account-settings',
};

const cleanText = (value: unknown, maxLength: number): string => (
  typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').slice(0, maxLength) : ''
);

export function normalizeNotificationSettings(value: unknown): CustomerNotificationSettings {
  const source = value && typeof value === 'object' ? value as Partial<CustomerNotificationSettings> : {};
  return {
    orderUpdates: source.orderUpdates !== false,
    wishlistUpdates: source.wishlistUpdates !== false,
    promotions: source.promotions === true,
    marketingEmail: source.marketingEmail === true,
  };
}

export function normalizeAddressDraft(value: Partial<CustomerAddressDraft>): CustomerAddressDraft {
  return {
    label: cleanText(value.label, 40) || 'Home',
    fullName: cleanText(value.fullName, 120),
    phone: cleanText(value.phone, 30),
    addressLine1: cleanText(value.addressLine1, 240),
    addressLine2: cleanText(value.addressLine2, 240),
    city: cleanText(value.city, 80),
    district: cleanText(value.district, 80),
    postalCode: cleanText(value.postalCode, 20),
    isDefault: value.isDefault === true,
  };
}

export function validateAddressDraft(value: CustomerAddressDraft): string[] {
  const errors: string[] = [];
  if (!value.fullName) errors.push('Full name is required.');
  const phoneDigits = value.phone.replace(/\D/gu, '');
  if (phoneDigits.length < 9 || phoneDigits.length > 15) errors.push('Enter a valid phone number.');
  if (!value.addressLine1) errors.push('Street address is required.');
  if (!value.city) errors.push('City is required.');
  if (!value.district) errors.push('District is required.');
  return errors;
}

export function sortCustomerAddresses(addresses: readonly CustomerAddress[]): CustomerAddress[] {
  return [...addresses].sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return left.label.localeCompare(right.label, undefined, { sensitivity: 'base', numeric: true });
  });
}

export function buildRecentlyViewedProducts(productIds: readonly string[], products: readonly Product[], limit = 8): Product[] {
  const productsById = new Map(products.map(product => [product.id, product]));
  return productIds
    .map(id => productsById.get(id))
    .filter((product): product is Product => Boolean(product && product.isActive !== false))
    .slice(0, Math.max(0, limit));
}

export function addRecentlyViewedProduct(productIds: readonly string[], productId: string, limit = 12): string[] {
  const normalizedId = cleanText(productId, 200);
  if (!normalizedId) return [...productIds];
  return [normalizedId, ...productIds.filter(id => id !== normalizedId)].slice(0, Math.max(1, limit));
}

export function formatAccountDate(value: string | undefined): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat('en-LK', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
