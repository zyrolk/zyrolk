import { CartItem } from '../../types';
import { CustomerAddress } from '../account/accountData';

export interface CheckoutFormValues {
  customerName: string;
  customerPhone: string;
  customerPhone2: string;
  customerEmail: string;
  customerAddress: string;
  city: string;
  district: string;
}

export type CheckoutField = keyof CheckoutFormValues;
export type CheckoutErrors = Partial<Record<CheckoutField, string>>;

export const EMPTY_CHECKOUT_FORM: CheckoutFormValues = {
  customerName: '', customerPhone: '', customerPhone2: '', customerEmail: '',
  customerAddress: '', city: '', district: 'Colombo',
};

const clean = (value: unknown, maxLength: number): string => typeof value === 'string'
  ? value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '').slice(0, maxLength)
  : '';

export function normalizeCheckoutForm(value: Partial<CheckoutFormValues>): CheckoutFormValues {
  return {
    customerName: clean(value.customerName, 120),
    customerPhone: clean(value.customerPhone, 30),
    customerPhone2: clean(value.customerPhone2, 30),
    customerEmail: clean(value.customerEmail, 160),
    customerAddress: clean(value.customerAddress, 500),
    city: clean(value.city, 80),
    district: clean(value.district, 80) || 'Colombo',
  };
}

export function validateCheckoutForm(value: CheckoutFormValues, options: { requireEmail?: boolean } = {}): CheckoutErrors {
  const normalized = normalizeCheckoutForm(value);
  const errors: CheckoutErrors = {};
  if (!normalized.customerName) errors.customerName = 'Enter the recipient name.';
  const primaryDigits = normalized.customerPhone.replace(/\D/gu, '');
  if (primaryDigits.length < 9 || primaryDigits.length > 15) errors.customerPhone = 'Enter a valid phone number with 9 to 15 digits.';
  if (normalized.customerPhone2) {
    const secondaryDigits = normalized.customerPhone2.replace(/\D/gu, '');
    if (secondaryDigits.length < 9 || secondaryDigits.length > 15) errors.customerPhone2 = 'Enter a valid secondary phone number.';
  }
  if (options.requireEmail && !normalized.customerEmail) errors.customerEmail = 'Email is required for secure online payment.';
  else if (normalized.customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized.customerEmail)) errors.customerEmail = 'Enter a valid email address.';
  if (!normalized.customerAddress) errors.customerAddress = 'Enter the street address.';
  if (!normalized.city) errors.city = 'Enter the delivery city.';
  if (!normalized.district) errors.district = 'Choose a delivery district.';
  return errors;
}

export function checkoutFormFromAddress(address: CustomerAddress, email = ''): CheckoutFormValues {
  const street = [address.addressLine1, address.addressLine2, address.postalCode].map(part => clean(part, 240)).filter(Boolean).join(', ');
  return normalizeCheckoutForm({
    customerName: address.fullName,
    customerPhone: address.phone,
    customerEmail: email,
    customerAddress: street,
    city: address.city,
    district: address.district,
  });
}

export function getCheckoutCartSignature(items: readonly CartItem[]): string {
  return JSON.stringify(items.map(item => [item.product.id, item.quantity]));
}

export function readCheckoutDraft(storage: Storage | null): CheckoutFormValues {
  if (!storage) return EMPTY_CHECKOUT_FORM;
  try {
    const value = JSON.parse(storage.getItem('zyro.checkout.draft') || '{}') as Partial<CheckoutFormValues>;
    return normalizeCheckoutForm(value);
  } catch {
    return EMPTY_CHECKOUT_FORM;
  }
}

export function writeCheckoutDraft(storage: Storage | null, value: CheckoutFormValues): void {
  if (!storage) return;
  try { storage.setItem('zyro.checkout.draft', JSON.stringify(normalizeCheckoutForm(value))); } catch { /* Session storage may be unavailable. */ }
}

export function clearCheckoutDraft(storage: Storage | null): void {
  if (!storage) return;
  try { storage.removeItem('zyro.checkout.draft'); } catch { /* Session storage may be unavailable. */ }
}
