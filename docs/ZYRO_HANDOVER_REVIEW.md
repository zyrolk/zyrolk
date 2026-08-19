# Zyro.lk — Complete Handover / Production Readiness Review

**Document prepared:** 2026-08-19  
**Prepared for:** Next AI developer (Gemini) continuing Zyro.lk work  
**Review method:** Repository inspection and read-only validation commands only. No application source code was modified during this review. No browser visual QA was performed.

---

## Table of Contents

1. [Project Identity](#1-project-identity)
2. [Current Repository State](#2-current-repository-state)
3. [Architecture](#3-architecture)
4. [Current Functional Status](#4-current-functional-status)
5. [Penpot Storefront Redesign](#5-penpot-storefront-redesign)
6. [Remaining Visual Work](#6-remaining-visual-work)
7. [Testing / Quality](#7-testing--quality)
8. [Security / Data Safety](#8-security--data-safety)
9. [Production / Deployment Readiness](#9-production--deployment-readiness)
10. [Launch Blockers](#10-launch-blockers)
11. [Recommended Final Roadmap](#11-recommended-final-roadmap)
12. [Important Do-Not-Touch Areas](#12-important-do-not-touch-areas)
13. [Instructions for the Next AI](#13-instructions-for-the-next-ai)
14. [Source of Truth Index](#14-source-of-truth-index)

---

## 1. Project Identity

| Field | Value | Source |
| --- | --- | --- |
| **Project name** | Zyro.lk (`zyro-lk` npm package) | `package.json` (`name`), `index.html` (`application-name`) |
| **Version** | `1.0.0` in `package.json`; HEAD commit message references **v1.0.1 production candidate**; git tag **`v1.0.2`** points at HEAD | `package.json`, `git log -1`, `git tag -l` |
| **Primary framework** | React 19 SPA + Vite 6 | `package.json` dependencies |
| **Frontend stack** | React 19, TypeScript 5.8, Vite 6, Tailwind CSS 4 (`@tailwindcss/vite`), Lucide icons, Motion (`motion/react`), Recharts | `package.json`, `src/main.tsx`, `vite.config.ts` (implied by build) |
| **Backend stack** | Express 4 (root `server.ts` for local/prod bundled server), Firebase Cloud Functions v2 (Node 20) hosting modular Express API | `server.ts`, `functions/package.json`, `functions/src/index.ts` |
| **Firebase architecture** | Firestore (catalog, orders, users, supplier queues, CMS), Firebase Auth (custom claims for admin/supplier), Cloud Storage (media), Cloud Functions (HTTPS `api` + scheduled jobs + Firestore triggers), Firebase Hosting (`dist/`) | `firebase.json`, `docs/architecture.md`, `src/firebase.ts` |
| **Firebase project ID** | `zyrolk-e0164` | `.firebaserc`, `scripts/validateProductionConfiguration.ts` |
| **Launch payment mode** | **COD-only** (Cash on Delivery). PayHere code retained but **unregistered and unbound** for this release | `tests/payhereCodOnlyLaunch.test.ts`, `docs/PRODUCTION_OPERATIONS_RUNBOOK.md` |

### Important Dependencies

| Package | Role |
| --- | --- |
| `firebase` / `firebase-admin` / `firebase-functions` | Client SDK, Admin SDK, Cloud Functions |
| `express` | Local server + Functions API host |
| `@google/genai` | Gemini AI (AI Manager / orchestrator) |
| `sharp` | Image processing (supplier media pipeline) |
| `recharts` | Admin / AI Manager charts |
| `motion` | Storefront animations (with reduced-motion safeguards) |

### Commands

| Purpose | Command | Source |
| --- | --- | --- |
| **Development** | `npm install` → `cd functions && npm install` → `npm run dev` | `README.md`, `package.json` |
| **Lint (TypeScript)** | `npm run lint` (`tsc --noEmit`) | `package.json` |
| **Full test suite** | `npm test` | `package.json`, `scripts/runAllTests.ts` |
| **Emulator-critical tests** | `npm run test:emulator-critical` (requires running emulators + `demo-*` project) | `scripts/runEmulatorCriticalTests.ts`, `.github/workflows/ci.yml` |
| **Production build** | `npm run build` (Vite → `dist/` + esbuild `server.ts` → `dist/server.cjs`) | `package.json` |
| **Functions build** | `npm --prefix functions run build` | `functions/package.json` |
| **Production config validation** | `npm run release:config:check` | `scripts/validateProductionConfiguration.ts` |
| **Start production server locally** | `npm start` / `npm run preview` | `package.json` |

---

## 2. Current Repository State

### Git Summary

| Item | Value |
| --- | --- |
| **Branch** | `main` |
| **HEAD commit** | `aae1f015b9a505e86f43bfe6e20901d6485e03fd` |
| **HEAD message** | `release: prepare Zyro.lk v1.0.1 production candidate` |
| **Git tag at HEAD** | `v1.0.2` (annotated tag resolves to this commit) |
| **Working tree** | **DIRTY** — 25 modified tracked files, 8 untracked files |
| **Production deployable per runbook?** | **NO** — `docs/PRODUCTION_OPERATIONS_RUNBOOK.md` explicitly forbids deployment from an uncommitted/dirty working tree |

### Modified Tracked Files (25)

**Likely Penpot / storefront-related:**

- `index.html` — Inter Tight font, theme-color `#6547E8`, SEO meta
- `src/main.tsx` — imports `storefrontPenpot.css`
- `src/App.tsx` — `zy-penpot-storefront` wrapper, filter sheet, mobile sort, page attributes
- `src/components/MobileBottomNav.tsx`
- `src/components/Navbar.tsx`
- `src/components/ProductCard.tsx`
- `src/components/ProductFilters.tsx`

**Likely Supplier Hub / backend-related (unrelated to Penpot storefront):**

- `functions/src/api/routes/supplierPortal.ts`
- `functions/src/api/suppliers/supplierApproval.ts`
- `functions/src/api/suppliers/supplierPortalLogic.ts`
- `src/components/SupplierHubFiveStars.tsx`
- `src/components/SupplierReviewEditorModal.tsx`
- `src/services/supplierHubPresentation.ts`

**Test adjustments (mixed):**

- `tests/productionBlockersP1Emulator.test.ts` (+92 lines)
- 12 supplier-related test files (assertion updates)
- *(Penpot test is untracked, not in modified list)*

### Untracked Files (8)

| File | Appears related to |
| --- | --- |
| `src/styles/storefrontPenpot.css` | **Penpot storefront redesign** |
| `tests/penpotStorefrontRedesign.test.ts` | **Penpot regression tests** |
| `src/components/SupplierReviewQuickCard.tsx` | Supplier Hub UI |
| `tests/supplierReviewLaunchUi.test.ts` | Supplier Hub UI tests |
| `docs/ai-rules.md` | BuilderAI onboarding docs |
| `docs/architecture.md` | BuilderAI onboarding docs |
| `docs/project-constitution.md` | BuilderAI onboarding docs |
| `.builderai/target-project.json` | BuilderAI external-target manifest |

### Change Volume (uncommitted)

```
25 files changed, 834 insertions(+), 547 deletions(-)
```

Source: `git diff --stat HEAD` run during this review.

### Version Inconsistency Note

- `package.json` → `"version": "1.0.0"`
- HEAD commit message → v1.0.1 candidate
- Git tag at HEAD → `v1.0.2`

This is a documentation/process inconsistency, not necessarily a runtime bug. Resolve before public launch tagging.

---

## 3. Architecture

### High-Level Runtime

```text
Browser (React SPA, src/)
    ↕ Firebase Auth, Firestore listeners, Storage uploads
Firebase Hosting (dist/) ── SPA fallback + /api/** rewrite
    ↕
Cloud Function "api" (functions/src/api/app.ts — modular Express)
    ↕ Firestore / Auth / Secret Manager
Scheduled Functions + Firestore Triggers (supplier sync, orders, payments expiry)
Local dev: server.ts (Express + Vite middleware) imports same functions/src modules
```

**Source:** `docs/architecture.md`, `firebase.json`, `server.ts`, `functions/src/index.ts`

### Frontend Structure (`src/`)

| Area | Location | Responsibility |
| --- | --- | --- |
| **App shell / routing** | `src/App.tsx` | State-based page navigation, Firestore subscriptions, cart/wishlist, admin mode toggle |
| **Route parsing** | `src/services/navigation/storefrontRoutes.ts` | Path → page ID (`/products`, `/account/orders`, etc.) |
| **Storefront components** | `src/components/` | Navbar, ProductCard, HeroBanner, MarketplaceHomePhase1, CartDrawer, etc. |
| **Feature modules** | `src/features/` | checkout, account, personalization, supplier-portal, ai-manager, reviews, auth |
| **Client services** | `src/services/` | catalog, search, security, observability, supplier APIs, settings |
| **Styles cascade** | `src/main.tsx` imports | `index.css` → `storefrontL6.css` → `storefrontL7.css` → `storefrontHeader.css` → **`storefrontPenpot.css` (last, uncommitted)** |
| **Firebase client** | `src/firebaseApp.ts`, `src/firebase.ts` | App Check bootstrap before SDK init (`src/main.tsx` → `storefrontBootstrap.ts`) |

### Backend Structure (`functions/src/`)

| Area | Location |
| --- | --- |
| **HTTPS API entry** | `functions/src/index.ts` exports `api` |
| **Express app factory** | `functions/src/api/app.ts` |
| **Route modules** | `functions/src/api/routes/` — checkout, orders, supplier, supplierPortal, adminProducts, adminConfiguration, contact, reviewSystem, payments (retained, not registered in app for COD launch) |
| **Checkout logic** | `functions/src/api/checkout/checkoutLogic.ts` |
| **Supplier ingestion** | `functions/src/api/suppliers/` |
| **Scheduled jobs** | `functions/src/scheduled/` — supplierSync, supplierQueueWorker, paymentReservations, orderNotificationRetries |
| **Triggers** | `functions/src/triggers/` — reviewAggregates, orderNotifications, supplierOfferFailover |
| **Secrets** | `functions/src/config/secrets.ts` — `A2Z_USERNAME`, `A2Z_PASSWORD` via Secret Manager |

### Authentication

- **Customer:** Firebase Auth (email/password, Google — exact enabled providers: **NOT VERIFIED** in Firebase Console from repo alone)
- **Admin:** Firebase **custom claims** (`admin` or `role == 'admin'`) — never email matching or Firestore profile fields
- **Supplier Hub admin:** custom claim `supplierHubAdmin` or admin claim
- **Supplier portal:** Firestore `users/{uid}.role == 'supplier'` + trusted API authorization
- **App Check:** Required in production (`REQUIRE_APP_CHECK=true`); bootstrap in `src/services/security/storefrontBootstrap.ts`

**Source:** `firestore.rules` (lines 7–17), `src/services/security/adminAuthorization.ts`, `src/main.tsx`

### State / Persistence

| Data | Storage |
| --- | --- |
| Cart | Browser local storage via `src/services/browser/persistentStorage.ts` |
| Wishlist / recently viewed | Local storage + Firestore user doc sync (owner-scoped rules) |
| Checkout draft | Local storage (`src/features/checkout/checkoutModel.ts`) |
| Catalog | Firestore `products` (public read; **writes blocked** — Functions-only) |
| Commercial fields | Firestore `product_private` (admin read only via rules) |
| Orders | Firestore `orders` + private attribution collection |
| Website settings / CMS | Firestore `settings`, CMS page documents |

### Commerce Architecture

- **Server-authoritative totals:** `functions/src/api/checkout/checkoutLogic.ts` — coupons, delivery, stock checks
- **COD confirmation window:** 1 hour (`COD_CONFIRMATION_WINDOW_MS`)
- **Abuse limits:** Phone (3/hour) and network (12/hour) throttles for offline checkout
- **Idempotency:** `checkout_idempotency` collection, `Idempotency-Key` header
- **Stock reservations:** Admin confirmation commits; cancellation/expiry restores
- **Payment methods allowed in logic:** `cod`, `whatsapp_confirm`, `payhere` — but UI/API registration is **COD-only** for launch

### Supplier Hub

- **UI:** `src/components/SupplierHubFiveStars.tsx` (admin-only, lazy-loaded from `App.tsx`)
- **Review-first ingestion:** Supplier sync stages to queue; approval publishes to `products` + `product_private`
- **Server:** `functions/src/api/routes/supplier.ts`, `functions/src/api/suppliers/supplierApproval.ts`
- **Background:** scheduled sync workers, queue worker, operational alerts

### Admin

- **UI:** `src/components/AdminDashboard.tsx` (lazy-loaded)
- **Capabilities:** Dashboard, products, brands, categories, orders, settings, CMS, Supplier Hub entry, AI Manager tab
- **Product writes:** Through trusted Admin Product API (`functions/src/api/routes/adminProducts.ts`) — not direct Firestore client writes

### AI Manager

- **UI:** `src/features/ai-manager/AIManagerPanel.tsx` (embedded in AdminDashboard)
- **Mode:** Read-only advisory — `AI_MANAGER_ACTION_POLICY.mode = 'read-only'`, `canExecuteActions: false`
- **Domains:** Sales, inventory, supplier, pricing, customer intelligence dashboards
- **Orchestrator:** `src/services/ai-orchestrator/` (Gemini via `@google/genai`)

### Important Shared Components

- `ProductCard.tsx` — commerce actions (cart, wishlist, WhatsApp, detail)
- `Navbar.tsx` / `MobileBottomNav.tsx` — search, navigation, mobile dock
- `PremiumCheckoutDrawer.tsx` — checkout UX
- `ProductDetailModal.tsx` — product experience overlay
- `StorefrontProductShelf.tsx` — homepage shelves
- `MarketplaceHomePhase1.tsx` — Phase 1 homepage composition
- `AppErrorBoundary.tsx` — top-level error boundary

---

## 4. Current Functional Status

Classification key: **READY** = implemented with regression test evidence; **PARTIAL** = implemented but gaps remain; **NEEDS WORK** = significant gaps; **NOT VERIFIED** = cannot confirm from repo alone (requires live environment / browser).

| Area | Status | Evidence |
| --- | --- | --- |
| **Storefront shell** | READY | `src/App.tsx`, `tests/storefrontLaunchPolish.test.ts` |
| **Homepage** | READY | `MarketplaceHomePhase1.tsx`, `tests/homepageProductShelves.test.ts`, `tests/homepageLaunchPolish.test.ts` |
| **Categories** | READY | `App.tsx` categories page, `tests/categoriesRedesign.test.ts` |
| **Search** | READY | `Navbar.tsx` combobox + suggestions, `tests/productSearch.test.ts` |
| **Product listing** | READY | Paginated Firestore catalog via `storefrontCatalog.ts`, filters in `ProductFilters.tsx` |
| **Product details** | READY | `ProductDetailModal.tsx`, `tests/productExperience.test.ts` |
| **Wishlist** | READY | `WishlistExperience.tsx`, `tests/wishlistPersonalizationSprint81.test.ts` |
| **Recently viewed** | READY | `personalization.ts`, account sync in `App.tsx` |
| **Compare products** | READY | `CompareProducts.tsx`, personalization tests |
| **Cart** | READY | `CartDrawer.tsx`, local persistence in `App.tsx` |
| **Checkout** | READY (COD-only) | `PremiumCheckoutDrawer.tsx`, `functions/src/api/routes/checkout.ts`, `tests/checkout.test.ts`, `tests/premiumCheckoutSprint83.test.ts` |
| **Address book** | READY | `AccountCenter.tsx`, Firestore rules `isValidCustomerAddress`, `tests/customerAccountCenterSprint79.test.ts` |
| **Coupons** | READY | Server validation in `checkoutLogic.ts`, UI in checkout drawer |
| **Order creation** | READY | `/api/checkout` routes in Functions + `server.ts` |
| **Order confirmation** | READY | In-drawer confirmation step (`zy-confirmation-*` classes) |
| **Account center** | READY | Profile, addresses, security, settings, orders — `tests/customerAccountCenterSprint79.test.ts` |
| **Customer orders** | READY | `CustomerOrdersView.tsx`, `tests/customerOrdersSprint80.test.ts` |
| **Authentication** | READY | `AuthModal.tsx`, `tests/authErrorMessage.test.ts` |
| **WhatsApp ordering** | READY | `FloatingWhatsApp.tsx`, ProductCard quick buy, checkout confirmation WhatsApp button |
| **Stock display** | READY | ProductCard stock states, server validation at checkout |
| **Pricing display** | READY | Server-calculated totals; client shows live catalog prices |
| **Supplier Hub** | READY (logic) / PARTIAL (uncommitted UI changes) | Extensive supplier test suite; dirty `SupplierHubFiveStars.tsx` |
| **Admin dashboard** | READY | `AdminDashboard.tsx`, many admin tests |
| **AI Manager** | READY (advisory) | `AIManagerPanel.tsx`, `tests/ai-manager-*.test.ts`, read-only policy |
| **Error states** | READY | `AppErrorBoundary.tsx`, checkout errors, account alerts |
| **Loading states** | READY | `LazyBlockFallback`, `ProductGridLoading`, skeleton classes |
| **Offline states** | READY | `App.tsx` offline listener + `zy-storefront-connection-state` banner |
| **PayHere payments** | PARTIAL (disabled by design) | Code in `payments.ts` retained; not registered for launch |
| **Production live data** | NOT VERIFIED | Requires credentialed smoke tests against `zyrolk-e0164` |
| **Custom domain HTTPS** | NOT VERIFIED | Historical doc noted DNS issues; current DNS state not checked in this review |
| **Visual/Penpot fidelity** | PARTIAL | CSS/tests present; **no browser visual QA in this review** |

---

## 5. Penpot Storefront Redesign

### Files Involved

| File | Role |
| --- | --- |
| `src/styles/storefrontPenpot.css` | **Primary Penpot presentation layer** (~1,878 lines, **untracked**) |
| `src/main.tsx` | Loads Penpot CSS **after** header styles |
| `src/App.tsx` | Applies `zy-penpot-storefront` class when `!isAdminMode`; sets `data-storefront-page` |
| `src/components/Navbar.tsx` | Mobile delivery context, search combobox |
| `src/components/MobileBottomNav.tsx` | Five-destination dock (Home, Categories, Wishlist, Cart, Account) |
| `src/components/ProductCard.tsx` | Trust chips, commerce actions |
| `src/components/ProductFilters.tsx` | Penpot filter class hook |
| `index.html` | Inter Tight font, `#6547E8` theme-color |
| `tests/penpotStorefrontRedesign.test.ts` | Static regression tests (**untracked**) |

**Isolation contract:** All Penpot rules scoped to `.zy-penpot-storefront`. Admin and supplier experiences excluded.

**Source:** `tests/penpotStorefrontRedesign.test.ts` line 13–20, `storefrontPenpot.css` header comment.

### CSS Architecture

1. **Design tokens** on `.zy-penpot-storefront` — background `#f6f7fb`, primary `#6547e8`, accent `#ff6b3d`, typography Inter Tight
2. **Legacy token bridging** — maps `--zy-color-primary` etc. to Penpot tokens for L6/L7 compatibility
3. **Component sections** — header, hero, shelves, product cards, catalog, filters, product detail, personalization, checkout, account, connection states
4. **Responsive breakpoints** — `@media (max-width: 389px)`, `(max-width: 767px)`, `(min-width: 768px) and (max-width: 1023px)`, desktop
5. **Accessibility** — `prefers-reduced-motion`, `forced-colors`, 2.75rem (44px) minimum touch targets
6. **Legacy override pattern** — Penpot overrides Tailwind utility leaks via `[class*="bg-brand-blue"]` selectors rather than removing legacy classes from TSX

### Verified Penpot Items (from repository — NOT from browser)

| Claimed item | Verified in repo? | Evidence |
| --- | --- | --- |
| Compact mobile header | **YES** | `storefrontPenpot.css` `@media (max-width: 767px)` `.zy-market-header-shell`, `.zy-brand-button` rules |
| Reduced mobile hero | **YES** | `.zy-ai-hero-stage { min-height: 12rem }` at mobile breakpoint; test asserts no `min-height: 24rem` |
| Trust chips | **YES** | `ProductCard.tsx` → `.zy-product-card-trust`; Penpot styles lines 466–490 |
| Two-column product shelves | **YES** | `.zy-storefront-product-shelf-grid` → `grid-template-columns: repeat(2, …)` + `scroll-snap-type: none` |
| Reduced product-card height | **YES** | `.zy-product-card { height: 20.25rem }` at mobile |
| 44×44 touch targets | **YES** | `.zy-product-card-wishlist`, `.zy-product-card-action-grid` → `2.75rem`; `.zy-button { min-height: 2.75rem }` |
| Mobile categories grid | **YES** | `.zy-categories-grid` → 3-column grid; category items `width: auto` |
| Mobile listing banner removal | **YES** | `.zy-catalog-page > .zy-page-banner { display: none }` |
| Refined filter bottom sheet | **YES** | `.zy-filter-sheet`, `::before` handle, 2-column filter fieldsets, reset button; `App.tsx` `zy-filter-sheet-reset` |

### Commerce Actions Preserved

Penpot tests confirm ProductCard retains: `onAddToCart`, `handleWhatsAppQuickBuy`, `onViewDetail`, `onToggleWishlist`, COD/free-delivery trust chips.

**Source:** `tests/penpotStorefrontRedesign.test.ts` lines 31–40, `ProductCard.tsx`.

### Penpot Coverage by Surface (CSS selectors present)

| Surface | Penpot CSS coverage |
| --- | --- |
| Home / hero / shelves | YES |
| Product listing / filters | YES |
| Product detail modal | YES |
| Wishlist / recently viewed / compare | YES |
| Checkout + order confirmation | YES (Penpot overrides atop `premiumCheckout.css`) |
| Account center | YES |
| Connection/offline banner | YES |
| Contact / CMS pages | **PARTIAL / NOT VERIFIED** — no dedicated Penpot sections found; inherit shell styles only |
| Admin / Supplier Hub / Supplier Portal | **Excluded by design** |

### Tests

`tests/penpotStorefrontRedesign.test.ts` — 8 test cases covering isolation, tokens, mobile grid, P1 cascade, categories/filters, navigation dock, checkout/account coverage, accessibility breakpoints.

**Status:** File is **untracked**; included in full suite only if present on disk (runs as part of `npm test` when file exists — **817 pass, 0 fail** during this review).

### Visual QA Completed

| QA type | Result |
| --- | --- |
| Browser visual comparison to Penpot designs | **NOT VERIFIED** — no browser access during this review |
| Responsive device testing (390px, tablet, desktop) | **NOT VERIFIED** in browser |
| Static CSS/test regression | **PASS** — `penpotStorefrontRedesign.test.ts` assertions match current files |

### Known Penpot Mismatches / Risks (code-level)

1. **Legacy Tailwind classes remain in TSX** — Penpot overrides via attribute selectors; removing Penpot scope would revert to blue legacy palette (**P2**)
2. **`premiumCheckout.css` retains legacy blue/green confirmation colors** — partially overridden by Penpot but base file still uses `#1d4ed8`, `#2563eb` (**P2**)
3. **`index.html` loads Space Grotesk + JetBrains Mono** but Penpot primary font is Inter Tight — unused font weight (**P3**)
4. **Contact/CMS page Penpot parity** — not evidenced in CSS (**P2**, needs visual QA)

---

## 6. Remaining Visual Work

Ranked by launch impact:

| Issue | Rank | Evidence |
| --- | --- | --- |
| Uncommitted Penpot CSS + tests not in release commit | **P0** | Working tree dirty; `storefrontPenpot.css` untracked |
| No browser visual QA against Penpot designs | **P0** | Cannot verify pixel parity from repo alone |
| Checkout/order-success legacy blue palette in `premiumCheckout.css` | **P1** | Lines 210–226 use `#1d4ed8`, `#2563eb`, `#eff6ff` |
| Search suggestions fixed positioning on mobile — runtime overlap risk | **P1** | CSS `position: fixed` on `.zy-search-suggestions`; needs device QA |
| Contact page / CMS pages Penpot styling | **P2** | No Penpot selectors for `ContactPage`, `CmsPage` |
| Legacy `bg-brand-blue` / Tailwind color classes in storefront TSX | **P2** | Overridden by Penpot but not migrated to semantic classes |
| Skeleton loaders still use generic `animate-pulse` / slate tones | **P2** | Penpot tints skeletons but base pulse pattern unchanged |
| Admin/AI Manager blue palette (intentionally separate) | **P3** | `AdminDashboard.tsx` uses `bg-blue-600` throughout — by design |
| Typography: Space Grotesk loaded but unused in Penpot scope | **P3** | `index.html` font link |
| Border radii inconsistency between L6/L7 base and Penpot tokens | **P2** | Mixed `rounded-2xl` (Tailwind) vs Penpot `0.75rem`/`1rem` |
| Tablet breakpoint (768–1023px) intermediate layouts | **P2** | CSS rules exist; **NOT VERIFIED** visually |

---

## 7. Testing / Quality

### Test Inventory

- **Total test files:** 137+ under `tests/*.test.ts`
- **Test runner:** Node.js built-in test runner via `tsx` (`scripts/runAllTests.ts`)

### Latest Validation Results (this review, 2026-08-19)

| Command | Result |
| --- | --- |
| `npm run lint` | **PASS** (exit 0) |
| `npm test` | **PASS** — 836 tests, **817 pass**, **0 fail**, **19 skipped**, duration ~257s |
| `npm run build` | **PASS** — Vite build + `dist/server.cjs` (~786 KB) |
| `npm --prefix functions run build` | **PASS** |
| `npm run release:config:check` | **PASS** — `repository-production-configuration-valid` |
| `git diff --check` | **PASS** (no conflict markers); CRLF→LF warnings on 11 files (line-ending normalization pending) |

### Skipped Tests (19 — emulator not running locally)

These skip when `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, `FUNCTIONS_EMULATOR_HOST`, or `FIREBASE_STORAGE_EMULATOR_HOST` are unset:

| Test file | Skip count |
| --- | --- |
| `productionBlockersP1Emulator.test.ts` | 1 |
| `productCommercialMigrationBatchSafetySH5C.test.ts` | 1 |
| `supplierProductReviewE2EEmulatorSH3Final.test.ts` | 4 |
| `supplierRemovedProductE2EEmulatorSH2Final.test.ts` | 1 |
| `adminProductApiE2EEmulatorSH4Final.test.ts` | 1 |
| `adminProductIdentityE2EEmulatorSH4A.test.ts` | 1 |
| `supplierManualJobConcurrencyEmulatorSH2Final.test.ts` | 1 |
| `supplierReviewIdentityConcurrencyEmulatorSH2Final.test.ts` | 2 |
| `supplierSecurityEmulatorSprint8.test.ts` | 1 |
| `storageSecurityEmulatorSprint1.test.ts` | 1 |
| `orderFulfilmentSafetySH7A.test.ts` | 1 |
| `orderPrivateAttributionSH7B.test.ts` | 1 |
| `orderFulfilmentGroupsSH7C.test.ts` | 1 |
| `orderFulfilmentTrackingSH7D.test.ts` | 1 |
| `orderFulfilmentNotificationsSH7E.test.ts` | 1 |

**CI behavior:** `.github/workflows/ci.yml` runs `npm run test:emulator-critical` inside Firebase emulators. The script **fails if any required test skips** (`scripts/runEmulatorCriticalTests.ts` line 60–62).

**Local limitation:** Running `npm test` without emulators skips 19 integration tests. This is expected; CI is the authoritative emulator gate.

### Known Test Limitations

- Most tests are **static source assertions** (read file, regex match) — they do not render React or hit production Firebase
- Emulator E2E tests require Java 21 + Firebase emulators (CI uses `firebase-tools@15.26.0`)
- No Playwright/Cypress browser E2E suite found in repository
- Visual regression / screenshot tests: **none**

---

## 8. Security / Data Safety

| Control | Status | Evidence |
| --- | --- | --- |
| **Admin auth via custom claims** | READY | `firestore.rules` `isAdmin()`, `functions/src/api/security/adminAuthorization.ts` |
| **Product writes blocked from client** | READY | `firestore.rules` — `products` create/update/delete: `false` |
| **Commercial field separation** | READY | `product_private` collection, `isPublicProductData()`, migration scripts |
| **Checkout server authority** | READY | `checkoutLogic.ts`, `tests/checkout.test.ts`, idempotency + abuse limits |
| **Coupon server validation** | READY | `resolveCouponDiscount()` in checkout logic |
| **Order idempotency** | READY | `CHECKOUT_IDEMPOTENCY_COLLECTION`, `Idempotency-Key` header |
| **App Check enforcement** | CONFIGURED (repo) / NOT VERIFIED (Console) | `REQUIRE_APP_CHECK`, bootstrap in `main.tsx` |
| **CORS allowlist** | CONFIGURED (repo) | `API_ALLOWED_ORIGINS` in `.env.example`, runtime in `app.ts` |
| **Supplier SSRF protection** | READY | `supplierOutboundRequest.ts`, `tests/supplierSsrfProtectionSprint3.test.ts` |
| **Secrets handling** | READY | `.gitignore` excludes `.env*`; A2Z via Secret Manager; PayHere secret **not bound** |
| **PII in client bundles** | LOW RISK | No secrets in Vite vars except App Check site key (public by design) |
| **Supplier credentials in Firestore** | BLOCKED | Profile ID references only; tests enforce no raw credentials |
| **Storage rules** | READY (rules file) / NOT VERIFIED (emulator locally) | `storage.rules`, emulator test skips locally |

### Trust Boundaries (do not weaken)

1. Browser → may read public catalog, own user data, call `/api/**` with Auth + App Check
2. Browser → **must not** write products, orders checkout totals, supplier approvals, or admin operations directly
3. Functions → sole authority for checkout, product publish, supplier sync outbound requests
4. PayHere → disabled at API registration layer for COD launch (`tests/payhereCodOnlyLaunch.test.ts`)

---

## 9. Production / Deployment Readiness

| Item | Status | Notes |
| --- | --- | --- |
| **Firebase project configured** | CONFIGURED | `.firebaserc` → `zyrolk-e0164` |
| **firebase.json hosting/functions/rules** | READY | CSP headers, `/api/**` → `api`, SPA fallback |
| **Production build** | READY | Verified `npm run build` succeeds |
| **Functions build** | READY | Verified `functions` tsc succeeds |
| **Repository config check** | READY | `release:config:check` passes |
| **Environment variables documented** | READY | `.env.example` |
| **Deployment scripts** | PARTIAL | Manual Firebase CLI per `docs/PRODUCTION_OPERATIONS_RUNBOOK.md`; no automated deploy workflow in CI |
| **Domain `zyro.lk`** | NOT VERIFIED | Referenced throughout; DNS/HTTPS health not checked in this review |
| **Firebase Hosting fallback** | CONFIGURED | `https://zyrolk-e0164.web.app` in defaults |
| **Cloudflare** | NOT VERIFIED | Mentioned only in historical checklist `docs/SPRINT_L5_1_RELEASE_READINESS.md` |
| **App Check Console registration** | NOT VERIFIED | Requires Firebase Console evidence |
| **Secret Manager bindings** | NOT VERIFIED | Requires GCP Console evidence |
| **Firestore indexes READY state** | NOT VERIFIED | `firestore.indexes.json` present; index build status unknown |
| **Trigger Email extension** | NOT VERIFIED | Referenced in runbook |
| **Firestore backup bucket** | NOT VERIFIED | Requires `ZYRO_BACKUP_BUCKET` operator setup |
| **Clean git tree for deploy** | **BLOCKED** | Dirty working tree with uncommitted Penpot + Supplier Hub work |
| **PayHere** | BLOCKED (by design) | COD-only launch; PayHere not registered |

**Authoritative deployment procedure:** `docs/PRODUCTION_OPERATIONS_RUNBOOK.md` (supersedes `docs/SPRINT_L5_1_RELEASE_READINESS.md`).

---

## 10. Launch Blockers

| Issue | Severity | Evidence | File/Area | Recommended Action |
| --- | --- | --- | --- | --- |
| Dirty working tree with uncommitted storefront + supplier changes | **P0** | `git status` — 25 modified, 8 untracked | Entire worktree | Review, commit, or stash as approved release candidate before any deploy |
| `storefrontPenpot.css` untracked | **P0** | `git status ??` | `src/styles/storefrontPenpot.css` | Add to release commit; Penpot styles won't ship without it |
| No browser visual QA for Penpot redesign | **P0** | No E2E/visual test infra; review did not use browser | Storefront UI | Run manual responsive QA on 390px / 768px / 1280px before launch |
| Production Console gates unverified | **P0** | `release:config:check` lists external operator gates | Firebase Console, DNS, App Check | Complete runbook §Production Console gates with recorded evidence |
| Custom domain DNS/HTTPS | **P0** | Historical NXDOMAIN note in `SPRINT_L5_1_RELEASE_READINESS.md`; current state **NOT VERIFIED** | DNS / Firebase Hosting | Verify apex + www resolve with valid certs |
| Version/tag inconsistency (package 1.0.0 vs tag v1.0.2 vs commit v1.0.1) | **P1** | `package.json`, git tags, commit message | Release process | Align version, tag, and release notes |
| 19 emulator tests skipped locally | **P1** (local only) | `npm test` output | CI emulators | Ensure CI passes on release commit; do not deploy if CI emulator step fails |
| Checkout confirmation legacy blue styling | **P1** | `premiumCheckout.css` | Checkout UX | Visual QA + Penpot alignment for order success |
| Mixed unrelated changes (Supplier Hub + Penpot in same dirty tree) | **P1** | `git diff --stat` | Supplier + storefront | Split or explicitly review combined release scope |

---

## 11. Recommended Final Roadmap

### Phase 1 — Remaining UI / Penpot Work (1–3 days)

1. Commit or isolate Penpot files: `storefrontPenpot.css`, `penpotStorefrontRedesign.test.ts`, related component changes
2. Browser visual QA at 390px, 768px, 1024px, 1280px — home, listing, detail, wishlist, checkout, account, order success
3. Fix **P1** visual issues found in QA (checkout confirmation colors, search overlay, contact/CMS if needed)
4. Do **not** refactor backend, checkout logic, or supplier approval during this phase

### Phase 2 — Regression and QA (1–2 days)

1. Run full validation gate on clean commit:

```powershell
npm run release:config:check
npm run lint
npm test
npm run build
npm --prefix functions run build
git diff --check
```

2. Push to `main` and confirm CI passes including `test:emulator-critical`
3. Resolve CRLF warnings if pre-commit hooks require LF normalization

### Phase 3 — Production Configuration (1–2 days, operator)

Follow `docs/PRODUCTION_OPERATIONS_RUNBOOK.md`:

1. Firestore export backup (`ZYRO_BACKUP_BUCKET`)
2. Verify App Check, Auth authorized domains, Secret Manager, indexes READY
3. Deploy order: Rules → indexes → Storage rules → Functions → Hosting
4. Admin custom claims grant (`security:admin-claims:*`)

### Phase 4 — Real-World Smoke Testing (1 day)

Credentialed tests per runbook:

- Customer: browse, search, wishlist, COD checkout, order confirmation
- Admin: product edit, order confirm, Supplier Hub approval
- Supplier: portal access, product request
- Verify emails/notifications

### Phase 5 — Launch

1. DNS cutover / canonical redirect `www` → apex
2. Monitor Function errors, App Check rejections, checkout throttles
3. Record GO/NO-GO with Git revision, CI log, smoke test results

### Phase 6 — Post-Launch Monitoring (ongoing)

1. Cloud Monitoring alerts (Functions, checkout failures)
2. Supplier sync job health
3. Order notification delivery
4. Customer-reported UI issues from Penpot rollout

---

## 12. Important Do-Not-Touch Areas

Unless fixing a **verified production bug** with explicit approval, do **not** modify:

| Area | Reason | Key paths |
| --- | --- | --- |
| **Checkout totals & validation** | Server-authoritative commerce | `functions/src/api/checkout/checkoutLogic.ts`, `functions/src/api/routes/checkout.ts`, `server.ts` checkout routes |
| **Firestore security rules** | High-risk; explicit operator approval required | `firestore.rules`, `storage.rules` |
| **Product commercial data model** | Public/private split is security-critical | `product_private`, `productCommercialData.ts` |
| **Supplier approval publish gate** | Review-first ingestion contract | `supplierApproval.ts`, `supplierQueueDecisionPlan.ts` |
| **Admin authorization** | Custom claims only | `adminAuthorization.ts`, `firestore.rules` `isAdmin()` |
| **PayHere integration code** | Retained but disabled; do not re-enable without launch decision | `functions/src/api/routes/payments.ts`, `payhereLogic.ts` |
| **Firebase Functions export shape** | Deployment contract | `functions/src/index.ts` |
| **API route registration** | COD-only registration is intentional | `functions/src/api/app.ts` |
| **Supplier SSRF / outbound policy** | Security boundary | `supplierOutboundRequest.ts` |
| **App Check bootstrap** | Production gate | `src/main.tsx`, `storefrontBootstrap.ts` |
| **AI Manager action policy** | Must remain read-only advisory | `aiActionPolicy.ts` |
| **CI emulator-critical test list** | Release gate | `scripts/runEmulatorCriticalTests.ts` |
| **Protected secrets paths** | Never commit or expose | `.env*`, `firebase-applet-config.json`, `functions/src/config/secrets.ts` |

**Penpot-safe change zone:** Storefront presentation under `.zy-penpot-storefront` scope — CSS and matching TSX class hooks in `Navbar`, `ProductCard`, `App.tsx` filter sheet, etc.

---

## 13. Instructions for the Next AI

### Current Project State

Zyro.lk is a **feature-complete COD-only e-commerce platform** on Firebase (`zyrolk-e0164`) with extensive automated tests (817 passing). HEAD is tagged `v1.0.2` at commit `aae1f01`. The working tree is **dirty** with an in-progress **Penpot storefront redesign** (untracked CSS + tests) and **Supplier Hub UI/backend adjustments**.

### What Has Already Been Completed

- Full commerce flow: catalog, search, cart, COD checkout, orders, account, wishlist, personalization
- Supplier Hub review-first ingestion with scheduled sync
- Admin dashboard, supplier portal, AI Manager (read-only)
- Security hardening: commercial field separation, App Check bootstrap, server-authoritative checkout
- Penpot CSS architecture + static regression tests (in working tree, not yet committed)
- All validation commands pass on current dirty tree

### What Should Be Done Next

1. **Finish Penpot visual QA** in a browser at key breakpoints
2. **Commit** Penpot + any approved fixes as a clean release candidate (decide whether Supplier Hub changes ship together or separately)
3. **Run CI** and complete production Console gates per runbook
4. **Deploy** following strict order in `docs/PRODUCTION_OPERATIONS_RUNBOOK.md`
5. **Execute credentialed smoke tests** before public launch

### What Must NOT Be Changed

See [§12 Important Do-Not-Touch Areas](#12-important-do-not-touch-areas). In summary: do not redesign architecture, do not re-enable PayHere without approval, do not weaken Firestore rules, do not move checkout authority to the client, do not autonomously publish supplier data, do not make AI Manager execute write actions.

### How to Validate Changes

```powershell
npm run lint
npm test
npm run build
npm --prefix functions run build
npm run release:config:check
git diff --check
```

For emulator-critical coverage (matches CI):

```powershell
npx firebase emulators:exec --project demo-zyro-local --only auth,firestore,functions,storage "npm run test:emulator-critical"
```

For Penpot-specific regression:

```powershell
npx tsx --test tests/penpotStorefrontRedesign.test.ts
```

### How to Report Completion

Report:

1. Git commit hash and confirmation working tree is clean
2. Output of all validation commands above
3. CI run URL / pass confirmation
4. Browser QA checklist results (devices + pages tested)
5. Any remaining P1/P2 visual deltas with screenshots
6. Explicit list of files changed and confirmation do-not-touch areas were not modified

---

## 14. Source of Truth Index

| Conclusion | Primary source |
| --- | --- |
| Project identity & scripts | `package.json`, `README.md` |
| Architecture contract | `docs/architecture.md`, `.builderai/target-project.json` |
| Firebase wiring | `firebase.json`, `.firebaserc` |
| App shell & routing | `src/App.tsx`, `src/services/navigation/storefrontRoutes.ts` |
| Penpot scope & tokens | `src/styles/storefrontPenpot.css`, `tests/penpotStorefrontRedesign.test.ts` |
| Checkout authority | `functions/src/api/checkout/checkoutLogic.ts` |
| COD-only launch | `tests/payhereCodOnlyLaunch.test.ts`, `docs/PRODUCTION_OPERATIONS_RUNBOOK.md` |
| Security rules | `firestore.rules`, `storage.rules` |
| Admin claims | `firestore.rules`, `functions/src/api/security/adminAuthorization.ts` |
| AI Manager read-only | `src/features/ai-manager/services/aiActionPolicy.ts` |
| Deployment procedure | `docs/PRODUCTION_OPERATIONS_RUNBOOK.md` |
| CI pipeline | `.github/workflows/ci.yml` |
| Emulator-critical tests | `scripts/runEmulatorCriticalTests.ts` |
| Production config validation | `scripts/validateProductionConfiguration.ts` |
| Test results (2026-08-19) | Commands run during this review — see §7 |

---

*End of handover document.*
