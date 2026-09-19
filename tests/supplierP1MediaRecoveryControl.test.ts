import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildP1_002MediaRecoveryEndpoint,
  isP1_002MediaRecoveryQueueId,
  P1_002_MEDIA_RECOVERY_QUEUE_IDS,
} from '../src/components/supplier-operations/SupplierOperationsDashboard';

const source = readFileSync(new URL('../src/components/supplier-operations/SupplierOperationsDashboard.tsx', import.meta.url), 'utf8');

test('P1-002 media recovery exposes exactly the seven fixed queue IDs', () => {
  assert.deepEqual(P1_002_MEDIA_RECOVERY_QUEUE_IDS, [
    'dropex-shx2063',
    'dropex-atf0326',
    'dropex-0520',
    'dropex-azk0709',
    'dropex-shx1985',
    'dropex-atf0186',
    'dropex-azk0414',
  ]);
  assert.ok(P1_002_MEDIA_RECOVERY_QUEUE_IDS.every(isP1_002MediaRecoveryQueueId));
  assert.equal(isP1_002MediaRecoveryQueueId('dropex-other'), false);
  assert.equal(buildP1_002MediaRecoveryEndpoint('dropex-other'), null);
});

test('P1-002 recovery uses the exact selected queue ID and existing authenticated helper', () => {
  assert.equal(
    buildP1_002MediaRecoveryEndpoint('dropex-shx2063'),
    '/api/supplier-review-queue/dropex-shx2063/refresh',
  );
  assert.match(source, /postSupplierApi\(endpoint, \{\}\)/u);
  assert.match(source, /const endpoint = buildP1_002MediaRecoveryEndpoint\(p1MediaRecoveryQueueId\)/u);
  assert.match(source, /P1_002_MEDIA_RECOVERY_QUEUE_IDS\.map/u);
});

test('P1-002 recovery is explicit, single-flight, and surfaces success or error', () => {
  assert.match(source, /onSubmit=\{\(event\) => \{ event\.preventDefault\(\); void runP1MediaRecovery\(\); \}\}/u);
  assert.match(source, /!p1MediaRecoveryConfirmed \|\| p1MediaRecoveryBusy/u);
  assert.match(source, /setP1MediaRecoveryBusy\(true\)/u);
  assert.match(source, /setP1MediaRecoveryBusy\(false\)/u);
  assert.match(source, /p1MediaRecoveryResult\.message/u);
  assert.match(source, /Refresh requested once for/u);
});

test('P1-002 recovery has no approval, publication, sync, or alert-lifecycle action', () => {
  const start = source.indexOf('const runP1MediaRecovery');
  const end = source.indexOf('\n  const summary =', start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.doesNotMatch(handler, /\/approve|\/publish|supplier-sync|\/resolve|\/acknowledge|\/retry/u);
  assert.doesNotMatch(handler, /setTimeout|setInterval|useEffect/u);
});
