# Zyro.lk Launch Report

Date: 2026-07-09

## Executive Summary

Zyro.lk is ready for a controlled soft launch after final production environment configuration and live smoke testing. The architecture, checkout hardening, Supplier Hub approval workflow, scheduled sync foundation, security rules, CI checks, and launch documentation are in place.

Recommended launch decision:

- Soft launch: approved after launch checklist completion.
- Public launch: approved after 3-7 days of stable soft-launch monitoring.

No critical launch blocker was found during Sprint 15.

## Overall Production Readiness Score

Overall score: 88/100

This score reflects strong architecture, checkout safety, Supplier Hub workflow protection, security rules, automated tests, and documentation, with deductions for operational items that must be completed in the live Firebase project and residual dependency audit findings that currently require upstream Firebase/Google package compatibility.

## Production Readiness Scores

| Area | Score | Status | Notes |
| --- | ---: | --- | --- |
| Architecture | 92/100 | Ready | Approved hybrid architecture is implemented: Firebase Hosting routes `/api/**` to one modular Express API Function, with background Functions for scheduled sync and review aggregation. |
| Security | 86/100 | Ready with conditions | Firestore/Storage rules, admin supplier auth, SSRF protection, checkout validation, rate limiting, idempotency, and centralized logging are present. Configure `API_ALLOWED_ORIGINS` before public launch. |
| Performance | 88/100 | Ready | Sprint 13 reduced initial app bundle by lazy-loading admin/customer secondary modules. Firebase vendor chunk remains large but split from the app entry. |
| Supplier Hub | 87/100 | Soft-launch ready | Durable queues, admin auth, SSRF protection, audit trail, scheduled sync, and multi-supplier foundation are in place. Field-level approvals and backend approval endpoint can wait. |
| Checkout | 94/100 | Ready | Server-side transaction, stock validation, sequential order numbering, validation, idempotency, and rate limiting are implemented and tested. |
| Admin | 84/100 | Ready with live smoke test | Admin dashboard, CMS, website settings, orders, products, and Supplier Hub are implemented. Live Firebase Storage upload should be confirmed before public launch. |
| Testing | 82/100 | Good | Automated tests cover checkout, review aggregates, supplier security, SSRF, queue persistence, approval, rejection, and audit behavior. Browser E2E tests are still recommended post-launch. |
| Deployment | 84/100 | Ready with environment checks | Firebase Hosting/Functions config and GitHub Actions CI exist. Live deploy, Scheduler visibility, domain/cert, and env vars must be confirmed by the launch checklist. |
| Documentation | 94/100 | Ready | Master project context, production audit, hardening report, roadmap, go-live checklist, and launch report exist. |

## Completed Architecture Summary

The current production architecture is:

```text
Firebase Hosting
  -> /api/**
    -> One modular Express API hosted as Firebase HTTPS Function `api`

Background Firebase Functions:
  -> scheduledSupplierSync
  -> syncReviewAggregates
```

Implemented production capabilities:

- React/Vite storefront with code-split customer/admin modules.
- Firebase Auth-backed customer and admin flows.
- Firestore-backed products, categories, users, orders, settings, CMS pages, reviews, supplier sources, queues, audit records, and sync history.
- Checkout API with server-side validation, totals, stock checks, idempotency, rate limiting, and sequential order numbers.
- Supplier Hub API protected by Firebase ID token admin authentication.
- Supplier URL allowlisting and SSRF protection.
- Durable supplier queues:
  - `supplier_review_queue`
  - `supplier_import_queue`
  - `supplier_pending_changes`
  - `supplier_sync_history`
- Supplier approval audit collection:
  - `supplier_approval_audit`
- Scheduled supplier sync with Firestore lock:
  - `supplier_sync_locks`
- Review aggregate backend trigger.
- GitHub Actions CI for lint, build, Functions build, and tests.
- Centralized sanitized Functions logging and API security headers.

## End-To-End Audit Results

### Customer Flows

| Flow | Status | Evidence |
| --- | --- | --- |
| Customer registration/login | Ready for live smoke test | Auth UI and Firestore user rules are present. Requires live Firebase Auth provider confirmation. |
| Product browsing | Ready | Storefront reads public `products` and categories. Root build passes. |
| Search/filter | Ready | Storefront search/filter code is present and TypeScript build passes. |
| Wishlist | Ready | Wishlist behavior is implemented in the React app and tied to customer state/local persistence. |
| Cart | Ready | Cart drawer and cart persistence are implemented; root build passes. |
| Checkout | Verified by tests/build | Automated tests cover validation, totals, idempotency, rate limiting, and request validation. |
| Order creation | Verified by tests/static audit | Checkout route writes orders server-side inside a transaction. Live smoke order required before launch. |
| Review creation | Ready with backend aggregate | Firestore rules permit authenticated owner reviews; aggregate trigger recalculates product rating/count. |

### Admin And Operations

| Flow | Status | Evidence |
| --- | --- | --- |
| Admin login | Ready for live smoke test | Admin access is enforced by email or `users/{uid}.role == "admin"`. |
| Admin dashboard | Ready | Admin module is lazy-loaded and included in successful root build. |
| Product management | Ready | Admin writes remain protected by Firestore admin rules. |
| CMS | Ready | `pages` collection is publicly readable and admin writable. |
| Website settings | Ready | `settings` is publicly readable and admin writable. |
| Firebase Storage uploads | Ready for live smoke test | Storage rules allow admin writes to `banners/` and `logos/`; live upload should be confirmed. |
| Supplier sync | Verified by tests/static audit | Sync queues supplier data and does not publish directly to `products`. |
| Queue creation | Verified by tests/static audit | Queue collections are covered by rules and scheduled/manual flows write queue data. |
| Approval | Verified by tests | Approval writes to `products`, cleans queues, and creates audit records. |
| Rejection | Verified by tests | Rejection does not write to `products`, cleans queues, and creates audit records. |
| Scheduled sync | Ready | Scheduled Function reads settings, uses lock, writes queues/history, and avoids direct product writes. |
| Audit logging | Ready | Approval audit and sanitized Functions logging are present. |

## Security Audit Results

| Control | Status | Notes |
| --- | --- | --- |
| Firestore rules | Ready | Admin-only writes for product/admin/supplier collections; customer ownership enforced for users/orders/reviews; idempotency records backend-only. |
| Storage rules | Ready | Public reads and admin-only writes for banners/logos. |
| Supplier endpoint authentication | Ready | Supplier routes require Firebase ID token and admin authorization. |
| SSRF protection | Ready | Tests cover localhost/private IP blocking, invalid protocols, and allowlisted supplier URLs. |
| Checkout protection | Ready | Server-side validation, stock checks, totals, order numbers, transaction writes, and idempotency are implemented. |
| Rate limiting | Ready | Checkout rate limiting is implemented and tested. |
| Idempotency | Ready | Duplicate checkout requests with the same key return original successful order. |
| Admin authorization | Ready | Admin email or Firestore role is required for protected flows. |
| Error logging | Ready | Functions logging sanitizes sensitive keys. |
| CORS | Ready with condition | Wildcard CORS remains for compatibility until `API_ALLOWED_ORIGINS` is configured. |

## Deployment Readiness Results

| Area | Status | Notes |
| --- | --- | --- |
| Firebase Hosting | Ready | `firebase.json` serves `dist` and rewrites `/api/**` to `api`. |
| Firebase Functions | Ready | `api`, `scheduledSupplierSync`, and `syncReviewAggregates` are exported. |
| Firestore indexes | Monitor | No explicit `firestore.indexes.json` exists. No missing-index blocker was found statically; live smoke tests should confirm console has no missing-index prompts. |
| Environment variables | Ready with checklist | `ADMIN_EMAIL` and `API_ALLOWED_ORIGINS` are supported; supplier credentials remain server-side. |
| Scheduled Functions | Ready | `scheduledSupplierSync` runs every 15 minutes and respects `supplier_settings/config`. |
| Build output | Verified | Root build and Functions build pass. |
| CI/CD workflow | Ready | GitHub Actions runs npm install, lint, build, Functions build, tests, and uploads failure logs. |

## Remaining Known Issues

### High

- Live Firebase production smoke tests still need to be executed by an authenticated admin before public launch:
  - Admin login
  - Storage upload
  - Real checkout test
  - Supplier test/sync/approval/rejection against production data
- Supplier approval currently uses a client-side Firestore batch. It is protected by Firestore admin rules and tested, but a backend approval endpoint would improve centralized logging and server-side validation.

### Medium

- npm audit still reports moderate Firebase/Google transitive dependency findings. Sprint 14 safely upgraded Functions to the newest compatible Firebase major set, but a fully clean audit currently requires upstream compatibility for `firebase-admin@14.x` with `firebase-functions`.
- CORS should be tightened with `API_ALLOWED_ORIGINS` before public launch.
- No explicit Firestore indexes file is present. This is acceptable if current queries do not require composite indexes, but production smoke testing should check for missing-index console errors.
- Browser-driven E2E tests are not yet part of CI.

### Low

- Some lower-level supplier connector internals still use direct console logging. Public API failure paths now use centralized sanitized logging.
- Supplier image management can be improved further after launch with more automation and validation.

## Accepted Technical Debt

- Root `server.ts` remains for local/fullstack serving while production API traffic uses the Firebase Functions Express API.
- Supplier approval is still client-triggered through Firestore batch operations rather than a dedicated backend approval API.
- Manual live smoke testing remains required because automated browser E2E tests are not yet implemented.
- Dependency audit has moderate transitive findings that require upstream Firebase/Google package compatibility to eliminate safely.
- Supplier Hub supports the multi-supplier architecture foundation, but only the existing supplier workflow should be used for launch.

## Recommended Launch Strategy

### Step 1: Pre-Launch Freeze

- Freeze feature work.
- Only accept Critical launch fixes.
- Confirm `origin/main` is the deploy source.
- Complete every Critical and High item in `GO_LIVE_CHECKLIST.md`.

### Step 2: Soft Launch

- Launch to internal admins and a small controlled customer group.
- Keep supplier scheduled sync disabled initially unless the admin has verified manual sync in production.
- Run a controlled checkout order.
- Run one supplier manual sync, approve one item, reject one item, and verify audit records.
- Monitor logs for at least 24 hours.

### Step 3: Public Launch

- Proceed after 3-7 days of stable soft launch.
- Enable scheduled supplier sync only after queue/approval behavior is confirmed with production supplier data.
- Monitor checkout, Function errors, Firestore permission errors, Supplier Hub sync history, and Storage upload failures.

## Soft Launch Recommendation

Soft launch is recommended after:

- Production env vars are confirmed.
- Firebase rules and Functions are deployed.
- One live checkout is verified.
- Admin dashboard and Storage upload are verified.
- Supplier manual sync, approval, rejection, and audit logging are verified.

Suggested soft-launch window: 3-7 days.

## Public Launch Recommendation

Public launch is recommended only after soft launch shows:

- No checkout regressions.
- No unexpected Firestore permission errors.
- No Supplier Hub direct product publishing.
- No repeated scheduled sync lock failures.
- No elevated Function errors.
- No unresolved missing-index prompts.

## Future Roadmap: Phase 2

Critical/High candidates for Phase 2:

- Move Supplier Hub approval/rejection to backend API endpoints for stronger server-side validation and centralized logging.
- Add browser E2E tests for customer checkout and admin Supplier Hub workflows.
- Configure production monitoring alerts for checkout failures, Function errors, and Firestore permission errors.
- Add explicit Firestore index management if production smoke tests reveal missing composite indexes.
- Add App Check evaluation for public endpoints and Firebase client access.
- Improve supplier image ingestion and replacement controls.
- Add role-based admin permissions beyond a single admin/customer split.
- Add order tracking and customer-facing order history improvements.
- Add supplier conflict resolution for multiple suppliers.

## Final Recommendation

Zyro.lk should proceed to controlled soft launch, not immediate broad public launch.

The codebase is production-ready enough for real controlled traffic, but public launch should wait until live Firebase smoke tests, production environment configuration, and a short monitoring window are complete.
