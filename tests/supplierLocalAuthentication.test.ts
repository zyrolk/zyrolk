import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Supplier Hub waits for Firebase Auth restoration and attaches the ID token", () => {
  const supplierHub = readFileSync("src/components/SupplierHubFiveStars.tsx", "utf8");

  assert.match(supplierHub, /onIdTokenChanged\(auth, \(currentUser\) =>/);
  assert.match(supplierHub, /if \(currentUser\) void loadSources\(\)/);
  assert.match(supplierHub, /await auth\.authStateReady\(\)/);
  assert.match(supplierHub, /user\.getIdToken\(forceRefresh\)/);
  assert.match(supplierHub, /'Authorization': `Bearer \$\{token\}`/);
  assert.match(supplierHub, /if \(response\.status === 401\) response = await request\(true\)/);
});

test("local Admin Auth uses the same Firebase project while production keeps environment authority", () => {
  const firebaseAdmin = readFileSync("functions/src/api/firebase.ts", "utf8");

  assert.match(firebaseAdmin, /process\.env\.GCLOUD_PROJECT/);
  assert.match(firebaseAdmin, /process\.env\.GOOGLE_CLOUD_PROJECT/);
  assert.match(firebaseAdmin, /process\.env\.FIREBASE_PROJECT_ID/);
  assert.match(firebaseAdmin, /\|\| "zyrolk-e0164"/);
  assert.match(firebaseAdmin, /initializeApp\(\{ projectId \}\)/);
});

test("localhost omits token revocation lookup while production Functions retain it", () => {
  const server = readFileSync("server.ts", "utf8");
  const middleware = readFileSync("functions/src/api/middleware/supplierHubAdminAuth.ts", "utf8");

  assert.match(server, /const isLocalDevelopmentRequest = isLocalSupplierApiRuntime && isExactLocalhost\(req\.hostname \|\| ""\)/);
  assert.match(server, /res\.locals\.supplierHubLocalExpressPreview = isLocalDevelopmentRequest/);
  assert.match(middleware, /req\.header\("Authorization"\)/);
  assert.match(middleware, /authHeader\.match\(\/\^Bearer/);
  assert.match(middleware, /res\.locals\.supplierHubLocalExpressPreview === true\s+\? await adminAuth\.verifyIdToken\(match\[1\]\)/);
  assert.match(middleware, /: await adminAuth\.verifyIdToken\(match\[1\], true\)/);
  assert.doesNotMatch(readFileSync("functions/src/api/app.ts", "utf8"), /supplierHubLocalExpressPreview/);
  assert.match(middleware, /adminAuth\.verifyIdToken\(match\[1\], true\)/);
});
