import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync('server.ts', 'utf8');
const hosting = readFileSync('firebase.json', 'utf8');

test('preview mirrors Firebase Hosting by keeping storefront delivery outside API App Check', () => {
  const appCheckStart = server.indexOf('app.use(async (req, res, next) => {');
  const staticStart = server.indexOf('app.use(express.static(distPath');
  assert.ok(appCheckStart >= 0 && staticStart > appCheckStart);
  assert.match(server, /const isApiRequest = req\.path === "\/api" \|\| req\.path\.startsWith\("\/api\/"\);/);
  assert.match(server, /if \(!isApiRequest\) \{\s+next\(\);\s+return;\s+\}/);
  assert.match(server, /app\.use\(express\.static\(distPath/);
  assert.match(server, /app\.get\("\*", \(req, res\) => \{\s+res\.sendFile\(path\.join\(distPath, "index\.html"\)\);/);
});

test('API App Check remains protected while the disabled PayHere callback has no exemption', () => {
  assert.match(server, /const token = req\.header\("X-Firebase-AppCheck"\);/);
  assert.match(server, /res\.status\(401\)\.json\(\{ error: "App verification is required" \}\);/);
  assert.match(server, /adminAppCheck\.verifyToken\(token\)/);
  assert.match(server, /const isLocalDevelopmentRequest = isLocalSupplierApiRuntime && isExactLocalhost\(req\.hostname \|\| ""\)/);
  assert.match(server, /\["localhost", "127\.0\.0\.1", "::1", "\[::1\]"\]/);
  assert.doesNotMatch(server, /req\.path === "\/api\/payments\/payhere\/notify"/);
  assert.match(server, /req\.path === "\/sitemap\.xml"/);
  assert.match(hosting, /"source": "\/api\/\*\*"[\s\S]*"function": "api"/);
  assert.match(hosting, /"source": "\*\*"[\s\S]*"destination": "\/index\.html"/);
});

test('local Express allows loopback origins only in non-production', () => {
  assert.match(server, /const LOCAL_EXPRESS_ALLOWED_ORIGINS = \["http:\/\/localhost:3000", "http:\/\/127\.0\.0\.1:3000"\]/);
  assert.match(server, /const isLocalSupplierApiRuntime = process\.env\.NODE_ENV !== "production"/);
  assert.match(server, /const allowedOrigins = isLocalSupplierApiRuntime\s+\? \[\.\.\.new Set\(\[\.\.\.productionAllowedOrigins, \.\.\.LOCAL_EXPRESS_ALLOWED_ORIGINS\]\)\]\s+: productionAllowedOrigins/);
});

test('Functions retain production App Check enforcement and permit only loopback emulator requests', () => {
  const functionsApp = readFileSync('functions/src/api/app.ts', 'utf8');
  assert.match(functionsApp, /process\.env\.FUNCTIONS_EMULATOR === "true" && isExactLocalhost\(req\.hostname \|\| ""\)/);
  assert.match(functionsApp, /const token = req\.header\("X-Firebase-AppCheck"\);/);
  assert.match(functionsApp, /adminAppCheck\.verifyToken\(token\)/);
  assert.match(functionsApp, /\["localhost", "127\.0\.0\.1", "::1", "\[::1\]"\]/);
  assert.doesNotMatch(functionsApp, /LOCAL_EXPRESS_ALLOWED_ORIGINS/);
});
