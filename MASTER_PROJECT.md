# MASTER PROJECT CONTEXT: Zyro.lk

This is the primary project context document for Zyro.lk. Every future coding task, bug fix, feature addition, refactor, and AI-assisted change should follow this document before making implementation decisions.

When another project document disagrees with this file, treat this file as the source of truth unless the user explicitly updates the project direction.

## Project Overview

Zyro.lk is a Sri Lankan e-commerce storefront and admin system for selling consumer products online. The application combines a public shopping experience, an admin dashboard, supplier integration tools, order processing, and Firebase-backed content management.

The product is not only a catalog website. It is intended to become an operational commerce platform where supplier inventory can be imported, reviewed, approved, published, sold, and tracked with minimal manual work while preserving admin control.

Primary goals:

- Provide a fast, modern storefront for customers.
- Maintain product, category, page, banner, order, and settings data in Firebase.
- Support guest and authenticated customer shopping flows.
- Give admins a single dashboard for catalog management, orders, CMS pages, settings, and supplier operations.
- Integrate supplier feeds through a review-first workflow so external data never silently overwrites the live storefront.
- Keep the codebase understandable, type-safe, and easy to extend.

## Technology Stack

Frontend:

- React 19
- TypeScript
- Vite
- Tailwind CSS
- Motion for animations
- Lucide React for icons
- Recharts for dashboard charts

Backend and runtime:

- Express server in `server.ts`
- Firebase Admin SDK for trusted server-side Firestore operations
- Vite middleware in development
- Static build serving in production
- `tsx` for local TypeScript server execution
- esbuild for bundling the server into `dist/server.cjs`

Firebase:

- Firestore for product, category, order, user, CMS, settings, supplier, queue, and history data
- Firebase Auth for customers and admins
- Firebase Storage for uploaded media such as banners and logos
- Firestore and Storage security rules in `firestore.rules` and `storage.rules`

Supplier and processing services:

- A2Z supplier connector under `src/services/connectors/a2z-website`
- Sync engine under `src/services/sync-engine`
- Integration pipeline modules under `src/services/integration`
- Image management modules under `src/services/image-management`
- Sandbox supplier import tooling under `src/services/sandbox`

Development commands:

- `npm run dev` starts the Express/Vite local development server.
- `npm run build` builds the Vite app and bundles the Express server.
- `npm run start` runs the production server bundle.
- `npm run preview` runs the production server bundle.
- `npm run lint` currently runs `tsc --noEmit`.

## Current Architecture

The application is a React single-page app served by an Express server.

High-level layers:

- Browser client: renders the storefront, cart, auth flows, CMS pages, and admin dashboard.
- React app: `src/App.tsx` manages top-level page state, live Firestore listeners, cart and wishlist syncing, and routing-like page switching.
- Component layer: reusable UI and business components live in `src/components`.
- Admin layer: `AdminDashboard` hosts admin modules, including `SupplierHubFiveStars`.
- Server layer: `server.ts` exposes checkout and supplier proxy APIs, initializes Firebase Admin, and serves the frontend.
- Firebase backend: Firestore, Auth, and Storage provide persistent data and security boundaries.
- Supplier integration layer: connector, sync, integration, image, and sandbox services provide the foundation for supplier ingestion.

Important frontend files:

- `src/App.tsx`: application shell, public store data listeners, cart/wishlist syncing, page selection.
- `src/components/AdminDashboard.tsx`: admin dashboard container.
- `src/components/SupplierHubFiveStars.tsx`: Supplier Hub UI and current supplier sync/review/approval behavior.
- `src/components/ProductCard.tsx`, `ProductDetailModal.tsx`, `CartDrawer.tsx`: core commerce UI.
- `src/firebase.ts`: Firebase client initialization and Firestore error handling.
- `src/types.ts`: shared product and domain types.

Important backend files:

- `server.ts`: local/prod Express server, checkout transaction, supplier test and fetch APIs.
- `functions/src/index.ts`: Firebase Functions implementation for checkout-like server behavior.
- `firestore.rules`: Firestore access control.
- `storage.rules`: Firebase Storage access control.

Core Firestore collections:

- `products`: live storefront products. Publicly readable, admin writable.
- `categories`: product categories. Publicly readable, admin writable.
- `orders`: customer orders. Created by guests or owning users, read by owner/admin, updated by admins.
- `users`: user profiles and roles.
- `settings/website`: site settings, delivery settings, banners, contact info, branding.
- `pages`: CMS content pages.
- `reviews`: public product reviews, with admin moderation.
- `supplierSources`: supplier connection definitions and source settings.
- `supplier_review_queue`, `supplier_import_queue`, `supplier_pending_changes`, `supplier_sync_history`, `supplier_settings`: intended supplier workflow collections.
- `counters/orders`: order sequence counter for order numbers.

## Supplier Hub Workflow

The Supplier Hub is the admin-facing control center for supplier data ingestion. Its current main implementation is `src/components/SupplierHubFiveStars.tsx`.

Current workflow:

1. Admin creates or edits supplier sources in `supplierSources`.
2. Supplier source settings define source type, URL, endpoint, status, filters, product limits, and sync options.
3. Admin starts supplier sync from Supplier Hub.
4. The client reads existing live products from Firestore.
5. The client calls `/api/fetch-supplier`.
6. `server.ts` fetches supplier products securely from the server side.
7. For A2Z sources, the server resolves credentials from `supplierSources` or environment variables and calls the A2Z connector service.
8. Supplier products are filtered by category and brand settings.
9. Current sync intentionally limits downloaded products to the first 5 products unless a lower saved source limit is set.
10. Products are mapped into review queue items.
11. Existing products are matched by supplier item code, SKU, document ID, or slug.
12. Differences are detected for product name, cost price, market price, stock, description, and primary image.
13. A product payload is prepared for approval.
14. The payload is stored in local review state and must not be written to `products` during sync.
15. The admin reviews pending queue items before they affect the storefront.

Supplier Hub invariants:

- Sync is a staging action, not a publishing action.
- Supplier data must be mapped, compared, and reviewed before becoming live.
- A supplier sync must not directly write new or changed products into `products`.
- Rejected supplier items must not write to Firestore.
- Approval is the only action that can publish supplier item payloads to the live `products` collection.
- Supplier credentials must stay server-side or in admin-only Firestore documents. Never expose credentials in client-visible code.

Future Supplier Hub direction:

- Persist review queues and import queues in Firestore instead of relying only on local component state.
- Track source, sync batch, approval user, approval timestamp, rejection reason, and raw supplier snapshot.
- Support multi-supplier conflict resolution.
- Support image downloading, optimization, and controlled replacement.
- Add automatic sync scheduling only after durable queue persistence and approval audit logging are in place.

## Approval Workflow

The approval workflow protects the live storefront from unreviewed supplier changes.

Correct approval model:

1. Supplier sync fetches and maps supplier data.
2. Sync compares supplier data against existing live products.
3. Sync creates review queue items with `productPayload`.
4. Sync does not write to the `products` collection.
5. Admin approves or rejects each review item.
6. Approval writes the prepared payload to `products` with `setDoc(..., { merge: true })`.
7. Rejection updates queue state only and does not write to `products`.
8. Public storefront listeners in `src/App.tsx` pick up approved products from `products`.

Important implementation detail:

- The storefront currently listens directly to the `products` collection and filters mainly by active flags such as `isActive !== false`.
- Because `products` is live public catalog data, anything written there can appear on the homepage quickly.
- Therefore, never use `products` as a staging queue.

Approval rules for future changes:

- Do not add code that writes supplier data to `products` during fetch, parse, map, compare, or sync.
- Do not mark products `approved: true`, `published: true`, or `visible: true` as a substitute for approval if the document is already being written to `products`.
- If adding persistent staging, use admin-only queue collections and write to `products` only from explicit admin approval.
- Approval must be idempotent where possible.
- Approval should preserve existing product fields that are not part of the supplier update unless the admin explicitly approves overwriting them.
- Price, stock, image, and description updates should remain reviewable independently when practical.

## Development Roadmap

Immediate priorities:

- Keep the approval workflow intact and prevent regression.
- Move Supplier Hub review/import/pending-change state from local React state into Firestore queue collections.
- Add audit fields to approvals and rejections.
- Improve TypeScript coverage by replacing `any` in supplier queue and payload paths with shared types.
- Add automated checks for supplier sync behavior so unapproved products cannot enter `products`.
- Verify checkout behavior with transaction-focused tests.

Near-term priorities:

- Improve supplier source management for website, API, and WhatsApp-based sources.
- Complete durable sync history and sync metrics.
- Add robust image ingestion through the image management services.
- Add admin controls for partial approvals such as price-only, stock-only, or image-only updates.
- Add stronger validation for product payloads before approval.
- Improve product matching and duplicate detection.
- Add user-facing order tracking and admin order workflow improvements.

Longer-term priorities:

- Support multiple suppliers with source priority and conflict rules.
- Add scheduled sync workers after durable queues and audit logs are complete.
- Add supplier sandbox previews before importing.
- Add analytics for product performance, supplier reliability, margin, stock aging, and approval throughput.
- Add role-based permissions beyond a single admin/customer split.
- Improve deployment automation and environment separation for local, staging, and production.

## Security Rules

Security is based on Firebase rules plus trusted server-side operations.

Firestore rules:

- Public users can read `products`, `categories`, `settings`, `pages`, `reviews`, and `test`.
- Only admins can write `products`, `categories`, `settings`, `pages`, supplier collections, and most admin-managed data.
- A user can read their own `users/{uid}` document; admins can read all users.
- New users may create their own profile only with role `customer`.
- Non-admin users must not escalate their role.
- Guests can create orders only with `customerUid == "guest"` and no auth.
- Authenticated customers can create orders for their own UID.
- Customers can read only their own orders.
- Only admins can update or delete orders.

Storage rules:

- `banners` and `logos` are publicly readable.
- Only authenticated admins can write `banners` and `logos`.

Admin identity:

- Admin access is granted if the authenticated email is `zyrolkofficial@gmail.com` or the user document has `role == "admin"`.

Security rules for future development:

- Never trust client-provided prices, totals, stock, discounts, roles, or supplier data.
- Checkout must calculate prices, delivery fees, totals, order numbers, and stock changes server-side inside a transaction.
- Supplier credentials must not be bundled into frontend code.
- Supplier fetches should go through server-side proxy endpoints to avoid exposing credentials and to control CORS, validation, and logging.
- Do not broaden public writes in Firestore or Storage rules.
- Any new collection must have explicit security rules before being relied on in production.
- Any customer-owned data must validate ownership with `request.auth.uid`.
- Any admin-only workflow must use `isAdmin()`.

## Git Workflow

Repository hygiene:

- Check `git status --short` before making changes.
- Treat existing uncommitted changes as user work unless proven otherwise.
- Do not revert, overwrite, or reformat unrelated files.
- Keep changes scoped to the requested task.
- Prefer small, reviewable commits.
- Do not commit secrets, `.env` files, credentials, supplier passwords, or Firebase service account keys.

Branching:

- Use feature branches for non-trivial work.
- In Codex-assisted work, use the `codex/` prefix for new branches unless the user requests another naming scheme.
- Use descriptive branch names such as `codex/persist-supplier-review-queue` or `codex/fix-checkout-stock-transaction`.

Before committing:

- Run `npm run lint` for TypeScript validation.
- Run `npm run build` when changes affect runtime, bundling, server code, routes, Firebase imports, or frontend build behavior.
- Manually verify key UI flows when touching customer-facing or admin-facing components.
- For Supplier Hub work, verify that sync does not publish products and approval does publish products.

Commit messages:

- Use concise, behavior-focused messages.
- Good examples:
  - `Fix supplier approval publishing flow`
  - `Persist supplier review queue`
  - `Validate checkout cart items server-side`
  - `Add admin-only supplier source rules`

## AI Development Rules

All future AI coding tasks must follow these rules:

- Read this file first before making project decisions.
- Inspect the relevant existing files before proposing or editing code.
- Prefer existing architecture and naming patterns over inventing new ones.
- Keep edits focused on the user's request.
- Preserve the approval workflow invariant: supplier sync stages; admin approval publishes.
- Do not write unapproved supplier data into `products`.
- Do not weaken Firestore or Storage security rules.
- Do not expose secrets, supplier credentials, Firebase private keys, or service account material.
- Avoid broad rewrites unless the user explicitly asks for a refactor.
- Use TypeScript types instead of adding new `any` usage.
- Keep UI consistent with the current admin/storefront design language.
- Use Lucide icons for UI actions when icons are needed.
- Avoid adding new dependencies unless they solve a clear project need.
- Validate with `npm run lint` and, when appropriate, `npm run build`.
- Document important workflow or security changes in this file or a focused companion document.
- If a change affects checkout, supplier ingestion, approval, auth, or security rules, treat it as high risk and verify carefully.

AI agents should produce implementation, verification, and a concise summary. They should not stop at a plan when the user has asked for a concrete code or file change.

## Long-Term Vision

Zyro.lk should evolve into a reliable commerce operating system for Sri Lankan online retail.

The long-term product vision:

- A polished storefront customers trust.
- A powerful admin cockpit for products, content, customers, orders, settings, and suppliers.
- A supplier ingestion engine that can safely import data from websites, APIs, files, WhatsApp messages, and future integrations.
- A durable approval system with review queues, audit logs, rollback ability, and field-level control.
- Smart stock, price, margin, and image workflows that reduce manual work without removing admin judgment.
- Scalable architecture that can support multiple suppliers, multiple product categories, scheduled jobs, analytics, and operational dashboards.
- Security-first data handling where public users can browse and order safely while admin and supplier operations remain protected.

The guiding principle is simple:

Supplier automation should accelerate the business, but live customer-facing data must remain controlled, reviewable, and trustworthy.
