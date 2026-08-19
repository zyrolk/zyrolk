<!-- builderai-document
type: architecture
version: 1
-->

# Architecture

## Status and scope

Zyro.lk is a production-oriented Sri Lankan e-commerce platform combining a React storefront, Express
runtime, and Firebase backend (Firestore, Auth, Storage, Functions). Implemented capabilities include
public catalog browsing, cart and wishlist, authenticated and guest checkout (including PayHere),
customer account center, CMS pages, admin dashboard, Supplier Hub with review-first supplier
ingestion, supplier portal, and AI Manager (advisory UI under `src/features/ai-manager`).

BuilderAI external-target sessions operate on this repository under the **EXTERNAL_TARGET** profile.
They must **extend** the existing implementation with the smallest safe change. They must **not**
redesign the application, restart greenfield modules, or break unrelated storefront, checkout,
Supplier Hub, authentication, or Firebase security boundaries.

Companion project context lives in repository-root documents such as `MASTER_PROJECT.md`,
`README.md`, and `ARCHITECTURE_DIAGRAM.md`. This file is the BuilderAI onboarding architecture
contract.

## Architectural principles

1. **Preserve approved backend shape.** Request/response APIs belong in one modular Express API
   hosted as a Firebase HTTPS Function under `functions/src/api`. Background work uses separate
   scheduled jobs and Firestore triggers under `functions/src/scheduled` and
   `functions/src/triggers`. Do not create one Firebase Function per business endpoint.
2. **Server-authoritative commerce.** Checkout totals, coupons, stock reservations, payment
   verification, admin checks, and supplier outbound requests must remain in trusted server code
   (`functions/src`, and `server.ts` for local/bundled execution). Never trust client-provided
   prices, roles, discounts, or supplier credentials.
3. **Review-first supplier ingestion.** Supplier sync stages data for admin review. Unapproved
   supplier payloads must not be written to live `products`. Approval is the publishing gate.
4. **Security rules are part of the architecture.** `firestore.rules` and `storage.rules` enforce
   public read vs admin write boundaries. Changes to rules or new collections require explicit
   operator approval and regression review.
5. **Incremental migration only.** Prefer extending existing components, services, and route modules
   over parallel rewrites. Preserve frontend API contracts unless explicitly approved.
6. **Use existing verification.** Root `package.json` scripts and the `tests/` suite are the
   authoritative local validation entry points for BuilderAI verification stages.

## Target source boundaries

```text
src/              React SPA — App.tsx shell, components/, features/ (checkout, account,
                  supplier-portal, ai-manager), client services under src/services/
functions/src/    Trusted server — api/routes, api/checkout, api/suppliers, api/orders,
                  api/payments, api/security, scheduled jobs, Firestore triggers
server.ts         Root Express server — local dev/prod entry importing functions/src modules
tests/            Node --test regression and emulator-backed workflow tests (*.test.ts)
public/           Static web manifest assets (robots.txt, manifest.json); not primary code
docs/             Operator and BuilderAI onboarding docs (this file and companions)
.builderai/       External-target manifest (target-project.json)
firebase.json     Hosting/functions configuration (change only with explicit approval)
firestore.rules   Firestore security rules (high-risk; explicit approval required)
storage.rules     Storage security rules (high-risk; explicit approval required)
```

### Runtime and Firebase boundaries

| Layer | Location | Responsibility |
| --- | --- | --- |
| Browser client | `src/` | Storefront UI, admin UI, Firestore listeners, Auth UI |
| Local/prod server | `server.ts` | Express + Vite middleware (dev) or static `dist/` (prod) |
| HTTPS API | `functions/src/api/` | Checkout, orders, payments, supplier, admin, contact routes |
| Background jobs | `functions/src/scheduled/`, `functions/src/triggers/` | Supplier sync, queues, notifications, payment reservations |
| Data plane | Firestore / Auth / Storage | Catalog, orders, users, supplier queues, CMS, settings |

Firebase client initialization: `src/firebase.ts`. Firebase Admin initialization and trusted writes
occur in server code. Do not move credential resolution into client bundles.

### Major functional areas (existing — do not break)

- **Customer storefront:** catalog, search/filters, product detail, cart, wishlist, CMS pages.
- **Checkout and payments:** server-side cart validation, PayHere session creation, payment return
  handling, COD and offline checkout limits.
- **Admin dashboard:** catalog, orders, CMS, settings, supplier operations entry via
  `AdminDashboard.tsx`.
- **Supplier Hub:** `SupplierHubFiveStars.tsx` and related services — sync, review queue, approval.
- **Supplier portal:** `src/features/supplier-portal/`.
- **AI Manager:** `src/features/ai-manager/` — advisory mode; must not autonomously publish catalog or
  process orders.

Protected paths and ownership rules are declared in `.builderai/target-project.json`. Do not read or
copy secret material from `.env*` files or `firebase-applet-config.json` into AI context.
