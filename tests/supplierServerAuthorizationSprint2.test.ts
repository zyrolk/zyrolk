import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  parseSupplierApprovalDraft,
  parseSupplierReviewQueueItemIds,
} from '../functions/src/api/suppliers/supplierApproval';

test('Sprint 2 accepts only a bounded, validated admin review draft', () => {
  const draft = parseSupplierApprovalDraft({
    productName: '  Zyro Wireless Headphones  ',
    sellingPrice: 4500,
    comparePrice: 5000,
    stock: 8,
    category: 'audio',
    brand: 'Zyro Select',
    isActive: true,
    primaryImageUrl: 'https://supplier.example/headphones.jpg',
    galleryImageUrls: ['https://supplier.example/headphones-side.jpg'],
  });

  assert.deepEqual(draft, {
    productName: 'Zyro Wireless Headphones',
    sellingPrice: 4500,
    comparePrice: 5000,
    stock: 8,
    category: 'audio',
    brand: 'Zyro Select',
    isActive: true,
    primaryImageUrl: 'https://supplier.example/headphones.jpg',
    galleryImageUrls: ['https://supplier.example/headphones-side.jpg'],
  });
  assert.throws(() => parseSupplierApprovalDraft({ ...draft, stock: 1.5 }), /Stock is invalid/);
  assert.throws(() => parseSupplierApprovalDraft({ ...draft, primaryImageUrl: 'javascript:alert(1)' }), /valid supplier product image/);
  assert.throws(() => parseSupplierApprovalDraft({ ...draft, comparePrice: 100 }), /Compare price/);
});

test('Sprint 2 rejects duplicate, path-like, and oversized bulk queue identifiers', () => {
  assert.deepEqual(parseSupplierReviewQueueItemIds(['review-1', 'change-review-2']), ['review-1', 'change-review-2']);
  assert.throws(() => parseSupplierReviewQueueItemIds(['review-1', 'review-1']), /unique/);
  assert.throws(() => parseSupplierReviewQueueItemIds(['../products/live']), /invalid/);
  assert.throws(() => parseSupplierReviewQueueItemIds([]), /between one and 100/);
});

test('Supplier Hub queue decisions are Functions-authoritative and transaction guarded', () => {
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const approval = readFileSync('functions/src/api/suppliers/supplierApproval.ts', 'utf8');
  const hub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  const legacyDashboard = readFileSync('src/components/AdminDashboard.tsx', 'utf8');
  const legacyDecisionService = readFileSync('src/services/supplierQueueService.ts', 'utf8');

  assert.match(routes, /supplier-review-queue\/:queueItemId\/approve", requireSupplierHubAdmin/);
  assert.match(routes, /supplier-review-queue\/bulk-approve", requireSupplierHubAdmin/);
  assert.match(routes, /supplier-review-queue\/bulk-reject", requireSupplierHubAdmin/);
  assert.match(approval, /await db\.runTransaction/);
  assert.match(approval, /Supplier review item is no longer pending/);
  assert.match(approval, /supplier_approval_audit/);
  assert.match(approval, /supplier_notifications/);
  assert.match(approval, /const terminalState = action === "approved" \? "approved"/);
  assert.doesNotMatch(hub, /approveSupplierQueueItem\(/);
  assert.doesNotMatch(hub, /rejectSupplierQueueItem\(/);
  assert.doesNotMatch(hub, /deleteSupplierQueueItem\(/);
  assert.doesNotMatch(legacyDashboard, /approveSupplierQueueItem\(/);
  assert.doesNotMatch(legacyDashboard, /rejectSupplierQueueItem\(/);
  assert.match(hub, /postSupplierApi\('\/api\/supplier-review-queue\/bulk-approve'/);
  assert.match(legacyDashboard, /\/api\/supplier-review-queue\/\$\{encodeURIComponent\(queueItemId\)\}/);
  assert.doesNotMatch(legacyDecisionService, /writeBatch\(|batch\.commit\(/);
  assert.match(legacyDecisionService, /\/api\/supplier-review-queue\//);
});

test('Supplier Hub authorization accepts only revocation-checked server-verifiable admin claims', () => {
  const middleware = readFileSync('functions/src/api/middleware/supplierHubAdminAuth.ts', 'utf8');
  assert.match(middleware, /adminAuth\.verifyIdToken/);
  assert.match(middleware, /verifyIdToken\(match\[1\], true\)/);
  assert.match(middleware, /claims\.admin === true/);
  assert.doesNotMatch(middleware, /collection\("users"\)/);
  assert.match(middleware, /res\.locals\.supplierAdmin/);
});
