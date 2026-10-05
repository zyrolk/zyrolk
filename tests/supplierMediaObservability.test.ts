import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSupplierMediaQueueProjection,
  classifySupplierMediaObservability,
  supplierMediaQueueClassFor,
  supplierReviewMediaMatchesFilter,
} from '../functions/src/api/suppliers/supplierMediaObservability';

const now = Date.parse('2026-10-05T12:00:00.000Z');
const sourceUrl = 'https://supplier.example/image.jpg';
const managedMedia = [{
  firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/image.jpg',
  originalSupplierUrl: sourceUrl,
  imageStatus: 'ready',
  isPrimary: true,
}];

const baseRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  queueState: 'review_pending',
  mediaStatus: 'ready',
  mediaReadiness: 'publication_safe',
  mediaSourceImageUrls: [sourceUrl],
  managedMedia,
  mediaFailures: [],
  createdAt: '2026-10-05T11:58:00.000Z',
  updatedAt: '2026-10-05T11:59:00.000Z',
  ...overrides,
});

test('media state mapping distinguishes ready, processing, retry, issue, unavailable, and permanent states', () => {
  assert.equal(classifySupplierMediaObservability(baseRecord(), now).state, 'READY');
  assert.equal(classifySupplierMediaObservability(baseRecord({ queueState: 'processing', mediaStatus: 'downloading' }), now).state, 'PROCESSING');
  assert.equal(classifySupplierMediaObservability(baseRecord({
    queueState: 'retryable_failure',
    mediaStatus: 'failed',
    mediaReadiness: 'blocked',
    retryCount: 1,
    nextRetryAt: '2026-10-05T12:10:00.000Z',
    mediaFailures: [{ code: 'UNKNOWN', retryable: true }],
  }), now).state, 'RETRY_SCHEDULED');
  assert.equal(classifySupplierMediaObservability(baseRecord({
    queueState: 'dead_letter',
    mediaStatus: 'failed',
    mediaReadiness: 'blocked',
    mediaFailures: [{ code: 'UNKNOWN', retryable: false }],
  }), now).state, 'NEEDS_ATTENTION');
  assert.equal(classifySupplierMediaObservability(baseRecord({
    mediaStatus: 'failed',
    mediaReadiness: 'blocked',
    mediaSourceImageUrls: [],
    managedMedia: [],
    mediaFailures: [],
  }), now).state, 'SUPPLIER_IMAGE_UNAVAILABLE');
  assert.equal(classifySupplierMediaObservability(baseRecord({
    mediaStatus: 'partial',
    mediaReadiness: 'blocked',
    managedMedia: [],
    mediaFailures: [{ code: 'IMAGE_TOO_LARGE', retryable: false }],
  }), now).state, 'PERMANENT_MEDIA_CONSTRAINT');
  assert.equal(classifySupplierMediaObservability(baseRecord({
    mediaStatus: 'partial',
    mediaReadiness: 'blocked',
    managedMedia: [],
    mediaFailures: [{ code: 'IMAGE_TOO_LARGE', retryable: false }],
  }), now).rawState, 'PERMANENT_FAILURE');
  assert.equal(classifySupplierMediaObservability(baseRecord({
    queueState: 'dead_letter',
    retryCount: 3,
    retryLimit: 3,
    mediaStatus: 'failed',
    mediaReadiness: 'blocked',
    mediaFailures: [{ code: 'UNKNOWN', retryable: true }],
  }), now).rawState, 'RETRY_EXHAUSTED');
});

test('age evidence is deterministic and conservative around the five-minute worker cadence', () => {
  const fresh = classifySupplierMediaObservability(baseRecord({
    queueState: 'processing',
    mediaStatus: 'downloading',
    processingStartedAt: '2026-10-05T11:58:00.000Z',
  }), now);
  assert.equal(fresh.ageClass, 'fresh');
  assert.equal(fresh.possiblyStuck, false);

  const aging = classifySupplierMediaObservability(baseRecord({
    queueState: 'processing',
    mediaStatus: 'downloading',
    processingStartedAt: '2026-10-05T11:45:00.000Z',
  }), now);
  assert.equal(aging.ageClass, 'aging');
  assert.equal(aging.possiblyStuck, false);

  const stale = classifySupplierMediaObservability(baseRecord({
    queueState: 'processing',
    mediaStatus: 'downloading',
    processingStartedAt: '2026-10-05T11:20:00.000Z',
    leaseExpiresAt: '2026-10-05T11:25:00.000Z',
  }), now);
  assert.equal(stale.ageClass, 'stale');
  assert.equal(stale.possiblyStuck, true);

  const scheduled = classifySupplierMediaObservability(baseRecord({
    queueState: 'retryable_failure',
    mediaStatus: 'failed',
    mediaReadiness: 'blocked',
    retryCount: 1,
    nextRetryAt: '2026-10-05T12:10:00.000Z',
    updatedAt: '2026-10-05T11:20:00.000Z',
    mediaFailures: [{ code: 'UNKNOWN', retryable: true }],
  }), now);
  assert.equal(scheduled.state, 'RETRY_SCHEDULED');
  assert.equal(scheduled.ageClass, 'stale');
  assert.equal(scheduled.possiblyStuck, false);
});

test('legacy records remain unknown and are never promoted to ready or stuck', () => {
  const legacy = classifySupplierMediaObservability({
    queueState: 'processing',
    createdAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:10:00.000Z',
  }, now);
  assert.equal(legacy.state, 'LEGACY_UNKNOWN');
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.possiblyStuck, false);
  assert.equal(legacy.sourceImageCount, null);
  assert.equal(legacy.retryCount, null);
});

test('media filters are mutually exclusive and preserve legacy safety', () => {
  const ready = baseRecord();
  const processing = baseRecord({ queueState: 'processing', mediaStatus: 'downloading' });
  const retry = baseRecord({
    queueState: 'retryable_failure',
    mediaStatus: 'failed',
    mediaReadiness: 'blocked',
    nextRetryAt: '2026-10-05T12:10:00.000Z',
    mediaFailures: [{ retryable: true }],
  });
  const issue = baseRecord({
    queueState: 'dead_letter',
    mediaStatus: 'failed',
    mediaReadiness: 'blocked',
    mediaFailures: [{ retryable: false }],
  });
  const legacy = { queueState: 'processing' };

  assert.equal(supplierReviewMediaMatchesFilter(ready, 'ready', now), true);
  assert.equal(supplierReviewMediaMatchesFilter(ready, 'processing', now), false);
  assert.equal(supplierReviewMediaMatchesFilter(processing, 'processing', now), true);
  assert.equal(supplierReviewMediaMatchesFilter(retry, 'processing', now), true);
  assert.equal(supplierReviewMediaMatchesFilter(issue, 'issues', now), true);
  assert.equal(supplierReviewMediaMatchesFilter(legacy, 'issues', now), false);
  assert.equal(supplierReviewMediaMatchesFilter(legacy, 'all', now), true);
});

test('media readiness remains separate from product publish validation', () => {
  const ready = classifySupplierMediaObservability(baseRecord({
    productValidation: { readyToPublish: false, missingFields: ['category'] },
  }), now);
  assert.equal(ready.state, 'READY');
  assert.equal(ready.readiness, 'ready');
});

test('media queue projection mirrors observability without changing approval readiness', () => {
  const ready = baseRecord({
    productValidation: { readyToPublish: false, missingFields: ['category'] },
  });
  assert.equal(supplierMediaQueueClassFor(ready, now), 'ready');
  assert.deepEqual(buildSupplierMediaQueueProjection(ready, {}, now), {
    mediaQueueClass: 'ready',
    mediaQueueClassVersion: 1,
  });
  assert.equal(supplierMediaQueueClassFor({
    ...ready,
    queueState: 'processing',
    mediaStatus: 'downloading',
  }, now), 'processing');
  assert.equal(supplierMediaQueueClassFor({
    ...ready,
    queueState: 'dead_letter',
    mediaStatus: 'failed',
    mediaFailures: [{ retryable: false }],
  }, now), 'issues');
  assert.equal(supplierMediaQueueClassFor({ queueState: 'processing' }, now), 'unknown');
});
