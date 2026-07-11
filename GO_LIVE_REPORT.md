# Zyro.lk Go-Live Readiness Report

Date: 2026-07-11

Scope: Sprint 24 final production validation

Baseline: Sprint 23 storefront commit `21e42cf`

## Executive Summary

Zyro.lk is **conditionally ready for production launch** with a readiness score of **90/100**. The storefront, builds, automated business-critical tests, Firebase configuration, security controls, responsive layout, and accessibility presentation have been validated without changing application architecture or business logic.

Launch approval should remain conditional until the production owner completes the environment checklist and performs credentialed smoke tests against the deployed project. In particular, production API origins must be configured explicitly, required supplier credentials must be supplied through the production runtime, and a populated product must be used to validate the live order journey.

## Production Configuration Review

| Area | Result | Evidence / action |
| --- | --- | --- |
| Firebase project | Pass | `.firebaserc` targets `zyrolk-e0164`. Confirm this is the intended production project before deployment. |
| Firebase Hosting | Pass | Hosting serves `dist`; `/api/**` rewrites to the `api` Function; remaining paths rewrite to `index.html`. |
| Functions exports | Pass | `api`, `syncReviewAggregates`, and `scheduledSupplierSync` are exported from `functions/src/index.ts`. |
| Firestore rules | Static pass; emulator pending | Public catalog/settings/pages reads, owner-scoped customer data, admin writes, supplier restrictions, and backend-only checkout idempotency are represented in source. The local emulator could not start because Java is unavailable; validate in a Java-enabled deployment environment before rules deployment. |
| Firestore indexes | Non-blocking | No `firestore.indexes.json` is present. Current reviewed queries use simple collection reads or single-field filters and do not demonstrate a composite-index requirement. |
| Storage rules | Pass | Public reads and admin-only writes are limited to `banners/` and `logos/`; unmatched paths are denied. |
| Environment template | Updated | `.env.example` now documents placeholders for admin identity, API origin allowlisting, supplier allowlisting/credentials, Gemini, application URL, and Cloudinary. No real secrets are committed. |
| API configuration | Conditional | `API_ALLOWED_ORIGINS` must be set in production. If omitted, the current compatibility mode permits wildcard CORS. |

### Production Environment Checklist

- Set `ADMIN_EMAIL` to the approved production administrator.
- Set `API_ALLOWED_ORIGINS` to the exact HTTPS storefront origin(s).
- Set `APP_URL` to the canonical production URL.
- Set `ALLOWED_SUPPLIER_DOMAINS` if an additional runtime supplier allowlist is required.
- Configure `A2Z_USERNAME` and `A2Z_PASSWORD` only in the production runtime or approved protected supplier configuration.
- Configure `GEMINI_API_KEY` through the approved secret/runtime mechanism.
- Configure the Cloudinary cloud name and a restricted unsigned upload preset.
- Confirm the Firebase project and Hosting channel before any deploy command.
- Never copy placeholder values from `.env.example` into production unchanged.

## End-to-End Smoke-Test Matrix

| Flow | Result | Notes |
| --- | --- | --- |
| Home and navigation | Pass | Desktop, tablet, and mobile layouts were validated during final storefront QA. |
| Search and suggestions | Pass | Existing search UI, keyboard navigation, empty states, and navigation behavior were visually validated. Search algorithms were not changed. |
| Categories and filters | Pass | Category navigation, zero-data presentation, filter drawer, and responsive behavior were validated. |
| Product cards | Partial | Presentation and interaction controls were validated previously. The local live catalog returned zero products during final validation. |
| Product Detail | Partial | Component build and static accessibility review passed; a live product-dependent modal smoke test requires populated production/staging data. |
| Wishlist | Pass for empty state | Navigation and empty-state presentation passed. A populated authenticated wishlist requires a credentialed production smoke test. |
| Cart | Pass for empty state and automated logic | Drawer semantics and empty state passed. Checkout calculation and validation are covered by automated tests. |
| Checkout and order creation | Automated pass / live pending | Validation, totals, idempotency, and rate limiting passed automated tests. Create one controlled production/staging order before public launch. |
| Login and registration | Presentation pass / live pending | Dialog semantics, labels, focus styling, and responsive presentation passed. Firebase credential flows were not exercised with real credentials. |
| Admin Dashboard | Build pass / live pending | Lazy-loaded bundle builds successfully. Credentialed Dashboard, Products, Orders, Settings, and permissions require production-admin QA. |
| Supplier Hub and approval queue | Automated security pass / live pending | Admin authorization, SSRF protection, queue approval/rejection behavior, audit writes, and product-write regression tests passed. External supplier connectivity was not invoked. |
| Reviews | Pass | Aggregate creation/update/deletion behavior and rejected/invalid review handling passed automated tests. |
| CMS and Contact | Pass | Responsive rendering, CMS readability, form semantics, and contact presentation passed. |
| WhatsApp ordering | Configuration dependent | Buttons and presentation are present; final destination depends on the production `whatsappNumber` setting. |

## Security Validation

Automated validation covers:

- Supplier endpoint administrator authorization.
- Blocking localhost, private IP, invalid protocol, and non-allowlisted supplier targets.
- Checkout cart/request validation.
- Checkout idempotency and mismatched-key rejection.
- Checkout request rate limiting.
- Review aggregate recalculation after create, update, and delete operations.
- Ignoring rejected and invalid reviews in product aggregates.
- Supplier approval audit writes and queue cleanup.
- Prevention of direct product writes during supplier synchronization.

Remaining security considerations:

- Configure `API_ALLOWED_ORIGINS`; wildcard compatibility mode should not be the production default.
- Confirm production Firebase Auth authorized domains and administrator claims/documents.
- Confirm supplier credentials exist only in approved runtime secrets or protected Firestore documents.
- Perform a rules deployment/emulator check as part of the controlled deployment pipeline.
- Review production logs after the controlled checkout and supplier smoke tests for sanitized error output.

## Performance Validation

Latest production build measurements:

| Chunk | Minified | Gzip |
| --- | ---: | ---: |
| Firebase | 731.86 KB | 182.30 KB |
| Charts | 393.93 KB | 112.95 KB |
| React vendor | 367.16 KB | 113.74 KB |
| Admin Dashboard | 211.56 KB | 40.87 KB |
| Main storefront | 109.53 KB | 26.37 KB |
| Supplier Hub | 94.90 KB | 17.08 KB |
| Product Detail | 44.91 KB | 10.93 KB |

Observations:

- Vite reports the Firebase chunk above its 500 KB warning threshold.
- Admin, Supplier Hub, charts, Product Detail, Cart, Authentication, Contact, and CMS code are separated from the primary storefront through established lazy-loading boundaries.
- Product and category images use native lazy loading and asynchronous decoding where appropriate; the hero remains the intentional critical image.
- No performance regression requiring architectural work was identified during this validation sprint.
- A production Lighthouse run should be captured after deployment because network latency, CDN caching, Firebase region, real images, and third-party services cannot be represented accurately by the local build alone.

## Accessibility Validation

- Focus-visible treatments are present on primary storefront controls.
- Carousel controls expose accessible labels and current-slide semantics.
- Cart and authentication surfaces expose dialog semantics.
- Contact and authentication fields have programmatic labels.
- Newsletter and inquiry status feedback use live-region semantics.
- Mobile controls use minimum touch targets where reviewed.
- Reduced-motion styling is present, and the CMS page remains readable when reduced motion or a dark operating-system preference is active.
- Exact responsive widths previously checked: 320, 360, 390, 414, 768, 820, 1024, 1280, and 1440 pixels.

## Remaining Non-Blocking Issues

1. The Firebase vendor chunk remains large, although it is expected for the client Firebase SDK and does not block launch.
2. Live Product Detail, populated wishlist/cart, checkout order creation, and administrator journeys require seeded staging or controlled production data.
3. External Supplier Hub connectivity requires approved credentials and must not be tested against production suppliers without operational authorization.
4. No committed composite-index manifest exists; add one only when a verified query requires a composite index.
5. Production Lighthouse metrics remain deployment-dependent.

## Launch Recommendation

**Conditional GO.** Proceed with a controlled production deployment after the environment checklist is complete. Use a preview/temporary Hosting channel where available, confirm the Firebase target, then complete one credentialed administrator walkthrough and one controlled customer order before announcing the storefront publicly.

## Rollback Considerations

- Record the deployed Git commit and Firebase release identifiers before launch.
- Firebase Hosting can be rolled back to the previous known-good release from the Firebase console/CLI release history.
- Restore the previous Functions revision if API or trigger behavior regresses.
- Revert the release commit rather than rewriting Git history.
- Treat Firestore/Storage rule rollback separately from application rollback and validate the target project before deployment.
- Do not delete customer orders, reviews, supplier audit records, or schema data as part of an application rollback.
- Preserve checkout idempotency records across application rollbacks.

## Final Verification Record

Final results:

- `npm.cmd run lint`: passed.
- `npm.cmd test`: passed, 18/18 tests.
- `npm.cmd run build`: passed with the documented Firebase chunk-size warning.
- `npm.cmd run build` from `functions/`: passed.
- `git diff --check`: passed.
- Firestore emulator rules load: not completed because Java is not installed in the validation environment. No Firebase state was changed.
