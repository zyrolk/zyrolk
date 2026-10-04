import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { calculateCheckoutTotals, type CheckoutSettings } from '../functions/src/api/checkout/checkoutLogic';
import { calculateCustomerOrderTotals } from '../src/features/account/customerOrders';
import {
  describeDeliveryProgress,
  resolveDeliveryQuote,
} from '../src/services/settings/shippingSettings';
import { describeDeliveryTierPreview, validateStoreSettings } from '../src/services/settings/storeSettingsValidation';
import { DEFAULT_WEBSITE_SETTINGS, normalizeWebsiteSettings } from '../src/services/settings/websiteSettings';
import type { WebsiteSettings } from '../src/types';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const formatPrice = (amount: number) => new Intl.NumberFormat('en-LK', {
  style: 'currency', currency: 'LKR', minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(amount);

const LAUNCH = { deliveryCharge: 300, reducedDeliveryMin: 3000, reducedDeliveryCharge: 150, freeDeliveryMin: 5000 };
const AREAS = [
  { id: 'colombo', name: 'Colombo', districts: ['Colombo'], charge: 300, estimatedDelivery: 'Varies', isActive: true },
  { id: 'kandy', name: 'Kandy', districts: ['Kandy'], charge: 400, estimatedDelivery: 'Varies', isActive: true },
  { id: 'cheap', name: 'Cheap', districts: ['Gampaha'], charge: 100, estimatedDelivery: 'Varies', isActive: true },
];
const withAreas = { ...LAUNCH, deliveryAreas: AREAS };

const storefront = (settings: unknown) => settings as WebsiteSettings;
const serverFee = (subtotal: number, settings: unknown, district = 'Matara', coupon = 0) => (
  calculateCheckoutTotals(subtotal, district, settings as CheckoutSettings, coupon).deliveryFee
);
const clientFee = (subtotal: number, settings: unknown, district = 'Matara') => (
  resolveDeliveryQuote(storefront(settings), district, subtotal).deliveryFee
);

test('Step 3B server: launch tiers at every boundary', () => {
  for (const [subtotal, expected] of [[0, 0], [2999, 300], [3000, 150], [4999, 150], [5000, 0], [5001, 0]] as const) {
    assert.equal(serverFee(subtotal, LAUNCH), expected, `subtotal ${subtotal}`);
  }
  assert.equal(calculateCheckoutTotals(3000, 'Matara', LAUNCH).deliveryTier, 'reduced');
  assert.equal(calculateCheckoutTotals(2999, 'Matara', LAUNCH).deliveryTier, 'standard');
  assert.equal(calculateCheckoutTotals(5000, 'Matara', LAUNCH).deliveryTier, 'free');
  assert.equal(calculateCheckoutTotals(0, 'Matara', LAUNCH).deliveryTier, 'none');
});

test('Step 3B server: thresholds use the selling-price subtotal, not the original price', () => {
  // Product regular price 4000; the verified selling subtotal decides the tier.
  const originalPriceSubtotal = 4000;
  assert.ok(originalPriceSubtotal >= LAUNCH.reducedDeliveryMin);
  assert.equal(serverFee(2800, LAUNCH), 300);
  assert.equal(serverFee(3200, LAUNCH), 150);
  const route = read('functions/src/api/routes/checkout.ts');
  assert.match(route, /itemsSubtotal \+= truePrice \* item\.quantity/);
  assert.doesNotMatch(route, /itemsSubtotal \+=[^\n]*originalPrice/);
});

test('Step 3B server: the coupon applies after tier eligibility and delivery never counts toward a threshold', () => {
  const totals = calculateCheckoutTotals(3200, 'Matara', LAUNCH, 400);
  assert.equal(totals.deliveryFee, 150);
  assert.equal(totals.discountAmount, 400);
  assert.equal(totals.grandTotalPrice, 3200 - 400 + 150);
  const nearReduced = calculateCheckoutTotals(2850, 'Matara', LAUNCH);
  assert.equal(nearReduced.deliveryFee, 300, '2850 + 300 delivery must not unlock the reduced tier');
  const nearFree = calculateCheckoutTotals(4900, 'Matara', LAUNCH);
  assert.equal(nearFree.deliveryFee, 150, '4900 + 150 delivery must not unlock free delivery');
});

test('Step 3B areas: the reduced charge never raises a cheaper area charge', () => {
  const expectations: Array<[string, number, number]> = [
    ['Colombo', 2999, 300], ['Colombo', 3000, 150], ['Colombo', 5000, 0],
    ['Kandy', 2999, 400], ['Kandy', 3000, 150], ['Kandy', 5000, 0],
    ['Gampaha', 2999, 100], ['Gampaha', 3000, 100], ['Gampaha', 5000, 0],
  ];
  for (const [district, subtotal, expected] of expectations) {
    assert.equal(serverFee(subtotal, withAreas, district), expected, `server ${district} ${subtotal}`);
    assert.equal(clientFee(subtotal, withAreas, district), expected, `storefront ${district} ${subtotal}`);
  }
  const inactive = { ...LAUNCH, deliveryAreas: [{ ...AREAS[1], isActive: false }] };
  assert.equal(serverFee(2999, inactive, 'Kandy'), 300);
  assert.equal(clientFee(2999, inactive, 'Kandy'), 300);
});

test('Step 3B backward compatibility: the reduced tier is off unless both fields are valid', () => {
  const twoLevel = { deliveryCharge: 300, freeDeliveryMin: 5000 };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['missing', twoLevel],
    ['null', { ...twoLevel, reducedDeliveryMin: null, reducedDeliveryCharge: null }],
    ['only threshold', { ...twoLevel, reducedDeliveryMin: 3000 }],
    ['only charge', { ...twoLevel, reducedDeliveryCharge: 150 }],
    ['non-numeric', { ...twoLevel, reducedDeliveryMin: 'soon', reducedDeliveryCharge: 150 }],
    ['negative charge', { ...twoLevel, reducedDeliveryMin: 3000, reducedDeliveryCharge: -1 }],
    ['zero threshold', { ...twoLevel, reducedDeliveryMin: 0, reducedDeliveryCharge: 150 }],
    ['threshold at free', { ...twoLevel, reducedDeliveryMin: 5000, reducedDeliveryCharge: 150 }],
    ['threshold above free', { ...twoLevel, reducedDeliveryMin: 6000, reducedDeliveryCharge: 150 }],
    ['blank strings', { ...twoLevel, reducedDeliveryMin: '', reducedDeliveryCharge: '' }],
  ];
  for (const [label, settings] of cases) {
    for (const [subtotal, expected] of [[2999, 300], [3000, 300], [4999, 300], [5000, 0]] as const) {
      assert.equal(serverFee(subtotal, settings), expected, `server ${label} ${subtotal}`);
      assert.equal(clientFee(subtotal, settings), expected, `storefront ${label} ${subtotal}`);
    }
    assert.equal(calculateCheckoutTotals(3000, 'Matara', settings).reducedDeliveryMin, null, label);
  }
});

test('Step 3B normalisation and code defaults never inject 3000 / 150', () => {
  const legacy = normalizeWebsiteSettings({ deliveryCharge: 300, freeDeliveryMin: 5000 });
  assert.equal(Object.hasOwn(legacy, 'reducedDeliveryMin'), false);
  assert.equal(Object.hasOwn(legacy, 'reducedDeliveryCharge'), false);
  assert.equal(Object.hasOwn(normalizeWebsiteSettings(null), 'reducedDeliveryMin'), false);
  const configured = normalizeWebsiteSettings(LAUNCH);
  assert.equal(configured.reducedDeliveryMin, 3000);
  assert.equal(configured.reducedDeliveryCharge, 150);
  for (const source of [
    read('src/services/settings/websiteSettings.ts'),
    read('functions/src/api/checkout/checkoutLogic.ts'),
    read('src/services/settings/shippingSettings.ts'),
  ]) {
    assert.doesNotMatch(source, /reducedDelivery(Min|Charge)\s*[:=]\s*(3000|150)\b/);
  }
  const admin = read('src/components/AdminDashboard.tsx');
  assert.match(admin, /if \(updatedSettings\.reducedDeliveryMin === null\) delete updatedSettings\.reducedDeliveryMin;/);
  assert.match(admin, /if \(updatedSettings\.reducedDeliveryCharge === null\) delete updatedSettings\.reducedDeliveryCharge;/);
});

test('Step 3B malformed settings fail safely and keep storefront and server in agreement', () => {
  const malformed: Array<[string, Record<string, unknown>]> = [
    ['null free threshold', { deliveryCharge: 300, freeDeliveryMin: null }],
    ['text free threshold', { deliveryCharge: 300, freeDeliveryMin: 'free' }],
    ['negative free threshold', { deliveryCharge: 300, freeDeliveryMin: -5 }],
    ['text charge', { deliveryCharge: 'three hundred', freeDeliveryMin: 5000 }],
    ['malformed areas', { ...LAUNCH, deliveryAreas: [null, 'Kandy', { charge: 90 }, { districts: 'Kandy', charge: 90 }, { districts: [null, 7], charge: 90 }] }],
    ['invalid area charge falls back to global', { ...LAUNCH, deliveryAreas: [{ districts: ['Matara'], charge: 'x', isActive: true }] }],
    ['areas not an array', { ...LAUNCH, deliveryAreas: { Matara: 50 } }],
  ];
  for (const [label, settings] of malformed) {
    for (const subtotal of [0, 1000, 2999, 3000, 4999, 5000, 7000]) {
      assert.doesNotThrow(() => clientFee(subtotal, settings), label);
      assert.equal(clientFee(subtotal, settings), serverFee(subtotal, settings), `${label} at ${subtotal}`);
    }
  }
  assert.equal(serverFee(4999, { deliveryCharge: 300, freeDeliveryMin: null }), 300);
  assert.equal(serverFee(5000, { deliveryCharge: 300, freeDeliveryMin: 'free' }), 0);
  assert.equal(serverFee(1000, { ...LAUNCH, deliveryAreas: [{ districts: ['Matara'], charge: 'x', isActive: true }] }), 300);
});

test('Step 3B storefront parity: the quote matches the server across tiers, areas and coupons', () => {
  const settingsVariants = [null, { deliveryCharge: 300, freeDeliveryMin: 5000 }, LAUNCH, withAreas];
  for (const settings of settingsVariants) {
    for (const district of ['Colombo', 'Kandy', 'Gampaha', 'Matara', '']) {
      for (const subtotal of [0, 1, 2999, 3000, 3001, 4999, 5000, 5001, 12000]) {
        const server = calculateCheckoutTotals(subtotal, district, settings as CheckoutSettings);
        const quote = resolveDeliveryQuote(storefront(settings), district, subtotal);
        assert.equal(quote.deliveryFee, server.deliveryFee, `${JSON.stringify(settings)} ${district} ${subtotal}`);
        assert.equal(quote.tier, server.deliveryTier);
        assert.equal(quote.standardCharge, server.baseDeliveryCharge);
        assert.equal(quote.freeDeliveryMin, server.freeDeliveryThreshold);
      }
    }
  }
});

test('Step 3B checkout messages: standard, reduced, free and tier-off copy with dynamic savings', () => {
  const message = (subtotal: number, settings: unknown, district = 'Matara') => {
    const quote = resolveDeliveryQuote(storefront(settings), district, subtotal);
    return { quote, ...describeDeliveryProgress(quote, subtotal, formatPrice) };
  };

  const standard = message(2800, LAUNCH);
  assert.equal(standard.quote.deliveryFee, 300);
  assert.equal(standard.headline, `Add ${formatPrice(200)} more to save ${formatPrice(150)} on delivery`);
  assert.equal(standard.detail, `FREE delivery on orders of ${formatPrice(5000)} or more.`);
  assert.equal(standard.showSaving, false);

  const reduced = message(3200, LAUNCH);
  assert.equal(reduced.quote.deliveryFee, 150);
  assert.equal(reduced.quote.standardCharge, 300);
  assert.equal(reduced.headline, `${formatPrice(150)} delivery unlocked • Add ${formatPrice(1800)} more for FREE delivery`);
  assert.equal(reduced.detail, `You save ${formatPrice(150)} on delivery`);
  assert.equal(reduced.showSaving, true);

  const free = message(5200, LAUNCH);
  assert.equal(free.quote.deliveryFee, 0);
  assert.equal(free.headline, 'FREE delivery unlocked');
  assert.equal(free.detail, `You save ${formatPrice(300)} on delivery`);
  assert.equal(free.showSaving, true);

  const kandyReduced = message(3200, withAreas, 'Kandy');
  assert.equal(kandyReduced.detail, `You save ${formatPrice(250)} on delivery`);
  assert.equal(message(5200, withAreas, 'Kandy').detail, `You save ${formatPrice(400)} on delivery`);

  const cheapStandard = message(2800, withAreas, 'Gampaha');
  assert.equal(cheapStandard.headline, `${formatPrice(2200)} away from free delivery`, 'no saving is claimed when the area charge is already below the reduced charge');
  const cheapReduced = message(3200, withAreas, 'Gampaha');
  assert.equal(cheapReduced.quote.deliveryFee, 100);
  assert.equal(cheapReduced.showSaving, false);
  assert.doesNotMatch(cheapReduced.headline, /save|unlocked/i);

  const tierOff = { deliveryCharge: 300, freeDeliveryMin: 5000 };
  const offBelow = message(3200, tierOff);
  assert.equal(offBelow.headline, `${formatPrice(1800)} away from free delivery`);
  assert.equal(offBelow.detail, 'Keep shopping or continue with the current delivery fee.');
  assert.equal(offBelow.showSaving, false);
  const offFree = message(5200, tierOff);
  assert.equal(offFree.headline, 'Free delivery unlocked');
  assert.equal(offFree.detail, 'Your order qualifies for islandwide delivery.');
  assert.equal(offFree.showSaving, false);

  assert.equal(message(2500, LAUNCH).progressPercent, 50);
  assert.equal(message(5200, LAUNCH).progressPercent, 100);

  const drawer = read('src/features/checkout/PremiumCheckoutDrawer.tsx');
  assert.match(drawer, /<DeliveryRewards subtotal=\{itemsSubtotal\} deliveryQuote=\{deliveryQuote\} formatPrice=\{formatPrice\} \/>/);
  assert.match(drawer, /deliveryProgress\.showSaving && <div><span>Standard delivery<\/span><b><s>\{formatPrice\(deliveryQuote\.standardCharge\)\}<\/s><\/b><\/div>/);
  assert.match(drawer, /deliveryProgress\.showSaving && <div className="is-discount"><span>You save \{formatPrice\(deliveryQuote\.saving\)\} on delivery<\/span><\/div>/);
});

test('Step 3B Admin validation accepts the launch tiers and rejects invalid delivery settings', () => {
  const settings = { ...DEFAULT_WEBSITE_SETTINGS, whatsappNumber: '' };
  const validate = (values: { deliveryCharge?: string; freeDeliveryMin?: string; reducedDeliveryMin?: string; reducedDeliveryCharge?: string }) => validateStoreSettings({
    settings,
    deliveryCharge: values.deliveryCharge ?? '300',
    freeDeliveryMin: values.freeDeliveryMin ?? '5000',
    reducedDeliveryMin: values.reducedDeliveryMin ?? '',
    reducedDeliveryCharge: values.reducedDeliveryCharge ?? '',
  });

  const launch = validate({ reducedDeliveryMin: '3000', reducedDeliveryCharge: '150' });
  assert.deepEqual(launch.errors, []);
  assert.equal(launch.reducedDeliveryMin, 3000);
  assert.equal(launch.reducedDeliveryCharge, 150);

  const off = validate({});
  assert.deepEqual(off.errors, []);
  assert.equal(off.reducedDeliveryMin, null);
  assert.equal(off.reducedDeliveryCharge, null);

  const rejected: Array<[string, Parameters<typeof validate>[0], RegExp]> = [
    ['negative standard fee', { deliveryCharge: '-1' }, /Delivery charge must be a non-negative number/],
    ['zero free threshold', { freeDeliveryMin: '0' }, /Free delivery threshold must be greater than zero/],
    ['non-numeric free threshold', { freeDeliveryMin: 'free' }, /Free delivery threshold must be a non-negative number/],
    ['only reduced threshold', { reducedDeliveryMin: '3000' }, /both a starting amount and a charge/],
    ['only reduced charge', { reducedDeliveryCharge: '150' }, /both a starting amount and a charge/],
    ['zero reduced threshold', { reducedDeliveryMin: '0', reducedDeliveryCharge: '150' }, /starting amount must be a number greater than zero/],
    ['reduced threshold at free', { reducedDeliveryMin: '5000', reducedDeliveryCharge: '150' }, /must start below the free delivery threshold/],
    ['reduced threshold above free', { reducedDeliveryMin: '6000', reducedDeliveryCharge: '150' }, /must start below the free delivery threshold/],
    ['negative reduced fee', { reducedDeliveryMin: '3000', reducedDeliveryCharge: '-5' }, /Reduced delivery charge must be a non-negative number/],
    ['reduced fee above standard', { reducedDeliveryMin: '3000', reducedDeliveryCharge: '350' }, /cannot be higher than the standard delivery charge/],
    ['non-numeric reduced threshold', { reducedDeliveryMin: 'abc', reducedDeliveryCharge: '150' }, /starting amount must be a number greater than zero/],
    ['infinite reduced fee', { reducedDeliveryMin: '3000', reducedDeliveryCharge: 'Infinity' }, /Reduced delivery charge must be a non-negative number/],
  ];
  for (const [label, values, pattern] of rejected) {
    const result = validate(values);
    assert.ok(result.errors.some((error) => pattern.test(error)), `${label}: ${result.errors.join(' | ')}`);
  }
});

test('Step 3B Admin preview uses the entered values', () => {
  assert.deepEqual(describeDeliveryTierPreview({
    deliveryCharge: '300', freeDeliveryMin: '5000', reducedDeliveryMin: '3000', reducedDeliveryCharge: '150',
  }), ['Below LKR 3,000: LKR 300', 'LKR 3,000 to below LKR 5,000: LKR 150', 'LKR 5,000+: FREE']);
  assert.deepEqual(describeDeliveryTierPreview({
    deliveryCharge: '425', freeDeliveryMin: '7000', reducedDeliveryMin: '2500', reducedDeliveryCharge: '200',
  }), ['Below LKR 2,500: LKR 425', 'LKR 2,500 to below LKR 7,000: LKR 200', 'LKR 7,000+: FREE']);
  assert.deepEqual(describeDeliveryTierPreview({ deliveryCharge: '300', freeDeliveryMin: '5000' }), [
    'Below LKR 5,000: LKR 300', 'LKR 5,000+: FREE', 'Reduced delivery tier is off.',
  ]);
  assert.equal(describeDeliveryTierPreview({ deliveryCharge: '300', freeDeliveryMin: '5000', reducedDeliveryMin: '3000' }), null);
  assert.equal(describeDeliveryTierPreview({ deliveryCharge: '300', freeDeliveryMin: '5000', reducedDeliveryMin: '6000', reducedDeliveryCharge: '150' }), null);

  const admin = read('src/components/AdminDashboard.tsx');
  for (const label of ['Standard Delivery Charge (LKR)', 'Reduced Delivery Starts At (LKR)', 'Reduced Delivery Charge (LKR)', 'Free Delivery Starts At (LKR)']) {
    assert.ok(admin.includes(label), label);
  }
  assert.match(admin, /Leave both reduced fields blank to turn the reduced delivery tier off\./);
  assert.match(admin, /reducedDeliveryMin: tempReducedDeliveryMin,\s*reducedDeliveryCharge: tempReducedDeliveryCharge,/);
});

test('Step 3B order display uses the delivery fee saved on the order, never current settings', () => {
  const item = { productId: 'p1', name: 'Item', price: 1000, quantity: 3, imageUrl: '' };
  const historical = calculateCustomerOrderTotals({ items: [item], itemsSubtotal: 3000, deliveryFee: 350, discountAmount: 0, totalPrice: 3350 });
  const reduced = calculateCustomerOrderTotals({ items: [item], itemsSubtotal: 3000, deliveryFee: 150, discountAmount: 0, totalPrice: 3150 });
  const free = calculateCustomerOrderTotals({ items: [{ ...item, quantity: 5 }], itemsSubtotal: 5000, deliveryFee: 0, discountAmount: 0, totalPrice: 5000 });
  const withCoupon = calculateCustomerOrderTotals({ items: [item], itemsSubtotal: 3000, deliveryFee: 150, discountAmount: 400, totalPrice: 2750 });
  assert.equal(historical.deliveryFee, 350);
  assert.equal(reduced.deliveryFee, 150);
  assert.equal(free.deliveryFee, 0);
  assert.equal(withCoupon.deliveryFee, 150);
  assert.equal(withCoupon.discountAmount, 400);

  const admin = read('src/components/AdminDashboard.tsx');
  const invoiceStart = admin.indexOf('{/* Invoice Financial summary */}');
  const invoiceEnd = admin.indexOf('Grand Total (LKR)', invoiceStart);
  assert.ok(invoiceStart > 0 && invoiceEnd > invoiceStart);
  const invoice = admin.slice(invoiceStart, invoiceEnd);
  assert.doesNotMatch(invoice, /settings\?\.deliveryCharge|\|\|\s*350/);
  assert.match(invoice, /selectedOrderTotals\.deliveryFee === 0 \? 'Free' : formatPrice\(selectedOrderTotals\.deliveryFee\)/);
  assert.match(invoice, /formatPrice\(selectedOrderTotals\.itemsSubtotal\)/);
  assert.match(admin, /const selectedOrderTotals = calculateCustomerOrderTotals\(selectedOrder \|\| \{ items: \[\], totalPrice: 0 \}\);/);
});
