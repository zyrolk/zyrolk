# Sprint 84 production deployment

Sprint 84 adds PayHere payments, transactional stock reservations, notification outbox records, App Check enforcement support, commerce telemetry, and dynamic SEO endpoints. Deploy the changes as one coordinated release so the API, rules, indexes, and storefront agree on the payment lifecycle.

## 1. Configure PayHere

Create separate PayHere sandbox and live applications for the deployed Zyro.lk domain. PayHere merchant secrets are domain-specific, so use the secret shown for the exact approved application and mode.

Store the merchant secret in Firebase Secret Manager:

```powershell
firebase functions:secrets:set PAYHERE_MERCHANT_SECRET --project zyrolk-e0164
```

Configure these non-secret Functions runtime values for the target environment:

```dotenv
PAYHERE_MODE=sandbox
PAYHERE_MERCHANT_ID=your_merchant_id
PUBLIC_SITE_URL=https://your-approved-domain.example
API_ALLOWED_ORIGINS=https://your-approved-domain.example
REQUIRE_APP_CHECK=false
```

Use `PAYHERE_MODE=live` only with the live merchant ID, matching live secret, approved production domain, and an HTTPS `PUBLIC_SITE_URL`. The application generates the PayHere `notify_url` as `${PUBLIC_SITE_URL}/api/payments/payhere/notify`; it does not accept client-declared payment success.

## 2. Configure email delivery

Install the official Firebase Trigger Email extension and configure it to watch the `mail` collection:

```powershell
firebase ext:install firebase/firestore-send-email --project zyrolk-e0164
```

Provide the verified sender and SMTP transport in the extension prompts. The order trigger writes deterministic, idempotent messages for customer order/payment/status updates and admin order/payment alerts. Delivery state is maintained by the extension on the private `mail` documents.

## 3. Configure App Check and analytics

Register the web application with Firebase App Check using reCAPTCHA Enterprise. Supply the public site key to the storefront build:

```dotenv
VITE_FIREBASE_APP_CHECK_SITE_KEY=your_recaptcha_enterprise_site_key
VITE_FIREBASE_MEASUREMENT_ID=your_ga_measurement_id
```

Deploy first with `REQUIRE_APP_CHECK=false`, review App Check metrics for legitimate storefront traffic, then set it to `true` and redeploy the API. The PayHere notification endpoint and sitemap are intentionally exempt because they are server/gateway requests; PayHere verification still requires the valid server-side signature and exact order amount/currency.

Enable Google Analytics and Performance Monitoring for the Firebase web application. Commerce events are emitted for add-to-cart, checkout start, payment-method selection, and server-confirmed purchase. Production client failures are sent as sanitized codes and contexts without customer input or stack traces.

## 4. Deploy the coordinated release

Build and test locally, then deploy rules, the required composite index, Functions, and Hosting:

```powershell
npm run lint
npm test
npm run build
npm --prefix functions run build
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting --project zyrolk-e0164
```

The reservation expiry scheduler requires the deployed `orders` composite index on `stockReservationStatus` and `stockReservationExpiresAt`. Wait for index creation to complete before enabling PayHere checkout.

## 5. Release verification

In sandbox, verify all of these paths before switching to live mode:

1. A successful guest payment reaches the return page, remains pending until the signed notification arrives, then shows paid.
2. An authenticated checkout appears in My Orders with its payment timeline and reference.
3. A failed or cancelled payment restores stock once and allows a retry while stock is available.
4. Replaying the same successful notification does not create another fulfillment or stock change.
5. Two simultaneous checkouts for the final unit cannot both reserve it.
6. An abandoned reservation expires, restores stock, and marks the order cancelled.
7. Customer and admin notification documents are delivered by the email extension.
8. App Check metrics, Analytics commerce events, Performance traces, and sanitized server logs are visible.

## Data compatibility

No existing collection is renamed and no historical order backfill is required. New PayHere orders receive additive payment and reservation fields. The server-owned `payment_transactions`, `payment_receipts`, `notification_outbox`, and `mail` collections are denied to storefront clients by Firestore rules. Existing COD, WhatsApp confirmation, checkout, account, admin, supplier, CMS, and AI workflows keep their existing contracts.
