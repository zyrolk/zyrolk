import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  LAUNCH1000_PILOT_MANIFEST_REVISION,
  LAUNCH1000_PILOT_PRODUCT_IDS,
  runLaunch1000PilotDryRun,
} from '../src/services/launch1000AdminDryRun';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const successResponse = (): Response => new Response(JSON.stringify({
  success: true,
  mode: 'dry_run',
  manifestRevision: LAUNCH1000_PILOT_MANIFEST_REVISION,
  results: LAUNCH1000_PILOT_PRODUCT_IDS.map((productId) => ({
    productId,
    sku: productId,
    outcome: 'ELIGIBLE',
    reasonCodes: [],
    expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    expectedFingerprint: 'fingerprint',
    intendedTaxonomy: { categoryId: 'home-garden', subcategoryId: 'tools-hardware', proposalId: null },
    deterministicSpecNormalization: {},
    validationErrors: [],
    projectionClasses: ['ready_for_review'],
  })),
  counts: { ELIGIBLE: LAUNCH1000_PILOT_PRODUCT_IDS.length },
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('Launch-1000 bridge sends the exact fixed pilot request through the privileged API client', async () => {
  let request: { path: string; body: Record<string, unknown> } | null = null;
  const response = await runLaunch1000PilotDryRun(async (path, body) => {
    request = { path, body };
    return successResponse();
  }, () => true);

  assert.deepEqual(request, {
    path: '/api/launch1000/products/dry-run',
    body: {
      manifestRevision: LAUNCH1000_PILOT_MANIFEST_REVISION,
      productIds: [...LAUNCH1000_PILOT_PRODUCT_IDS],
    },
  });
  assert.equal(response.mode, 'dry_run');
  assert.equal(response.results.length, 10);
});

test('unauthenticated bridge state fails before the privileged client is called', async () => {
  let called = false;
  await assert.rejects(
    runLaunch1000PilotDryRun(async () => {
      called = true;
      return successResponse();
    }, () => false),
    /Admin authentication is required/u,
  );
  assert.equal(called, false);
});

test('bridge uses the existing auth/App Check helper and has no apply or taxonomy action', () => {
  const service = read('src/services/launch1000AdminDryRun.ts');
  const panel = read('src/components/Launch1000PilotDryRunPanel.tsx');
  const hub = read('src/components/SupplierHubFiveStars.tsx');
  const apiClient = read('src/services/supplierHubApi.ts');
  const adminDashboard = read('src/components/AdminDashboard.tsx');

  assert.match(service, /postSupplierApi/u);
  assert.doesNotMatch(service, /fetch\s*\(/u);
  assert.doesNotMatch(service, /getIdToken|getAppCheckRequestHeaders|Authorization/u);
  assert.match(service, /\/api\/launch1000\/products\/dry-run/u);
  assert.doesNotMatch(`${service}\n${panel}\n${hub}`, /apply-pilot|taxonomy\/(?:approve|create)/u);
  assert.doesNotMatch(`${service}\n${panel}`, /supplier-sync|media.*retry|maintenanceMode|localDemand/u);
  assert.match(hub, /<Launch1000PilotDryRunPanel \/>/u);
  assert.match(apiClient, /getIdToken/u);
  assert.match(apiClient, /getAppCheckRequestHeaders/u);
  assert.match(apiClient, /Authorization/u);
  assert.match(adminDashboard, /tokenResult\.claims\.admin === true \|\| tokenResult\.claims\.role === 'admin'/u);
  assert.match(adminDashboard, /if \(authorized === false\)/u);
  assert.match(adminDashboard, /<SupplierHubFiveStars/u);
});
