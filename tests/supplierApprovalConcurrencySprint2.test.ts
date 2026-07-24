import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSupplierProductApprovalBaseline,
  detectSupplierApprovalConflict,
  rebaseSupplierApprovalConflict,
  reconcileSupplierApprovalStock,
} from '../functions/src/api/suppliers/supplierApprovalConcurrency';
import { buildSupplierAuditEvent } from '../functions/src/api/suppliers/supplierAuditTrail';

const product = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Wireless Headphones',
  description: 'Original description',
  imageUrl: 'https://supplier.example/main.jpg',
  imageUrls: ['https://supplier.example/main.jpg', 'https://supplier.example/side.jpg'],
  category: 'audio',
  specs: { brand: 'Acme', color: 'Black' },
  price: 5_000,
  originalPrice: 5_500,
  stock: 10,
  isActive: true,
  active: true,
  visible: true,
  published: true,
  ...overrides,
});

test('Sprint 2 detects stale and concurrent approvals without treating stock movements as catalog conflicts', () => {
  const baseline = buildSupplierProductApprovalBaseline('product-1', product(), '2026-07-23T00:00:00.000Z');
  const stale = detectSupplierApprovalConflict(baseline, 'product-1', product({ name: 'Admin title edit' }));
  assert.equal(stale?.reason, 'product_changed_after_queue');
  assert.deepEqual(stale?.changedFields, ['title']);

  // A checkout reservation changes stock only. It must be reconciled, not treated
  // as a stale catalog overwrite.
  assert.equal(detectSupplierApprovalConflict(baseline, 'product-1', product({ stock: 8 })), null);

  const rebased = rebaseSupplierApprovalConflict(baseline, 'product-1', product({ name: 'Admin title edit', stock: 8 }));
  assert.equal(detectSupplierApprovalConflict(rebased, 'product-1', product({ name: 'Admin title edit', stock: 8 })), null);
  const concurrentSecondEdit = detectSupplierApprovalConflict(rebased, 'product-1', product({ name: 'Second admin edit', stock: 8 }));
  assert.deepEqual(concurrentSecondEdit?.changedFields, ['title']);
});

test('Sprint 2 protects admin price, description, image, category, brand, specification, compare-price, and visibility edits', () => {
  const baseline = buildSupplierProductApprovalBaseline('product-1', product());
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ price: 5_100 }, 'price'],
    [{ description: 'Admin description edit' }, 'description'],
    [{ imageUrls: ['https://supplier.example/replaced.jpg'], imageUrl: 'https://supplier.example/replaced.jpg' }, 'images'],
    [{ category: 'premium-audio' }, 'category'],
    [{ specs: { brand: 'Admin Brand', color: 'Black' } }, 'brand'],
    [{ specs: { brand: 'Acme', color: 'Blue' } }, 'specifications'],
    [{ originalPrice: 5_900 }, 'comparePrice'],
    [{ visible: false }, 'visibility'],
  ];
  for (const [change, expectedField] of cases) {
    const conflict = detectSupplierApprovalConflict(baseline, 'product-1', product(change));
    assert.equal(conflict?.changedFields.includes(expectedField as never), true, expectedField);
  }
});

test('Sprint 2 inventory reconciliation preserves reservations and intervening adjustments', () => {
  // Supplier moved from 10 to 12 (+2), while checkout reserved two units (live 8).
  assert.equal(reconcileSupplierApprovalStock(10, 8, 12, true), 10);
  // The same supplier delta is added after an administrator adjustment to 15.
  assert.equal(reconcileSupplierApprovalStock(10, 15, 12, true), 17);
  // A supplier reduction cannot make the live quantity negative.
  assert.equal(reconcileSupplierApprovalStock(10, 2, 0, true), 0);
  assert.equal(reconcileSupplierApprovalStock(0, 0, 7, false), 7);
});

test('Sprint 2 manual conflict resolution rebases protected data but preserves the immutable inventory baseline', () => {
  const baseline = buildSupplierProductApprovalBaseline('product-1', product({ stock: 10 }));
  const current = product({ description: 'Admin edit', stock: 7 });
  const conflict = detectSupplierApprovalConflict(baseline, 'product-1', current);
  assert.deepEqual(conflict?.changedFields, ['description']);

  const resolutionBaseline = rebaseSupplierApprovalConflict(baseline, 'product-1', current);
  assert.equal(resolutionBaseline.stockAtCapture, 10);
  assert.equal(detectSupplierApprovalConflict(resolutionBaseline, 'product-1', current), null);
  assert.equal(reconcileSupplierApprovalStock(resolutionBaseline.stockAtCapture, 7, 12, true), 9);
});

test('Sprint 2 conflict events preserve actor, reason, versions, and field-level old/new values', () => {
  const baseline = buildSupplierProductApprovalBaseline('product-1', product());
  const conflict = detectSupplierApprovalConflict(baseline, 'product-1', product({ price: 5_250 }));
  assert.ok(conflict);
  const event = buildSupplierAuditEvent({
    queueItemId: 'queue-1',
    queueItem: { productPayload: { id: 'product-1' }, sourceId: 'a2z', supplierId: 'supplier-1' },
    action: 'approval_conflict',
    previousState: 'review_pending',
    newState: 'conflict',
    admin: { uid: 'admin-1', email: 'admin@zyro.lk' },
    reason: conflict.reason,
    conflict,
    now: 1_000,
  }, 'audit-1');
  assert.equal(event.action, 'approval_conflict');
  assert.equal(event.adminUserId, 'admin-1');
  assert.deepEqual((event.changedFields as Record<string, unknown>).price, { before: 5_000, after: 5_250 });
  assert.deepEqual(event.approvalConflict, {
    reason: 'product_changed_after_queue',
    detectedFields: ['price'],
    previousVersion: baseline.version,
    currentVersion: conflict.currentVersion,
  });
});

test('Sprint 2 production queue creation and approval paths carry and transactionally enforce baselines', () => {
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const portal = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');
  const approval = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');

  assert.match(sync, /approvalBaseline: buildSupplierProductApprovalBaseline/);
  assert.match(portal, /approvalBaseline: buildSupplierProductApprovalBaseline/);
  assert.match(approval, /transaction\.get\(productReference\)/);
  assert.match(approval, /detectSupplierApprovalConflict/);
  assert.match(approval, /queueState: "conflict"/);
  assert.match(approval, /status: "CONFLICT"/);
  assert.match(approval, /approvalAttemptCount: FieldValue\.increment\(1\)/);
  assert.match(approval, /reconcileSupplierApprovalStock/);
  assert.match(routes, /resolveConflict: req\.body\?\.resolveConflict === true/);
  assert.match(routes, /res\.status\(result\.success \? 200 : 409\)/);
});
