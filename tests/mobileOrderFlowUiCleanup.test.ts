import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string): string => readFileSync(path, 'utf8');
const accountCss = read('src/features/account/accountCenter.css');
const checkoutCss = read('src/features/checkout/premiumCheckout.css');
const floatingWhatsApp = read('src/components/FloatingWhatsApp.tsx');
const app = read('src/App.tsx');
const orders = read('src/features/account/CustomerOrdersView.tsx');

test('mobile payment confirmation clears the fixed header and bottom dock', () => {
  assert.match(checkoutCss, /\.zy-order-confirmation \{ padding-top: calc\(1\.5rem \+ 5\.2rem\); padding-bottom: calc\(9rem \+ env\(safe-area-inset-bottom\)\); \}/u);
  assert.match(checkoutCss, /\.zy-premium-checkout-header \{ min-height: 5\.2rem/u);
});

test('mobile order surfaces hide intentional scrollbars while preserving touch scrolling', () => {
  assert.match(accountCss, /\.zy-order-filter-row[^}]*scrollbar-width: none/u);
  assert.match(accountCss, /\.zy-account-sidebar nav[^}]*scrollbar-width: none/u);
  assert.match(accountCss, /\.zy-order-timeline[^}]*scrollbar-width: none/u);
  assert.match(accountCss, /overscroll-behavior-x: contain/u);
  assert.match(accountCss, /\.zy-order-timeline ol \{ min-width: 540px; \}/u);
});

test('mobile account content reserves safe-area space above the dock', () => {
  assert.match(accountCss, /\.zy-account-center \{ padding-bottom: calc\(9rem \+ env\(safe-area-inset-bottom\)\); \}/u);
  assert.match(app, /pb-\[calc\(7rem\+env\(safe-area-inset-bottom\)\)\]/u);
});

test('floating WhatsApp keeps clearance from actions, dock, and safe-area inset', () => {
  assert.match(floatingWhatsApp, /MOBILE_BOTTOM_CLEARANCE = 136/u);
  assert.match(floatingWhatsApp, /bottom-\[calc\(8\.5rem\+env\(safe-area-inset-bottom\)\)\]/u);
});

test('order hero keeps the order reference readable on blue', () => {
  assert.match(accountCss, /\.zy-order-invoice-head h2 \{[^}]*color: #fff/u);
});

test('order commerce and status behavior remains component-owned', () => {
  assert.match(orders, /buildCustomerOrderTimeline\(selectedOrder\.status\)/u);
  assert.match(orders, /Buy Again/u);
  assert.match(orders, /Cancel Order/u);
  assert.match(orders, /window\.print\(\)/u);
});
