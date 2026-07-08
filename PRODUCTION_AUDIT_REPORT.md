# Zyro.lk Production Readiness Audit Report

Date: 2026-07-08

Scope: Full repository audit of the Zyro.lk React, Express, Firebase, Supplier Hub, checkout, admin, services, rules, deployment config, public assets, and source-of-truth project documents.

This audit does not change application code. It documents current readiness, launch blockers, risks, and recommended next steps.

## Executive Summary

Estimated current production readiness: 68%

Zyro.lk is a substantial, feature-rich e-commerce application with a working customer storefront, cart, checkout flow, admin dashboard, CMS, Firebase integration, product management, order management, and a meaningful Supplier Hub foundation. The core business direction is clear, and the most dangerous historical Supplier Hub bug, direct supplier sync writes to the live `products` collection, is currently fixed in the active `SupplierHubFiveStars` implementation.

The project is not yet launch-ready for a public production launch without targeted fixes. The main blockers are deployment/API parity, admin/auth edge cases, missing automated tests, incomplete durable Supplier Hub queues, Firestore rules mismatch for `supplierHubSettings`, public review/product count write conflicts, SSRF risk in generic supplier fetch endpoints, bundle size, and incomplete SEO/routing.

Build and verification results:

- `npm.cmd run lint`: passed.
- `npm.cmd run build`: passed.
- Build warning: main JS bundle is large, about 1,958.48 kB minified and 503.74 kB gzip.
- Root `npm audit --omit=dev`: 6 moderate vulnerabilities, mainly through `firebase-admin`, `@google-cloud/storage`, `gaxios`, `teeny-request`, and `uuid`.
- Functions `npm audit --omit=dev`: 9 moderate vulnerabilities through `firebase-admin`, `firebase-functions`, `@google-cloud/firestore`, `@google-cloud/storage`, `google-gax`, `gaxios`, `teeny-request`, and `uuid`.
- Test discovery: no test/spec files found.

## Completion Percentage

Overall production readiness: 68%

Estimated completion by area:

- Public storefront: 78%
- Mobile customer experience: 76%
- Checkout and order creation: 78%
- Admin dashboard: 70%
- Product management: 72%
- Authentication and authorization: 62%
- Firebase security rules: 68%
- Supplier Hub: 52%
- Approval workflow: 64%
- Image management: 55%
- SEO and routing: 45%
- Performance: 58%
- Testing and QA automation: 15%
- Deployment readiness: 55%
- Observability and operations: 35%

Remaining work estimate:

- Critical launch blockers: 18%
- High-priority production hardening: 9%
- Medium-priority quality and scale work: 4%
- Low-priority polish and future enhancements: 1%

The project can reach a controlled soft launch after the critical and most high-priority items are completed. A full production launch should include the testing, deployment, security, and observability hardening listed below.

## Complete And Production-Ready

The following areas are materially complete or close enough to production behavior to be considered ready after final QA:

- React/Vite storefront structure with homepage, products, categories, wishlist, contact page, CMS pages, cart drawer, product cards, and product detail modal.
- Firebase client integration for Auth, Firestore, and Storage.
- Public Firestore reads for products, categories, pages, reviews, and settings.
- Admin-only Firestore writes for products, categories, pages, settings, supplier collections, and orders.
- Transaction-based checkout in `server.ts` and `functions/src/index.ts`.
- Server-side checkout pricing, stock validation, delivery fee calculation, order number counter, stock decrement, and order document creation.
- Cart item validation with maximum cart items and maximum quantity per item.
- Product active-state validation during checkout.
- Admin product create/edit/delete flows.
- Admin order status update flow.
- CMS page editing and fallback page content.
- Website settings editing, including branding, contact details, banners, social URLs, delivery charge, and free delivery threshold.
- Storage rules for admin-only uploads to `banners` and `logos`.
- Static SEO basics in `index.html`, `robots.txt`, and `sitemap.xml`.
- Approval workflow invariant in `SupplierHubFiveStars`: supplier sync prepares local payloads and approval writes to `products`; rejection does not write to Firestore.
- Build and TypeScript lint currently pass.

## Partially Complete

The following areas exist and work in some form, but are not yet production-durable:

- Supplier Hub review queue: useful in the current session, but `SupplierHubFiveStars` stores review queue, import queue, pending changes, and sync history mostly in local React state.
- Supplier Hub persistence: `AdminDashboard` has listeners for `supplier_review_queue`, `supplier_import_queue`, `supplier_pending_changes`, and `supplier_sync_history`, but `SupplierHubFiveStars` does not fully persist its active workflow there.
- Approval workflow audit trail: approval writes products, but lacks durable reviewed-by, reviewed-at, source batch, rejection reason, and rollback metadata in the main Supplier Hub flow.
- Multi-supplier support: source model exists, but active sync is still mostly website/A2Z focused.
- Image management services: image validation, queueing, metadata, optimization, and selection modules exist, but are not fully wired into the live Supplier Hub approval process.
- Admin dashboard: broad and feature-rich, but too large and centralized for maintainability; several sections duplicate Supplier Hub behavior.
- Review system: customers can submit reviews, admins can see moderation signals, but product rating updates conflict with Firestore rules and moderation is not fully reliable.
- SEO: base metadata exists, but product/category detail routes, dynamic metadata, and sitemap coverage are missing.
- Routing: page state works in-app, but there is no URL-level route for products, categories, CMS pages, or admin sections.
- Deployment: Firebase Hosting rewrites `/api/checkout` to the checkout function, but does not rewrite `/api/test-supplier` or `/api/fetch-supplier`.

## Incomplete Or Missing

- Automated tests for checkout, Supplier Hub, approval workflow, auth, Firestore rule assumptions, product management, and admin flows.
- Durable Supplier Hub approval queue tied to Firestore.
- Field-level approval for price, stock, images, descriptions, and new products.
- Approval/rejection audit log with actor, timestamp, reason, source, and batch ID.
- Production-safe supplier endpoint allowlist and SSRF protection.
- API auth checks for supplier testing/fetching endpoints in Express.
- Firebase Functions equivalents for `/api/test-supplier` and `/api/fetch-supplier`, or a confirmed full Express deployment target.
- Admin route protection at URL and API level beyond client state and Firestore rules.
- Product/category slugs as actual public URLs.
- Dynamic sitemap generation for products, categories, and CMS pages.
- Error reporting/monitoring.
- Analytics for checkout failures, order conversion, supplier sync results, and admin operations.
- Rate limiting on checkout, supplier endpoints, auth-related workflows, and reviews.
- Input validation/sanitization schema layer for all server endpoints.
- CI pipeline that runs lint, build, and tests.
- Staging environment and production environment separation.
- Backups/export plan for Firestore data.
- Disaster recovery and rollback plan.

## High-Priority Bugs

Critical:

- Firebase Hosting currently rewrites only `/api/checkout` to a function. The Supplier Hub calls `/api/test-supplier` and `/api/fetch-supplier`, but those are only defined in `server.ts`. If deployed only to Firebase Hosting/Functions as configured, Supplier Hub supplier testing and fetching will not work.
- `supplierHubSettings/config` is used by `AdminDashboard`, but `firestore.rules` has no `supplierHubSettings` match. Admin reads/writes to that collection will be denied in production.
- `ProductDetailModal` lets authenticated users create reviews, then attempts to update `products/{productId}` rating and `reviewsCount`. Firestore rules allow review creation by authenticated users but product writes only by admins, so the product rating update will fail for normal customers.
- `AuthModal` attempts to create admin users client-side for `admin@zyro.lk` and `rchi5408@gmail.com`. Firestore rules only allow users to create their own document with role `customer`, so this admin self-assignment will be denied unless bypassed outside rules. It also conflicts with the permanent admin email rule of `zyrolkofficial@gmail.com`.
- Generic supplier endpoints accept arbitrary `websiteUrl`/`endpoint` and server-side fetch them. Without allowlisting and private-network blocking, this is an SSRF risk if endpoints are reachable by unauthorized users or misconfigured deployment.

High:

- `AdminDashboard` assigns missing order numbers from the client using an order list index. Server checkout already creates sequential order numbers through `counters/orders`. The client-side repair path can create inconsistent order numbers if legacy orders exist or if multiple admins are open.
- Supplier approval state in `SupplierHubFiveStars` is local. Browser refresh or admin session loss discards unapproved review items.
- Approved supplier payload includes `approved: true`, `published: true`, and `visible: true` in the payload before approval. It is currently safe because the payload stays local until approval, but the data model is fragile and could regress if a future staging persistence change writes this payload too early.
- `server.ts` supplier endpoints do not verify admin auth. Firestore rules protect supplier source documents, but the HTTP endpoints themselves accept requests if available.
- Customer contact form only shows a local success state and does not persist inquiries, send email, or send notifications.
- Build output has a very large main JS bundle, likely from single-file admin/dashboard code and no route/code splitting.

Medium:

- `CloudinaryUpload` stores unsigned Cloudinary config in localStorage and uses a default cloud name/upload preset. This may be acceptable for an unsigned preset but should be locked down in Cloudinary and moved to admin settings or environment.
- `firebase.ts` deletes existing Firebase app instances on startup, which can be risky in HMR/dev and unnecessary in production.
- `tsconfig.json` uses `allowJs: true` and does not enforce strict mode.
- Extensive `any` usage in admin and supplier code reduces confidence in schema and workflow changes.
- Several UI strings show mojibake/encoding artifacts such as `â€¢`, `Â©`, `ðŸŽ‰`, and `âš ï¸`.
- Root and Functions Firebase Admin dependency versions differ.

## Security Risks

Critical and high risks:

- SSRF risk through generic supplier test/fetch endpoints.
- Supplier test/fetch endpoints lack explicit server-side admin authentication.
- Firebase Hosting only exposes checkout function; supplier endpoint deployment path is unclear.
- Admin self-assignment attempt in `AuthModal` conflicts with rules and could create confusion or insecure future fixes.
- Customer review flow tries to update product aggregate fields directly from the client.
- No rate limiting on checkout, reviews, supplier endpoints, or auth-adjacent operations.
- No request body size limit beyond Express default JSON behavior.
- No schema validation library on server endpoint inputs.
- `onRequest({ cors: true })` plus `Access-Control-Allow-Origin: *` in the checkout function is broad.
- Dependency audit reports moderate vulnerabilities.

Positive security notes:

- Firestore rules protect live products, categories, settings, pages, supplier collections, and order updates with `isAdmin()`.
- User role escalation is blocked in Firestore rules.
- Checkout does not trust client prices or totals.
- Checkout stock decrement and order creation happen in Firestore transactions.
- Storage uploads to `banners` and `logos` are admin-only.
- A2Z credentials were removed from source and are read from environment or admin-only supplier source documents.

## Performance Issues

- Main JS bundle is about 1.96 MB minified and 503 KB gzip. This is high for mobile users.
- `AdminDashboard.tsx` is about 441 KB source and bundled into the main app path instead of lazy-loaded behind admin mode.
- `SupplierHubFiveStars.tsx` is about 148 KB source and also contributes to bundle size.
- `ProductDetailModal.tsx` is about 67 KB source.
- Recharts, Motion, Lucide, admin UI, supplier hub, and storefront appear bundled together.
- Firestore listeners load entire `products`, `categories`, `reviews`, `orders`, supplier queue collections, and users without pagination in admin contexts.
- Product/category counts are calculated with repeated full-array filters in render paths.
- External images are mostly unoptimized remote URLs and not served through a consistent responsive image pipeline.
- Google Fonts are imported in CSS, adding external render dependency.

## Database And Firestore Design Review

Strengths:

- Core collections are recognizable: `products`, `categories`, `orders`, `users`, `settings/website`, `pages`, `reviews`, supplier collections, and `counters/orders`.
- Firestore rules mostly align with public read/admin write requirements.
- Checkout uses `counters/orders` transactionally for order numbering.
- Supplier workflow collections are already named and rule-protected.

Concerns:

- `supplierHubSettings` is used but missing from rules.
- Supplier collections are split between `supplierHub`, `supplierSources`, `supplier_review_queue`, `supplier_import_queue`, `supplier_pending_changes`, `supplier_sync_history`, and `supplier_settings`, but active components do not use them consistently.
- `SupplierHubFiveStars` uses local state for workflow queues while `AdminDashboard` listens to persistent queue collections.
- Product document state fields are inconsistent: `isActive`, `active`, `published`, `approved`, and `visible` appear in supplier payloads, while storefront primarily filters only `isActive !== false`.
- Review aggregation is attempted from the client and conflicts with product write rules.
- Orders contain customer PII and are admin-readable, which is expected, but there is no documented retention/deletion policy.
- Some admin operations read full collections rather than querying by date/status or paginating.

## Supplier Hub Review

Current status: partially complete, not production-durable.

What works:

- Supplier source records are loaded from `supplierSources`.
- Admin can configure supplier source details.
- Server-side A2Z connector exists.
- Sync fetches supplier products through `/api/fetch-supplier`.
- Sync compares supplier products to live products.
- Sync prepares `productPayload` locally and populates local review/import/pending-change state.
- Sync does not directly write fetched supplier products to `products`.
- Approval writes to `products`; rejection does not.

Launch blockers:

- Supplier fetch/test API deployment mismatch with Firebase Hosting.
- Supplier test/fetch endpoints need server-side admin auth and URL allowlisting.
- Review queue is not durable in `SupplierHubFiveStars`.
- Sync history is local in `SupplierHubFiveStars`.
- Pending changes are local in `SupplierHubFiveStars`.
- No durable batch ID or raw supplier snapshot.
- No rejection reason or approval audit trail.
- Product limit is hard-coded to first 5 products, which is safe for testing but incomplete for real operations.
- Image pipeline is not fully integrated into approval.

## Approval Workflow Review

Current status: fixed at the most critical behavioral level, but not complete for production operations.

Correct behavior currently observed:

- `handleSyncSupplier` fetches, filters, maps, compares, and creates local queue items.
- No `setDoc(doc(db, "products"...))` occurs during sync.
- `handleApprovePendingChange` and `handleApproveReviewItem` write the stored payload to `products`.
- `handleRejectPendingChange` and `handleRejectReviewItem` update local state only.

Remaining issues:

- Review item payloads are local state only.
- Pending changes and sync history are not durable in the main Supplier Hub flow.
- Approval has no audit metadata in the product write.
- Approval does not support field-level decisions.
- Approval cannot be recovered after page refresh.
- Approval uses full payload merge, which can overwrite fields the admin may not intend to update.

## Authentication And Authorization Review

Strengths:

- Firebase Auth is used.
- Admin UI checks `zyrolkofficial@gmail.com` or `users/{uid}.role == admin`.
- Firestore rules enforce admin writes.
- User document role escalation is blocked.

Risks:

- `AuthModal` attempts to create admin profiles client-side for `admin@zyro.lk` and `rchi5408@gmail.com`, which Firestore rules should block.
- Google popup fallback suggests demo credential behavior and should not ship as production UX.
- Admin dashboard visibility is client-controlled via `isAdminMode`, with Firestore rules as the real write/read protection. This is acceptable only if all admin data remains rule-protected.
- No server-side auth validation on supplier HTTP endpoints.
- No email verification requirement for customer review creation.
- No custom claims; all admin checks depend on email allowlist or Firestore role reads.

## Admin Dashboard Review

Strengths:

- Broad operational dashboard exists.
- Product, category, order, customer, CMS, settings, and supplier sections are present.
- Live Firestore listeners keep admin data fresh.
- Admin auth gate exists.
- Dashboard has useful metrics and low-stock/order panels.

Risks and gaps:

- `AdminDashboard.tsx` is extremely large, around 441 KB source, making maintenance and testing hard.
- Some Supplier Hub functionality is duplicated or superseded by `SupplierHubFiveStars`.
- `supplierHubSettings` rule mismatch likely breaks a settings path.
- Client-side order number repair should be removed or moved to a controlled migration/server path after approval.
- No pagination for large admin collections.
- No granular roles or permissions.
- No audit log for admin edits/deletes.

## Checkout And Order System Review

Strengths:

- Checkout is server-side and transaction-based.
- Server validates cart item shape, max items, max quantity, product existence, product active status, stock, and price.
- Server recalculates subtotal, delivery fee, free delivery threshold, grand total, and order number.
- Stock decrement is atomic.
- Guest checkout is supported.
- Order success and WhatsApp notification UX exists.

Risks and gaps:

- Checkout endpoint is broad CORS in Functions.
- No rate limiting or abuse protection.
- No phone/email/address format validation beyond presence.
- No idempotency key, so retry/double-click/network replay can create duplicate orders.
- No order confirmation email/SMS/WhatsApp automation from backend.
- No payment gateway or deposit workflow.
- Admin order number repair can conflict with server-generated order numbers for legacy documents.
- Firebase Hosting rewrite only maps `/api/checkout`; Express checkout and Functions checkout can diverge over time unless kept in sync.

## Product Management Review

Strengths:

- Admin can create, edit, duplicate, and delete products.
- SKU generation and duplicate checks exist.
- Product active/draft state exists.
- Product specs, images, cost price, market price, category, featured/new/bestseller flags are supported.
- Storefront handles out-of-stock states and WhatsApp inquiry.

Risks and gaps:

- Product schema has inconsistent status flags.
- Product deletes are hard deletes; no archive/restore flow.
- No validation schema for product documents.
- No image ownership/cleanup when replacing or deleting products.
- No inventory history or stock adjustment audit.
- No bulk import/export.
- No product URL slugs/routes for SEO.

## Image Management Review

Strengths:

- Firebase Storage upload exists for banners and logos.
- Cloudinary upload helper exists for product images.
- Image management service modules exist: validator, selector, queue builder, optimizer, metadata, manager.
- Supplier images are compared and placed in payloads.

Risks and gaps:

- Product image upload path uses Cloudinary unsigned uploads and localStorage config.
- Image management services are not fully wired into the live Supplier Hub workflow.
- No consistent image size/responsive transformation policy.
- No upload file size validation enforcement in Cloudinary component despite UI saying 10MB.
- No malware/content scanning.
- No automatic cleanup of unused media.
- Storage rules only cover `banners` and `logos`.

## SEO And Routing Review

Strengths:

- Static SEO tags exist in `index.html`.
- `robots.txt` exists and disallows `/admin` and `/api/`.
- `sitemap.xml` exists.
- CMS pages exist in app state.

Risks and gaps:

- The app is a client-side SPA with state-based navigation, not real URL routes.
- Product, category, CMS, and admin pages do not have crawlable unique URLs.
- Sitemap only includes the homepage.
- Metadata is static and does not change per product/category/page.
- No structured data for products, organization, breadcrumbs, or reviews.
- No SSR/prerendering.
- `robots.txt` disallows `/admin`, but admin is not a true route.

## Mobile Responsiveness Review

Strengths:

- Mobile bottom nav exists.
- Product grids use responsive columns.
- Product detail modal has mobile sticky purchase actions.
- Cart drawer is full-width on mobile.
- Admin dashboard has mobile menu patterns.

Risks and gaps:

- Admin dashboard is very dense and may be difficult to use on small screens.
- Large modals and rich product detail content need device testing across common Sri Lankan Android/iPhone sizes.
- Text encoding artifacts are visible in several UI strings.
- Heavy animations and large bundle can hurt low-end mobile performance.
- No automated visual regression or responsive screenshot tests.

## UI/UX Review

Strengths:

- Storefront feels polished and conversion-oriented.
- Cart and checkout are understandable.
- Product detail modal is rich, with gallery, specs, related products, reviews, and WhatsApp actions.
- Admin dashboard is comprehensive.
- Empty states and loading skeletons exist.

Risks and gaps:

- Admin UI is complex and may overwhelm operators.
- Some wording is not production-appropriate, for example Google fallback/dev bypass messaging.
- Contact form says inquiry sent but does not actually submit anywhere.
- Encoding artifacts reduce trust.
- Alerts are used in customer-facing paths.
- No dedicated order tracking page for customers.
- No clear post-order backend notification path.

## Code Quality Review

Strengths:

- TypeScript is used and `tsc --noEmit` passes.
- Components are organized by feature.
- Service folders exist for supplier, sync, integration, sandbox, and image management concerns.
- Checkout validation was recently strengthened.

Risks and gaps:

- `AdminDashboard.tsx` and `SupplierHubFiveStars.tsx` are too large.
- Heavy `any` usage in admin, supplier, reviews, and service paths.
- `tsconfig` does not enable strict mode.
- No test suite.
- Duplicated checkout logic in `server.ts` and `functions/src/index.ts`.
- Duplicate/parallel Supplier Hub implementations between `AdminDashboard` and `SupplierHubFiveStars`.
- Some services are architectural scaffolding but not wired into the production flow.
- Many console logs would be noisy in production.

## Technical Debt

- Monolithic admin dashboard component.
- Monolithic Supplier Hub component.
- State-based router instead of URL router.
- Duplicate server/function checkout logic.
- Mismatched supplier collection names and settings collections.
- Inconsistent product status model.
- Local-state approval queues.
- Lack of schema validation and strict typing.
- No automated tests.
- No CI/CD pipeline.
- No observability.
- Encoding/mojibake issues in text content.

## Scalability Concerns

- Full collection listeners for products, reviews, orders, users, and supplier queues will become expensive.
- Admin dashboard computations are array-heavy and done on the client.
- Main bundle includes admin code for all users.
- Supplier sync runs client-initiated and fetches through HTTP request/response flows.
- Sequential order counter can become a contention point at high order volume, though acceptable for early launch.
- No background worker/queue for supplier sync, image downloads, or scheduled tasks.
- No caching strategy for public catalog.

## Suggested Architecture Improvements

Recommended direction:

- Keep the existing architecture for launch, but add guardrails instead of rewriting.
- Add React Router or equivalent route layer incrementally.
- Lazy-load admin dashboard and Supplier Hub.
- Move supplier sync/fetch/approval persistence to server-side functions or trusted backend APIs.
- Persist Supplier Hub queues to existing admin-only queue collections.
- Add a shared checkout validation module to avoid drift between Express and Functions.
- Add Firestore schema/types for product, supplier queue, order, review, settings, and user documents.
- Add Zod or similar runtime validation for API requests and supplier payloads.
- Add an admin audit log collection after explicit approval.
- Add CI for lint, build, tests, and dependency audit.
- Add monitoring/logging for checkout failures, supplier sync failures, and admin writes.

## Features To Add Before Launch

Critical before public launch:

- Fix deployed API parity for Supplier Hub or disable Supplier Hub in production until deployed safely.
- Add server-side admin auth and URL allowlisting to supplier endpoints.
- Add Firestore rule for `supplierHubSettings` or migrate code to existing approved collection.
- Fix review aggregate update conflict.
- Remove production demo/dev auth fallback messaging.
- Add at least focused tests for checkout and approval invariant.
- Add customer/order notification path.
- Add contact inquiry persistence or clearly convert it to WhatsApp-only.
- Add rate limiting and input validation to server endpoints.

High before launch:

- Persist Supplier Hub review/import/pending/sync history in Firestore.
- Add approval audit fields.
- Add idempotency or double-submit protection for checkout.
- Code split admin dashboard and Supplier Hub.
- Fix mojibake/encoding artifacts.
- Expand sitemap and routing strategy.
- Add dependency vulnerability resolution plan.

## Features That Can Wait Until After Launch

- Field-level supplier approvals.
- Multi-supplier conflict resolution.
- Scheduled supplier sync.
- Full image optimization pipeline.
- Advanced analytics dashboards.
- Role-based admin permissions beyond admin/customer.
- Product recommendations.
- Payment gateway integration.
- Advanced inventory forecasting.
- Server-side rendering or full prerendering, if initial SEO is acceptable for soft launch.
- Bulk import/export tools.
- Automated rollback for supplier approvals.

## Final Production Readiness Judgment

Zyro.lk is a strong pre-launch build, not a fully production-hardened system yet.

Recommended launch posture:

- Do not launch broadly until all Critical tasks in `PRIORITY_ROADMAP.md` are complete.
- A private admin/customer pilot is reasonable after API deployment parity, auth/rules mismatches, and review/product write conflicts are resolved.
- A public launch is reasonable after Critical plus most High tasks are complete, especially tests, rate limiting, queue durability, and performance/code splitting.
