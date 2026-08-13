import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AppCheckBootstrapError, loadProtectedStorefront } from '../src/services/security/storefrontBootstrap';
import {
  CLOUDINARY_MAX_IMAGE_BYTES,
  buildCloudinaryImageUploadUrl,
  validateCloudinaryUploadCandidate,
  validateCloudinaryUploadPreset,
} from '../src/services/media/cloudinaryUploadPolicy';

test('production Firebase configuration includes the registered App Check site key', () => {
  const config = JSON.parse(readFileSync('firebase-applet-config.json', 'utf8')) as { appCheckSiteKey?: string };
  assert.equal(config.appCheckSiteKey, '6Le0-mItAAAAAN7iQ_B8SHI1gn3gGtx7IOtc5NHu');
});

test('App Check fails closed and emits the canonical request header', () => {
  const source = readFileSync('src/services/security/appCheck.ts', 'utf8');
  assert.match(source, /ReCaptchaEnterpriseProvider\(appCheckSiteKey\)/);
  assert.match(source, /getToken\(instance as Parameters<typeof getToken>\[0\], forceRefresh\)/);
  assert.match(source, /if \(!result\.token\) throw new Error/);
  assert.match(source, /return \{ 'X-Firebase-AppCheck': result\.token \}/);
  assert.doesNotMatch(source, /catch\s*\{\s*return \{\};\s*\}/);
});

test('protected storefront modules load only after App Check bootstrap succeeds', async () => {
  const events: string[] = [];
  const result = await loadProtectedStorefront(
    async () => {
      events.push('app-check-start');
      await Promise.resolve();
      events.push('app-check-ready');
    },
    async () => {
      events.push('protected-modules-loaded');
      return 'ready';
    },
  );

  assert.equal(result, 'ready');
  assert.deepEqual(events, ['app-check-start', 'app-check-ready', 'protected-modules-loaded']);
});

test('App Check bootstrap failure prevents protected storefront modules from loading', async () => {
  let protectedModulesLoaded = false;
  await assert.rejects(
    () => loadProtectedStorefront(
      async () => { throw new Error('token unavailable'); },
      async () => {
        protectedModulesLoaded = true;
        return 'unexpected';
      },
    ),
    (error: unknown) => error instanceof AppCheckBootstrapError
      && error.cause instanceof Error
      && error.cause.message === 'token unavailable',
  );
  assert.equal(protectedModulesLoaded, false);

  const main = readFileSync('src/main.tsx', 'utf8');
  assert.doesNotMatch(main, /^import App from/m);
  assert.doesNotMatch(main, /^import AppErrorBoundary from/m);
  assert.match(main, /loadProtectedStorefront\(initializeStorefrontAppCheck/);
  assert.match(main, /Browser verification failed/);
});

test('App Check bootstrap creates no production bypass and preserves exact local emulator hosts', () => {
  const source = readFileSync('src/services/security/appCheck.ts', 'utf8');
  assert.match(source, /hostname === 'localhost'/);
  assert.match(source, /hostname === '127\.0\.0\.1'/);
  assert.match(source, /hostname === '::1'/);
  assert.doesNotMatch(source, /web\.app|zyro\.lk|NODE_ENV|VITE_REQUIRE_APP_CHECK/);
  assert.match(source, /getToken\(instance as Parameters<typeof getToken>\[0\], false\)/);

  const firebaseApp = readFileSync('src/firebaseApp.ts', 'utf8');
  const firebaseServices = readFileSync('src/firebase.ts', 'utf8');
  assert.doesNotMatch(firebaseApp, /firebase\/(auth|firestore|storage)/);
  assert.match(firebaseServices, /getAuth\(app\)/);
  assert.match(firebaseServices, /getFirestore\(app\)/);
});

test('Hosting and local production CSP allow only the exact Cloudinary upload origin', () => {
  const firebase = JSON.parse(readFileSync('firebase.json', 'utf8')) as {
    hosting: { headers: Array<{ headers: Array<{ key: string; value: string }> }> };
  };
  const catchAllHeaders = firebase.hosting.headers.find((entry) => (
    entry.headers.some(({ key }) => key === 'Content-Security-Policy')
  ));
  const csp = catchAllHeaders?.headers.find(({ key }) => key === 'Content-Security-Policy')?.value || '';
  const connectSource = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src ')) || '';
  assert.match(connectSource, /(?:^|\s)https:\/\/api\.cloudinary\.com(?:\s|$)/);
  assert.doesNotMatch(connectSource, /\*\.cloudinary\.com/);

  const server = readFileSync('server.ts', 'utf8');
  assert.match(server, /connect-src 'self' https:\/\/api\.cloudinary\.com/);
  assert.doesNotMatch(server, /https:\/\/\*\.cloudinary\.com/);

  const imageSource = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('img-src ')) || '';
  assert.match(imageSource, /(?:^|\s)https:(?:\s|$)/);
});

test('Cloudinary upload policy enforces the advertised image types, size, and fixed origin', () => {
  assert.equal(validateCloudinaryUploadCandidate({ type: 'image/png', size: CLOUDINARY_MAX_IMAGE_BYTES }), null);
  assert.equal(validateCloudinaryUploadCandidate({ type: 'image/jpeg', size: 1 }), null);
  assert.equal(validateCloudinaryUploadCandidate({ type: 'image/webp', size: 100 }), null);
  assert.match(validateCloudinaryUploadCandidate({ type: 'image/gif', size: 100 }) || '', /PNG/);
  assert.match(validateCloudinaryUploadCandidate({ type: 'image/png', size: CLOUDINARY_MAX_IMAGE_BYTES + 1 }) || '', /10MB/);
  assert.match(validateCloudinaryUploadCandidate({ type: 'image/png', size: 0 }) || '', /invalid/);

  assert.equal(
    buildCloudinaryImageUploadUrl('zyro_cloud'),
    'https://api.cloudinary.com/v1_1/zyro_cloud/image/upload',
  );
  assert.throws(() => buildCloudinaryImageUploadUrl('zyro/cloud'), /invalid/);
  assert.equal(validateCloudinaryUploadPreset('zyrolk_upload'), 'zyrolk_upload');
  assert.throws(() => validateCloudinaryUploadPreset('../preset'), /invalid/);

  const component = readFileSync('src/components/CloudinaryUpload.tsx', 'utf8');
  assert.match(component, /validateCloudinaryUploadCandidate\(file\)/);
  assert.match(component, /xhr\.open\("POST", uploadUrl\)/);
  assert.match(component, /accept="image\/png,image\/jpeg,image\/webp,\.png,\.jpg,\.jpeg,\.webp"/);
  assert.doesNotMatch(component, /accept="image\/\*"/);
});

test('Supplier Hub refreshes App Check together with Firebase Auth after a 401', () => {
  const source = readFileSync('src/services/supplierHubApi.ts', 'utf8');
  assert.match(source, /user\.getIdToken\(forceRefresh\)/);
  assert.match(source, /getAppCheckRequestHeaders\(forceRefresh\)/);
  assert.match(source, /if \(response\.status === 401\) response = await request\(true\)/);
});

test('production Functions continue enforcing verified App Check tokens', () => {
  const source = readFileSync('functions/src/api/app.ts', 'utf8');
  assert.match(source, /const token = req\.header\("X-Firebase-AppCheck"\)/);
  assert.match(source, /await adminAppCheck\.verifyToken\(token\)/);
  assert.match(source, /res\.status\(401\)\.json\(\{ error: "App verification is required" \}\)/);
});
