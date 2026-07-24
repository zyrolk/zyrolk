import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('COD-only launch leaves PayHere implementation retained but unbound and unregistered', () => {
  const secrets = readFileSync('functions/src/config/secrets.ts', 'utf8');
  const app = readFileSync('functions/src/api/app.ts', 'utf8');
  const checkout = readFileSync('functions/src/api/routes/checkout.ts', 'utf8');
  const drawer = readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8');

  assert.doesNotMatch(secrets, /defineSecret\("PAYHERE_MERCHANT_SECRET"\)/);
  assert.doesNotMatch(secrets, /PAYHERE_MERCHANT_SECRET/);
  assert.doesNotMatch(app, /registerPaymentRoutes\(app/);
  assert.doesNotMatch(app, /payments\/payhere\/notify/);
  assert.match(checkout, /Only Cash on Delivery is currently available/);
  assert.match(drawer, /const paymentMethod = 'cod' as const/);
  assert.doesNotMatch(drawer, /submitPayHerePayment/);
  assert.match(readFileSync('functions/src/api/routes/payments.ts', 'utf8'), /verifyPayHereNotification/);
});
