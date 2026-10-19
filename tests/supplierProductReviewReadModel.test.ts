import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSupplierReviewQueryFingerprint,
  decodeSupplierReviewCursorToken,
  listSupplierReviewReadModelPage,
  SUPPLIER_REVIEW_BUSINESS_QUEUE_CLASSES_VERSION,
  SupplierReviewQueryModel,
} from '../functions/src/scheduled/supplierReviewQueue';
import { SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION } from '../functions/src/api/suppliers/supplierReviewBusinessQueueProjection';
import { SupplierReviewAnchorCache, buildSupplierReviewQueryKey } from '../src/services/supplierReviewPagination';

type StoredDocument = Record<string, unknown>;
type StoredRecord = { id: string; data: StoredDocument };
type FakeSnapshot = { exists: boolean; id: string; data: () => StoredDocument | undefined };

const makeFakeDb = (records: StoredRecord[], options: { mediaProjectionActive?: boolean; businessProjectionActive?: boolean; businessProjectionVersion?: number } = {}) => {
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
          if (operator === 'array-contains') return Array.isArray(actual) && actual.includes(value);
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
          exists: (id === 'supplier_review_queue_media_projection' && options.mediaProjectionActive === true)
            || (id === 'supplier_review_queue_business_projection' && options.businessProjectionActive === true),
          id,
          data: () => ((id === 'supplier_review_queue_media_projection' && options.mediaProjectionActive === true)
            || (id === 'supplier_review_queue_business_projection' && options.businessProjectionActive === true))
            ? { status: 'active', version: id === 'supplier_review_queue_business_projection'
              ? (options.businessProjectionVersion ?? SUPPLIER_REVIEW_BUSINESS_PROJECTION_VERSION)
              : 1 }
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

test('PR-1 supplier scope pages beyond the exact-search limit with an exact count', async () => {
  const scopedRecords = records(150).map((record, index) => ({
    ...record,
    data: { ...record.data, sourceId: index < 121 ? 'dropex' : 'other-source' },
  }));
  const db = makeFakeDb(scopedRecords) as never;
  const first = await listSupplierReviewReadModelPage(db, {
    query: query({ supplierSourceId: 'dropex', pageSize: 50 }), page: 1,
  });
  const second = await listSupplierReviewReadModelPage(db, {
    query: query({ supplierSourceId: 'dropex', pageSize: 50 }),
    page: 2,
    cursor: first.nextCursor || undefined,
    queryRevision: first.queryRevision,
  });
  const third = await listSupplierReviewReadModelPage(db, {
    query: query({ supplierSourceId: 'dropex', pageSize: 50 }),
    page: 3,
    cursor: second.nextCursor || undefined,
    queryRevision: first.queryRevision,
  });
  assert.equal(first.countStatus, 'exact');
  assert.equal(first.totalCount, 121);
  assert.equal(first.totalPages, 3);
  assert.equal(first.items.length, 50);
  assert.equal(second.items.length, 50);
  assert.equal(third.items.length, 21);
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map((item) => item.id)).size, 121);
  assert.equal(first.items[0]?.id, 'review-000');
  assert.equal(third.items[0]?.id, 'review-100');
});

test('PR-1 supplier scope combines readiness and media predicates without client filtering', async () => {
  const scopedRecords = records(120).map((record, index) => ({
    ...record,
    data: {
      ...record.data,
      sourceId: index < 100 ? 'dropex' : 'other-source',
      businessQueueClasses: index < 60 ? ['category_decision_required'] : ['stock_price_issues'],
      mediaQueueClass: index < 40 ? 'ready' : 'issues',
    },
  }));
  const db = makeFakeDb(scopedRecords, { businessProjectionActive: true, mediaProjectionActive: true }) as never;
  const first = await listSupplierReviewReadModelPage(db, {
    query: query({
      supplierSourceId: 'dropex',
      businessFilter: 'category_decision_required',
      mediaFilter: 'ready',
      sort: 'updated',
      pageSize: 25,
    }),
    page: 1,
  });
  const second = await listSupplierReviewReadModelPage(db, {
    query: query({
      supplierSourceId: 'dropex',
      businessFilter: 'category_decision_required',
      mediaFilter: 'ready',
      sort: 'updated',
      pageSize: 25,
    }),
    page: 2,
    cursor: first.nextCursor || undefined,
    queryRevision: first.queryRevision,
  });
  assert.equal(first.countStatus, 'exact');
  assert.equal(first.totalCount, 40);
  assert.equal(first.items.length, 25);
  assert.equal(second.items.length, 15);
  assert.equal(second.nextCursor, null);
  assert.ok([...first.items, ...second.items].every((item) => item.sourceId === 'dropex'));
});

test('PR-1 All Suppliers mode remains an unscoped exact count and query fingerprint changes with scope', async () => {
  const scopedRecords = records(150).map((record, index) => ({
    ...record,
    data: { ...record.data, sourceId: index < 121 ? 'dropex' : 'other-source' },
  }));
  const db = makeFakeDb(scopedRecords) as never;
  const allSuppliers = await listSupplierReviewReadModelPage(db, {
    query: query({ pageSize: 50 }), page: 1,
  });
  const dropex = await listSupplierReviewReadModelPage(db, {
    query: query({ supplierSourceId: 'dropex', pageSize: 50 }), page: 1,
  });
  assert.equal(allSuppliers.countStatus, 'exact');
  assert.equal(allSuppliers.totalCount, 150);
  assert.equal(dropex.totalCount, 121);
  assert.notEqual(
    buildSupplierReviewQueryFingerprint(query()),
    buildSupplierReviewQueryFingerprint(query({ supplierSourceId: 'dropex' })),
  );
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
  assert.notEqual(key, buildSupplierReviewQueryKey({ view: 'review', filter: 'new_products', media: 'all', supplierScope: 'dropex', search: '', sort: 'created', pageSize: 50 }));
  for (let page = 3; page <= 40; page += 1) cache.set(key, page, `cursor-${page}`);
  assert.equal(cache.nearest(key, 40)?.page, 40);
});

test('PR-1 supplier scope uses dedicated indexed fields and leaves identity search separate', () => {
  const queue = readFileSync('functions/src/scheduled/supplierReviewQueue.ts', 'utf8');
  const indexes = JSON.parse(readFileSync('firestore.indexes.json', 'utf8')) as {
    indexes?: Array<{ collectionGroup?: string; fields?: Array<{ fieldPath?: string }> }>;
  };
  assert.match(queue, /where\("sourceId", "==", query\.supplierSourceId\)/u);
  assert.match(queue, /Boolean\(query\.supplierSourceId \|\| query\.businessFilter/u);
  assert.doesNotMatch(queue.slice(queue.indexOf('const SUPPLIER_REVIEW_EXACT_SEARCH_FIELDS'), queue.indexOf('] as const;', queue.indexOf('const SUPPLIER_REVIEW_EXACT_SEARCH_FIELDS'))), /sourceId|supplierId/u);
  assert.equal(indexes.indexes?.filter((index) => index.collectionGroup === 'supplier_review_queue'
    && index.fields?.some((field) => field.fieldPath === 'sourceId')).length, 8);
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

test('indexed business projection provides direct Actionable pages and exact counts', async () => {
  const actionableRecords: StoredRecord[] = Array.from({ length: 75 }, (_, index) => ({
    id: `actionable-${String(index).padStart(3, '0')}`,
    data: {
      status: 'Pending',
      queueState: 'review_pending',
      businessQueueClasses: ['actionable'],
      businessQueueClassesVersion: SUPPLIER_REVIEW_BUSINESS_QUEUE_CLASSES_VERSION,
      comparison: { comparisonStatus: 'NEW_PRODUCT' },
      productValidation: { readyToPublish: true, missingFields: [], errors: [] },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 75 - index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 75 - index)).toISOString(),
    },
  }));
  const db = makeFakeDb(actionableRecords, { businessProjectionActive: true }) as never;
  const first = await listSupplierReviewReadModelPage(db, {
    query: query({ businessFilter: 'actionable', pageSize: 50 }), page: 1,
  });
  assert.equal(first.countStatus, 'exact');
  assert.equal(first.totalCount, 75);
  assert.equal(first.totalPages, 2);
  assert.equal(first.items.length, 50);
  const second = await listSupplierReviewReadModelPage(db, {
    query: query({ businessFilter: 'actionable', pageSize: 50 }),
    page: 2,
    cursor: first.nextCursor || undefined,
    queryRevision: first.queryRevision,
  });
  assert.equal(second.items.length, 25);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 75);
});

test('active v3 business metadata keeps the legacy-compatible Product Review path before migration', async () => {
  const db = makeFakeDb(records(3), {
    businessProjectionActive: true,
    businessProjectionVersion: 3,
  }) as never;
  const result = await listSupplierReviewReadModelPage(db, {
    query: query({ businessFilter: 'actionable', pageSize: 25 }), page: 1,
  });
  assert.equal(result.countStatus, 'unavailable');
  assert.equal(result.items.length, 3);
});
