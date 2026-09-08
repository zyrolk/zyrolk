import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const navbar = readFileSync('src/components/Navbar.tsx', 'utf8');
const paymentReturn = readFileSync('src/features/checkout/PaymentReturnPage.tsx', 'utf8');
const modal = readFileSync('src/components/ProductDetailModal.tsx', 'utf8');
const checkout = readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8');

test('Deals navigation uses the live Flash Deals anchor in desktop and mobile menus', () => {
  assert.match(navbar, /document\.getElementById\('homepage-flash-deals'\)/);
  assert.doesNotMatch(navbar, /phase-one-deals-title/);
  assert.match(navbar, /navLinks\.map\(\(link\)/);
  assert.match(navbar, /navLinks\.map\(\(\{ id, label, icon: Icon, action \}\)/);
  assert.match(navbar, /id: 'deals'[\s\S]{0,140}action: navigateToDeals/);
  assert.match(navbar, /id: 'today-offers'[\s\S]{0,160}action: navigateToDeals/);
});

test('legacy payment-return routing is a safe COD-only fallback without payment API calls', () => {
  assert.match(app, /paymentReturnContext \? 'payment-return'/);
  assert.match(app, /onSupport=\{\(\) => finishPaymentReturn\('contact'\)\}/);
  assert.match(paymentReturn, /Online payment is not currently available/);
  assert.match(paymentReturn, /Cash on Delivery only/);
  assert.match(paymentReturn, /This link did not confirm an online payment or change your order/);
  assert.match(paymentReturn, /Contact Support/);
  assert.doesNotMatch(paymentReturn, /PayHere|\/api\/payments\/|Retry with PayHere|fetchJson|submitPayHerePayment/iu);
});

test('active WhatsApp product action is support-only and COD checkout remains authoritative', () => {
  assert.match(modal, /Need help ordering\? Chat on WhatsApp/);
  assert.match(modal, /Get help ordering .* on WhatsApp/);
  assert.match(modal, /official Zyro\.lk checkout/);
  assert.match(modal, /This WhatsApp message is not an order confirmation/);
  assert.doesNotMatch(modal, /WhatsApp Quick Checkout|Order .* through WhatsApp|WhatsApp checkout/iu);
  assert.match(checkout, /const paymentMethod = 'cod' as const/);
  assert.match(checkout, /Cash on Delivery/);
});

test('App preserves the historical-order compatibility surface without enabling PayHere routes', () => {
  const orders = readFileSync('src/features/account/CustomerOrdersView.tsx', 'utf8');
  const api = readFileSync('functions/src/api/app.ts', 'utf8');
  assert.match(orders, /selectedOrder\.paymentMethod === 'payhere'/);
  assert.match(orders, /PayHere transaction reference/);
  assert.doesNotMatch(api, /registerPaymentRoutes\(app/);
});
