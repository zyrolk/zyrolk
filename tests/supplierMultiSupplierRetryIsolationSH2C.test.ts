import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  isSupplierSourceTerminallySuccessfulForJob,
  partitionSupplierSourcesForSyncJob,
  resolveSupplierSyncRunStatus,
} from '../functions/src/scheduled/supplierSync';

const checkpoint = (syncJobId: string, status: string) => ({
  catalogSync: {
    syncJobId,
    status,
    traversalId: `${syncJobId}-${status}`,
    terminationReason: status === 'limited' ? 'limit_reached' : 'catalog_complete',
  },
}) as Parameters<typeof isSupplierSourceTerminallySuccessfulForJob>[0];

test('same-job retry skips only sources with a terminal successful traversal', () => {
  assert.equal(isSupplierSourceTerminallySuccessfulForJob(checkpoint('job-1', 'completed'), 'job-1'), true);
  assert.equal(isSupplierSourceTerminallySuccessfulForJob(checkpoint('job-1', 'limited'), 'job-1'), true);
  assert.equal(isSupplierSourceTerminallySuccessfulForJob(checkpoint('job-1', 'in_progress'), 'job-1'), false);
  assert.equal(isSupplierSourceTerminallySuccessfulForJob(checkpoint('job-1', 'paused'), 'job-1'), false);
  assert.equal(isSupplierSourceTerminallySuccessfulForJob(checkpoint('job-1', 'failed'), 'job-1'), false);
});

test('a later manual or scheduled job never inherits another job terminal state', () => {
  const source = checkpoint('old-job', 'completed');
  assert.equal(isSupplierSourceTerminallySuccessfulForJob(source, 'new-job'), false);
  assert.equal(isSupplierSourceTerminallySuccessfulForJob(source, ''), false);
});

test('retry partition preserves failed and resumable sources while excluding prior successes', () => {
  const sources = [
    { id: 'source-a', ...checkpoint('same-job', 'completed') },
    { id: 'source-b', ...checkpoint('same-job', 'paused') },
    { id: 'source-c', ...checkpoint('same-job', 'in_progress') },
    { id: 'source-d', ...checkpoint('older-job', 'completed') },
  ];
  const result = partitionSupplierSourcesForSyncJob(sources, 'same-job');

  assert.deepEqual(result.terminalSuccessful.map((source) => source.id), ['source-a']);
  assert.deepEqual(result.pending.map((source) => source.id), ['source-b', 'source-c', 'source-d']);
});

test('multi-supplier status is based on source outcomes, never queued product count', () => {
  assert.equal(resolveSupplierSyncRunStatus({
    completedSources: 1, failedSources: 1, incompleteSources: 0, interrupted: false,
  }), 'Partial');
  assert.equal(resolveSupplierSyncRunStatus({
    completedSources: 0, failedSources: 2, incompleteSources: 0, interrupted: false,
  }), 'Failed');
  assert.equal(resolveSupplierSyncRunStatus({
    completedSources: 2, failedSources: 0, incompleteSources: 0, interrupted: false,
  }), 'Success');
  assert.equal(resolveSupplierSyncRunStatus({
    completedSources: 1, failedSources: 0, incompleteSources: 1, interrupted: false,
  }), 'Partial');
  assert.equal(resolveSupplierSyncRunStatus({
    completedSources: 0, failedSources: 0, incompleteSources: 0, interrupted: true,
  }), 'Partial');
});

test('source failure remains isolated and progress uses the original source scope', () => {
  const source = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const sourceFailureBlock = source.match(/catch \(error: any\) \{[\s\S]*?\/\/ A single connector failure must not prevent remaining suppliers from syncing\.[\s\S]*?continue;/u)?.[0] || '';

  assert.match(sourceFailureBlock, /metrics\.sourceFailures \+= 1/u);
  assert.match(sourceFailureBlock, /continue;/u);
  assert.match(source, /completedSourceCount = sourcePartition\.terminalSuccessful\.length/u);
  assert.match(source, /totalSources: totalSourceCount/u);
  assert.doesNotMatch(source, /metrics\.productsQueued > 0 \? "Partial" : "Failed"/u);
});
