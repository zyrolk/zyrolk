# Zyro.lk production operations runbook

This is the only current launch procedure for the **Cash on Delivery-only**
release. PayHere source remains disabled and its historical checklists are not
deployment instructions for this release.

## Ownership and immutable release evidence

- Firebase project: `zyrolk-e0164`
- Hosting origins: `https://zyro.lk`, `https://www.zyro.lk`, and the approved
  Firebase Hosting fallback domain
- Required Function secrets: `A2Z_USERNAME` and `A2Z_PASSWORD`
- Required operator roles: release owner, Firebase/GCP operator, smoke-test
  owner, rollback owner, and incident owner
- Required release record: Git revision/tag, validation output, backup export,
  Rules/index revisions, Functions revision, Hosting release, configuration
  verification, smoke-test result, and GO/NO-GO decision

No production command may be run from an uncommitted or dirty working tree.

## Release and change freeze

1. Announce an Admin/Supplier maintenance window. Customer browsing may remain
   available, but pause product, category, brand, supplier, approval and order
   administration while migrations and coordinated deployment run.
2. Review every staged file and create an approved immutable release commit and
   tag. Record both identifiers before any deployment.
3. Require a clean working tree and run the complete validation gate on the
   exact release revision using Node 20.
4. Run `npm run release:config:check`. This checks repository configuration
   only; it does not claim that Firebase Console resources are configured.
5. Stop if any required emulator test skips or any validation command fails.

```powershell
npm run release:config:check
npm run lint
npm test
npm run build
npm --prefix functions run build
git diff --check
```

CI starts Firestore, Auth, Functions and Storage emulators with a `demo-*`
project and runs `npm run test:emulator-critical`. Preserve the CI log with the
release record.

## Backup requirement

Before Rules, Functions, Hosting or data migration changes:

1. Use a dedicated backup bucket with retention and object versioning. Keep its
   name outside source control in `ZYRO_BACKUP_BUCKET`.
2. Create a release-scoped Firestore export and wait for completion.

```powershell
$ZyroProject = 'zyrolk-e0164'
$ZyroBackupBucket = $env:ZYRO_BACKUP_BUCKET
if (-not $ZyroBackupBucket) { throw 'ZYRO_BACKUP_BUCKET is required' }
$ZyroBackupId = 'release-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
gcloud firestore export "gs://$ZyroBackupBucket/firestore/$ZyroBackupId" --project=$ZyroProject
gcloud firestore operations list --project=$ZyroProject
```

3. Record the completed export operation and object path.
4. Verify object versioning and retention on the production Storage bucket.
   Firestore export does not back up Storage objects.
5. Confirm the rollback owner can read the backup without granting public
   access or broader application permissions.

## Production Console gates

These checks cannot be proven from source control. Record evidence for every
item before deployment:

- `firebase use` and `gcloud config get-value project` both identify
  `zyrolk-e0164`.
- Firebase Authentication enables only approved launch providers, including
  email/password and Google if Google sign-in is exposed.
- `zyro.lk`, `www.zyro.lk`, and the approved Hosting fallback are registered as
  Auth authorized domains.
- Apex and `www` DNS, canonical redirect and HTTPS certificates are healthy.
- The production web app/domain is registered with Firebase App Check and the
  deployed API enforces App Check.
- The Hosting build receives the production
  `VITE_FIREBASE_APP_CHECK_SITE_KEY`; no server secret is present in a Vite
  variable.
- `API_ALLOWED_ORIGINS` contains only exact approved HTTPS origins. Do not use
  `*` and do not include trailing paths.
- `REQUIRE_APP_CHECK=true` is effective for deployed Functions.
- `ALLOWED_SUPPLIER_DOMAINS` and stored supplier URLs contain only approved
  supplier hosts. Server SSRF validation remains authoritative.
- Firestore uses `firestore.rules` and `firestore.indexes.json`; Storage uses
  `storage.rules`; Hosting publishes `dist` and routes `/api/**` to `api`.
- The Trigger Email extension, Cloud Monitoring policies, notification
  channels, scheduled Functions and service accounts are configured as
  described below.

## Admin custom claims

Admin authorization is based on Firebase custom claims, never email matching or
a browser-writable profile field.

1. Select the intended administrator account and run the dry-run without
   sharing its token or UID in release notes:

   ```powershell
   npm run security:admin-claims:dry-run -- --email=<approved-admin-email>
   ```

2. Confirm the Firebase project and account with a second operator.
3. Set `ADMIN_CLAIM_MIGRATION_CONFIRM=zyrolk-e0164` only in the approved operator
   process and run the apply command.
4. Force the account to refresh its ID token, then verify Admin Product,
   Supplier Hub and Product Review access.
5. Verify an ordinary authenticated account receives `403` and a revoked Admin
   session receives `401` for privileged operations.

## A2Z credential profiles

Supplier documents may contain only a safe credential profile identifier. Raw
usernames, passwords, tokens and headers must never be stored in Firestore,
jobs, history, audit records, URLs, browser state or logs.

`A2Z_USERNAME` and `A2Z_PASSWORD` are separate Secret Manager values. Each may
use either:

- the legacy scalar value for the single `a2z-global` profile; or
- an `a2z-profiles-v1:` prefix followed by a JSON object keyed by allowlisted
  profile ID.

For profile-map mode, both secrets must use the same profile keys and exact host
bindings. Conceptual shape only:

```text
a2z-profiles-v1:{
  "a2z-global": {"value":"<secret-value>","allowedHosts":["exact-host.example"]},
  "supplier-profile": {"value":"<secret-value>","allowedHosts":["exact-host.example"]}
}
```

The username map contains username values and the password map contains
password values. Never place a real map in source control, a command argument,
CI logs or release notes. Update secrets using an approved non-echoing Secret
Manager workflow.

Rules:

- Keep an `a2z-global` entry in **both** maps while legacy sources still use it.
- A new independent A2Z source must reference its own configured profile.
- Host binding is exact; no wildcard or path is accepted.
- Targets must use HTTPS.
- The username and password host lists must agree.
- Test Connection and actual Sync use the same resolver. Run both after any
  credential change.
- Roll back by restoring the previous Secret Manager versions, not by writing
  credentials into Firestore.

## Firestore index deployment

Deploy indexes first and wait until every required index reports `READY`.
Do not continue while an index is building or failed.

```powershell
firebase deploy --only firestore:indexes --project zyrolk-e0164
```

Verify the Product Review history, queue retry/lease, sync-job, order
reservation, active category-product and approved review query shapes.

## Security migration gate

Keep the Admin/Supplier change freeze active. Do not execute either apply step
without the completed backup and explicit two-person approval.

### Product commercial-data migration

Public `products` documents must contain none of the fields listed by
`COMMERCIAL_PRODUCT_FIELDS`. Commercial values belong in `product_private`.

1. Run `npm run security:products:dry-run` using approved Application Default
   Credentials.
2. Inspect only counts and field names; the tool must not print field values.
3. If required, set `PRODUCT_SECURITY_MIGRATION_CONFIRM=zyrolk-e0164` in the
   operator process and run `npm run security:products:apply`.
4. Re-run the dry-run and require `productsRequiringMigration: 0`.

### Review and question ownership-data migration

Public `reviews` and `productQuestions` documents must not contain `userId` or
internal `orderId` ownership evidence. That evidence belongs in the server-only
`review_private` and `product_question_private` companion documents.

1. Deploy the reviewed Functions revision first so all new reviews/questions
   are written using the split public/private contract. Keep the review change
   freeze active until Rules are deployed.
2. Run `npm run security:reviews:dry-run` using approved Application Default
   Credentials and inspect counts only.
3. If required, set `REVIEW_OWNERSHIP_MIGRATION_CONFIRM=zyrolk-e0164` in the
   operator process and run `npm run security:reviews:apply`.
4. Re-run the dry-run and require `documentsRequiringMigration: 0` and
   `unsafePublicDocuments: 0`.
5. Deploy the reviewed Firestore Rules only after zero-result verification.
   The Rules deliberately fail closed on any unmigrated public document.

### Supplier credential migration

1. Run `npm run security:supplier-credentials:dry-run`.
2. Inspect only counts and credential-path names.
3. Confirm every affected source already has a valid Secret Manager profile.
4. If required, set
   `SUPPLIER_SOURCE_CREDENTIAL_MIGRATION_CONFIRM=zyrolk-e0164` and run
   `npm run security:supplier-credentials:apply`.
5. Re-run the dry-run and require `sourcesRequiringCredentialRemoval: 0`.
6. Test Connection for every configured supplier before enabling Auto Sync.

The migrations are not a rollback mechanism. Never restore commercial fields
to public products, ownership evidence to public review/question documents, or
raw credentials to supplier documents.

## Trigger Email and operational monitoring

### Email operations

- Install/configure the Firebase Trigger Email extension against the existing
  `mail` handoff and use a verified sender.
- Place one controlled COD order and verify customer/admin messages progress
  from `notification_outbox` to delivered state.
- Verify `retryOrderNotifications` processes `retry_pending` records and that a
  terminal failure is visible in Admin operational readiness.
- Verify duplicate order events do not create duplicate logical emails.
- Supplier critical alerts use the same monitored email delivery lifecycle.

### Supplier monitoring

1. Create/update the six log-based metrics from `monitoring/supplier-hub/`.
2. Create the sync-failure, review-backlog and queue-latency policies only after
   their metrics receive data.
3. Attach at least one verified notification channel to every policy and send a
   test notification. Repository policy files intentionally contain no channel
   IDs.
4. Exercise a safe test alert and verify both application alert history and
   email handoff.
5. Confirm the application alert engine exposes sync failure, dead-letter,
   queue worker failure and scheduler failure. Do not invent a second alert
   engine.

### Order and checkout operations

- Verify Admin operational readiness reports notification delivery,
  retry-pending and terminal failure counts.
- Verify structured checkout/order Function errors reach the configured logging
  and alerting destination without customer or payment data leakage.
- Monitor checkout rejection rate, reservation-expiry failures, order trigger
  errors and email terminal failures. Add Console policies only for supported
  structured logs/metrics; do not claim repository policies that do not exist.

## Scheduler and Function verification

After Functions deployment, verify the deployed revision, service account,
secret bindings, last run and next run for:

- `scheduledSupplierSync` — every 15 minutes, with per-source Hourly / Every 3
  Hours / Every 6 Hours / Daily eligibility
- `supplierSyncJobCreated` and `scheduledSupplierSyncJobDispatcher` — durable
  sync jobs and one-minute recovery dispatch
- `scheduledSupplierQueueWorker` — five-minute Product Review queue processing
- `scheduledSupplierOperationalAlerts` — five-minute alert evaluation
- `expirePaymentReservations` — five-minute COD reservation expiry
- `sendOrderNotifications`, `trackOrderNotificationDelivery`, and
  `retryOrderNotifications` — email handoff, delivery and five-minute retry

Supplier schedulers use `Asia/Colombo`. Do not invoke production schedulers as a
substitute for a controlled manual smoke test.

## Safe deployment order

1. Complete the release/change freeze and immutable release record.
2. Complete production Console, admin-claim, App Check, Auth and credential
   gates without printing secrets.
3. Run the complete validation and emulator gate on the release revision.
4. Create and verify Firestore/Storage backups.
5. Deploy Firestore indexes and wait for `READY`.
6. Deploy Functions, including the split review/Q&A writes, scheduled workers
   and triggers.
7. Run all three security migration dry-runs; apply only approved required
   changes; require zero-result verification.
8. Deploy Firestore Rules and Storage Rules. Do not deploy the review read
   fence before the ownership-data migration is verified at zero.
9. Verify Function revisions, IAM, secrets, schedules, Trigger Email and
   monitoring channels.
10. Build Hosting with the production App Check key. Deploy Hosting last.
11. Run the production smoke-test checklist and record GO/NO-GO.

```powershell
firebase deploy --only firestore:indexes --project zyrolk-e0164
firebase deploy --only functions --project zyrolk-e0164
firebase deploy --only firestore:rules,storage --project zyrolk-e0164
firebase deploy --only hosting --project zyrolk-e0164
```

## Production smoke-test checklist

Use dedicated customer, Admin and Supplier test accounts. Do not use production
customer orders or supplier credentials in screenshots/logs.

### Customer commerce

- Homepage, categories, search, product details, images, price and active stock
  load from bounded catalogue queries.
- Email/password registration/login and Google login work; unauthorized Admin
  and Supplier routes remain denied.
- Wishlist, compare and cart preserve canonical Product IDs.
- Guest and authenticated COD checkout use server price/stock.
- Duplicate checkout submission returns one logical order.
- Price change, insufficient stock and inactive product fail closed.
- Customer cancellation and controlled reservation expiry restore stock once.
- My Orders shows the resulting immutable order/item snapshots.
- Every new checkout creates a server-only `order_private/{orderId}` companion
  with immutable per-line Product ID/SKU and purchase-time supplier-offer
  attribution. Customer totals continue to come from the public product; cost
  and supplier routing evidence never enter the customer order document.

### Admin catalogue and orders

- Manual product creation returns a server Product ID and SKU and creates one
  SKU claim/audit.
- Retry with the same idempotency key returns the same logical product.
- Product update preserves Product ID/SKU; archive hides the product without
  deleting history or releasing SKU ownership.
- Admin order status follows the transition matrix and preserves inventory.
- Supplier assignment is permitted only after the order is confirmed and its
  stock reservation is committed. Supplier fulfilment cannot begin while the
  order remains pending or its inventory remains reserved.
- Reservation expiry may cancel and restore only an unassigned pending order;
  expiry and Admin/customer cancellation fail closed after supplier fulfilment
  starts, and reassignment is blocked once fulfilment starts.
- Before routing supplier-backed catalogue products, set and verify the
  server-managed `supplierSources/{sourceId}.supplierAccountId` against an
  active Supplier Portal account. Missing/inactive mappings fail checkout
  closed; credential changes do not change source ownership.
- New supplier-backed orders derive deterministic fulfilment groups inside the
  server-only `order_private/{orderId}` document from immutable purchase-time
  line attribution. Lines for the same Supplier Portal account share one group;
  mixed-supplier orders keep independent groups and internal lines are not
  silently assigned to a supplier.
- Admin assignment is permitted only to the active Supplier Portal account
  captured for every line in that group and only while the current source
  ownership still matches. Supplier progression is revision-fenced and limited
  to assigned -> accepted -> processing -> packed -> shipped. A decline may
  return only an untouched assigned group to unassigned; reassignment after
  acceptance is prohibited.
- The public order contains only non-sensitive aggregate fulfilment state.
  Supplier account/source/offer identifiers, item codes and purchase costs stay
  in `order_private`; suppliers receive only their assigned group projection.
  Admin marks delivery only after every group is shipped.
- A supplier records one bounded courier name and tracking number only while its
  group is `packed`. The trusted transaction records tracking, advances that
  group to `shipped`, increments both revisions, writes immutable operational
  audit, and publishes only the customer-safe shipment projection. Tracking is
  then supplier-immutable. Admin correction is a separate revision-fenced API
  whose audit retains the prior bounded courier and number; it never changes
  supplier attribution or moves the group backward.
- Suppliers cannot submit tracking URLs. No courier templates are currently
  verified, so `trackingUrl` remains null and customers see the courier and
  tracking number without an external link. There is no courier API or
  automatic logistics integration.
- Fulfilment assignment, decline, shipment and delivery notifications reuse
  the existing `supplier_notifications`, `notification_outbox` and Trigger
  Email `mail` pipeline. Their deterministic IDs are derived from the committed
  revision-fenced fulfilment event, so transaction retries and duplicate API
  calls cannot create a second logical notification. Assignment is visible to
  the assigned Supplier Portal account; decline is visible in the Admin alert
  center; shipment/delivery remain visible in My Orders and are emailed when
  order email notifications are enabled.
- Shipment and delivery messages use only the customer-safe order/shipment
  projection. Supplier account/source/offer IDs, supplier item codes, costs and
  private audit data must never enter customer email. Supplier assignment
  messages are group-scoped. No email is sent directly from a transaction: the
  transaction atomically hands off to the existing outbox and retry pipeline.
- Cancellation continues to use the existing order-status notification path.
  Status-change fencing prevents a duplicate cancellation email, and SH-7E
  does not introduce a second cancellation event or notification queue.
- Legacy orders remain readable without `order_private`. Do not guess or
  automatically backfill historical supplier attribution; future fulfilment
  mutations must fail closed and identify such orders for explicit Admin
  handling.
- An ordinary user is denied; a deliberately revoked Admin test session is
  rejected on privileged APIs.

### Supplier and Product Review

- Add/configure supplier, Test Connection, Save, then manually run the initial
  Full Sync. Save alone must not start synchronization.
- New product remains absent from storefront until approval.
- Approve one new product and verify mapping, approved offer, Product ID/SKU,
  public/private product and audit consistency.
- Exercise price/stock/content update approval and verify no pre-approval public
  mutation.
- Exercise removal rejection and a separate removal approval.
- Verify duplicate conflict remains visible and unpublished.
- Enable Auto Sync and confirm source-specific next run, job history, queue
  processing and alert visibility.

### Rules, media, notifications and operations

- Direct browser writes to `products`, `product_private`, `zyro_sku_claims`,
  Supplier Hub queues/offers/jobs and approval audit are denied.
- Public product reads contain no commercial fields.
- Supplier original/review media cannot be browser-written or publicly read;
  approved managed variants remain available.
- Order and Supplier alert emails are delivered and retry/terminal status is
  visible.
- Cloud Monitoring test notifications reach the verified channel.
- Scheduler last-success timestamps advance without duplicate work.

Any security-boundary failure, duplicate identity/SKU/order, unexplained stock
change, pre-approval publication, missing index, missing email, dead scheduler,
or failed rollback prerequisite is a NO-GO.

## Rollback procedure

1. Stop and record the incident; restore the Admin/Supplier change freeze.
2. Hosting: roll back to the immediately previous recorded Hosting release.
3. Functions: check out the recorded previous revision, build it with its
   declared Node runtime and deploy Functions only.
4. Rules/indexes: deploy the recorded previous reviewed files. Never weaken
   Rules merely to recover UI access.
5. Secrets: restore an approved prior Secret Manager version. Never copy secret
   values into Firestore, environment documentation or incident notes.
6. Data: first import the backup into an isolated staging project and reconcile
   documents created after the export. Firestore import merges; it does not
   remove later documents.
7. Storage: recover individual object generations from the versioned bucket.
8. Never restore commercial fields to public products or raw supplier
   credentials to supplier documents during rollback.
9. Repeat checkout, inventory, orders, Supplier Hub, Product Review, media,
   notifications and scheduler smoke tests before reopening administration.

## Release closure

The release record must contain the immutable Git revision/tag, validation and
emulator totals, dependency-audit result, Firestore export, Storage retention
evidence, index status, Rules revisions, migration zero-results, admin-claim
verification, App Check/Auth/domain verification, Secret Manager version IDs
(not values), deployed Function and Hosting revisions, scheduler status,
notification test, smoke-test result, rollback owner and final GO/NO-GO owner.
