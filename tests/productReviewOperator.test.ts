import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  hasProductReviewOperatorAccess,
  hasAdminAccess,
} from '../functions/src/api/security/adminAuthorization';
import { hasProductReviewOperatorAccess as hasClientProductReviewOperatorAccess } from '../src/services/security/adminAuthorization';

test('Product Review operator capability is exact and does not broaden admin claims', () => {
  assert.equal(hasProductReviewOperatorAccess({ productReviewOperator: true }), true);
  assert.equal(hasClientProductReviewOperatorAccess({ productReviewOperator: true }), true);
  assert.equal(hasProductReviewOperatorAccess({ productReviewOperator: false }), false);
  assert.equal(hasClientProductReviewOperatorAccess({ productReviewOperator: false }), false);
  assert.equal(hasProductReviewOperatorAccess({ role: 'operator' }), false);
  assert.equal(hasProductReviewOperatorAccess({ email: 'maheshim828@gmail.com' }), false);
  assert.equal(hasAdminAccess({ productReviewOperator: true }), false);
});

test('Product Review routes admit the operator only to the permitted review surface', () => {
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const middleware = readFileSync('functions/src/api/middleware/supplierHubAdminAuth.ts', 'utf8');

  for (const route of [
    'supplier-review-catalog',
    'supplier-review-queue',
    'supplier-review-queue/diagnostics',
    'supplier-review-queue/:queueItemId/approve',
    'supplier-review-queue/:queueItemId/draft',
    'supplier-review-queue/:queueItemId/audit',
    'supplier-products/:productId/offers',
  ]) {
    assert.match(routes, new RegExp(`${route.replaceAll('/', '\\/')}[^\\n]+requireProductReviewOperator`));
  }

  for (const route of [
    'supplier-sync',
    'supplier-settings',
    'supplier-review-queue/:queueItemId/refresh',
    'supplier-review-queue/bulk-approve',
    'supplier-review-queue/bulk-reject',
    'launch1000/taxonomy/create',
    'supplier-category-mappings',
  ]) {
    assert.match(routes, new RegExp(`${route.replaceAll('/', '\\/')}[^\\n]+requireSupplierHubAdmin`));
  }

  assert.match(middleware, /!hasSupplierHubAdminAccess\(decodedToken\) && !hasProductReviewOperatorAccess\(decodedToken\)/);
  assert.match(middleware, /verifyIdToken\(match\[1\], true\)/);
});

test('Operator UI is review-only, uses local skip navigation, and keeps approval server-authoritative', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const dashboard = readFileSync('src/components/AdminDashboard.tsx', 'utf8');
  const hub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
  const modal = readFileSync('src/components/ProductReviewOperatorModal.tsx', 'utf8');
  const card = readFileSync('src/components/SupplierReviewQuickCard.tsx', 'utf8');

  assert.match(app, /hasProductReviewOperatorAccess/);
  assert.match(app, /operatorMode=\{isProductReviewOperator\}/);
  assert.match(dashboard, /hasProductReviewOperatorAccess/);
  assert.match(dashboard, /tab\.id === 'productReview'/);
  assert.match(dashboard, /if \(!authorized \|\| productReviewOperator\) return/);
  assert.match(hub, /if \(operatorMode\) \{/);
  assert.match(hub, /setOperatorSkippedReviewIds/);
  assert.match(hub, /onSkip=\{operatorMode \? \(\) => handleOperatorSkip\(item\) : undefined\}/);
  assert.match(hub, /canQuickApprove=\{operatorMode \? false/);
  assert.match(hub, /ProductReviewOperatorModal/);
  assert.match(card, /onSkip\?: \(\) => void/);
  assert.match(modal, /onSaveDraft/);
  assert.match(modal, /onPublish/);
  assert.match(modal, /Managed primary image is not publication-ready/);
  assert.match(modal, /Save is required before publish/);
  assert.doesNotMatch(modal, /postSupplierApi|patchSupplierApi|getSupplierApi/);
});

test('Admin identity display is derived from the authenticated Firebase user', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const dashboard = readFileSync('src/components/AdminDashboard.tsx', 'utf8');

  assert.match(app, /authenticatedUserEmail=\{user\?\.email \?\? null\}/);
  assert.match(dashboard, /authenticatedUserEmail\?: string \| null/);
  assert.match(dashboard, /authenticatedUserEmail\?\.trim\(\) \|\| auth\.currentUser\?\.email\?\.trim\(\) \|\| 'Signed-in account'/);
  assert.doesNotMatch(dashboard, /<p className="text-\[10px\] text-slate-500 truncate">\{PRODUCTION_ADMIN_EMAIL\}<\/p>/);
});

test('Auth transitions clear stale identity and navigation before claims resolve', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const dashboard = readFileSync('src/components/AdminDashboard.tsx', 'utf8');

  assert.match(app, /setUser\(currentUser\);\s*setIsAdminMode\(false\);\s*setIsAdminUser\(false\);\s*setIsProductReviewOperator\(false\)/);
  assert.match(app, /if \(!isCurrentAuthContext\(\)\) return;/);
  assert.match(dashboard, /setAuthorized\(null\);\s*setProductReviewOperator\(false\);\s*setActiveTab\(initialTab\)/);
  assert.match(dashboard, /authCheckVersionRef\.current/);
  assert.match(app, /setUser\(null\)/);
});

test('Admin, operator, and unauthenticated states keep distinct navigation', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const dashboard = readFileSync('src/components/AdminDashboard.tsx', 'utf8');

  assert.match(app, /const isFullAdmin = hasAdminAccess\(tokenResult\.claims\)/);
  assert.match(app, /setIsProductReviewOperator\(isReviewOperator && !isFullAdmin\)/);
  assert.match(dashboard, /const isFullAdmin = tokenResult\.claims\.admin === true \|\| tokenResult\.claims\.role === 'admin'/);
  assert.match(dashboard, /if \(!currentUser\) \{\s*setAuthorized\(false\)/);
  assert.match(dashboard, /ADMIN_SIDEBAR_NAV\.filter\(\(tab\) => !productReviewOperator \|\| tab\.id === 'productReview'\)/);
});
