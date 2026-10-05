import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSupplierReviewQueryFingerprint,
  decodeSupplierReviewCursorToken,
  listSupplierReviewReadModelPage,
  SupplierReviewQueryModel,
} from '../functions/src/scheduled/supplierReviewQueue';
import { SupplierReviewAnchorCache, buildSupplierReviewQueryKey } from '../src/services/supplierReviewPagination';

type StoredDocument = Record<string, unknown>;
type StoredRecord = { id: string; data: StoredDocument };
type FakeSnapshot = { exists: boolean; id: string; data: () => StoredDocument | undefined };

const makeFakeDb = (records: StoredRecord[], options: { mediaProjectionActive?: boolean } = {}) => {
  const snapshotFor = (id: string): FakeSnapshot => {
    const record = records.find((entry) => entry.id === id);
    return { exists: Boolean(record), id, data: () => record?.data };
  };
  const makeQuery = (
    filters: Array<{ field: string; operator: string; value: unknown }> = [],
    cursorId: string | null = null,
    limit: number | null = null,
    sortField = 'createdAt',
    sortDirection = 'desc',
  ): any => {
    const query = {
      where: (field: string, operator: string, value: unknown) => makeQuery([...filters, { field, operator, value }], cursorId, limit, sortField, sortDirection),
      orderBy: (field: string | { toString: () => string }, direction: string) => {
        const name = String(field);
        return name === '__name__'
          ? makeQuery(filters, cursorId, limit, sortField, sortDirection)
          : makeQuery(filters, cursorId, limit, name, direction);
      },
      startAfter: (cursor: { id: string }) => makeQuery(filters, cursor.id, limit, sortField, sortDirection),
      limit: (value: number) => makeQuery(filters, cursorId, value, sortField, sortDirection),
      count: () => ({
        get: async () => ({
          data: () => ({ count: query.execute().length }),
        }),
      }),
      execute: () => {
        let selected = records.filter(({ data }) => filters.every(({ field, operator, value }) => {
          const actual = field.split('.').reduce<unknown>((current, part) => (
            current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
          ), data);
          if (operator === 'in') return Array.isArray(value) && value.includes(actual);
          if (operator === '<=') return String(actual || '') <= String(value);
          return actual === value;
        }));
        selected.sort((left, right) => {
          const leftValue = String(left.data[sortField] || '');
          const rightValue = String(right.data[sortField] || '');
          const primary = sortDirection === 'desc'
            ? rightValue.localeCompare(leftValue)
            : leftValue.localeCompare(rightValue);
          return primary || (sortDirection === 'desc' ? right.id.localeCompare(left.id) : left.id.localeCompare(right.id));
        });
        if (cursorId) {
          const cursorIndex = selected.findIndex((entry) => entry.id === cursorId);
          selected = cursorIndex >= 0 ? selected.slice(cursorIndex + 1) : [];
        }
        if (limit !== null) selected = selected.slice(0, limit);
        return selected.map((entry) => snapshotFor(entry.id));
      },
      get: async () => {
        const docs = query.execute();
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
    return query;
  };
  return {
    collection: (collectionName = '') => ({
      where: (field: string, operator: string, value: unknown) => makeQuery().where(field, operator, value),
      orderBy: (field: string, direction: string) => makeQuery().orderBy(field, direction),
      doc: (id: string) => ({ get: async () => collectionName === 'supplier_read_model_meta'
        ? {
          exists: options.mediaProjectionActive === true,
          id,
          data: () => options.mediaProjectionActive === true
            ? { status: 'active', version: 1 }
            : undefined,
        }
        : snapshotFor(id) }),
      get: async () => ({ docs: [], size: 0, empty: true }),
    }),
  };
};

const query = (overrides: Partial<SupplierReviewQueryModel> = {}): SupplierReviewQueryModel => ({
  view: 'review',
  state: 'active',
  mediaFilter: 'all',
  search: '',
  searchMode: 'exact',
  sort: 'created',
  pageSize: 50,
  ...overrides,
});

const records = (count: number): StoredRecord[] => Array.from({ length: count }, (_, index) => ({
  id: `review-${String(index).padStart(3, '0')}`,
  data: {
    status: 'Pending',
    queueState: 'review_pending',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, count - index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, count - index)).toISOString(),
    supplierItemCode: `SKU-${String(index).padStart(3, '0')}`,
    productName: `Review product ${index}`,
    comparison: { comparisonStatus: 'NEW_PRODUCT' },
    productValidation: { readyToPublish: true, missingFields: [], errors: [] },
  },
}));

test('PR-1 page sizes, exact counts, and last partial page are server-backed', async () => {
  const db = makeFakeDb(records(121)) as never;
  for (const pageSize of [25, 50, 100] as const) {
    const result = await listSupplierReviewReadModelPage(db, { query: query({ pageSize }), page: 1 });
    assert.equal(result.pageSize, pageSize);
    assert.equal(result.totalCount, 121);
    assert.equal(result.totalPages, Math.ceil(121 / pageSize));
    assert.equal(result.countStatus, 'exact');
    assert.equal(result.items.length, pageSize);
  }
  const first = await listSupplierReviewReadModelPage(db, { query: query({ pageSize: 50 }), page: 1 });
  const second = await listSupplierReviewReadModelPage(db, {
    query: query({ pageSize: 50 }), page: 2, cursor: first.nextCursor || undefined, queryRevision: first.queryRevision,
  });
  const last = await listSupplierReviewReadModelPage(db, {
    query: query({ pageSize: 50 }), page: 3, cursor: second.nextCursor || undefined, queryRevision: first.queryRevision,
  });
  const ids = [...first.items, ...second.items, ...last.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 121);
  assert.equal(last.items.length, 21);
  assert.equal(last.nextCursor, null);
});

test('PR-1 stable tuple supports Previous/Next and bounded numbered jumps', async () => {
  const db = makeFakeDb(records(260)) as never;
  const first = await listSupplierReviewReadModelPage(db, { query: query(), page: 1 });
  const third = await listSupplierReviewReadModelPage(db, {
    query: query(), page: 3, cursor: first.nextCursor || undefined, queryRevision: first.queryRevision,
  });
  assert.equal(third.page, 3);
  assert.ok(third.previousCursor);
  const second = await listSupplierReviewReadModelPage(db, {
    query: query(), page: 2, cursor: third.previousCursor || undefined, queryRevision: first.queryRevision,
  });
  assert.equal(second.page, 2);
  assert.equal(second.items[0]?.id, 'review-050');
  assert.equal(third.items[0]?.id, 'review-100');
});

test('PR-1 exact supplier identity search finds a later-page record without browser preloading', async () => {
  const db = makeFakeDb(records(121)) as never;
  const result = await listSupplierReviewReadModelPage(db, {
    query: query({ search: 'SKU-119' }), page: 1,
  });
  assert.equal(result.countStatus, 'exact');
  assert.equal(result.totalCount, 1);
  assert.deepEqual(result.items.map((item) => item.id), ['review-119']);
  assert.equal(result.searchCapabilities.exactSupplierIdentity, true);
  assert.equal(result.searchCapabilities.productNamePrefix, false);
});

test('PR-1 query fingerprints and cursors cannot cross query boundaries', async () => {
  const db = makeFakeDb(records(60)) as never;
  const first = await listSupplierReviewReadModelPage(db, { query: query(), page: 1 });
  assert.notEqual(
    buildSupplierReviewQueryFingerprint(query()),
    buildSupplierReviewQueryFingerprint(query({ sort: 'updated' })),
  );
  await assert.rejects(() => listSupplierReviewReadModelPage(db, {
    query: query({ sort: 'updated' }),
    page: 2,
    cursor: first.nextCursor || undefined,
    queryRevision: first.queryRevision,
  }), /does not match this query/u);
  assert.throws(() => decodeSupplierReviewCursorToken('not-a-cursor'), /cursor is invalid/u);
});

test('PR-1 client anchor cache is query-scoped and bounded', () => {
  const cache = new SupplierReviewAnchorCache();
  const key = buildSupplierReviewQueryKey({ view: 'review', filter: 'new_products', media: 'all', search: '', sort: 'created', pageSize: 50 });
  cache.set(key, 1, null);
  cache.set(key, 2, 'opaque-page-2');
  assert.deepEqual(cache.nearest(key, 2), { page: 2, cursor: 'opaque-page-2' });
  assert.equal(cache.nearest('different-query', 2), null);
  for (let page = 3; page <= 40; page += 1) cache.set(key, page, `cursor-${page}`);
  assert.equal(cache.nearest(key, 40)?.page, 40);
});

test('PR-1 preserves Admin authorization and does not introduce offset pagination', () => {
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const queue = readFileSync('functions/src/scheduled/supplierReviewQueue.ts', 'utf8');
  assert.match(routes, /app\.get\("\/api\/supplier-review-queue", requireSupplierHubAdmin/u);
  assert.doesNotMatch(queue, /\.offset\(/u);
  assert.match(routes, /listSupplierReviewReadModelPage/u);
  assert.match(queue, /\.count\(\)\.get\(\)/u);
});

test('PR-2 media evidence is projected and media filters preserve business pagination boundaries', async () => {
  const db = makeFakeDb([
    {
      id: 'media-ready',
      data: {
        status: 'Pending', queueState: 'review_pending', createdAt: '2026-01-01T00:00:03.000Z', updatedAt: '2026-01-01T00:00:03.000Z',
        comparison: { comparisonStatus: 'NEW_PRODUCT' },
        mediaStatus: 'ready', mediaReadiness: 'publication_safe', mediaSourceImageUrls: ['https://supplier.example/ready.jpg'],
        managedMedia: [{ firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/ready.jpg', originalSupplierUrl: 'https://supplier.example/ready.jpg', imageStatus: 'ready', isPrimary: true }], mediaFailures: [],
      },
    },
    {
      id: 'media-processing',
      data: {
        status: 'Pending', queueState: 'processing', createdAt: '2026-01-01T00:00:02.000Z', updatedAt: '2026-01-01T00:00:02.000Z',
        comparison: { comparisonStatus: 'NEW_PRODUCT' },
        mediaStatus: 'downloading', mediaSourceImageUrls: ['https://supplier.example/processing.jpg'], managedMedia: [], mediaFailures: [],
      },
    },
    {
      id: 'media-issue',
      data: {
        status: 'Pending', queueState: 'dead_letter', createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
        comparison: { comparisonStatus: 'NEW_PRODUCT' },
        mediaStatus: 'failed', mediaReadiness: 'blocked', mediaSourceImageUrls: ['https://supplier.example/issue.jpg'], managedMedia: [], mediaFailures: [{ retryable: false }],
      },
    },
  ]) as never;
  const all = await listSupplierReviewReadModelPage(db, { query: query({ pageSize: 25 }), page: 1 });
  const mediaStates = all.items.map((item) => (item.media as { state?: string } | undefined)?.state);
  assert.equal(mediaStates[0], 'READY');
  assert.equal(mediaStates[1], 'PROCESSING');
  assert.equal(mediaStates[2], 'NEEDS_ATTENTION');
  const processing = await listSupplierReviewReadModelPage(db, {
    query: query({ mediaFilter: 'processing', businessFilter: 'new_products', pageSize: 25 }),
    page: 1,
  });
  assert.deepEqual(processing.items.map((item) => item.id), ['media-processing']);
  assert.equal(processing.countStatus, 'unavailable');
  assert.equal(processing.queryFingerprint, buildSupplierReviewQueryFingerprint(query({ mediaFilter: 'processing', businessFilter: 'new_products', pageSize: 25 })));
});

test('indexed media projection provides bounded Ready pages and exact counts', async () => {
  const readyRecords: StoredRecord[] = Array.from({ length: 75 }, (_, index) => ({
    id: `ready-${String(index).padStart(3, '0')}`,
    data: {
      status: 'Pending',
      queueState: 'review_pending',
      mediaQueueClass: 'ready',
      mediaQueueClassVersion: 1,
      mediaStatus: 'ready',
      mediaReadiness: 'publication_safe',
      mediaSourceImageUrls: ['https://supplier.example/ready.jpg'],
      managedMedia: [{ firebaseStorageUrl: 'https://firebasestorage.googleapis.com/v0/b/demo/o/ready.jpg', originalSupplierUrl: 'https://supplier.example/ready.jpg', imageStatus: 'ready', isPrimary: true }],
      mediaFailures: [],
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 75 - index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 75 - index)).toISOString(),
    },
  }));
  const processingRecord: StoredRecord = {
    id: 'processing-001',
    data: {
      status: 'Pending', queueState: 'processing', mediaQueueClass: 'processing', mediaQueueClassVersion: 1,
      mediaStatus: 'downloading', mediaSourceImageUrls: ['https://supplier.example/processing.jpg'], managedMedia: [], mediaFailures: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const db = makeFakeDb([...readyRecords, processingRecord], { mediaProjectionActive: true }) as never;
  const first = await listSupplierReviewReadModelPage(db, { query: query({ mediaFilter: 'ready', pageSize: 50 }), page: 1 });
  assert.equal(first.countStatus, 'exact');
  assert.equal(first.totalCount, 75);
  assert.equal(first.totalPages, 2);
  assert.equal(first.items.length, 50);
  const second = await listSupplierReviewReadModelPage(db, {
    query: query({ mediaFilter: 'ready', pageSize: 50 }),
    page: 2,
    cursor: first.nextCursor || undefined,
    queryRevision: first.queryRevision,
  });
  assert.equal(second.items.length, 25);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 75);
  assert.equal(second.nextCursor, null);
});

test('indexed media projection stays behind the migration gate until active', async () => {
  const db = makeFakeDb(records(3)) as never;
  const result = await listSupplierReviewReadModelPage(db, {
    query: query({ mediaFilter: 'ready', pageSize: 25 }), page: 1,
  });
  assert.equal(result.countStatus, 'unavailable');
  assert.match(result.countReason || '', /media filter is derived/u);
});
