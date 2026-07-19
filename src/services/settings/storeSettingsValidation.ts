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

  if (settings.currency && settings.currency !== 'LKR') errors.push('Currency must remain LKR for the current checkout contract.');
  if (settings.storeStatus && !['open', 'closed'].includes(settings.storeStatus)) errors.push('Store status is invalid.');
  if (settings.maintenanceMode && !settings.maintenanceMessage?.trim()) errors.push('A maintenance message is required when maintenance mode is enabled.');

  const areaIds = new Set<string>();
  const districts = new Set<string>();
  (settings.deliveryAreas || []).forEach((area, index) => {
    const label = `Delivery area ${index + 1}`;
    const id = area.id.trim().toLocaleLowerCase();
    if (!id || areaIds.has(id)) errors.push(`${label} must have a unique identifier.`);
    areaIds.add(id);
    if (!area.name.trim()) errors.push(`${label} name is required.`);
    if (!Number.isFinite(Number(area.charge)) || Number(area.charge) < 0) errors.push(`${label} charge must be a non-negative number.`);
    if (!area.estimatedDelivery.trim()) errors.push(`${label} estimated delivery time is required.`);
    if (!area.districts.length) errors.push(`${label} must include at least one district.`);
    area.districts.forEach((district) => {
      const districtKey = district.trim().toLocaleLowerCase();
      if (!districtKey || districts.has(districtKey)) errors.push(`${label} contains a missing or duplicate district assignment.`);
      districts.add(districtKey);
    });
  });

  Object.values(settings.homepageSections || {}).forEach((section) => {
    if (section.enabled && !section.title.trim()) errors.push('Enabled homepage sections require a title.');
    if (section.title.length > 80) errors.push('Homepage section titles must be 80 characters or fewer.');
    if (section.subtitle.length > 220) errors.push('Homepage section subtitles must be 220 characters or fewer.');
  });

  return {
    errors,
    deliveryCharge: parsedDeliveryCharge,
    freeDeliveryMin: parsedFreeDeliveryMin,
  };
};
