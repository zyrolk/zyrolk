import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertSupplierOrderTransition,
  calculateSupplierSummary,
  normalizeSupplierSku,
  sanitizeSupplierProductDraft,
  sanitizeSupplierProfile,
  supplierOwnsOrder,
  validateSupplierProductForSubmission,
} from '../functions/src/api/suppliers/supplierPortalLogic';
import { buildSupplierQueueDecisionPlan } from '../src/services/supplierQueueDecisionPlan';

const category = {
  isActive: true,
  subcategories: [{ id: 'security-cameras', name: 'Security Cameras', isActive: true }],
  specificationTemplate: [{ name: 'Product Type', required: true }, { name: 'Resolution', required: false }],
};
const brand = { isActive: true, name: 'Generic' };

const validDraft = () => sanitizeSupplierProductDraft({
  name: 'A9 Security Camera', supplierSku: ' A9 / 001 ', brand: 'generic', category: 'electronics',
  subcategory: 'security-cameras', productType: 'Wireless Security Camera', price: 4200, stock: 8,
  imageUrl: 'https://cdn.example.com/a9.jpg', description: 'Compact wireless security camera.',
  specs: { 'Product Type': 'Wireless Security Camera' },
});

test('supplier profile validation sanitizes launch fields and requires complete bank details', () => {
  const profile = sanitizeSupplierProfile({
    companyName: '  Camera   Partner ', contactPerson: 'Supplier Owner', phone: '+94 77 123 4567',
    address: '10 Main Street, Colombo', businessRegistrationNumber: '',
    bankDetails: { accountHolderName: 'Supplier Owner', bankName: 'Bank', branchName: 'Colombo', accountNumber: '00123' },
  });
  assert.equal(profile.companyName, 'Camera Partner');
  assert.equal(profile.bankDetails.accountNumber, '00123');
  assert.throws(() => sanitizeSupplierProfile({
    companyName: 'Supplier', contactPerson: 'Owner', phone: '0771234567', address: 'Colombo',
    bankDetails: { bankName: 'Bank' },
  }), /Complete every bank detail/);
});

test('supplier product submission validates brand, category ownership, media, stock and required specifications', () => {
  assert.deepEqual(validateSupplierProductForSubmission(validDraft(), category, brand), []);
  const invalid = { ...validDraft(), stock: -1, imageUrl: 'javascript:alert(1)', specs: {} };
  const errors = validateSupplierProductForSubmission(invalid, category, { ...brand, isActive: false });
  assert.ok(errors.some((error) => error.includes('active registered brand')));
  assert.ok(errors.some((error) => error.includes('non-negative whole number')));
  assert.ok(errors.some((error) => error.includes('valid HTTP or HTTPS')));
  assert.ok(errors.some((error) => error.includes('Required specification')));
});

test('supplier SKU normalization supports deterministic duplicate claims', () => {
  assert.equal(normalizeSupplierSku(' A9 / 001 '), 'a9-001');
  assert.equal(normalizeSupplierSku('a9---001'), 'a9---001');
});

test('supplier fulfilment follows the launch sequence and blocks completed orders', () => {
  assert.equal(assertSupplierOrderTransition('pending', 'processing', 'confirmed'), 'processing');
  assert.equal(assertSupplierOrderTransition('processing', 'packed', 'processing'), 'packed');
  assert.equal(assertSupplierOrderTransition('packed', 'shipped', 'processing'), 'shipped');
  assert.throws(() => assertSupplierOrderTransition('pending', 'shipped', 'confirmed'), /cannot move/i);
  assert.throws(() => assertSupplierOrderTransition('packed', 'shipped', 'delivered'), /cannot be changed/i);
  assert.throws(() => assertSupplierOrderTransition('processing', 'packed', 'cancelled'), /cannot be changed/i);
});

test('supplier order ownership supports single and multi-supplier assignments only', () => {
  assert.equal(supplierOwnsOrder({ supplierId: 'supplier-a' }, 'supplier-a'), true);
  assert.equal(supplierOwnsOrder({ supplierIds: ['supplier-a', 'supplier-b'] }, 'supplier-b'), true);
  assert.equal(supplierOwnsOrder({ supplierId: 'supplier-a' }, 'supplier-b'), false);
});

test('supplier dashboard calculates every launch metric from owned live data', () => {
  const summary = calculateSupplierSummary(
    [{ isActive: true, stock: 2, lowStockLimit: 5 }, { isActive: true, stock: 10 }],
    [{ status: 'pending' }, { status: 'rejected' }],
    [
      { status: 'delivered', createdAt: '2026-07-10T00:00:00.000Z', supplierTotal: 6000 },
      { status: 'processing', createdAt: '2026-07-11T00:00:00.000Z', supplierTotal: 3000 },
    ],
    new Date('2026-07-19T00:00:00.000Z'),
  );
  assert.deepEqual(summary, {
    totalProducts: 2, pendingProducts: 1, approvedProducts: 2, rejectedProducts: 1,
    activeOrders: 1, monthlySales: 6000, lowStockProducts: 1,
  });
});

test('admin approval completes the linked supplier request and creates a notification', () => {
  const plan = buildSupplierQueueDecisionPlan({
    id: 'portal-request-1', portalRequestId: 'request-1', supplierId: 'supplier-1',
    supplierSkuClaimId: 'sku-claim', productFingerprintClaimId: 'product-claim', productName: 'Camera',
    productPayload: { id: 'camera', name: 'Camera' } as never,
  }, 'approved', { uid: 'admin', email: 'admin@example.com' }, 'timestamp', 'audit-1');
  assert.ok(plan.sets.some((operation) => operation.collection === 'products' && operation.id === 'camera'));
  assert.ok(plan.sets.some((operation) => operation.collection === 'supplier_product_requests' && operation.data.status === 'approved'));
  assert.ok(plan.sets.some((operation) => operation.collection === 'supplier_notifications' && operation.data.type === 'product_approved'));
  assert.equal(plan.deletes.some((operation) => operation.collection.includes('claims')), false);
});

test('admin rejection records an actionable reason and releases duplicate claims', () => {
  const plan = buildSupplierQueueDecisionPlan({
    id: 'portal-request-1', portalRequestId: 'request-1', supplierId: 'supplier-1',
    supplierSkuClaimId: 'sku-claim', productFingerprintClaimId: 'product-claim', productName: 'Camera',
    rejectionReason: 'Main image does not meet catalogue requirements.',
  }, 'rejected', { uid: 'admin', email: 'admin@example.com' }, 'timestamp', 'audit-1');
  const requestUpdate = plan.sets.find((operation) => operation.collection === 'supplier_product_requests');
  assert.equal(requestUpdate?.data.rejectionReason, 'Main image does not meet catalogue requirements.');
  assert.ok(plan.deletes.some((operation) => operation.collection === 'supplier_sku_claims'));
  assert.ok(plan.deletes.some((operation) => operation.collection === 'supplier_product_claims'));
});

test('Supplier Portal routes enforce role, ownership, duplicate prevention and projection boundaries', () => {
  const route = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');
  assert.match(route, /orders\/:orderId\/assign", requireSupplierHubAdmin/);
  assert.match(route, /supplierSnapshot\.data\(\)\?\.role !== "supplier"/);
  assert.match(route, /userSnapshot\.data\(\)\?\.role !== "supplier"/);
  assert.match(route, /ownerId !== identity\.uid/);
  assert.match(route, /supplierOwnsOrder\(snapshot\.data\(\) \|\| \{\}, identity\.uid\)/);
  assert.match(route, /supplier_sku_claims/);
  assert.match(route, /supplier_product_claims/);
  assert.match(route, /A matching product or supplier SKU already exists/);
  assert.doesNotMatch(route.slice(route.indexOf('const projectProduct'), route.indexOf('const projectRequest')), /costPrice|marketPrice|reservedStock|paymentReference/);
});

test('supplier fulfilment does not touch customer order status, inventory or reservation fields', () => {
  const route = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');
  const fulfilmentRoute = route.slice(route.indexOf('app.post("/api/supplier-portal/orders'), route.indexOf('app.post("/api/supplier-portal/notifications'));
  const orderMutation = fulfilmentRoute.slice(fulfilmentRoute.indexOf('transaction.update(orderReference'), fulfilmentRoute.indexOf('    });'));
  assert.match(fulfilmentRoute, /supplierFulfilmentStatus/);
  assert.doesNotMatch(orderMutation, /stockReservation|stockRestoration|paymentStatus|collection\("products"\)|\n\s*status:/);
});

test('Firestore rules expose only owned supplier portal records and deny claim access', () => {
  const rules = readFileSync('firestore.rules', 'utf8');
  const portalRoutes = readFileSync('functions/src/api/routes/supplierPortal.ts', 'utf8');
  assert.match(rules, /function isSupplier\(\)/);
  assert.match(rules, /match \/supplier_profiles\/\{supplierId\}[\s\S]*isSupplier\(\) && isOwner\(supplierId\)/);
  assert.match(rules, /match \/supplier_product_requests\/\{requestId\}[\s\S]*allow read: if isSupplierHubAdmin\(\)/);
  assert.match(portalRoutes, /projectRequestPayload\(request\)/);
  assert.match(rules, /match \/supplier_notifications\/\{notificationId\}[\s\S]*resource\.data\.supplierId == request\.auth\.uid/);
  assert.match(rules, /match \/supplier_sku_claims\/\{claimId\}[\s\S]*allow read: if false;[\s\S]*allow write: if false;/);
  assert.match(rules, /match \/supplier_product_claims\/\{claimId\}[\s\S]*allow read: if false;[\s\S]*allow write: if false;/);
  assert.match(rules, /match \/orders\/\{orderId\}[\s\S]*resource\.data\.customerUid == request\.auth\.uid/);
});

test('supplier UI is role-isolated, API-backed, responsive and accessible', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const portal = readFileSync('src/features/supplier-portal/SupplierPortal.tsx', 'utf8');
  const admin = readFileSync('src/components/AdminDashboard.tsx', 'utf8');
  assert.match(app, /userData\?\.role === 'supplier'/);
  assert.match(app, /<SupplierPortal user=\{user\}/);
  assert.doesNotMatch(portal, /firebase\/firestore|setDoc|updateDoc|writeBatch/);
  assert.match(portal, /aria-label="Supplier Hub sections"/);
  assert.match(portal, /role="dialog" aria-modal="true"/);
  assert.match(portal, /zy-skip-link/);
  assert.match(portal, /sm:grid-cols-2/);
  assert.match(portal, /loading="lazy"/);
  assert.match(admin, /Assigned Supplier/);
  assert.match(admin, /handleAssignOrderSupplier/);
  assert.match(admin, /newProduct\.supplierId/);
});
