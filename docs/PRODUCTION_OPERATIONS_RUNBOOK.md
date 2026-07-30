# Zyro.lk production operations runbook

This is the launch runbook for the current **Cash on Delivery-only** release.
PayHere source code is retained for a future controlled rollout, but its routes
and Secret Manager binding are intentionally disabled.

## Ownership and release gates

- Firebase project: `zyrolk-e0164`
- Hosting: `https://zyro.lk`, `https://www.zyro.lk`, and the Firebase Hosting fallback domain
- Required Function secrets: `A2Z_USERNAME`, `A2Z_PASSWORD`
- Required controls: production origin allowlist, App Check enforcement,
  approved supplier domains, and the configured Firebase Storage bucket
- Required notification dependency: Firebase Trigger Email extension with a
  verified sender

Do not deploy unless lint, the complete test suite, storefront build, Functions
build and `git diff --check` pass from the exact release revision.

## Backup before every production release

1. Use a dedicated backup bucket with retention and object versioning. Keep its
   name outside source control in `ZYRO_BACKUP_BUCKET`.
2. Create and verify a release-scoped Firestore export:

   ```powershell
   $ZyroProject = 'zyrolk-e0164'
   $ZyroBackupBucket = $env:ZYRO_BACKUP_BUCKET
   if (-not $ZyroBackupBucket) { throw 'ZYRO_BACKUP_BUCKET is required' }
   $ZyroBackupId = 'release-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
   gcloud firestore export "gs://$ZyroBackupBucket/firestore/$ZyroBackupId" --project=$ZyroProject
   gcloud firestore operations list --project=$ZyroProject
   ```

3. Confirm the export operation completed before deploying.
4. Confirm Storage object versioning and retention for
   `gs://zyrolk-e0164.firebasestorage.app`. Firestore exports do not contain
   Storage objects.
5. Record the Git revision, export path, rules revision and operator in the
   release record.

## Safe deployment order

1. `firebase use` and `gcloud config get-value project` must both identify
   `zyrolk-e0164`.
2. Verify `A2Z_USERNAME` and `A2Z_PASSWORD` exist without printing values.
3. Run the complete validation pipeline.
4. Create and verify the Firestore export above.
5. Deploy Firestore indexes and wait until every required index reports ready.
6. Deploy Firestore Rules and Storage Rules.
7. Deploy Functions, including scheduled workers and triggers.
8. Deploy Hosting last so the browser never precedes its API contract.
9. Verify App Check, allowed origins and Supplier Hub monitoring.
10. Smoke test browse, search, cart, COD checkout, orders, Admin order handling,
    supplier sync, Product Review and email delivery status.

```powershell
npm run lint
npm test
npm run build
npm --prefix functions run build
git diff --check
firebase deploy --only firestore:indexes --project zyrolk-e0164
firebase deploy --only firestore:rules,storage --project zyrolk-e0164
firebase deploy --only functions --project zyrolk-e0164
firebase deploy --only hosting --project zyrolk-e0164
```

## Email operations

- Admin Dashboard > Operational readiness shows delivered, processing,
  retry-pending and terminally failed outbox totals.
- `retryOrderNotifications` runs every five minutes against a bounded, indexed
  retry page.
- For terminal failures, verify Trigger Email extension health, sender status
  and the sanitized failure reason. Never copy recipient data into incidents.
- Supplier critical-alert emails use the same monitored outbox lifecycle.

## Supplier monitoring

Deploy metrics and alert policies using `monitoring/supplier-hub/README.md`.
Attach and test a verified email notification channel before launch. Supplier
Hub Activity remains the operational source for sync history, recovery actions,
alerts and immutable supplier audit history.

## Rollback

1. Stop and record the incident. Do not run migrations or manual data edits
   while rollback is being evaluated.
2. Hosting: roll back to the immediately previous Firebase Hosting release from
   the Firebase console, then verify the storefront and API compatibility.
3. Functions: check out the recorded previous release revision, rebuild it and
   deploy Functions only. Scheduled Functions are versioned with that source.
4. Rules/indexes: deploy the recorded previous `firestore.rules`,
   `storage.rules`, and `firestore.indexes.json`. Never weaken rules merely to
   recover UI access.
5. Data: first import the backup into an isolated staging project and verify
   document counts and business workflows. Firestore import merges documents;
   it does not remove documents created after the export. Prepare an explicit
   reconciliation list before any production import.
6. Storage: recover individual object generations from the versioned bucket.
7. Repeat checkout, inventory, orders, Supplier Hub and notification smoke tests.

## Recovery evidence

Every release record must retain the Git revision, validation output, deployed
Function revision, Hosting release, Firestore export operation, index status,
monitoring policy status, notification test and rollback decision owner.
