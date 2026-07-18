import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  EMPTY_CHECKOUT_FORM,
  checkoutFormFromAddress,
  clearCheckoutDraft,
  normalizeCheckoutForm,
  readCheckoutDraft,
  validateCheckoutForm,
  writeCheckoutDraft,
} from '../src/features/checkout/checkoutModel';
import { normalizeCustomerOrder, calculateCustomerOrderTotals } from '../src/features/account/customerOrders';

const checkout = readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8');
const checkoutStyles = readFileSync('src/features/checkout/premiumCheckout.css', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');
const functionCheckout = readFileSync('functions/src/api/routes/checkout.ts', 'utf8');
const localCheckout = readFileSync('server.ts', 'utf8');
const rules = readFileSync('firestore.rules', 'utf8');

function storageDouble(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

test('checkout validation normalizes customer input and reports each required delivery field', () => {
  assert.deepEqual(normalizeCheckoutForm({ ...EMPTY_CHECKOUT_FORM, customerName: '  Nimal  ', city: '  Kandy ' }), {
    ...EMPTY_CHECKOUT_FORM,
    customerName: 'Nimal',
    city: 'Kandy',
  });
  assert.deepEqual(validateCheckoutForm(EMPTY_CHECKOUT_FORM), {
    customerName: 'Enter the recipient name.',
    customerPhone: 'Enter a valid phone number with 9 to 15 digits.',
    customerAddress: 'Enter the street address.',
    city: 'Enter the delivery city.',
  });
  assert.equal(Object.keys(validateCheckoutForm({
    customerName: 'Nimal Perera', customerPhone: '0771234567', customerPhone2: '',
    customerEmail: 'nimal@example.com', customerAddress: '1 Main Street', city: 'Kandy', district: 'Kandy',
  })).length, 0);
});

test('address book records map into checkout without changing the account address contract', () => {
  assert.deepEqual(checkoutFormFromAddress({
    id: 'home', label: 'Home', fullName: 'Nimal Perera', phone: '0771234567',
    addressLine1: '1 Main Street', addressLine2: 'Floor 2', city: 'Kandy', district: 'Kandy',
    postalCode: '20000', isDefault: true,
  }, 'nimal@example.com'), {
    customerName: 'Nimal Perera', customerPhone: '0771234567', customerPhone2: '',
    customerEmail: 'nimal@example.com', customerAddress: '1 Main Street, Floor 2, 20000', city: 'Kandy', district: 'Kandy',
  });
  assert.match(checkout, /collection\(db, 'users', user\.uid, 'addresses'\)/);
  assert.match(checkout, /address\.isDefault/);
});

test('checkout drafts survive closure and are removed only after a successful order', () => {
  const storage = storageDouble();
  const draft = { ...EMPTY_CHECKOUT_FORM, customerName: 'Nimal', customerPhone: '0771234567', customerAddress: '1 Main Street', city: 'Kandy', district: 'Kandy' };
  writeCheckoutDraft(storage, draft);
  assert.deepEqual(readCheckoutDraft(storage), draft);
  clearCheckoutDraft(storage);
  assert.deepEqual(readCheckoutDraft(storage), EMPTY_CHECKOUT_FORM);
  assert.match(app, /readStoredArray<CartItem>\(getBrowserStorage\('localStorage'\), 'zyro_cart'\)/);
  assert.match(app, /writeStoredJson\(getBrowserStorage\('localStorage'\), 'zyro_cart', cart\)/);
  assert.match(checkout, /setPlacedOrder\(result\.order\)[\s\S]*clearCheckoutDraft[\s\S]*onClearCart\(\)/);
});

test('coupon validation and final checkout both use live trusted prices and private coupon records', () => {
  for (const source of [functionCheckout, localCheckout]) {
    assert.match(source, /\/api\/checkout\/coupon/);
    assert.match(source, /collection\("checkout_coupons"\)\.doc\(getCouponDocumentId\(code\)\)/);
    assert.match(source, /resolveCouponDiscount/);
    assert.match(source, /couponCode: requestedCouponCode/);
    assert.match(source, /discountAmount: totals\.discountAmount/);
  }
  assert.match(checkout, /\/api\/checkout\/coupon/);
  assert.match(checkout, /Your cart changed\. Apply the coupon again/);
  assert.match(rules, /match \/checkout_coupons\/\{couponId\}[\s\S]*allow read, write: if isAdmin\(\)/);
});

test('signed-in checkout binds orders to verified authentication and keeps guest checkout compatible', () => {
  assert.match(functionCheckout, /verifyIdToken/);
  assert.match(functionCheckout, /requestedCustomerUid !== customerUid/);
  assert.match(checkout, /user \? await user\.getIdToken\(\) : ''/);
  assert.match(checkout, /Authorization: `Bearer \$\{token\}`/);
  assert.match(functionCheckout, /if \(!match\) return "guest"/);
});

test('confirmation uses server-authoritative order values and coupon-aware order history remains accurate', () => {
  assert.match(checkout, /setPlacedOrder\(result\.order\)/);
  assert.match(checkout, /checkout-confirmation-title/);
  assert.match(checkout, /placedOrder\.totalPrice/);
  const order = normalizeCustomerOrder('order-1', {
    items: [{ productId: 'p1', name: 'Product', price: 4000, quantity: 1, imageUrl: '' }],
    itemsSubtotal: 4000, discountAmount: 500, deliveryFee: 350, totalPrice: 3850,
    couponCode: 'SAVE500', status: 'pending', paymentMethod: 'cod',
  });
  assert.deepEqual(calculateCustomerOrderTotals(order), {
    itemsSubtotal: 4000, discountAmount: 500, deliveryFee: 350, grandTotal: 3850,
  });
  assert.equal(order.couponCode, 'SAVE500');
});

test('premium one-page checkout includes accessible validation, focus containment, responsive layout, and reduced motion', () => {
  assert.match(checkout, /role="dialog" aria-modal="true"/);
  assert.match(checkout, /event\.key !== 'Tab'/);
  assert.match(checkout, /aria-invalid=\{Boolean\(errors\./);
  assert.match(checkout, /document\.getElementById\(`checkout-\$\{firstError\}`\)\?\.focus\(\)/);
  assert.match(checkout, /aria-busy=\{isSubmitting\}/);
  assert.match(checkoutStyles, /grid-template-columns: minmax\(0, 1\.08fr\)/);
  assert.match(checkoutStyles, /@media \(max-width: 600px\)[\s\S]*\.zy-place-order \{ position: sticky/);
  assert.match(checkoutStyles, /@media \(prefers-reduced-motion: reduce\)/);
});
