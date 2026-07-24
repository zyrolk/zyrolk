import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSupplierAuditEvent,
  buildSupplierImportantFieldChanges,
} from '../functions/src/api/suppliers/supplierAuditTrail';

test('Sprint 5 records an allowlisted before/after change set and rollback preparation for an approval', () => {
  const queueItem = {
    id: 'queue-1',
    sourceId: 'a2z-main',
    supplierId: 'supplier-1',
    correlationId: 'correlation-1',
    retryCount: 2,
    queueCreatedAt: new Date(1_000).toISOString(),
    processingStartedAt: new Date(2_000).toISOString(),
    productPayload: { id: 'product-1' },
  };
  const beforePublic = { price: 1200, stock: 3, category: 'audio', specs: { brand: 'Old Brand' }, published: false };
  const afterPublic = { price: 1400, stock: 3, category: 'audio', specs: { brand: 'New Brand' }, published: true };
  const beforePrivate = { supplierItemCode: 'SUP-OLD', supplierPurchasePrice: 800 };
  const afterPrivate = { supplierItemCode: 'SUP-NEW', supplierPurchasePrice: 900 };

  const changes = buildSupplierImportantFieldChanges({
    queueItem,
    beforePublicProduct: beforePublic,
    afterPublicProduct: afterPublic,
    beforePrivateProduct: beforePrivate,
    afterPrivateProduct: afterPrivate,
    previousState: 'review_pending',
    newState: 'approved',
  });
  assert.deepEqual(Object.keys(changes).sort(), ['brand', 'price', 'status', 'supplierCost', 'supplierSku']);
  assert.deepEqual(changes.price, { before: 1200, after: 1400 });
  assert.deepEqual(changes.stock, undefined);

  const event = buildSupplierAuditEvent({
    queueItemId: 'queue-1', queueItem, action: 'approve', previousState: 'review_pending', newState: 'approved',
    admin: { uid: 'admin-1', email: 'admin@zyro.lk' }, reason: 'Catalog quality verified.',
    beforePublicProduct: beforePublic, afterPublicProduct: afterPublic,
    beforePrivateProduct: beforePrivate, afterPrivateProduct: afterPrivate, now: 4_000,
  }, 'event-1');
  assert.equal(event.eventId, 'event-1');
  assert.equal(event.queueItemId, 'queue-1');
  assert.equal(event.correlationId, 'correlation-1');
  assert.equal(event.adminUserId, 'admin-1');
  assert.equal(event.adminEmail, 'admin@zyro.lk');
  assert.equal(event.approvalLatencyMs, 3_000);
  assert.equal(event.processingDurationMs, 2_000);
  assert.deepEqual((event.rollback as { before: { private: unknown } }).before.private, beforePrivate);
});

test('Sprint 5 keeps Supplier Hub audit records server-created, append-only, ordered, and correlated', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  const trail = readFileSync('functions/src/api/suppliers/supplierAuditTrail.ts', 'utf8');
  const approval = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  const queue = readFileSync('functions/src/scheduled/supplierReviewQueue.ts', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');

  assert.match(rules, /match \/supplier_approval_audit\/\{docId\}[\s\S]*allow read: if isSupplierHubAdmin\(\);[\s\S]*allow create, update, delete: if false;/);
  assert.match(trail, /transaction\.create\(reference/);
  assert.match(trail, /timestamp: input\.timestamp \|\| FieldValue\.serverTimestamp\(\)/);
  assert.match(trail, /correlationId/);
  assert.match(trail, /changedFields/);
  assert.match(approval, /action: action === "approved" \? "approve"/);
  assert.match(queue, /action: "retry"/);
  assert.match(routes, /action: "resume"/);
  assert.match(routes, /supplier-review-queue\/:queueItemId\/audit", requireSupplierHubAdmin/);
  assert.match(routes, /orderBy\("timestamp", "asc"\)/);
  assert.match(routes, /nextCursor/);
  assert.match(sync, /atomicGroup: queueItemId/);
});
