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
