import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { commerceAnalyticsItem } from '../src/services/observability/commerceAnalytics';

const source = (path: string): string => readFileSync(path, 'utf8');

test('Admin catalogue integrity checks use bounded cursor traversal instead of full collection reads', () => {
  const admin = source('src/components/AdminDashboard.tsx');
  const references = source('src/services/admin/adminCatalogReferences.ts');
  assert.doesNotMatch(admin, /getDocs\(collection\(db, ['"]products['"]\)\)/);
  assert.match(admin, /hasCategoryProductReference\(db, categoryToDelete\.id\)/);
  assert.match(admin, /hasBrandProductReference\(db, brandToDelete\)/);
  assert.match(admin, /updateBrandProductReferences\(db, editingBrand, name, now\)/);
  assert.match(references, /ADMIN_REFERENCE_SCAN_PAGE_SIZE = 200/);
  assert.match(references, /orderBy\(documentId\(\)\)/);
  assert.match(references, /startAfter\(cursor\)/);
  assert.match(references, /limit\(ADMIN_REFERENCE_SCAN_PAGE_SIZE\)/);
  assert.match(references, /if \(page\.length < ADMIN_REFERENCE_SCAN_PAGE_SIZE\) return/);
});

test('Admin operational status is custom-claim protected and aggregation backed', () => {
  const route = source('functions/src/api/routes/adminConfiguration.ts');
  const operations = source('functions/src/api/admin/adminOperations.ts');
  const app = source('functions/src/api/app.ts');
  const preview = source('server.ts');
  const admin = source('src/components/AdminDashboard.tsx');
  assert.match(route, /app\.get\('\/api\/admin\/operations-summary'/);
  assert.match(route, /verifyIdToken\(match\[1\], true\)/);
  assert.match(route, /hasAdminAccess\(token\)/);
  assert.match(operations, /query\.count\(\)\.get\(\)/);
  assert.match(operations, /notification_outbox/);
  assert.match(operations, /supplier_operational_alerts/);
  assert.match(operations, /checkout_coupons/);
  assert.match(operations, /supplier_approval_audit/);
  assert.match(app, /registerAdminConfigurationRoutes\(app, \{ auth: adminAuth, db: adminDb \}\)/);
  assert.match(preview, /registerAdminConfigurationRoutes\(app, \{ auth: adminAuth, db: adminDb \}\)/);
  assert.match(admin, /\/api\/admin\/operations-summary/);
  assert.match(admin, /Operational readiness/);
  assert.match(admin, /Email delivery/);
  assert.match(admin, /Supplier alerts/);
  assert.match(admin, /Coupons/);
  assert.match(admin, /Latest immutable supplier event/);
  assert.match(admin, /Some live administration data is unavailable/);
  assert.match(admin, /reportClientIssue\(`admin-\$\{key\}`/);
  assert.doesNotMatch(admin, /authInfo:[\s\S]*providerInfo/);
  assert.doesNotMatch(admin, /updateDoc\(doc\(db, "orders", orderList\[i\]\.id\)/);
});

test('supplier critical-alert email uses the monitored retryable outbox lifecycle', () => {
  const alerts = source('functions/src/api/suppliers/supplierOperationalAlerts.ts');
  const delivery = source('functions/src/triggers/orderNotifications.ts');
  const retries = source('functions/src/scheduled/orderNotificationRetries.ts');
  assert.match(alerts, /kind: "supplier_operational_alert"[\s\S]*attemptCount: 1[\s\S]*maxAttempts: 3[\s\S]*currentMailId: deliveryId/);
  assert.match(delivery, /isLegacySupplierAlert/);
  assert.match(delivery, /outbox\.kind === "supplier_operational_alert"/);
  assert.match(retries, /where\("status", "==", "retry_pending"\)/);
  assert.match(retries, /limit\(50\)/);
  const indexes = JSON.parse(source('firestore.indexes.json')) as {
    indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order?: string }> }>;
  };
  assert.ok(indexes.indexes.some((index) => index.collectionGroup === 'notification_outbox'
    && index.fields[0]?.fieldPath === 'status'
    && index.fields[1]?.fieldPath === 'updatedAt'
    && index.fields[1]?.order === 'DESCENDING'));
});

test('Supplier Hub metrics and alert policies are complete deployment assets', () => {
  const readme = source('monitoring/supplier-hub/README.md');
  assert.match(readme, /Select-String[\s\S]*\^name:/);
  assert.doesNotMatch(readme, /\$metric = \$_\.BaseName/);
  for (const [file, metric] of [
    ['sync-failure.json', 'supplier_hub_sync_failure'],
    ['queue-backlog.json', 'supplier_hub_queue_depth'],
    ['queue-latency.json', 'supplier_hub_queue_processing_duration_ms'],
  ]) {
    const policy = JSON.parse(source(`monitoring/supplier-hub/alert-policies/${file}`)) as {
      conditions: Array<{ conditionThreshold: { filter: string } }>;
      notificationChannels: unknown[];
    };
    assert.match(policy.conditions[0].conditionThreshold.filter, new RegExp(metric));
    assert.deepEqual(policy.notificationChannels, []);
  }
  assert.match(readme, /attach at least one verified email notification channel/);
});

test('production runbook covers backup, deploy, notification monitoring and rollback', () => {
  const runbook = source('docs/PRODUCTION_OPERATIONS_RUNBOOK.md');
  for (const contract of [
    'gcloud firestore export',
    'Firestore indexes',
    'Firestore Rules and Storage Rules',
    'Deploy Functions',
    'Deploy Hosting last',
    'Email operations',
    'Supplier monitoring',
    'Rollback',
    'isolated staging project',
  ]) assert.match(runbook, new RegExp(contract));
  assert.match(runbook, /Cash on Delivery-only/);
  assert.match(source('docs/SPRINT_84_DEPLOYMENT.md'), /historical deployment notes/);
});

test('critical storefront commerce events use bounded GA4-compatible items', () => {
  assert.deepEqual(commerceAnalyticsItem({
    id: 'product-1', name: 'Product', price: 2500, quantity: 2,
  }), {
    item_id: 'product-1', item_name: 'Product', price: 2500, quantity: 2,
  });
  assert.deepEqual(commerceAnalyticsItem({
    id: 'invalid', name: 'Invalid', price: Number.NaN, quantity: 0,
  }), {
    item_id: 'invalid', item_name: 'Invalid', price: 0, quantity: 1,
  });
  const analytics = source('src/services/observability/commerceAnalytics.ts');
  const app = source('src/App.tsx');
  const checkout = source('src/features/checkout/PremiumCheckoutDrawer.tsx');
  for (const event of ['view_item', 'view_cart', 'search', 'add_to_wishlist', 'add_to_cart', 'remove_from_cart']) {
    assert.match(analytics, new RegExp(`'${event}'`));
    assert.match(app, new RegExp(`trackCommerceEvent\\('${event}'`));
  }
  assert.match(checkout, /trackCommerceEvent\('begin_checkout'/);
  assert.match(checkout, /trackCommerceEvent\('add_payment_info'/);
  assert.match(checkout, /trackPurchaseOnce\([\s\S]*analyticsItems/);
});

test('Supplier audit remains immutable and server-authoritative', () => {
  const rules = source('firestore.rules');
  const auditRule = rules.slice(
    rules.indexOf('match /supplier_approval_audit/{docId}'),
    rules.indexOf('match /supplier_product_conflicts/{docId}'),
  );
  assert.match(auditRule, /allow read: if isSupplierHubAdmin\(\)/);
  assert.match(auditRule, /allow create, update, delete: if false/);
});
