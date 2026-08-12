import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductParser } from '../functions/src/api/suppliers/a2z/ProductParser';
import {
  buildCollisionSafeSupplierReviewQueueId,
  buildLegacySupplierReviewQueueId,
  canonicalSupplierReviewIdentity,
  planSupplierReviewQueueIds,
  SupplierReviewQueueIdentityInput,
} from '../functions/src/api/suppliers/supplierQueueIdentity';
import {
  buildFilteredSupplierOfferSightings,
  isSupplierOfferMissingFromTraversal,
} from '../functions/src/scheduled/supplierSync';
import { runSupplierCatalogTraversal } from '../functions/src/scheduled/supplierCatalogTraversal';
import { buildSupplierOfferId } from '../functions/src/api/suppliers/supplierOfferEngine';

const queueRecord = (input: SupplierReviewQueueIdentityInput): Record<string, unknown> => ({
  sourceId: input.sourceId,
  supplierCode: input.supplierCode,
  supplierSnapshot: {
    sourceId: input.sourceId,
    supplierProductId: input.supplierProductId,
    supplierSku: input.supplierCode,
  },
});

test('SH-2A collision-safe Product Review identity remains deterministic and legacy compatible', () => {
  const slashIdentity = {
    sourceId: 'a2z-traders', supplierProductId: 'SKU/A', supplierCode: 'SKU/A', productName: 'Slash product',
  };
  const plainIdentity = {
    sourceId: 'a2z-traders', supplierProductId: 'SKUA', supplierCode: 'SKUA', productName: 'Plain product',
  };
  assert.equal(buildLegacySupplierReviewQueueId(slashIdentity), buildLegacySupplierReviewQueueId(plainIdentity));

  const firstPlan = planSupplierReviewQueueIds([slashIdentity, plainIdentity], new Map());
  const retryPlan = planSupplierReviewQueueIds([plainIdentity, slashIdentity], new Map());
  const slashKey = canonicalSupplierReviewIdentity(slashIdentity);
  const plainKey = canonicalSupplierReviewIdentity(plainIdentity);
  assert.notEqual(firstPlan.get(slashKey), firstPlan.get(plainKey));
  assert.deepEqual(firstPlan, retryPlan, 'page order and retries must not change collision ownership');
  assert.ok([...firstPlan.values()].includes(buildCollisionSafeSupplierReviewQueueId(slashIdentity))
    || [...firstPlan.values()].includes(buildCollisionSafeSupplierReviewQueueId(plainIdentity)));

  const sameIdentity = planSupplierReviewQueueIds([slashIdentity, { ...slashIdentity }], new Map());
  assert.equal(sameIdentity.size, 1);
  assert.equal(sameIdentity.get(slashKey), buildLegacySupplierReviewQueueId(slashIdentity));

  const renamedSku = { ...slashIdentity, supplierCode: 'RENAMED-SKU', productName: 'Renamed product' };
  assert.deepEqual(
    planSupplierReviewQueueIds([slashIdentity, renamedSku], new Map()),
    planSupplierReviewQueueIds([renamedSku, slashIdentity], new Map()),
    'one stable supplier product ID must resolve independently of connector page order',
  );

  const legacyId = buildLegacySupplierReviewQueueId(slashIdentity);
  const legacyRecords = new Map<string, unknown>([[legacyId, queueRecord(slashIdentity)]]);
  const compatibleLegacyPlan = planSupplierReviewQueueIds([slashIdentity], legacyRecords);
  assert.equal(compatibleLegacyPlan.get(slashKey), legacyId, 'compatible historical review must be reused');

  const occupiedLegacyPlan = planSupplierReviewQueueIds(
    [plainIdentity],
    new Map<string, unknown>([[legacyId, queueRecord(slashIdentity)]]),
  );
  assert.equal(occupiedLegacyPlan.get(plainKey), buildCollisionSafeSupplierReviewQueueId(plainIdentity));
  assert.equal(
    planSupplierReviewQueueIds([plainIdentity], new Map<string, unknown>([[legacyId, queueRecord(slashIdentity)]])).get(plainKey),
    occupiedLegacyPlan.get(plainKey),
    'retry must resolve to the same hashed fallback',
  );
});

const observedProduct = ProductParser.parseJsonPayload({
  pro_id: '7295',
  pro_code: 'A2Z/7295',
  pro_name: 'Filtered supplier product',
  cat_name: 'Excluded category',
  brand_name: 'Excluded brand',
  wholesale_price: 100,
  bal: 5,
});
const observedOfferId = buildSupplierOfferId('a2z-traders', observedProduct.supplierProductId, observedProduct.sku);

for (const filterName of ['category', 'brand']) {
  test(`SH-2A existing product retrieved then ${filterName} filtered is sighted without commercial mutation`, () => {
    const existingOffer = {
      id: observedOfferId,
      price: 150,
      cost: 100,
      stock: 5,
      reviewStatus: 'approved',
      catalogPayload: { description: 'Reviewed content' },
    };
    const sightings = buildFilteredSupplierOfferSightings(
      'a2z-traders',
      [observedProduct],
      [],
      [existingOffer],
      'traversal-2',
      '2026-08-01T08:00:00.000Z',
    );
    assert.deepEqual(sightings, [{
      offerId: observedOfferId,
      data: {
        supplierCatalogTraversalId: 'traversal-2',
        supplierCatalogSeenAt: '2026-08-01T08:00:00.000Z',
      },
    }]);
    const afterSighting = { ...existingOffer, ...sightings[0].data };
    assert.equal(afterSighting.price, 150);
    assert.equal(afterSighting.cost, 100);
    assert.equal(afterSighting.stock, 5);
    assert.equal(afterSighting.reviewStatus, 'approved');
    assert.deepEqual(afterSighting.catalogPayload, { description: 'Reviewed content' });
    assert.equal(isSupplierOfferMissingFromTraversal(afterSighting, 'traversal-2'), false);
  });
}

test('SH-2A genuinely absent offer remains eligible for removal after a complete traversal', () => {
  assert.equal(isSupplierOfferMissingFromTraversal({
    availability: 'in_stock',
    supplierCatalogTraversalId: 'traversal-1',
  }, 'traversal-2'), true);
});

test('SH-2A incomplete traversal never executes removal reconciliation', async () => {
  let reconciliations = 0;
  const result = await runSupplierCatalogTraversal({
    connector: {
      fetchProductPage: async () => {
        throw new Error('A paused traversal must not fetch another page.');
      },
    },
    pageSize: 100,
    shouldPause: () => true,
    processPage: async () => ({ productsScanned: 0, productsImported: 0 }),
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => { reconciliations += 1; },
    traversalId: 'traversal-paused',
    now: () => Date.parse('2026-08-01T08:00:00.000Z'),
  });
  assert.equal(result.complete, false);
  assert.equal(result.paused, true);
  assert.equal(reconciliations, 0);
});
