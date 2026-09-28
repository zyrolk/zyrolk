import type { DeliveryAreaSettings, WebsiteSettings } from '../../types';
import { DEFAULT_DELIVERY_CHARGE, DEFAULT_FREE_DELIVERY_MIN } from './websiteSettings';

type DeliverySettings = Pick<WebsiteSettings, 'deliveryAreas' | 'deliveryCharge' | 'freeDeliveryMin' | 'reducedDeliveryMin' | 'reducedDeliveryCharge'>;

const key = (value: string): string => value.trim().toLocaleLowerCase();

/**
 * Mirrors the server's parseDeliveryAmount: only finite, non-negative numbers
 * (or numeric strings) are accepted; anything else is treated as absent.
 */
export function parseDeliveryAmount(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function resolveDeliveryArea(
  settings: Pick<WebsiteSettings, 'deliveryAreas'> | null | undefined,
  district: string,
): DeliveryAreaSettings | null {
  const districtKey = key(district);
  if (!districtKey || !Array.isArray(settings?.deliveryAreas)) return null;
  return settings.deliveryAreas.find((area) => (
    Boolean(area)
    && typeof area === 'object'
    && area.isActive !== false
    && Array.isArray(area.districts)
    && area.districts.some((candidate) => typeof candidate === 'string' && key(candidate) === districtKey)
  )) || null;
}

export function resolveDeliveryCharge(
  settings: Pick<WebsiteSettings, 'deliveryAreas' | 'deliveryCharge'> | null | undefined,
  district: string,
  fallback: number = DEFAULT_DELIVERY_CHARGE,
): number {
  return parseDeliveryAmount(resolveDeliveryArea(settings, district)?.charge)
    ?? parseDeliveryAmount(settings?.deliveryCharge)
    ?? fallback;
}

export function resolveFreeDeliveryMin(settings: Pick<WebsiteSettings, 'freeDeliveryMin'> | null | undefined): number {
  return parseDeliveryAmount(settings?.freeDeliveryMin) ?? DEFAULT_FREE_DELIVERY_MIN;
}

/** The reduced middle tier is enabled only by explicit, consistent settings. */
export function resolveReducedDeliveryTier(
  settings: Pick<WebsiteSettings, 'freeDeliveryMin' | 'reducedDeliveryMin' | 'reducedDeliveryCharge'> | null | undefined,
): { min: number; charge: number } | null {
  const min = parseDeliveryAmount(settings?.reducedDeliveryMin);
  const charge = parseDeliveryAmount(settings?.reducedDeliveryCharge);
  if (min === null || charge === null || min <= 0 || min >= resolveFreeDeliveryMin(settings)) return null;
  return { min, charge };
}

export type DeliveryTier = 'none' | 'standard' | 'reduced' | 'free';

export interface DeliveryQuote {
  tier: DeliveryTier;
  deliveryFee: number;
  standardCharge: number;
  freeDeliveryMin: number;
  reducedTier: { min: number; charge: number } | null;
  /** Fee charged in the reduced band for this district, when the tier is on. */
  reducedFee: number | null;
  /** Delivery saving versus the applicable standard charge. */
  saving: number;
}

/** Storefront mirror of the server's calculateCheckoutTotals delivery rule. */
export function resolveDeliveryQuote(
  settings: DeliverySettings | null | undefined,
  district: string,
  itemsSubtotal: number,
): DeliveryQuote {
  const standardCharge = resolveDeliveryCharge(settings, district);
  const freeDeliveryMin = resolveFreeDeliveryMin(settings);
  const reducedTier = resolveReducedDeliveryTier(settings);
  const reducedFee = reducedTier ? Math.min(reducedTier.charge, standardCharge) : null;
  let tier: DeliveryTier;
  let deliveryFee: number;
  if (!(itemsSubtotal > 0)) {
    tier = 'none';
    deliveryFee = 0;
  } else if (itemsSubtotal >= freeDeliveryMin) {
    tier = 'free';
    deliveryFee = 0;
  } else if (reducedTier && reducedFee !== null && itemsSubtotal >= reducedTier.min) {
    tier = 'reduced';
    deliveryFee = reducedFee;
  } else {
    tier = 'standard';
    deliveryFee = standardCharge;
  }
  return {
    tier,
    deliveryFee,
    standardCharge,
    freeDeliveryMin,
    reducedTier,
    reducedFee,
    saving: tier === 'none' ? 0 : Math.max(0, standardCharge - deliveryFee),
  };
}

export interface DeliveryProgressMessage {
  headline: string;
  detail: string;
  progressPercent: number;
  /** Whether checkout should show the standard charge and delivery saving. */
  showSaving: boolean;
}

/**
 * Customer-facing delivery progress copy. Savings are only claimed against the
 * applicable standard charge; with the reduced tier off, the original
 * standard/free wording is kept.
 */
export function describeDeliveryProgress(
  quote: DeliveryQuote,
  itemsSubtotal: number,
  formatPrice: (amount: number) => string,
): DeliveryProgressMessage {
  const progressPercent = quote.tier === 'free' || quote.freeDeliveryMin <= 0
    ? 100
    : Math.max(0, Math.min(100, (itemsSubtotal / quote.freeDeliveryMin) * 100));
  const remainingToFree = Math.max(0, quote.freeDeliveryMin - itemsSubtotal);
  const legacyProgress = {
    headline: `${formatPrice(remainingToFree)} away from free delivery`,
    detail: 'Keep shopping or continue with the current delivery fee.',
    progressPercent,
    showSaving: false,
  };
  if (!quote.reducedTier) {
    return quote.tier === 'free'
      ? { headline: 'Free delivery unlocked', detail: 'Your order qualifies for islandwide delivery.', progressPercent, showSaving: false }
      : legacyProgress;
  }
  if (quote.tier === 'free') {
    return {
      headline: 'FREE delivery unlocked',
      detail: quote.saving > 0 ? `You save ${formatPrice(quote.saving)} on delivery` : 'Your order qualifies for islandwide delivery.',
      progressPercent,
      showSaving: quote.saving > 0,
    };
  }
  if (quote.tier === 'reduced' && quote.saving > 0) {
    return {
      headline: `${formatPrice(quote.deliveryFee)} delivery unlocked • Add ${formatPrice(remainingToFree)} more for FREE delivery`,
      detail: `You save ${formatPrice(quote.saving)} on delivery`,
      progressPercent,
      showSaving: true,
    };
  }
  const potentialSaving = quote.reducedFee === null ? 0 : quote.standardCharge - quote.reducedFee;
  if (quote.tier === 'standard' && potentialSaving > 0) {
    return {
      headline: `Add ${formatPrice(quote.reducedTier.min - itemsSubtotal)} more to save ${formatPrice(potentialSaving)} on delivery`,
      detail: `FREE delivery on orders of ${formatPrice(quote.freeDeliveryMin)} or more.`,
      progressPercent,
      showSaving: false,
    };
  }
  return legacyProgress;
}

export function resolveDeliveryEstimate(
  settings: Pick<WebsiteSettings, 'deliveryAreas'> | null | undefined,
  district: string,
): string {
  return resolveDeliveryArea(settings, district)?.estimatedDelivery || '';
}
