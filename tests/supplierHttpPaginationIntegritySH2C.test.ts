import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HttpSupplierConnector,
  SupplierPaginationIntegrityError,
} from '../functions/src/api/suppliers/HttpSupplierConnector';
import type { SupplierCatalogPageRequest, SupplierCatalogPageResult } from '../functions/src/api/suppliers/types';
import {
  runSupplierCatalogTraversal,
  type SupplierCatalogTraversalCheckpoint,
  SupplierCatalogTraversalIntegrityError,
} from '../functions/src/scheduled/supplierCatalogTraversal';

interface StubResponse {
  data: unknown;
  targetUrl?: string;
}

const connectorWithResponses = (
  response: (url: string) => StubResponse | Promise<StubResponse>,
): { connector: HttpSupplierConnector; calls: string[] } => {
  const connector = new HttpSupplierConnector('https://supplier.example/catalog', {
    dataPath: 'products',
    outboundPolicy: { approvedHosts: ['supplier.example'], connector: 'http-test', sourceId: 'source-1' },
  });
  const calls: string[] = [];
  (connector as unknown as {
    fetchJson(url?: string): Promise<{ data: unknown; targetUrl: string }>;
  }).fetchJson = async (url = 'https://supplier.example/catalog') => {
    calls.push(url);
    const result = await response(url);
    return { data: result.data, targetUrl: result.targetUrl || url };
  };
  return { connector, calls };
};

const product = (id: number) => ({ sku: `SKU-${id}`, title: `Product ${id}` });

test('SH-2C generic HTTP accepts bounded numeric cursors and advances valid remote pages', async () => {
  const { connector, calls } = connectorWithResponses((url) => {
    const cursor = new URL(url).searchParams.get('cursor');
    return cursor === '2'
      ? { data: { products: [product(3)], pagination: { nextCursor: null, hasMore: false, total: 3 } } }
      : { data: { products: [product(1), product(2)], pagination: { nextCursor: 2, hasMore: true, total: 3 } } };
  });

  const first = await connector.fetchProductPage({ cursor: null, pageSize: 2, mode: 'full' });
  const second = await connector.fetchProductPage({ cursor: first.nextCursor, pageSize: 2, mode: 'full' });

  assert.equal(first.complete, false);
  assert.equal(first.nextCursor, '2');
  assert.equal(second.complete, true);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second.products, [product(3)]);
  assert.equal(new URL(calls[1]).searchParams.get('offset'), '2');
});

test('SH-2D generic HTTP does not treat current-page count as a catalogue total', async () => {
  const { connector } = connectorWithResponses(() => ({
    data: { products: [product(1), product(2)], pagination: { count: 2 } },
  }));

  const page = await connector.fetchProductPage({ cursor: null, pageSize: 2, mode: 'full' });

  assert.equal(page.complete, false);
  assert.equal(page.nextCursor, '2');
  assert.equal(page.catalogTotal, undefined);
});

test('SH-2C generic HTTP rejects malformed and contradictory pagination metadata', async (t) => {
  const cases: Array<{ name: string; data: unknown }> = [
    { name: 'malformed container', data: { products: [product(1), product(2)], pagination: 'page-2' } },
    { name: 'object cursor', data: { products: [product(1), product(2)], pagination: { nextCursor: { offset: 2 } } } },
    { name: 'negative total', data: { products: [product(1), product(2)], pagination: { total: -1 } } },
    { name: 'ended cursor with hasMore', data: { products: [product(1), product(2)], pagination: { nextCursor: null, hasMore: true } } },
    { name: 'cursor after terminal hasMore', data: { products: [product(1), product(2)], pagination: { nextCursor: 'page-2', hasMore: false } } },
    { name: 'terminal cursor before total', data: { products: [product(1), product(2)], pagination: { nextCursor: null, total: 3 } } },
    {
      name: 'contradictory root and nested total',
      data: { products: [product(1), product(2)], total: 2, meta: { total: 3 } },
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { connector } = connectorWithResponses(() => ({ data: entry.data }));
      await assert.rejects(
        connector.fetchProductPage({ cursor: null, pageSize: 2, mode: 'full' }),
        (error: unknown) => error instanceof SupplierPaginationIntegrityError,
      );
    });
  }
});

test('SH-2C generic HTTP rejects unsafe persisted cursor values before requesting the supplier', async () => {
  const { connector, calls } = connectorWithResponses(() => ({ data: { products: [] } }));
  await assert.rejects(
    connector.fetchProductPage({ cursor: `zyro-http-local-v1.${'x'.repeat(2_100)}`, pageSize: 2, mode: 'full' }),
    (error: unknown) => error instanceof SupplierPaginationIntegrityError,
  );
  await assert.rejects(
    connector.fetchProductPage({ cursor: 'page\u0000two', pageSize: 2, mode: 'full' }),
    (error: unknown) => error instanceof SupplierPaginationIntegrityError,
  );
  assert.equal(calls.length, 0);
});

test('SH-2C generic HTTP never converts an oversized remote page into a local complete catalogue', async () => {
  const { connector } = connectorWithResponses(() => ({
    data: {
      products: [product(1), product(2), product(3)],
      pagination: { nextCursor: 'page-2', hasMore: true, total: 6 },
    },
  }));

  await assert.rejects(
    connector.fetchProductPage({ cursor: null, pageSize: 2, mode: 'full' }),
    /more products than the requested remote page size/i,
  );

  const terminalRemote = connectorWithResponses(() => ({
    data: {
      products: [product(1), product(2), product(3)],
      pagination: { nextCursor: null, hasMore: false, total: 3 },
    },
  }));
  await assert.rejects(
    terminalRemote.connector.fetchProductPage({ cursor: null, pageSize: 2, mode: 'full' }),
    /more products than the requested remote page size/i,
  );
});

test('SH-2C unpaginated local snapshots are cached and fingerprint-validated on resume', async () => {
  const original = [product(1), product(2), product(3), product(4), product(5)];
  const firstRuntime = connectorWithResponses(() => ({ data: { products: original } }));
  const first = await firstRuntime.connector.fetchProductPage({ cursor: null, pageSize: 2, mode: 'full' });
  const second = await firstRuntime.connector.fetchProductPage({ cursor: first.nextCursor, pageSize: 2, mode: 'full' });
  const third = await firstRuntime.connector.fetchProductPage({ cursor: second.nextCursor, pageSize: 2, mode: 'full' });

  assert.equal(firstRuntime.calls.length, 1, 'one immutable local snapshot should serve the whole in-process traversal');
  assert.deepEqual([first.complete, second.complete, third.complete], [false, false, true]);
  assert.deepEqual(third.products, [product(5)]);

  const resumedRuntime = connectorWithResponses(() => ({
    data: { products: [product(0), ...original] },
  }));
  await assert.rejects(
    resumedRuntime.connector.fetchProductPage({ cursor: first.nextCursor, pageSize: 2, mode: 'full' }),
    /changed while resuming/i,
  );
});

test('SH-2C ignored pagination fails closed and never reconciles removals', async () => {
  const repeated = [product(1), product(2)];
  const { connector } = connectorWithResponses(() => ({ data: { products: repeated } }));
  let processedPages = 0;
  let reconciliations = 0;

  await assert.rejects(runSupplierCatalogTraversal({
    connector,
    pageSize: 2,
    processPage: async (page) => {
      processedPages += 1;
      return { productsScanned: page.products.length, productsImported: 0 };
    },
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  }), (error: unknown) => error instanceof SupplierCatalogTraversalIntegrityError);

  assert.equal(processedPages, 1);
  assert.equal(reconciliations, 0);
});

test('SH-2C malformed pagination fails before processing and never reconciles removals', async () => {
  const { connector } = connectorWithResponses(() => ({
    data: { products: [product(1)], pagination: { hasMore: 'yes' } },
  }));
  let processedPages = 0;
  let reconciliations = 0;

  await assert.rejects(runSupplierCatalogTraversal({
    connector,
    pageSize: 1,
    processPage: async () => {
      processedPages += 1;
      return { productsScanned: 1, productsImported: 0 };
    },
    persistCheckpoint: async () => undefined,
    reconcileDeletedProducts: async () => { reconciliations += 1; },
  }), (error: unknown) => error instanceof SupplierPaginationIntegrityError);

  assert.equal(processedPages, 0);
  assert.equal(reconciliations, 0);
});

test('SH-2C traversal rejects non-advancing and cyclic cursors before reconciliation', async (t) => {
  await t.test('non-advancing cursor', async () => {
    let call = 0;
    let reconciliations = 0;
    const connector = {
      async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
        call += 1;
        return call === 1
          ? { products: [product(1)], targetUrl: 'https://supplier.example', complete: false, nextCursor: 'same' }
          : { products: [product(2)], targetUrl: 'https://supplier.example', complete: false, nextCursor: request.cursor };
      },
    };
    await assert.rejects(runSupplierCatalogTraversal({
      connector,
      pageSize: 1,
      processPage: async () => ({ productsScanned: 1, productsImported: 0 }),
      persistCheckpoint: async () => undefined,
      reconcileDeletedProducts: async () => { reconciliations += 1; },
    }), /forward-only cursor/i);
    assert.equal(reconciliations, 0);
  });

  await t.test('multi-page cursor cycle', async () => {
    let call = 0;
    let processedPages = 0;
    let reconciliations = 0;
    const pages = [
      { products: [product(1)], nextCursor: 'A' },
      { products: [product(2)], nextCursor: 'B' },
      { products: [product(3)], nextCursor: 'A' },
    ];
    const connector = {
      async fetchProductPage(): Promise<SupplierCatalogPageResult> {
        const page = pages[Math.min(call++, pages.length - 1)];
        return { ...page, targetUrl: 'https://supplier.example', complete: false };
      },
    };
    await assert.rejects(runSupplierCatalogTraversal({
      connector,
      pageSize: 1,
      processPage: async () => { processedPages += 1; return { productsScanned: 1, productsImported: 0 }; },
      persistCheckpoint: async () => undefined,
      reconcileDeletedProducts: async () => { reconciliations += 1; },
    }), /cyclic catalogue cursor/i);
    assert.equal(processedPages, 2);
    assert.equal(reconciliations, 0);
  });

  await t.test('multi-page cursor cycle remains detectable after a worker restart', async () => {
    let pauseChecks = 0;
    let persisted: SupplierCatalogTraversalCheckpoint | undefined;
    const firstWorkerPages = [
      { products: [product(1)], nextCursor: 'A' },
      { products: [product(2)], nextCursor: 'B' },
    ];
    let firstWorkerCall = 0;
    const firstWorker = {
      async fetchProductPage(): Promise<SupplierCatalogPageResult> {
        const page = firstWorkerPages[Math.min(firstWorkerCall++, firstWorkerPages.length - 1)];
        return { ...page, targetUrl: 'https://supplier.example', complete: false };
      },
    };
    const paused = await runSupplierCatalogTraversal({
      connector: firstWorker,
      pageSize: 1,
      shouldPause: () => pauseChecks++ >= 2,
      processPage: async () => ({ productsScanned: 1, productsImported: 0 }),
      persistCheckpoint: async (checkpoint) => { persisted = checkpoint; },
      reconcileDeletedProducts: async () => assert.fail('a paused traversal must not reconcile removals'),
    });
    assert.equal(paused.paused, true);
    assert.equal(persisted?.cursor, 'B');

    let resumedProcessing = 0;
    let reconciliations = 0;
    const resumedWorker = {
      async fetchProductPage(): Promise<SupplierCatalogPageResult> {
        return {
          products: [product(3)],
          targetUrl: 'https://supplier.example',
          complete: false,
          nextCursor: 'A',
        };
      },
    };
    await assert.rejects(runSupplierCatalogTraversal({
      connector: resumedWorker,
      pageSize: 1,
      initial: persisted,
      processPage: async () => { resumedProcessing += 1; return { productsScanned: 1, productsImported: 0 }; },
      persistCheckpoint: async () => undefined,
      reconcileDeletedProducts: async () => { reconciliations += 1; },
    }), /cyclic catalogue cursor/i);
    assert.equal(resumedProcessing, 0);
    assert.equal(reconciliations, 0);
  });

  await t.test('repeated terminal page', async () => {
    let call = 0;
    let reconciliations = 0;
    const connector = {
      async fetchProductPage(): Promise<SupplierCatalogPageResult> {
        call += 1;
        return {
          products: [product(1)],
          targetUrl: 'https://supplier.example',
          complete: call > 1,
          nextCursor: call > 1 ? null : 'page-2',
        };
      },
    };
    await assert.rejects(runSupplierCatalogTraversal({
      connector,
      pageSize: 1,
      processPage: async () => ({ productsScanned: 1, productsImported: 0 }),
      persistCheckpoint: async () => undefined,
      reconcileDeletedProducts: async () => { reconciliations += 1; },
    }), /repeated a previously processed catalogue page/i);
    assert.equal(reconciliations, 0);
  });
});
