import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getDeliveryRewardsPresentation } from '../src/components/DeliveryRewards';
import { resolveDeliveryQuote } from '../src/services/settings/shippingSettings';

const SETTINGS = {
  deliveryCharge: 300,
  reducedDeliveryMin: 3000,
  reducedDeliveryCharge: 150,
  freeDeliveryMin: 5000,
};

const formatPrice = (amount: number) => new Intl.NumberFormat('en-LK', {
  style: 'currency',
  currency: 'LKR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
}).format(amount);

const presentation = (subtotal: number) => {
  const quote = resolveDeliveryQuote(SETTINGS, 'Colombo', subtotal);
  return { quote, rewards: getDeliveryRewardsPresentation(quote, subtotal, formatPrice) };
};

test('delivery rewards covers zero and below-threshold cart states', () => {
  const zero = presentation(0);
  assert.equal(zero.quote.deliveryFee, 0);
  assert.equal(zero.rewards.firstMilestone.unlocked, false);
  assert.equal(zero.rewards.freeMilestone.unlocked, false);

  const below = presentation(2999);
  assert.equal(below.quote.deliveryFee, 300);
  assert.equal(below.rewards.headline, `Add ${formatPrice(1)} more to save ${formatPrice(150)} on delivery`);
  assert.equal(below.rewards.detail, `Free delivery from ${formatPrice(5000)}`);
  assert.equal(below.rewards.firstMilestone.amount, 3000);
  assert.equal(below.rewards.firstMilestone.label, `Save ${formatPrice(150)}`);
  assert.equal(below.rewards.firstMilestone.unlocked, false);
  assert.equal(below.rewards.freeMilestone.unlocked, false);
});

test('delivery rewards unlocks the reduced milestone at exactly the configured boundary', () => {
  for (const subtotal of [3000, 3200, 4999]) {
    const { quote, rewards } = presentation(subtotal);
    assert.equal(quote.deliveryFee, 150);
    assert.equal(rewards.headline, `${formatPrice(150)} delivery saving unlocked`);
    assert.equal(rewards.detail, `Add ${formatPrice(5000 - subtotal)} more to unlock free delivery`);
    assert.equal(rewards.firstMilestone.unlocked, true);
    assert.equal(rewards.freeMilestone.unlocked, false);
  }
});

test('delivery rewards unlocks and caps both milestones at the free-delivery boundary', () => {
  for (const subtotal of [5000, 5200]) {
    const { quote, rewards } = presentation(subtotal);
    assert.equal(quote.deliveryFee, 0);
    assert.equal(rewards.headline, 'Free delivery unlocked');
    assert.equal(rewards.detail, `You saved ${formatPrice(300)} on delivery`);
    assert.equal(rewards.firstMilestone.unlocked, true);
    assert.equal(rewards.freeMilestone.unlocked, true);
    assert.equal(rewards.progressPercent, 100);
    assert.equal(rewards.secondSegmentPercent, 100);
  }
});

test('delivery rewards is display-only and does not introduce a second delivery authority', () => {
  const source = String(getDeliveryRewardsPresentation);
  assert.doesNotMatch(source, /fetch|setDelivery|grandTotal|deliveryFee\s*=/);
  assert.match(source, /deliveryQuote\.freeDeliveryMin/);
  assert.match(source, /deliveryQuote\.reducedTier/);
});

test('delivery rewards copy remains truthful when the reduced tier is disabled', () => {
  const quote = resolveDeliveryQuote({ deliveryCharge: 300, freeDeliveryMin: 5000 }, 'Colombo', 3200);
  const rewards = getDeliveryRewardsPresentation(quote, 3200, formatPrice);
  assert.equal(quote.deliveryFee, 300);
  assert.equal(rewards.headline, `Add ${formatPrice(1800)} more for free delivery`);
  assert.equal(rewards.firstMilestone.amount, 5000);
  assert.equal(rewards.freeMilestone.amount, 5000);
});

test('product delivery messaging consumes current settings instead of fixed thresholds', () => {
  const source = readFileSync('src/components/ProductDetailModal.tsx', 'utf8');
  const rewards = readFileSync('src/components/DeliveryRewards.tsx', 'utf8');
  assert.match(source, /<DeliveryRewardsNote settings=\{settings\} formatPrice=\{formatPrice\} \/>/);
  assert.match(rewards, /resolveDeliveryCharge\(settings, ''\)/);
  assert.match(rewards, /resolveReducedDeliveryTier\(settings\)/);
  assert.match(rewards, /resolveFreeDeliveryMin\(settings\)/);
  assert.doesNotMatch(source, /Rs\. 3,500|freeDeliveryMin\s*===\s*5000/);
});

test('delivery rewards styling stays compact and motion-safe', () => {
  const styles = readFileSync('src/features/checkout/premiumCheckout.css', 'utf8');
  assert.match(styles, /\.zy-delivery-rewards\s*\{[\s\S]*padding:\s*0\.55rem 0\.8rem 0\.5rem/);
  assert.match(styles, /\.zy-delivery-rewards-track i\s*\{[\s\S]*transition:\s*width 300ms ease/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*\.zy-delivery-rewards-track i/);
  assert.doesNotMatch(styles, /\.zy-delivery-progress/);
});

test('delivery rewards styling stays compact and motion-safe', () => {
  const styles = readFileSync('src/features/checkout/premiumCheckout.css', 'utf8');
  assert.match(styles, /\.zy-delivery-rewards\s*\{[\s\S]*padding:\s*0\.55rem 0\.8rem 0\.5rem/);
  assert.match(styles, /\.zy-delivery-rewards-track i\s*\{[\s\S]*transition:\s*width 300ms ease/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*\.zy-delivery-rewards-track i/);
  assert.doesNotMatch(styles, /\.zy-delivery-progress/);
});
