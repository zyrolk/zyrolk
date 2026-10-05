import assert from 'node:assert/strict';
import test from 'node:test';
import { supplierReviewMediaRetryLabel } from '../src/services/supplierMediaObservability';

test('media retry timing is shown only for a scheduled retry state', () => {
  assert.equal(supplierReviewMediaRetryLabel({
    state: 'PROCESSING',
    nextRetryAt: '2020-01-01T12:00:00.000Z',
  }), null);
  assert.equal(supplierReviewMediaRetryLabel({
    state: 'READY',
    nextRetryAt: '2020-01-01T12:00:00.000Z',
  }), null);
  assert.equal(supplierReviewMediaRetryLabel({
    state: 'RETRY_SCHEDULED',
    nextRetryAt: '2020-01-01T12:00:00.000Z',
  }), 'Retry due');
});
