import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string): string => readFileSync(path, 'utf8');

test('PERF-1 scopes storefront listeners and derived reads away from Admin mode', () => {
  const app = source('src/App.tsx');
  assert.match(app, /\/\/ Seeding & Firestore Live Sync[\s\S]*?if \(isAdminMode\) return;[\s\S]*?\}, \[isAdminMode\]\);/);
  assert.match(app, /if \(isAdminMode \|\| categories\.length === 0\) return;[\s\S]*?\}, \[categories, isAdminMode\]\);/);
  assert.match(app, /if \(isAdminMode \|\| loading \|\| requestedProductIds\.length === 0\) return;/);
});

test('PERF-1 scopes Admin collection listeners and heavy summaries to active sections', () => {
  const admin = source('src/components/AdminDashboard.tsx');
  assert.match(admin, /const needsOrders = \['stats', 'aiManager', 'orders', 'customers'\]\.includes\(activeTab\)/);
  assert.match(admin, /const needsReviews = \['stats', 'aiManager', 'customers'\]\.includes\(activeTab\)/);
  assert.match(admin, /const needsProducts = \['stats', 'aiManager', 'products'\]\.includes\(activeTab\)/);
  assert.match(admin, /where\('status', '==', 'pending'\)[\s\S]*limit\(5\)/);
  assert.match(admin, /unsubscribePendingOrderNotifications/);
  assert.match(admin, /authorized && activeTab === 'stats'\) void loadOperationsSummary\(\)/);
  assert.doesNotMatch(admin, /if \(authorized\) void loadOperationsSummary\(\);/);
});

test('Supplier Hub Overview uses a bounded lightweight contract while Operations keeps its heavy path', () => {
  const supplier = source('src/components/SupplierHubFiveStars.tsx');
  const operations = source('functions/src/api/suppliers/supplierOperations.ts');
  const routes = source('functions/src/api/routes/supplier.ts');
  assert.match(supplier, /getSupplierApi\('\/api\/supplier-operations\/overview'\)/);
  assert.doesNotMatch(supplier, /loadSources[\s\S]*?getSupplierApi\('\/api\/supplier-operations\/summary'\)/);
  assert.match(routes, /app\.get\("\/api\/supplier-operations\/overview", requireSupplierHubAdmin/);
  assert.match(operations, /loadSupplierReviewMediaProjectionCounts\(db\)/);
  assert.match(routes, /app\.get\("\/api\/supplier-operations\/summary", requireSupplierHubAdmin/);
});

test('Supplier queue list projection avoids per-asset signing and full category reads for indexed pages', () => {
  const queue = source('functions/src/scheduled/supplierReviewQueue.ts');
  assert.match(queue, /skipSigningForUsableCanonicalUrl\?: boolean/);
  assert.match(queue, /isStableManagedSupplierMediaUrl\(record\)/);
  assert.match(queue, /skipSigningForUsableCanonicalUrl && isStableManagedSupplierMediaUrl\(record\)/);
  assert.match(queue, /db\.getAll\(\.\.\.ids\.map\(\(id\) => db\.collection\("categories"\)\.doc\(id\)\)\)/);
  assert.match(queue, /skipSigningForUsableCanonicalUrl: true/);
});

test('Public module-preload filtering is case-insensitive for AdminDashboard chunks', () => {
  const vite = source('vite.config.ts');
  assert.match(vite, /const normalized = dep\.toLowerCase\(\)/);
  assert.match(vite, /!normalized\.includes\('admindashboard'\)/);
});

test('Product cards and detail secondary content preserve lazy boundaries', () => {
  const card = source('src/components/ProductCard.tsx');
  const related = source('src/features/product-experience/RelatedProductsRail.tsx');
  const detail = source('src/components/ProductDetailModal.tsx');
  assert.match(card, /srcSet=\{cardImageSrcSet\}/);
  assert.match(card, /productImageVariantUrl\(imageSource, 'thumbnail'\)/);
  assert.match(related, /productImageVariantUrl\(imageSource, 'thumbnail'\)/);
  assert.match(detail, /setTimeout\(\(\) => \{[\s\S]*productImageVariantUrl\(galleryImages\[index\], 'medium'\)/);
  assert.match(detail, /secondaryContentReady && isReviewsEnabled/);
  assert.match(detail, /secondaryContentReady && \([\s\S]*<RelatedProductsRail/);
});
