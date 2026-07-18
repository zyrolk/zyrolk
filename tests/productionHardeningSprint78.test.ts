import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fetchJson, NetworkRequestError } from '../src/services/network/fetchJson';
import {
  getBrowserStorage,
  readStoredArray,
  readStoredJson,
  writeStoredJson,
} from '../src/services/browser/persistentStorage';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const app = readFileSync('src/App.tsx', 'utf8');
const firebaseClient = readFileSync('src/firebase.ts', 'utf8');
const firebaseStorage = readFileSync('src/firebaseStorage.ts', 'utf8');
const admin = readFileSync('src/components/AdminDashboard.tsx', 'utf8');
const errorBoundary = readFileSync('src/components/AppErrorBoundary.tsx', 'utf8');
const main = readFileSync('src/main.tsx', 'utf8');
const cart = [
  readFileSync('src/components/CartDrawer.tsx', 'utf8'),
  readFileSync('src/features/checkout/PremiumCheckoutDrawer.tsx', 'utf8'),
].join('\n');
const authModal = readFileSync('src/components/AuthModal.tsx', 'utf8');
const productDetail = readFileSync('src/components/ProductDetailModal.tsx', 'utf8');
const contact = readFileSync('src/components/ContactPage.tsx', 'utf8');
const cms = readFileSync('src/components/CmsPage.tsx', 'utf8');
const firestoreRules = readFileSync('firestore.rules', 'utf8');
const storageRules = readFileSync('storage.rules', 'utf8');
const firebaseHosting = readFileSync('firebase.json', 'utf8');
const server = readFileSync('server.ts', 'utf8');
const viteConfig = readFileSync('vite.config.ts', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');

test('browser persistence survives unavailable, malformed, and quota-limited storage', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readStoredArray(storage, 'missing'), []);

  storage.setItem('cart', '{bad json');
  assert.deepEqual(readStoredArray(storage, 'cart'), []);

  assert.equal(writeStoredJson(storage, 'cart', [{ id: 'p1' }]), true);
  assert.deepEqual(readStoredArray<{ id: string }>(storage, 'cart'), [{ id: 'p1' }]);

  storage.setItem('position', JSON.stringify({ x: 20, y: 30 }));
  const position = readStoredJson(
    storage,
    'position',
    null as { x: number; y: number } | null,
    (value): value is { x: number; y: number } => Boolean(value && typeof value === 'object' && 'x' in value && 'y' in value),
  );
  assert.deepEqual(position, { x: 20, y: 30 });
  assert.equal(getBrowserStorage('localStorage'), null);
});

test('JSON requests provide safe success, HTTP, invalid-response, and timeout behavior', async () => {
  const successfulFetch = (async () => new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  assert.deepEqual(await fetchJson('/api/example', {}, { fetchImpl: successfulFetch }), { success: true });

  const conflictFetch = (async () => new Response(JSON.stringify({ error: 'Inventory changed' }), { status: 409 })) as typeof fetch;
  await assert.rejects(
    () => fetchJson('/api/example', {}, { fetchImpl: conflictFetch }),
    (error: unknown) => error instanceof NetworkRequestError && error.kind === 'http' && error.status === 409 && error.message === 'Inventory changed',
  );

  const invalidFetch = (async () => new Response('<html>Unavailable</html>', { status: 200 })) as typeof fetch;
  await assert.rejects(
    () => fetchJson('/api/example', {}, { fetchImpl: invalidFetch }),
    (error: unknown) => error instanceof NetworkRequestError && error.kind === 'invalid-response',
  );

  const abortingFetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  })) as typeof fetch;
  await assert.rejects(
    () => fetchJson('/api/example', {}, { fetchImpl: abortingFetch, timeoutMs: 5 }),
    (error: unknown) => error instanceof NetworkRequestError && error.kind === 'timeout',
  );
});

test('Firebase initialization is idempotent, quiet, PII-safe, and defers Storage to admin', () => {
  assert.match(firebaseClient, /getApps\(\)\[0\] \|\| initializeApp\(firebaseConfig\)/);
  assert.match(firebaseClient, /getFirestore\(app\)/);
  assert.doesNotMatch(firebaseClient, /deleteApp|getDocFromServer|testConnection|authInfo|currentUser\?\.email/);
  assert.doesNotMatch(firebaseClient, /console\.(log|info|warn|error)/);
  assert.match(firebaseStorage, /getStorage\(app\)/);
  assert.match(admin, /import \{ storage \} from '\.\.\/firebaseStorage'/);
  assert.doesNotMatch(firebaseClient, /firebase\/storage/);
  assert.ok(viteConfig.indexOf("id.includes('@firebase/storage')") < viteConfig.indexOf("id.includes('firebase')"));
  assert.match(viteConfig, /return 'firebase-firestore'/);
  assert.match(viteConfig, /return 'firebase-auth'/);
  assert.match(viteConfig, /return 'firebase-core'/);
});

test('storefront listeners recover from failures instead of leaving an endless loading state', () => {
  assert.match(app, /window\.addEventListener\('online', handleOnline\)/);
  assert.match(app, /window\.addEventListener\('offline', handleOffline\)/);
  assert.match(app, /handleDataFailure\('products', error, true\)/);
  assert.match(app, /if \(blocksProducts\) setLoading\(false\)/);
  assert.match(app, /zy-storefront-connection-state/);
  assert.match(app, /Retry connection/);
  assert.match(app, /writeStoredJson\(getBrowserStorage\('localStorage'\), 'zyro_cart', cart\)/);
  assert.match(styles, /Sprint 78: production recovery and connectivity states/);
});

test('a root error boundary provides a customer-safe recovery path', () => {
  assert.match(main, /<AppErrorBoundary>[\s\S]*<App \/>[\s\S]*<\/AppErrorBoundary>/);
  assert.match(errorBoundary, /getDerivedStateFromError/);
  assert.match(errorBoundary, /componentDidCatch/);
  assert.match(errorBoundary, /aria-labelledby="app-failure-title"/);
  assert.match(errorBoundary, /window\.location\.reload\(\)/);
  assert.doesNotMatch(errorBoundary, /error\.stack|componentStack\}/);
});

test('customer workflows use safe diagnostics and resilient checkout networking', () => {
  assert.match(cart, /fetchJson<\{ success: boolean; order: Order; paymentSession\?: PayHerePaymentSession; error\?: string \}>/);
  assert.match(cart, /Idempotency-Key/);
  assert.match(cart, /reportClientIssue\('checkout-request'/);
  for (const customerSurface of [app, cart, authModal, productDetail, contact, cms]) {
    assert.doesNotMatch(customerSurface, /console\.(log|info|warn|error|debug)/);
  }
  assert.match(viteConfig, /pure: \['console\.log', 'console\.info', 'console\.debug'\]/);
});

test('Firestore and Storage rules tighten existing production boundaries', () => {
  const reviewRules = firestoreRules.slice(firestoreRules.indexOf('match /reviews/{reviewId}'), firestoreRules.indexOf('// Product Q&A'));
  assert.match(reviewRules, /allow create, update, delete: if false/);
  assert.match(reviewRules, /match \/votes\/\{userId\}[\s\S]*allow read, write: if false/);
  const testCollectionRules = firestoreRules.slice(firestoreRules.indexOf('match /test/{docId}'));
  assert.match(testCollectionRules, /allow read, write: if false/);

  assert.match(storageRules, /request\.resource\.size < 10 \* 1024 \* 1024/);
  assert.match(storageRules, /request\.resource\.contentType\.matches\('image\/\.\*'\)/);
  assert.match(storageRules, /allow create, update: if isAdmin\(\) && isValidImageUpload\(\)/);
  assert.match(storageRules, /allow delete: if isAdmin\(\)/);
});

test('production delivery applies security headers and immutable caching only to hashed assets', () => {
  const hostingConfig = JSON.parse(firebaseHosting) as { hosting: { headers: unknown[] } };
  assert.ok(Array.isArray(hostingConfig.hosting.headers));
  assert.match(firebaseHosting, /X-Content-Type-Options/);
  assert.match(firebaseHosting, /X-Frame-Options/);
  assert.match(firebaseHosting, /Permissions-Policy/);
  assert.match(firebaseHosting, /public, max-age=31536000, immutable/);

  assert.match(server, /app\.disable\("x-powered-by"\)/);
  assert.match(server, /res\.setHeader\("X-Content-Type-Options", "nosniff"\)/);
  assert.match(server, /req\.path\.startsWith\("\/api\/"\)[\s\S]*"Cache-Control", "no-store"/);
  assert.match(server, /filePath\.includes\(`\$\{path\.sep\}assets\$\{path\.sep\}`\)/);
  assert.equal(existsSync('public/logo.svg'), false);
  assert.equal(existsSync('public/favicon.svg'), false);
});

test('Sprint 78 preserves protected commerce, CMS, admin, and supplier workflow contracts', () => {
  assert.match(app, /onAddToCart=\{handleAddToCart\}/);
  assert.match(app, /onBuyNow=\{handleBuyNow\}/);
  assert.match(app, /settings=\{settings\}/);
  assert.match(app, /<AdminDashboard/);
  assert.match(admin, /const SupplierHubFiveStars = lazy/);
  assert.match(admin, /const AIManagerPanel = lazy/);
  assert.match(cart, /idempotencyKey/);
  assert.match(firestoreRules, /match \/orders\/\{orderId\}[\s\S]*allow create, update, delete: if false/);
});
