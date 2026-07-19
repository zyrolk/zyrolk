# Sprint L5.1 Release Readiness

Prepared: 2026-07-19

This document is a deployment and release checklist only. Sprint L5.1 does not
authorize a Firebase deployment, DNS change, production data migration, or Git
commit.

## Release candidate

- Recommended version: `v1.0.0`
- Current branch during preparation: `main`
- Current release status: not releasable until the existing working tree is
  reviewed, committed as an approved release candidate, and tagged.
- The product commercial-data migration is intentionally one-way for public
  documents. Private copies are retained in `product_private`; commercial data
  must never be restored to `products` during rollback.

## Required deployment order

Use an announced Admin/Supplier maintenance window. The customer storefront can
remain available because its public product contract does not change.

- [ ] Review `git diff`, `git diff --check`, test output, and generated release notes.
- [ ] Create an approved release commit and immutable `v1.0.0` tag.
- [ ] Export/backup Firestore before migration and record the export identifier.
- [ ] Register both `zyro.lk` and the Firebase Hosting fallback with Firebase App Check.
- [ ] Configure `VITE_FIREBASE_APP_CHECK_SITE_KEY` for the Hosting build.
- [ ] Configure exact `API_ALLOWED_ORIGINS` values: `https://zyro.lk`,
      `https://www.zyro.lk`, and the approved Firebase Hosting fallback.
- [ ] Set non-secret Functions environment values: `REQUIRE_APP_CHECK=true`,
      `PAYHERE_MODE`, `PAYHERE_MERCHANT_ID`, and `PUBLIC_SITE_URL=https://zyro.lk`.
- [ ] Bind `PAYHERE_MERCHANT_SECRET`, `A2Z_USERNAME`, and `A2Z_PASSWORD` from
      Firebase Secret Manager. Confirm no secret exists in Hosting/Vite variables.
- [ ] Verify PayHere live credentials in the PayHere merchant portal and confirm
      the callback URL is `https://zyro.lk/api/payments/payhere/notify`.
- [ ] Deploy the reviewed Firestore rules first. This blocks any new public
      product write containing commercial fields and enables admin access to
      `product_private`.
- [ ] Run `npm run security:products:dry-run` with Application Default
      Credentials and inspect only the field names/counts reported.
- [ ] Set `PRODUCT_SECURITY_MIGRATION_CONFIRM=zyrolk-e0164`, run
      `npm run security:products:apply`, and retain the verified zero-unsafe result.
- [ ] Re-run the dry-run and require `productsRequiringMigration: 0`.
- [ ] Deploy Firestore indexes and wait until the reservation index reports ready.
- [ ] Deploy Storage rules and verify admin image upload plus unauthenticated media read.
- [ ] Deploy Firebase Functions and verify the `api`, `scheduledSupplierSync`,
      `expirePaymentReservations`, review aggregate, and order notification functions.
- [ ] Verify each deployed Function has its expected Secret Manager bindings.
- [ ] Verify the Trigger Email extension/outbox configuration with a controlled test order.
- [ ] Deploy Hosting only after the App Check site key is present in the built assets.
- [ ] Confirm `/api/payments/config` returns `200`, an allowlisted CORS origin,
      and no merchant secret.
- [ ] Confirm unauthenticated Firestore product reads contain none of the fields
      listed in `COMMERCIAL_PRODUCT_FIELDS`.
- [ ] Confirm an administrator can view and edit the moved commercial fields.
- [ ] Confirm a supplier sees only its own supplier SKU and allowlisted product fields.
- [ ] Monitor Function errors, App Check rejection metrics, expired reservations,
      checkout throttle rejections, email delivery, and payment callbacks.

## Production smoke tests

Run these against the release deployment with dedicated customer, admin, and
supplier test accounts. Automated regression coverage is necessary but does not
replace these credentialed tests.

### Customer

- [ ] Browse homepage, category shelves, search, and product details from live Firestore data.
- [ ] Add/remove wishlist items and verify account synchronization.
- [ ] Restore a persisted cart and complete authenticated and guest checkout.
- [ ] Place one COD order; verify stock becomes `reserved` and the order is pending.
- [ ] Confirm the COD order as admin; verify the reservation becomes `committed`.
- [ ] Place a controlled unconfirmed COD order; verify expiry cancels the order and restores stock once.
- [ ] Verify repeated COD attempts reach the persistent throttle without creating extra orders.
- [ ] Complete PayHere sandbox payment and verify only the signed callback marks it paid.
- [ ] Test failed/cancelled PayHere payment, retry, expiry, and one-time inventory restoration.
- [ ] Verify My Orders totals, coupons, payment timeline, cancellation, and invoice output.

### Admin

- [ ] Load Dashboard, Products, Brands, Categories, Orders, Settings, CMS, and Supplier Hub.
- [ ] Create and edit a product with commercial values; verify public/private document separation.
- [ ] Delete a test product; verify both public and private documents are removed.
- [ ] Approve a supplier item; verify storefront publication and private commercial storage.
- [ ] Update order status and assign a supplier without changing payment or reservation data unexpectedly.

### Supplier

- [ ] Verify missing and pending profiles cannot submit products, stock proposals, or fulfilment changes.
- [ ] Sign in with an active supplier and load dashboard, owned products, orders, and notifications.
- [ ] Create/edit/submit a product request and verify rejection/approval messaging.
- [ ] Verify another supplier's products, orders, profile, requests, and commercial data are inaccessible.

### Notifications and callbacks

- [ ] Verify customer order confirmation, payment confirmation, and status-update emails.
- [ ] Verify admin new-order and payment emails.
- [ ] Confirm duplicate event delivery does not duplicate notification outbox or email records.
- [ ] Replay a PayHere callback and confirm receipt/idempotency protection.
- [ ] Send invalid amount, merchant, signature, and status callbacks and confirm rejection.

## Domain and external-service audit

Read-only checks on 2026-07-19 returned DNS `NXDOMAIN` for both `zyro.lk` and
`www.zyro.lk`. The Firebase fallback `zyrolk-e0164.web.app` resolves, but the
custom-domain configuration cannot be considered ready.

- [ ] Add and verify `zyro.lk` in Firebase Hosting.
- [ ] Add `www.zyro.lk` and choose a single canonical redirect to `https://zyro.lk`.
- [ ] Publish the exact Firebase-provided DNS records; do not proxy them until
      Firebase has issued the custom-domain certificate.
- [ ] Verify valid HTTPS certificates for apex and `www`, including renewal.
- [ ] If Cloudflare is used, select SSL/TLS `Full (strict)`, preserve the Host
      header, bypass cache for `/api/**`, and never cache PayHere callbacks.
- [ ] Verify canonical tags, Open Graph URLs, `robots.txt`, and sitemap URLs use
      the resolving canonical domain.
- [ ] Verify `https://zyro.lk/sitemap.xml` returns the dynamic product sitemap and
      `robots.txt` references the same HTTPS URL.
- [ ] Re-register App Check, Analytics, Firebase Auth authorized domains, and
      PayHere URLs after DNS and certificates are active.

DNS, Firebase project state, Cloudflare zone settings, PayHere merchant status,
and email-extension delivery are external controls and remain blocking until a
release operator verifies them.

## Release notes — v1.0.0

### Security

- Moved supplier ownership, supplier SKU, product costs, market prices, margins,
  commission, internal notes, and commercial metadata out of public products.
- Added Firestore enforcement preventing commercial fields in future public product writes.
- Added admin-only private commercial product storage and a verified migration tool.
- Replaced raw Supplier Portal request payload responses with explicit allowlists.
- Changed missing supplier profiles from implicitly active to fail-closed pending/missing states.
- Changed API CORS and App Check defaults to production allowlist/enforcement behavior.

### Inventory resilience

- Added persistent hashed phone/network throttles for offline checkout attempts.
- Added a one-hour COD/WhatsApp confirmation reservation lifecycle.
- Admin order confirmation commits offline reservations; cancellation or expiry
  restores stock transactionally and idempotently.

### Compatibility

- Storefront product fields, search, ProductCard, cart, checkout request shape,
  orders, Admin UI presentation, Supplier UI presentation, and PayHere contracts remain unchanged.
- Admin and Supplier Hub merge private commercial data without exposing it to customers.

## Rollback guidance

- Roll back Hosting/Functions only to a build that understands `product_private`.
- Do not copy private commercial data back into `products`.
- Firestore rules that reject commercial public fields must remain deployed.
- If a release fault occurs, disable affected admin/supplier operations, retain
  the sanitized public catalogue, and fix forward from the Firestore export and release tag.
