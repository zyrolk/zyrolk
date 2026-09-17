import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DropexConnectorService } from '../functions/src/api/suppliers/dropex/DropexConnectorService';
import { ProductParser } from '../functions/src/api/suppliers/dropex/ProductParser';

const read = (path: string): string => readFileSync(path, 'utf8');

const response = (body: unknown, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(),
  text: async () => JSON.stringify(body),
  json: async <T>() => body as T,
});

const jwtForAccount = (accountId: string): string => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ account: { id: accountId }, exp: Math.floor(Date.now() / 1000) + 3_600 })}.signature`;
};

test('Dropex exact refresh reads raw reseller price before enriching only the exact row', async () => {
  const calls: string[] = [];
  const service = new DropexConnectorService(
    { supplierId: 'dropex', sourceId: 'dropex', credentialReference: 'test-profile' },
    {
      fetchOutbound: async (url) => {
        calls.push(url);
        if (url.includes('/auth/login')) return response({ access_token: jwtForAccount('reseller-1') });
        if (url.includes('/re-seller-products/get')) {
          return response({
            content: [
              { productDetail: { id: 'unrelated', sku: 'OTHER-1', name: 'Other' }, price: 999 },
              { productDetail: { id: '4970', sku: 'SHX2924', productCategoryId: 29, name: 'Target' }, price: 720 },
            ],
            last: true,
          });
        }
        if (url.includes('/product-categories')) return response([{ id: 29, name: 'Vehicle Accessories' }]);
        if (url.includes('/products/4970/dto')) {
          return response({ data: { description: 'Current description', sellingPrice: 1400, onHandInventory: 1 } });
        }
        throw new Error(`Unexpected supplier endpoint in exact refresh test: ${url}`);
      },
    },
  );

  const product = await service.fetchExactProductForRefresh(
    { username: 'test-user', password: 'test-password' },
    { approvedHosts: ['inventory.dropex.lk', 'user.dropex.lk'], connector: 'dropex' },
    { supplierProductId: '4970', sku: 'SHX2924' },
  );

  assert.equal(product.supplierProductId, '4970');
  assert.equal(product.sku, 'SHX2924');
  assert.equal(product.wholesalePrice, 720);
  assert.equal(product.recommendedRetailPrice, 1400);
  assert.equal(product.supplierCategory, 'Vehicle Accessories');
  assert.equal(calls.filter((url) => url.includes('/products/')).length, 1);
  assert.equal(calls.some((url) => url.includes('/products/unrelated/dto')), false);
});

test('Dropex commercial parser never falls back to DTO price aliases for fulfillment cost', () => {
  const parsed = ProductParser.parseCatalogItem({
    productDetail: { id: '4970', sku: 'SHX2924', sellingPrice: 1400 },
    buyingPrice: 410,
    reSellingPrice: 720,
  });
  assert.equal(parsed.wholesalePrice, 0);
  assert.equal(parsed.recommendedRetailPrice, 1400);
});

test('Dropex exact refresh rejects duplicate identities before any enrichment', async () => {
  const calls: string[] = [];
  const service = new DropexConnectorService(
    { supplierId: 'dropex', sourceId: 'dropex', credentialReference: 'test-profile' },
    {
      fetchOutbound: async (url) => {
        calls.push(url);
        if (url.includes('/auth/login')) return response({ access_token: jwtForAccount('reseller-1') });
        if (url.includes('/re-seller-products/get')) {
          return response({
            content: [
              { productDetail: { id: '4970', sku: 'SHX2924' }, price: 720 },
              { productDetail: { id: '4970', sku: 'SHX2924' }, price: 720 },
            ],
            last: true,
          });
        }
        throw new Error(`Unexpected enrichment request for ambiguous identity: ${url}`);
      },
    },
  );

  await assert.rejects(
    service.fetchExactProductForRefresh(
      { username: 'test-user', password: 'test-password' },
      { approvedHosts: ['inventory.dropex.lk', 'user.dropex.lk'], connector: 'dropex' },
      { supplierProductId: '4970', sku: 'SHX2924' },
    ),
    /multiple catalogue rows/u,
  );
  assert.equal(calls.filter((url) => url.includes('/products/')).length, 0);
  assert.equal(calls.some((url) => url.includes('/product-categories')), false);
});

test('Dropex exact refresh fails closed at its page and record bounds when the target is absent', async () => {
  const catalogCalls: string[] = [];
  const service = new DropexConnectorService(
    { supplierId: 'dropex', sourceId: 'dropex', credentialReference: 'test-profile' },
    {
      fetchOutbound: async (url) => {
        if (url.includes('/auth/login')) return response({ access_token: jwtForAccount('reseller-1') });
        if (url.includes('/re-seller-products/get')) {
          const page = new URL(url).searchParams.get('page') || '0';
          catalogCalls.push(page);
          return response({
            content: Array.from({ length: 100 }, (_, index) => ({
              productDetail: { id: `other-${page}-${index}`, sku: `OTHER-${page}-${index}` },
              price: 720,
            })),
            number: Number(page),
            totalElements: 5_000,
            last: false,
          });
        }
        throw new Error(`Unexpected enrichment request for absent identity: ${url}`);
      },
    },
  );

  await assert.rejects(
    service.fetchExactProductForRefresh(
      { username: 'test-user', password: 'test-password' },
      { approvedHosts: ['inventory.dropex.lk', 'user.dropex.lk'], connector: 'dropex' },
      { supplierProductId: '4970', sku: 'SHX2924' },
    ),
    /within the refresh bounds/u,
  );
  assert.equal(catalogCalls.length, 20);
  assert.equal(catalogCalls.at(-1), '19');
});

test('refresh route and sync helper are identity-bound, bounded, and use the current review pipeline', () => {
  const routes = read('functions/src/api/routes/supplier.ts');
  const sync = read('functions/src/scheduled/supplierSync.ts');
  const connector = read('functions/src/api/suppliers/dropex/DropexConnectorService.ts');

  assert.match(routes, /app\.post\("\/api\/supplier-review-queue\/:queueItemId\/refresh", requireSupplierHubAdmin/u);
  assert.match(routes, /refreshActiveSupplierReviewItem\(queueItemId, reviewerFor\(res\)\)/u);
  assert.match(sync, /Only an active supplier review_pending item can be refreshed/u);
  assert.match(sync, /reviewRecordIsTerminalDecision\(queueItem\)/u);
  assert.match(sync, /buildSupplierOfferId\(sourceId, supplierProductId, supplierSku\)/u);
  assert.match(sync, /The canonical product for this review item could not be found/u);
  assert.match(sync, /buildSupplierProductComparison\(product, \{ \.\.\.currentProduct \}\)/u);
  assert.match(sync, /buildProductPayload\(/u);
  assert.match(sync, /planSupplierTaxonomyCandidates\(/u);
  assert.match(sync, /stageSupplierOfferObservation\(/u);
  assert.match(sync, /commitQueuedItems\(queuedWrites\)/u);
  assert.match(connector, /REFRESH_MAX_PAGES = 20/u);
  assert.match(connector, /REFRESH_MAX_RECORDS = 2_000/u);
  assert.match(connector, /REFRESH_MAX_ELAPSED_MS = 30_000/u);
  assert.match(connector, /productId !== expectedProductId \|\| sku !== expectedSku/u);
  assert.match(connector, /ProductParser\.parseCatalogItem\(match, \{ categoryLookup, enrichment \}\)/u);
});

test('supplier review refresh UI is visible only for eligible Dropex reviews and cannot approve automatically', () => {
  const modal = read('src/components/SupplierReviewEditorModal.tsx');
  const hub = read('src/components/SupplierHubFiveStars.tsx');

  assert.match(modal, /Refresh from Supplier/u);
  assert.match(modal, /Refreshing…/u);
  assert.match(modal, /refreshEligible && onRefreshSupplier/u);
  assert.match(hub, /state === 'review_pending'/u);
  assert.match(hub, /connector === 'dropex' \|\| source === 'dropex'/u);
  assert.match(hub, /\/refresh`/u);
  assert.match(hub, /No approval or publication was performed/u);
  assert.doesNotMatch(hub.slice(hub.indexOf('const handleRefreshSupplierReviewItem'), hub.indexOf('const handleRetryDeadLetterMedia')), /decideSupplierReviewQueueItem/u);
});
