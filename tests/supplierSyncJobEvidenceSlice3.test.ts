import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  formatSupplierEvidenceMap,
  supplierSyncEvidenceDuration,
  supplierSyncReconciliationHelp,
  supplierSyncReconciliationLabel,
} from '../src/components/supplier-operations/SupplierSyncJobEvidencePanel';

const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('modern verified job evidence has truthful status, cursor, and duration helpers', () => {
  assert.equal(supplierSyncReconciliationLabel('VERIFIED'), 'Verified');
  assert.match(supplierSyncReconciliationHelp('VERIFIED'), /Counts, cursor chain, attempts/);
  assert.equal(formatSupplierEvidenceMap({ dropex: 'offset:6155' }), 'dropex: offset:6155');
  assert.equal(supplierSyncEvidenceDuration('2026-10-04T10:00:00.000Z', '2026-10-04T10:02:05.000Z'), '2m 5s');
});

test('issues and legacy jobs are visibly distinct without inventing evidence', () => {
  assert.equal(supplierSyncReconciliationLabel('ISSUES'), 'Needs attention');
  assert.equal(supplierSyncReconciliationLabel('LEGACY_UNVERIFIED'), 'Legacy — evidence incomplete');
  assert.equal(supplierSyncReconciliationLabel(null), 'Not recorded');
  assert.equal(formatSupplierEvidenceMap(null), 'Not recorded');
  assert.match(supplierSyncReconciliationHelp('LEGACY_UNVERIFIED'), /predates immutable attempt evidence/);
});

test('job evidence UI covers attempts, counters, issue groups, and Product Review navigation', () => {
  const component = source('src/components/supplier-operations/SupplierSyncJobEvidencePanel.tsx');
  const dashboard = source('src/components/supplier-operations/SupplierOperationsDashboard.tsx');
  for (const text of [
    'Attempt timeline',
    'Cumulative counts',
    'supplierData',
    'adminReview',
    'system',
    'Not recorded',
    'Open Product Review',
    '<details',
    'remainingLimitAtStart',
  ]) assert.match(component, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  assert.match(dashboard, /Open evidence/);
  assert.match(dashboard, /View evidence/);
  assert.match(dashboard, /onOpenProductReview/);
});

test('read model returns safe immutable evidence through the existing GET detail route only', () => {
  const evidence = source('functions/src/api/suppliers/supplierSyncEvidence.ts');
  const routes = source('functions/src/api/routes/supplier.ts');
  assert.match(evidence, /loadSupplierSyncEvidence/);
  assert.match(evidence, /projectAttemptEvidence/);
  assert.match(evidence, /errorMessageSafe\.slice\(0, 500\)/);
  assert.match(routes, /app\.get\("\/api\/supplier-sync\/jobs\/:jobId"/);
  assert.match(routes, /response\.evidence = await loadSupplierSyncEvidence/);
  assert.match(routes, /req\.query\.evidence/);
  assert.match(source('src/components/supplier-operations/SupplierSyncJobEvidencePanel.tsx'), /evidence=true/);
  assert.doesNotMatch(evidence, /supplierMetadata|supplierCost|costPrice|privatePayload/u);
  assert.doesNotMatch(routes, /app\.post\("\/api\/supplier-sync\/jobs\/:jobId\/evidence/);
});

test('business and sync execution controls remain outside the evidence surface', () => {
  const dashboard = source('src/components/supplier-operations/SupplierOperationsDashboard.tsx');
  const component = source('src/components/supplier-operations/SupplierSyncJobEvidencePanel.tsx');
  assert.doesNotMatch(component, /postSupplierApi|fetch\([^\n]+POST/u);
  assert.match(dashboard, /requestApi\([^\n]+, 'GET'\)/);
  assert.match(component, /Product Review remains a separate approval step/);
});
