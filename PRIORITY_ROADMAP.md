# Zyro.lk Priority Roadmap

Date: 2026-07-08

This roadmap ranks remaining work by launch impact. It should be used with `MASTER_PROJECT.md` and `PRODUCTION_AUDIT_REPORT.md`.

## Remaining Work Summary

Estimated remaining work to public production launch: 32%

Breakdown:

- Critical: 18%
- High: 9%
- Medium: 4%
- Low: 1%

Completion target:

- Current readiness: 68%
- Soft launch readiness target: 85%
- Public launch readiness target: 95%
- Post-launch maturity target: 100%

## Critical Tasks

Critical tasks block public launch or can cause broken core workflows, security exposure, or production data integrity problems.

1. Fix Supplier Hub API deployment parity
   - Problem: Firebase Hosting rewrites only `/api/checkout`, but Supplier Hub calls `/api/test-supplier` and `/api/fetch-supplier`.
   - Recommended approach: Add approved Firebase Functions or deploy the full Express server behind the same domain.
   - Estimated remaining work: 3%

2. Add server-side admin authentication to supplier endpoints
   - Problem: Supplier test/fetch endpoints do not verify admin identity at the HTTP layer.
   - Recommended approach: Require Firebase ID token, verify with Admin SDK, and check admin role/email before supplier requests.
   - Estimated remaining work: 2%

3. Add supplier URL allowlisting and SSRF protection
   - Problem: Generic supplier fetch accepts arbitrary URLs.
   - Recommended approach: Only fetch URLs from admin-approved `supplierSources`; block localhost, private IP ranges, metadata IPs, and non-http/https protocols.
   - Estimated remaining work: 2%

4. Resolve `supplierHubSettings` Firestore rules mismatch
   - Problem: `AdminDashboard` reads/writes `supplierHubSettings/config`, but rules do not allow that collection.
   - Recommended approach: Either add approved rules for `supplierHubSettings` or migrate that data into `supplier_settings/config`.
   - Estimated remaining work: 1%

5. Fix customer review aggregate write conflict
   - Problem: Customer review creation is allowed, but updating product `rating` and `reviewsCount` is admin-only and will fail for customers.
   - Recommended approach: Move product aggregate updates to a trusted backend function or Cloud Function trigger.
   - Estimated remaining work: 2%

6. Remove production demo/dev auth fallback behavior
   - Problem: Google login fallback mentions a developer bypass and demo credentials.
   - Recommended approach: Replace with production-safe messaging and no credential injection.
   - Estimated remaining work: 1%

7. Persist Supplier Hub review queue durably
   - Problem: Main Supplier Hub review items are local state only.
   - Recommended approach: Use existing admin-only `supplier_review_queue`, `supplier_import_queue`, `supplier_pending_changes`, and `supplier_sync_history` collections after explicit implementation approval.
   - Estimated remaining work: 3%

8. Add minimum launch tests
   - Problem: No test/spec files exist.
   - Recommended approach: Add focused tests for checkout validation, order total calculation, approval invariant, and Firestore-rule-sensitive assumptions.
   - Estimated remaining work: 2%

9. Add checkout double-submit protection
   - Problem: Repeated POSTs can create duplicate orders.
   - Recommended approach: Add an idempotency key from client or server-side duplicate guard per cart/customer/time window.
   - Estimated remaining work: 1%

10. Add endpoint input validation and rate limiting
    - Problem: Checkout and supplier APIs lack a formal validation/rate-limit layer.
    - Recommended approach: Add runtime schemas and lightweight rate limiting at server/function boundary.
    - Estimated remaining work: 1%

## High Priority Tasks

High tasks should be completed before public launch unless the launch is intentionally limited.

1. Add approval audit fields
   - Add reviewedBy, reviewedAt, sourceId, batchId, raw snapshot reference, and rejectionReason.
   - Estimated remaining work: 1%

2. Fix product status model consistency
   - Standardize `isActive`, `approved`, `published`, `visible`, and `active` usage.
   - Recommended approach: Keep `isActive` as storefront gate for now; document/migrate other flags carefully.
   - Estimated remaining work: 1%

3. Code split admin dashboard and Supplier Hub
   - Current build ships a large admin dashboard to all users.
   - Estimated remaining work: 1.5%

4. Resolve dependency audit findings
   - Root audit: 6 moderate vulnerabilities.
   - Functions audit: 9 moderate vulnerabilities.
   - Recommended approach: Upgrade dependency trees carefully; do not use forced downgrade blindly.
   - Estimated remaining work: 1%

5. Fix text encoding artifacts
   - Replace mojibake strings such as `â€¢`, `Â©`, and broken emoji sequences.
   - Estimated remaining work: 0.75%

6. Add production contact inquiry handling
   - Current contact form only displays local success.
   - Recommended approach: Persist inquiry or route all inquiries through WhatsApp/email clearly.
   - Estimated remaining work: 0.75%

7. Add customer order tracking basics
   - Allow customers to view order confirmation/status by order number or authenticated account.
   - Estimated remaining work: 1%

8. Remove client-side order number repair
   - Server checkout already generates order numbers.
   - Recommended approach: Use a one-time migration for legacy orders if needed, not admin render-time writes.
   - Estimated remaining work: 0.5%

9. Add CI verification
   - Run lint, build, tests, and optionally audit on push.
   - Estimated remaining work: 0.5%

## Medium Priority Tasks

Medium tasks improve quality, scalability, SEO, and maintainability.

1. Add URL routing
   - Add routes for home, products, categories, CMS pages, product detail, wishlist, contact, and admin.
   - Estimated remaining work: 1%

2. Expand sitemap and SEO metadata
   - Generate product/category/CMS sitemap entries.
   - Add dynamic title/description where possible.
   - Estimated remaining work: 0.75%

3. Add structured data
   - Product, organization, breadcrumb, and review schema.
   - Estimated remaining work: 0.5%

4. Refactor `AdminDashboard.tsx`
   - Split into focused modules without behavior changes.
   - Estimated remaining work: 1%

5. Refactor `SupplierHubFiveStars.tsx`
   - Split into source management, sync/review, approval, settings, and queue components.
   - Estimated remaining work: 1%

6. Add stronger TypeScript strictness
   - Reduce `any`, introduce shared Firestore document types, and consider strict mode incrementally.
   - Estimated remaining work: 0.75%

7. Add image upload validation
   - Enforce size/type limits and standard image transformations.
   - Estimated remaining work: 0.5%

8. Add observability
   - Log checkout failures, supplier sync failures, admin writes, and frontend errors.
   - Estimated remaining work: 0.5%

## Low Priority Tasks

Low tasks can wait until after launch.

1. Field-level supplier approvals
   - Allow admins to approve price, stock, image, and description independently.

2. Scheduled supplier sync
   - Add only after durable queues and audit logging are complete.

3. Multi-supplier conflict resolution
   - Add source priority, margin rules, and conflict policy.

4. Full image optimization pipeline
   - Wire image optimizer and selector services into live supplier import.

5. Advanced analytics
   - Add margin, stock aging, supplier reliability, and approval throughput dashboards.

6. Role-based admin permissions
   - Add roles such as inventory manager, order manager, content editor, and super admin.

7. Payment gateway integration
   - Add card/bank/deposit flows after COD launch is stable.

8. Product recommendation engine
   - Add personalized or category-based recommendations.

9. Bulk import/export tools
   - Add CSV/XLSX product and order workflows.

10. SSR or prerendering
    - Consider if SEO performance matters beyond static SPA metadata.

## Recommended Implementation Order

Phase 1: Production safety gate

1. Fix Supplier Hub API deployment parity.
2. Add supplier endpoint admin auth.
3. Add supplier URL allowlisting and SSRF protection.
4. Resolve `supplierHubSettings` rules mismatch.
5. Fix review aggregate write conflict.
6. Remove demo/dev auth fallback.

Phase 2: Data durability and tests

1. Persist Supplier Hub queues.
2. Add approval audit fields.
3. Add minimum checkout and approval tests.
4. Add checkout idempotency.
5. Add input validation and rate limiting.

Phase 3: Launch quality

1. Code split admin and Supplier Hub.
2. Fix encoding artifacts.
3. Add contact inquiry handling.
4. Add customer order tracking.
5. Resolve dependency audit findings.
6. Add CI.

Phase 4: SEO and maintainability

1. Add URL routing.
2. Expand sitemap and metadata.
3. Refactor large admin/supplier files.
4. Improve TypeScript strictness.
5. Add observability.

## Trade-Off Notes

Supplier Hub durability:

- Option A: Persist current `productPayload` in existing `supplier_review_queue`.
  - Pros: Fastest path, uses existing collections.
  - Cons: Must be careful because payload already contains live flags like `approved: true`.
  - Recommendation: Use this only with explicit `status: Pending` queue wrapper and never read queue docs as live products.

- Option B: Add a dedicated staging collection.
  - Pros: Cleaner separation from review queue.
  - Cons: Requires Firebase schema/rules approval.
  - Recommendation: Consider later if review queue payloads become too large or complex.

Deployment:

- Option A: Add Functions for supplier APIs.
  - Pros: Fits current Firebase Hosting deployment.
  - Cons: Duplicate code unless shared modules are extracted.
  - Recommendation: Best near-term if Firebase is the production host.

- Option B: Deploy full Express server.
  - Pros: Existing endpoints work as-is.
  - Cons: Requires hosting/runtime decisions outside Firebase Hosting rewrites.
  - Recommendation: Good if the project already has a Node hosting target.

Routing/SEO:

- Option A: Add React Router only.
  - Pros: Fast, improves shareable URLs.
  - Cons: Still SPA metadata unless supplemented.
  - Recommendation: Good first step.

- Option B: Add SSR/prerendering.
  - Pros: Better SEO.
  - Cons: Larger architecture change.
  - Recommendation: Wait unless organic product SEO is a launch-critical requirement.

## Launch Gate Checklist

Minimum before public launch:

- Critical tasks complete.
- `npm.cmd run lint` passes.
- `npm.cmd run build` passes.
- Checkout happy path manually verified.
- Checkout stock failure manually verified.
- Supplier sync does not write to `products`.
- Supplier approval writes to `products`.
- Supplier rejection does not write to `products`.
- Admin product create/edit/delete verified.
- Order status update verified.
- Customer auth/register/sign-in verified.
- Reviews verified after aggregate-write fix.
- Firestore rules deployed and verified.
- Storage rules deployed and verified.
- GitHub `origin/main` contains final launch commit.
- Working tree clean.
