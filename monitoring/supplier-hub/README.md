# Supplier Hub Cloud Monitoring

Supplier Hub emits structured `supplier_hub_operational_metric` entries through
the Firebase Functions logger. These definitions convert those entries into
Cloud Monitoring log-based metrics without adding network calls to operational
request paths.

Apply each definition to the production project with the Google Cloud CLI:

```powershell
Get-ChildItem monitoring/supplier-hub/*.yaml | ForEach-Object {
  $metric = (Select-String -Path $_.FullName -Pattern '^name:\s*(.+)$').Matches[0].Groups[1].Value.Trim()
  gcloud logging metrics describe $metric *> $null
  if ($LASTEXITCODE -eq 0) {
    gcloud logging metrics update $metric --config-from-file $_.FullName
  } else {
    gcloud logging metrics create $metric --config-from-file $_.FullName
  }
}
```

The metric name is read from each definition instead of inferred from its file
name. This keeps the deployed `supplier_hub_*` names aligned with the checked-in
metric definitions.

## Alert policies

The `alert-policies` directory contains production thresholds for sync failure,
sustained Product Review backlog and queue-processing latency. Create them only
after the log-based metrics are receiving production data:

```powershell
Get-ChildItem monitoring/supplier-hub/alert-policies/*.json | ForEach-Object {
  gcloud alpha monitoring policies create --policy-from-file=$_.FullName
}
```

The definitions contain no environment-specific notification-channel IDs.
Before launch, attach at least one verified email notification channel to every
policy in Cloud Monitoring and send a test notification. The application-level
Supplier Hub alert engine remains the primary critical-alert email path; Cloud
Monitoring provides an independent infrastructure signal.

The application code does not create or update cloud resources at runtime.
Provisioning remains an explicit deployment operation with the appropriate IAM
authorization. No supplier identifiers, job identifiers, or queue identifiers
are extracted as metric labels; those values remain available only as structured
log context to avoid unbounded metric cardinality.

## Launch verification gate

Repository definitions are not proof that production resources exist. Before
GO, the release operator must record:

1. All six `supplier_hub_*` log-based metrics exist in the intended project and
   receive a controlled test sample.
2. Sync failure, review backlog and queue-latency policies are enabled.
3. Every policy has a verified notification channel even though the checked-in
   policy deliberately keeps `notificationChannels` empty.
4. A test notification reaches the on-call mailbox and has a named response
   owner.
5. The application alert engine creates and emails critical
   `supplier_sync_failure`, `dead_letter_created`, `queue_worker_failure` and
   `scheduler_failure` alerts through the existing notification outbox.
6. Admin operational readiness shows delivered, retry-pending and terminally
   failed email totals from the existing order/Supplier alert outbox.

Cloud policies for order/checkout failures are not defined in this directory.
Use the existing structured Functions logs and Admin operational readiness for
the COD launch, and configure Console alerts only for signals that are actually
emitted. Do not represent a Console-only policy as deployed until it has been
created and tested.
