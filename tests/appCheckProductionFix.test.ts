import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
