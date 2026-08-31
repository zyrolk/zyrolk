import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const homepage = readFileSync('src/components/MarketplaceHomePhase1.tsx', 'utf8');
const hero = readFileSync('src/components/HeroBanner.tsx', 'utf8');
const motion = readFileSync('src/components/StorefrontMotionController.tsx', 'utf8');
const supplierDashboard = readFileSync('src/components/supplier-management/SupplierManagementDashboard.tsx', 'utf8');
const supplierHub = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');
const penpotStyles = readFileSync('src/styles/storefrontPenpot.css', 'utf8');

test('hero uses immediate reveal so fallback content is never permanently hidden', () => {
  assert.match(hero, /data-zy-reveal="immediate"/);
  assert.match(motion, /IMMEDIATE_REVEAL_SELECTOR/);
  assert.match(motion, /REVEAL_FAILSAFE_MS/);
  assert.match(hero, /Shop Sri Lanka Online/);
  assert.match(hero, /MARKETPLACE_MESSAGE/);
});

test('homepage category section uses independent loading and exits skeleton state on empty or error', () => {
  assert.match(app, /categoriesLoading=\{categoriesLoading\}/);
  assert.match(app, /categoriesError=\{categoriesLoadError\}/);
  assert.match(app, /setCategoriesLoading\(false\)/);
  assert.match(app, /handleCategoryFailure/);
  assert.match(homepage, /categoriesLoading \? \(/);
  assert.match(homepage, /categoriesError \? \(/);
  assert.match(homepage, /Categories are being prepared/);
  assert.doesNotMatch(homepage, /zy-foundation-category-skeleton is-empty/);
});

test('catalog loading has a storefront failsafe timeout', () => {
  assert.match(app, /catalogFailsafeTimer/);
  assert.match(app, /setLoading\(false\)/);
});

test('motion controller no longer resets reveals on every catalog count change', () => {
  assert.match(app, /motionKey=\{currentPage\}/);
  assert.doesNotMatch(app, /motionKey=\{`\$\{currentPage\}:\$\{loading\}/);
});

test('real categories still render in the mobile category rail', () => {
  assert.match(homepage, /zy-foundation-category-rail/);
  assert.match(homepage, /zy-foundation-category-tile/);
  assert.match(homepage, /categoryVisuals\.map/);
  assert.match(penpotStyles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test('supplier account lookup appears before supplier metrics cards', () => {
  const loadingBranch = supplierDashboard.slice(supplierDashboard.indexOf('if (loading)'));
  const loadedBranch = supplierDashboard.slice(supplierDashboard.lastIndexOf('return ('));
  assert.ok(loadingBranch.indexOf('supplier-account-query') < loadingBranch.indexOf('Loading supplier dashboard'));
  assert.ok(loadedBranch.indexOf('supplier-account-query') < loadedBranch.indexOf('grid gap-3 sm:grid-cols-2 xl:grid-cols-6'));
  assert.match(supplierDashboard, /Find account/);
});

test('external connector wording clarifies fulfilment account and connect source action', () => {
  assert.match(supplierHub, /Connect Source/);
  assert.match(supplierHub, /Fulfilment Supplier Account/);
  assert.match(supplierHub, /receives fulfilment groups for products imported from this external source/);
  assert.match(supplierHub, /Connect External Supplier/);
  assert.doesNotMatch(supplierHub, /Save Supplier'/);
});

test('A2Z credential profile UI does not default to the global profile', () => {
  assert.doesNotMatch(supplierHub, /useState<string>\(A2Z_GLOBAL_SECRET_PROFILE\)/);
  assert.match(supplierHub, /Credential profile ID \(required\)/);
  assert.match(supplierHub, /newSupplierCredentialProfile\.trim\(\)/);
  assert.doesNotMatch(supplierHub, /editCredentialProfile\.trim\(\) \|\| A2Z_GLOBAL_SECRET_PROFILE/);
});

test('supplier backend routes remain unchanged in this launch blocker fix', () => {
  assert.match(supplierDashboard, /\/api\/supplier-accounts\/lookup\?query=/);
  assert.match(supplierDashboard, /\/api\/supplier-operations\/summary/);
  assert.match(supplierDashboard, /\/api\/supplier-accounts\/\$\{encodeURIComponent\(account\.uid\)\}/);
});
