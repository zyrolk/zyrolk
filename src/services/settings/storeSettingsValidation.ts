import type { WebsiteSettings } from '../../types';

export interface StoreSettingsValidationInput {
  readonly settings: WebsiteSettings;
  readonly deliveryCharge: string;
  readonly freeDeliveryMin: string;
}

export interface StoreSettingsValidationResult {
  readonly errors: readonly string[];
  readonly deliveryCharge?: number;
  readonly freeDeliveryMin?: number;
}

export const isHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());

const isPhone = (value: string): boolean => {
  const trimmed = value.trim();
  if (!/^[+\d][\d\s()-]+$/u.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/gu, '');
  return digits.length >= 9 && digits.length <= 15;
};

const parseNonNegativeAmount = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const amount = Number(trimmed);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
};

export const validateStoreSettings = ({
  settings,
  deliveryCharge,
  freeDeliveryMin,
}: StoreSettingsValidationInput): StoreSettingsValidationResult => {
  const errors: string[] = [];
  const storeName = settings.storeName.trim();
  if (!storeName) errors.push('Store name is required.');
  if (storeName.length > 80) errors.push('Store name must be 80 characters or fewer.');

  const optionalUrls: Array<[string, string | undefined]> = [
    ['Logo', settings.logoUrl],
    ['Favicon', settings.faviconUrl],
    ['Facebook', settings.facebookUrl],
    ['Instagram', settings.instagramUrl],
    ['TikTok', settings.tiktokUrl],
    ['YouTube', settings.youtubeUrl],
  ];
  optionalUrls.forEach(([label, value]) => {
    if (value?.trim() && !isHttpUrl(value)) errors.push(`${label} must use a valid http or https URL.`);
  });

  if (settings.contactEmail?.trim() && !isEmail(settings.contactEmail)) {
    errors.push('Contact email is invalid.');
  }
  if (settings.contactPhone?.trim() && !isPhone(settings.contactPhone)) {
    errors.push('Primary phone number is invalid.');
  }
  if (settings.contactPhone2?.trim() && !isPhone(settings.contactPhone2)) {
    errors.push('Backup phone number is invalid.');
  }
  if (settings.whatsappNumber.trim() && !isPhone(settings.whatsappNumber)) {
    errors.push('WhatsApp number is invalid.');
  }

  const parsedDeliveryCharge = parseNonNegativeAmount(deliveryCharge);
  const parsedFreeDeliveryMin = parseNonNegativeAmount(freeDeliveryMin);
  if (parsedDeliveryCharge === undefined) errors.push('Delivery charge must be a non-negative number.');
  if (parsedFreeDeliveryMin === undefined) errors.push('Free delivery threshold must be a non-negative number.');

  return {
    errors,
    deliveryCharge: parsedDeliveryCharge,
    freeDeliveryMin: parsedFreeDeliveryMin,
  };
};
