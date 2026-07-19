import type { DeliveryAreaSettings, WebsiteSettings } from '../../types';

const key = (value: string): string => value.trim().toLocaleLowerCase();

export function resolveDeliveryArea(
  settings: Pick<WebsiteSettings, 'deliveryAreas'> | null | undefined,
  district: string,
): DeliveryAreaSettings | null {
  const districtKey = key(district);
  if (!districtKey) return null;
  return (settings?.deliveryAreas || []).find((area) => (
    area.isActive !== false && area.districts.some((candidate) => key(candidate) === districtKey)
  )) || null;
}

export function resolveDeliveryCharge(
  settings: Pick<WebsiteSettings, 'deliveryAreas' | 'deliveryCharge'> | null | undefined,
  district: string,
  fallback: number,
): number {
  const configured = resolveDeliveryArea(settings, district)?.charge ?? settings?.deliveryCharge;
  const charge = Number(configured);
  return Number.isFinite(charge) && charge >= 0 ? charge : fallback;
}

export function resolveDeliveryEstimate(
  settings: Pick<WebsiteSettings, 'deliveryAreas'> | null | undefined,
  district: string,
): string {
  return resolveDeliveryArea(settings, district)?.estimatedDelivery || '';
}
