# Zyro.lk Go-Live Checklist

Date: 2026-07-09

Use this checklist as the final operational gate before a Zyro.lk production launch. Do not launch publicly until every Critical and High item is either complete or explicitly accepted by the project owner.

## Infrastructure Checklist

### Critical

- [ ] Confirm production domain points to Firebase Hosting.
- [ ] Confirm HTTPS certificate is active for `zyro.lk` and `www.zyro.lk`.
- [ ] Confirm Firebase Hosting serves the latest `dist` build.
- [ ] Confirm `/api/**` rewrites to the single modular Firebase HTTPS Function named `api`.
- [ ] Confirm Firebase Functions deploy successfully from `functions/`.
- [ ] Confirm Functions runtime uses Node.js 20 as declared in `functions/package.json`.
- [ ] Confirm production Firebase project ID is correct before deploy.

### High

- [ ] Confirm no `.env`, service account key, supplier password, or Firebase private key is committed.
- [ ] Confirm Cloud Logging is enabled for Functions.
- [ ] Confirm billing and quota alerts are enabled in Google Cloud/Firebase.
- [ ] Confirm Firebase Hosting rollback target is available from the previous successful release.

### Medium

- [ ] Confirm `public/robots.txt`, `public/sitemap.xml`, and `public/manifest.json` match production URLs.
- [ ] Confirm static assets such as favicon and logo load from production Hosting.

## Firebase Checklist

### Critical

- [ ] Deploy `firestore.rules`.
- [ ] Deploy `storage.rules`.
- [ ] Confirm Firestore collections exist or can be created by the app as needed:
  - `products`
  - `categories`
  - `orders`
  - `users`
  - `settings`
  - `pages`
  - `reviews`
  - `supplierSources`
  - `supplier_settings`
  - `supplier_review_queue`
  - `supplier_import_queue`
  - `supplier_pending_changes`
  - `supplier_sync_history`
  - `supplier_approval_audit`
  - `supplier_sync_locks`
  - `checkout_idempotency`
- [ ] Confirm `settings/website` exists with production store, delivery, contact, and branding settings.
- [ ] Confirm `supplier_settings/config` exists before enabling scheduled sync.
- [ ] Confirm the admin user document has `role: "admin"` or uses the approved admin email.

### High

- [ ] Confirm Firebase Auth email/password provider is enabled if customer registration/login is expected at launch.
- [ ] Confirm Firestore indexes in the Firebase console show no missing-index errors after smoke testing.
- [ ] Confirm Storage bucket exists and allows the `banners/` and `logos/` paths.
- [ ] Confirm scheduled function `scheduledSupplierSync` is deployed and visible in Cloud Scheduler / Functions.
- [ ] Confirm review aggregate trigger `syncReviewAggregates` is deployed.

### Medium

- [ ] Seed minimum viable products, categories, CMS pages, and website settings.
- [ ] Confirm supplier sources are configured only for approved domains.
- [ ] Confirm supplier credentials are stored only in server-side environment variables or admin-only Firestore documents.

## Security Checklist

### Critical

- [ ] Confirm Firestore rules reject non-admin writes to `products`, `categories`, `settings`, `pages`, and supplier collections.
- [ ] Confirm customers can create/manage only their own review documents.
- [ ] Confirm customers cannot write `products.rating` or `products.reviewsCount` directly.
- [ ] Confirm `checkout_idempotency` is unreadable and unwritable from clients.
- [ ] Confirm Storage rules allow public reads but admin-only writes for `banners/` and `logos/`.
- [ ] Confirm supplier endpoints require a Firebase ID token and admin authorization.
- [ ] Confirm SSRF protection blocks localhost, private IP ranges, link-local addresses, and metadata endpoints.
- [ ] Confirm checkout totals, stock validation, delivery fees, order numbers, and stock decrement are calculated server-side.

### High

- [ ] Configure production `API_ALLOWED_ORIGINS`, recommended:

```text
https://zyro.lk,https://www.zyro.lk
```

- [ ] Confirm `ADMIN_EMAIL` is set or default admin identity is intentionally accepted.
- [ ] Confirm no raw backend exception, token, password, cookie, or supplier credential is exposed to clients.
- [ ] Confirm checkout rate limiting returns HTTP 429 on rapid repeated attempts.
- [ ] Confirm checkout idempotency returns the original order for the same idempotency key.

### Medium

- [ ] Review Firebase Auth authorized domains.
- [ ] Review Firebase App Check decision for post-launch hardening.
- [ ] Review admin account MFA policy outside the codebase.

## Feature Smoke Checklist

### Customer

- [ ] Customer registration works.
- [ ] Customer login works.
- [ ] Product browsing works.
- [ ] Search and filtering work.
- [ ] Wishlist add/remove works.
- [ ] Cart add/update/remove/clear works.
- [ ] Checkout creates one order and decrements stock.
- [ ] Duplicate checkout with the same idempotency key does not create a second order.
- [ ] Customer review creation works.
- [ ] Product rating and review count update through the backend trigger.

### Admin

- [ ] Admin login works.
- [ ] Admin dashboard loads.
- [ ] Product management loads and saves admin changes.
- [ ] Order management loads and updates order status.
- [ ] CMS pages load and save.
- [ ] Website settings load and save.
- [ ] Banner/logo uploads to Firebase Storage work.
- [ ] Supplier Hub loads sources and settings.
- [ ] Manual supplier test works for approved suppliers.
- [ ] Manual supplier sync creates queue items without writing products.
- [ ] Approval writes the queued product to `products`.
- [ ] Rejection removes queue items without writing products.
- [ ] Approval/rejection audit records are created.
- [ ] Sync history records manual and scheduled activity.

### Background Jobs

- [ ] Scheduled supplier sync respects `autoSyncEnabled`.
- [ ] Scheduled supplier sync writes only to supplier queue/history collections.
- [ ] Scheduled supplier sync lock prevents concurrent executions.
- [ ] Review aggregate trigger updates product rating and review count.

## Backup Checklist

### Critical

- [ ] Export Firestore before launch.
- [ ] Capture current Firebase Hosting release version before deploying.
- [ ] Export or document production `settings/website`.
- [ ] Export supplier source configuration without exposing credentials in shared documents.

### High

- [ ] Confirm Firestore point-in-time recovery or scheduled export strategy.
- [ ] Confirm Storage bucket backup strategy for banners/logos.
- [ ] Store rollback instructions with project owner access.

## Monitoring Checklist

### Critical

- [ ] Monitor Function errors for `api`, `scheduledSupplierSync`, and `syncReviewAggregates`.
- [ ] Monitor checkout failures and order creation volume.
- [ ] Monitor supplier sync errors and skipped runs.
- [ ] Monitor Firestore permission-denied errors after launch.

### High

- [ ] Configure alerts for elevated Function error rate.
- [ ] Configure alerts for unusual checkout 429 rate.
- [ ] Configure alerts for Firestore/Functions quota pressure.
- [ ] Review Firebase Hosting traffic and 404s.

### Medium

- [ ] Review Core Web Vitals after real user traffic begins.
- [ ] Review search analytics and product conversion behavior after soft launch.

## Launch Day Checklist

### Critical

- [ ] Pull latest `origin/main`.
- [ ] Run local verification:

```powershell
npm.cmd run lint
npm.cmd run build
cd functions
npm.cmd run build
cd ..
npm.cmd test
git diff --check
```

- [ ] Deploy Firestore rules.
- [ ] Deploy Storage rules.
- [ ] Deploy Functions.
- [ ] Deploy Hosting.
- [ ] Smoke test customer and admin flows.
- [ ] Place one real or controlled test checkout order.
- [ ] Verify order appears in Admin Dashboard.
- [ ] Verify stock decrement.
- [ ] Verify Supplier Hub queue/approval/rejection behavior in production.

### High

- [ ] Watch logs for the first 60 minutes.
- [ ] Keep the previous Firebase Hosting release available for rollback.
- [ ] Keep supplier auto sync disabled until manual supplier workflow is confirmed in production.

## Rollback Checklist

### Critical

- [ ] If storefront is broken, roll back Firebase Hosting to the previous release.
- [ ] If API is broken, redeploy the previous known-good Functions build from the previous commit.
- [ ] If Firestore rules block production traffic incorrectly, redeploy the previous known-good rules file.
- [ ] If supplier sync misbehaves, disable `supplier_settings/config.autoSyncEnabled`.
- [ ] If checkout misbehaves, stop public traffic and preserve failed order/log evidence before making fixes.

### High

- [ ] Record incident timeline.
- [ ] Preserve logs and affected order IDs.
- [ ] Verify rollback by rerunning customer browse/cart/checkout and admin login smoke tests.
- [ ] Communicate launch pause or rollback status before reattempting launch.
