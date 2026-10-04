import { Check, Truck } from 'lucide-react';
import type { DeliveryQuote } from '../services/settings/shippingSettings';
import { resolveDeliveryCharge, resolveFreeDeliveryMin, resolveReducedDeliveryTier } from '../services/settings/shippingSettings';
import type { WebsiteSettings } from '../types';

export interface DeliveryRewardsPresentation {
  headline: string;
  detail: string;
  progressPercent: number;
  firstMilestone: {
    amount: number;
    label: string;
    unlocked: boolean;
  };
  freeMilestone: {
    amount: number;
    label: string;
    unlocked: boolean;
  };
  firstSegmentPercent: number;
  secondSegmentPercent: number;
}

interface DeliveryRewardsProps {
  subtotal: number;
  deliveryQuote: DeliveryQuote;
  formatPrice: (amount: number) => string;
}

interface DeliveryRewardsNoteProps {
  settings?: WebsiteSettings | null;
  formatPrice: (amount: number) => string;
}

const safeSubtotal = (subtotal: number): number => Number.isFinite(subtotal) ? Math.max(0, subtotal) : 0;

export function getDeliveryRewardsPresentation(
  deliveryQuote: DeliveryQuote,
  subtotal: number,
  formatPrice: (amount: number) => string,
): DeliveryRewardsPresentation {
  const currentSubtotal = safeSubtotal(subtotal);
  const freeDeliveryMin = Math.max(0, deliveryQuote.freeDeliveryMin);
  const reducedTier = deliveryQuote.reducedTier;
  const reducedMin = reducedTier ? Math.max(0, reducedTier.min) : freeDeliveryMin;
  const reducedFee = deliveryQuote.reducedFee ?? reducedTier?.charge ?? deliveryQuote.standardCharge;
  const reducedSaving = Math.max(0, deliveryQuote.standardCharge - reducedFee);
  const reducedUnlocked = Boolean(reducedTier && currentSubtotal >= reducedMin);
  const freeUnlocked = deliveryQuote.tier === 'free' || (freeDeliveryMin > 0 && currentSubtotal >= freeDeliveryMin);
  const firstSegmentPercent = reducedTier
    ? Math.max(0, Math.min(100, reducedMin > 0 ? (currentSubtotal / reducedMin) * 100 : 100))
    : Math.max(0, Math.min(100, freeDeliveryMin > 0 ? (currentSubtotal / freeDeliveryMin) * 100 : 100));
  const secondSegmentPercent = reducedTier && reducedUnlocked
    ? Math.max(0, Math.min(100, freeDeliveryMin > reducedMin ? ((currentSubtotal - reducedMin) / (freeDeliveryMin - reducedMin)) * 100 : 100))
    : 0;
  const progressPercent = reducedTier
    ? freeUnlocked ? 100 : reducedUnlocked ? 50 + secondSegmentPercent / 2 : firstSegmentPercent / 2
    : freeUnlocked ? 100 : firstSegmentPercent;
  const remainingToReduced = Math.max(0, reducedMin - currentSubtotal);
  const remainingToFree = Math.max(0, freeDeliveryMin - currentSubtotal);

  let headline: string;
  let detail: string;
  if (freeUnlocked) {
    headline = 'Free delivery unlocked';
    detail = deliveryQuote.saving > 0
      ? `You saved ${formatPrice(deliveryQuote.saving)} on delivery`
      : 'Your order qualifies for islandwide delivery.';
  } else if (reducedUnlocked && reducedTier) {
    headline = reducedSaving > 0
      ? `${formatPrice(reducedSaving)} delivery saving unlocked`
      : 'Reduced delivery unlocked';
    detail = `Add ${formatPrice(remainingToFree)} more to unlock free delivery`;
  } else if (reducedTier) {
    headline = reducedSaving > 0
      ? `Add ${formatPrice(remainingToReduced)} more to save ${formatPrice(reducedSaving)} on delivery`
      : `Add ${formatPrice(remainingToReduced)} more to unlock reduced delivery`;
    detail = `Free delivery from ${formatPrice(freeDeliveryMin)}`;
  } else {
    headline = freeUnlocked
      ? 'Free delivery unlocked'
      : `Add ${formatPrice(remainingToFree)} more for free delivery`;
    detail = freeUnlocked
      ? 'Your order qualifies for islandwide delivery.'
      : `Free delivery from ${formatPrice(freeDeliveryMin)}`;
  }

  return {
    headline,
    detail,
    progressPercent,
    firstMilestone: {
      amount: reducedMin,
      label: reducedTier && reducedSaving > 0 ? `Save ${formatPrice(reducedSaving)}` : 'Reduced delivery',
      unlocked: reducedUnlocked || freeUnlocked,
    },
    freeMilestone: {
      amount: freeDeliveryMin,
      label: 'Free delivery',
      unlocked: freeUnlocked,
    },
    firstSegmentPercent,
    secondSegmentPercent,
  };
}

export function DeliveryRewardsNote({ settings, formatPrice }: DeliveryRewardsNoteProps) {
  const standardDeliveryCharge = resolveDeliveryCharge(settings, '');
  const reducedDeliveryTier = resolveReducedDeliveryTier(settings);
  const freeDeliveryMin = resolveFreeDeliveryMin(settings);
  const reducedSaving = reducedDeliveryTier
    ? Math.max(0, standardDeliveryCharge - Math.min(standardDeliveryCharge, reducedDeliveryTier.charge))
    : 0;
  const message = reducedDeliveryTier && reducedSaving > 0
    ? `Save ${formatPrice(reducedSaving)} on delivery from ${formatPrice(reducedDeliveryTier.min)} · Free delivery from ${formatPrice(freeDeliveryMin)}`
    : `Free delivery from ${formatPrice(freeDeliveryMin)}`;

  return <span className="text-[10px] text-brand-blue/80 block font-semibold">{message}</span>;
}

export default function DeliveryRewards({ subtotal, deliveryQuote, formatPrice }: DeliveryRewardsProps) {
  const presentation = getDeliveryRewardsPresentation(deliveryQuote, subtotal, formatPrice);
  const progressLabel = presentation.freeMilestone.unlocked
    ? 'Free delivery unlocked'
    : presentation.firstMilestone.unlocked
      ? 'Reduced delivery unlocked; free delivery is the next milestone'
      : 'Working toward reduced delivery and free delivery';

  return <section className="zy-delivery-rewards" aria-labelledby="delivery-rewards-title">
    <div className="zy-delivery-rewards-heading">
      <Truck aria-hidden="true" />
      <div>
        <strong id="delivery-rewards-title">Delivery rewards</strong>
        <p aria-live="polite">{presentation.headline}</p>
        <small>{presentation.detail}</small>
      </div>
    </div>
    <div className="zy-delivery-rewards-track" role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(presentation.progressPercent)}>
      <span><i style={{ width: `${presentation.firstSegmentPercent}%` }} /></span>
      <span><i style={{ width: `${presentation.secondSegmentPercent}%` }} /></span>
    </div>
    <ol className="zy-delivery-rewards-milestones">
      <li className={presentation.firstMilestone.unlocked ? 'is-unlocked' : ''}>
        <span className="zy-delivery-rewards-marker" aria-hidden="true">{presentation.firstMilestone.unlocked ? <Check /> : '1'}</span>
        <span><b>{formatPrice(presentation.firstMilestone.amount)}</b><small>{presentation.firstMilestone.label}</small></span>
        <em>{presentation.firstMilestone.unlocked ? 'Unlocked' : 'Next'}</em>
      </li>
      <li className={presentation.freeMilestone.unlocked ? 'is-unlocked' : ''}>
        <span className="zy-delivery-rewards-marker" aria-hidden="true">{presentation.freeMilestone.unlocked ? <Check /> : '2'}</span>
        <span><b>{formatPrice(presentation.freeMilestone.amount)}</b><small>{presentation.freeMilestone.label}</small></span>
        <em>{presentation.freeMilestone.unlocked ? 'Unlocked' : 'Next'}</em>
      </li>
    </ol>
  </section>;
}
