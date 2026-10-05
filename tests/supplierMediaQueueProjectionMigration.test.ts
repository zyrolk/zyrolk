import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('media projection migration is explicitly gated, checkpointed, and field-only', () => {
  const script = readFileSync('scripts/migrateSupplierMediaQueueProjection.ts', 'utf8');
  assert.match(script, /SUPPLIER_MEDIA_QUEUE_PROJECTION_CONFIRM/u);
  assert.match(script, /--apply/u);
  assert.match(script, /PAGE_SIZE = 200/u);
  assert.match(script, /MAX_BATCHES_PER_INVOCATION = 25/u);
  assert.match(script, /lastDocumentId/u);
  assert.match(script, /complete/u);
  assert.match(script, /status: "active"/u);
  assert.match(script, /buildSupplierMediaQueueProjection/u);
  assert.doesNotMatch(script, /supplierSync|productPayload|managedMedia:/u);
  assert.match(script, /projection-field-only/u);
  assert.match(script, /no-product-business-data-rewrite/u);
});
