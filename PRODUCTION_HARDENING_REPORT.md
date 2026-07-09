# Production Hardening Report

Date: 2026-07-09

## Summary

Sprint 14 completed a final production hardening pass for the deployed Firebase Functions API while preserving checkout, Supplier Hub, scheduled sync, review aggregates, and approval workflow behavior.

The main production API remains:

```text
Firebase Hosting -> /api/** -> one modular Express API hosted as a Firebase HTTPS Function
```

No Firestore schema changes were made. No API contracts were intentionally changed.

## Dependency Audit Status

### Root project

- `npm audit fix` was reviewed without `--force`.
- The root project already resolves `firebase-admin@14.1.0`.
- `npm audit` still reports moderate transitive findings involving Google/Firebase dependencies and `uuid`.
- npm's suggested automatic root fix would install `firebase-admin@10.3.0`, which is a breaking downgrade from the current major version, so it was not applied.

### Firebase Functions

- Upgraded Functions dependencies safely:
  - `firebase-admin`: `^12.0.0` -> `^13.6.0`
  - `firebase-functions`: `^5.0.0` -> `^7.2.5`
- Attempted `firebase-admin@14.1.0` with `firebase-functions@7.2.5`, but npm rejected the tree because `firebase-functions@7.2.5` peers only allow `firebase-admin` through major 13.
- No `--force` or `--legacy-peer-deps` was used.
- Remaining moderate audit findings require a future compatible Firebase Functions release that supports `firebase-admin@14.x`, or upstream Google package fixes.

## Security Checklist

- Centralized Functions logging utility added.
- Sensitive log keys such as tokens, authorization headers, passwords, credentials, API keys, cookies, and secrets are redacted before logging.
- Checkout failures are logged server-side with sanitized context.
- Supplier connection test and supplier fetch failures are logged server-side with sanitized context.
- Scheduled supplier sync evaluation, skip reasons, source failures, final status, and fatal failures are logged server-side.
- API client responses avoid exposing raw server exceptions for 500-level failures.
- Existing checkout validation, idempotency, rate limiting, stock validation, pricing calculation, and order numbering were preserved.
- Supplier Hub admin authentication remains required on supplier API routes.
- SSRF protection remains enforced before supplier network requests.
- Scheduled sync still writes only to supplier queue/history collections and does not write directly to `products`.
- Approval remains the only Supplier Hub path that writes supplier products to `products`.
- Firestore rules were reviewed and align with the current supplier queues, supplier settings, approval audit, scheduled sync locks, review aggregate behavior, and checkout idempotency records.
- Storage rules were reviewed and still limit banner/logo writes to admins while keeping those assets publicly readable.

## Environment Checklist

Functions runtime configuration now validates on app startup:

- `ADMIN_EMAIL`
  - Optional environment override.
  - Defaults to `zyrolkofficial@gmail.com` to preserve existing behavior.
  - Empty values fail fast with a clear Functions log.

- `API_ALLOWED_ORIGINS`
  - Optional comma-separated CORS allowlist.
  - If absent, the API keeps the existing wildcard CORS behavior for compatibility.
  - If present, only matching origins receive `Access-Control-Allow-Origin`.

Recommended production setting:

```text
API_ALLOWED_ORIGINS=https://zyro.lk,https://www.zyro.lk
```

Supplier credentials remain server-side through Firestore supplier source configuration or environment variables. They are not exposed to the frontend.

## Security Headers And CORS

The Functions Express API now adds these headers:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`
- `Cache-Control: no-store`

CORS remains compatible by default and can be tightened with `API_ALLOWED_ORIGINS`.

## Remaining Known Risks

Critical:

- None identified in this sprint.

High:

- Approval failures currently originate from the client-side Firestore batch path. They can be surfaced to the admin UI, but they are not centrally visible in Functions logs unless approval is later migrated to a backend API endpoint.

Medium:

- npm audit still reports moderate Firebase/Google transitive dependency findings. A fully clean audit currently requires a dependency tree npm will not resolve safely without forcing an incompatible `firebase-admin@14.x` / `firebase-functions@7.x` combination.
- Root audit also reports a forced downgrade path for `firebase-admin`, which was rejected as unsafe.

Low:

- API CORS is still wildcard until `API_ALLOWED_ORIGINS` is configured in production.
- Some older local `console` statements remain inside lower-level supplier connector internals. Public API routes now centralize their failure logs, but future cleanup can move connector internals to the same logger.

## Launch Readiness Assessment

Status: production-ready with documented residual dependency audit risk.

The project is ready to proceed toward launch hardening with these conditions:

- Configure `API_ALLOWED_ORIGINS` before production launch.
- Monitor Firebase release compatibility so Functions can move to `firebase-admin@14.x` when `firebase-functions` supports it cleanly.
- Consider migrating Supplier Hub approval actions to a trusted backend endpoint in a later sprint if centralized approval failure observability becomes a launch requirement.

No checkout, Supplier Hub, scheduled sync, approval workflow, or review aggregate behavior was intentionally changed.
