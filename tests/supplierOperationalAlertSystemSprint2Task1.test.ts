import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { SupplierOutboundResponse } from '../functions/src/api/security/supplierOutboundRequest';
import {
  recordSupplierOperationalAlert,
  resolveSupplierMediaOperationalAlertsSafely,
  sanitizeSupplierAlertTechnicalMetadata,
  supplierOperationalAlertId,
  transitionSupplierOperationalAlert,
} from '../functions/src/api/suppliers/supplierOperationalAlerts';
import { evaluateSupplierOperationalAlerts } from '../functions/src/scheduled/supplierOperationalAlerts';
import type { SupplierMediaPipelineDependencies } from '../functions/src/api/suppliers/supplierMediaPipeline';
import {
  classifySupplierMediaReadiness,
  SUPPLIER_MEDIA_FAILURE_CODE,
} from '../functions/src/api/suppliers/supplierMediaReadiness';
import {
  buildSupplierQueueLifecycle,
  ensureSupplierReviewQueueManagedMedia,
  processSupplierReviewQueueItem,
  resolveSupplierReviewQueueUpsertLifecycle,
} from '../functions/src/scheduled/supplierReviewQueue';

type StoredDocument = Record<string, unknown>;
type FakeSnapshot = { exists: boolean; id: string; data: () => StoredDocument | undefined };
type DocumentReference = {
  collectionName: string;
  id: string;
  key: string;
  get: () => Promise<FakeSnapshot>;
  set: (data: StoredDocument, options?: { merge?: boolean }) => Promise<void>;
};

const createFakeFirestore = (initial: Record<string, StoredDocument> = {}) => {
  const documents = new Map<string, StoredDocument>(Object.entries(initial));
  let generatedId = 0;
  const snapshot = (documentReference: DocumentReference) => ({
    exists: documents.has(documentReference.key),
    id: documentReference.id,
    data: () => documents.get(documentReference.key),
  });
  const reference = (collectionName: string, id: string | undefined): DocumentReference => {
    const documentId = id || `generated-${++generatedId}`;
    const documentReference = {
      collectionName,
      id: documentId,
      key: `${collectionName}/${documentId}`,
      get: async () => snapshot(documentReference),
      set: async (data: StoredDocument, options?: { merge?: boolean }) => {
        documents.set(documentReference.key, options?.merge
          ? { ...(documents.get(documentReference.key) || {}), ...data }
          : data);
      },
    };
    return documentReference;
  };
  const db = {
    collection: (collectionName: string) => ({
      doc: (id?: string) => reference(collectionName, id),
    }),
    runTransaction: async <T>(operation: (transaction: {
      get: (documentReference: DocumentReference) => Promise<FakeSnapshot>;
      set: (documentReference: DocumentReference, data: StoredDocument, options?: { merge?: boolean }) => void;
      create: (documentReference: DocumentReference, data: StoredDocument) => void;
    }) => Promise<T>) => operation({
      get: async (documentReference) => snapshot(documentReference),
      set: (documentReference, data, options) => {
        documents.set(documentReference.key, options?.merge
          ? { ...(documents.get(documentReference.key) || {}), ...data }
          : data);
      },
      create: (documentReference, data) => {
        if (documents.has(documentReference.key)) throw new Error(`Document ${documentReference.key} already exists.`);
        documents.set(documentReference.key, data);
      },
    }),
  };
  return { db, documents };
};

const createAlertMonitorFirestore = (queueItems: Record<string, StoredDocument>) => {
  type Filter = { field: string; operator: string; value: unknown };
  const queryFor = (collectionName: string, filters: Filter[] = [], take?: number): Record<string, unknown> => ({
    where: (field: string, operator: string, value: unknown) => queryFor(collectionName, [...filters, { field, operator, value }], take),
    orderBy: () => queryFor(collectionName, filters, take),
    limit: (value: number) => queryFor(collectionName, filters, value),
    get: async () => {
      const entries = collectionName === 'supplier_review_queue' ? Object.entries(queueItems) : [];
      const filtered = entries.filter(([, record]) => filters.every(({ field, operator, value }) => {
        if (operator === '==') return record[field] === value;
        if (operator === 'in') return Array.isArray(value) && value.includes(record[field]);
        return false;
      })).slice(0, take);
      return {
        docs: filtered.map(([id, record]) => ({ id, data: () => record })),
        size: filtered.length,
      };
    },
  });
  return {
    collection: (collectionName: string) => ({
      doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
      where: (field: string, operator: string, value: unknown) => queryFor(collectionName, [{ field, operator, value }]),
    }),
  };
};

const collectionDocuments = (documents: Map<string, StoredDocument>, collectionName: string) => [...documents.entries()]
  .filter(([key]) => key.startsWith(`${collectionName}/`))
  .map(([, value]) => value);

const mediaResponse = (body: Buffer, contentType: string, status = 200, declaredLength = body.length): SupplierOutboundResponse => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers({ 'content-type': contentType, 'content-length': String(declaredLength) }),
  text: async () => body.toString('utf8'),
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  json: async <T>() => JSON.parse(body.toString('utf8')) as T,
});

const mediaDependencies = (
  imageBody: Buffer,
  failingUrl?: string,
  fetchedUrls?: string[],
  oversizedUrl?: string,
): SupplierMediaPipelineDependencies => ({
  fetchImage: async (url) => {
    fetchedUrls?.push(url);
    return url === oversizedUrl
      ? mediaResponse(imageBody, 'image/png', 200, 10 * 1024 * 1024 + 1)
      : url === failingUrl
      ? mediaResponse(Buffer.from('upstream failure'), 'text/plain', 500)
      : mediaResponse(imageBody, 'image/png');
  },
  findAsset: async () => null,
  saveFile: async (storagePath) => `https://storage.example/${encodeURIComponent(storagePath)}`,
  saveAsset: async () => undefined,
  recordAudit: async () => undefined,
});

const pngBody = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgEpHjEpFjgFAABk4A8YCCZIUAAAAASUVORK5CYII=',
  'base64',
);

test('successful supplier media processing resolves matching media and storage alerts without publication', async () => {
  const queueItemId = 'dropex-media-ready';
  const imageUrl = 'https://supplier.example/media-ready.png';
  const { db, documents } = createFakeFirestore({
    [`supplier_review_queue/${queueItemId}`]: {
      queueState: 'review_pending',
      status: 'Pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [imageUrl] },
      productPayload: { id: 'review-product', imageUrls: [imageUrl] },
      managedMedia: [],
      mediaStatus: 'partial',
      mediaFailures: [{ reason: 'previous failure', retryable: true }],
    },
  });
  const mediaAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'media_processing_failure',
    supplierId: 'dropex',
    queueItemId,
  });
  const storageAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'storage_failure',
    supplierId: 'dropex',
    queueItemId,
  });
  const unrelatedAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'media_processing_failure',
    supplierId: 'dropex',
    queueItemId: 'dropex-unrelated',
  });
  const unrelatedSupplierAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'media_processing_failure',
    supplierId: 'a2z',
    queueItemId,
  });
  const deadLetterAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'dead_letter_created',
    supplierId: 'dropex',
    queueItemId,
  });
  const syncAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'supplier_sync_failure',
    supplierId: 'dropex',
    queueItemId,
  });
  const connectionAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'supplier_connection_failure',
    supplierId: 'dropex',
    queueItemId,
  });

  await ensureSupplierReviewQueueManagedMedia(db as never, queueItemId, {
    reprocessIncomplete: true,
    dependencies: mediaDependencies(pngBody),
  });

  const queue = documents.get(`supplier_review_queue/${queueItemId}`)!;
  assert.equal(queue.mediaStatus, 'ready');
  assert.deepEqual(queue.mediaFailures, []);
  assert.equal(documents.has('products/review-product'), false);
  assert.equal(documents.has('product_private/review-product'), false);
  assert.equal(documents.get(`supplier_operational_alerts/${mediaAlert.alertId}`)?.status, 'resolved');
  assert.equal(documents.get(`supplier_operational_alerts/${storageAlert.alertId}`)?.status, 'resolved');
  assert.equal(documents.get(`supplier_operational_alerts/${unrelatedAlert.alertId}`)?.status, 'open');
  for (const alert of [unrelatedSupplierAlert, deadLetterAlert, syncAlert, connectionAlert]) {
    assert.equal(documents.get(`supplier_operational_alerts/${alert.alertId}`)?.status, 'open');
  }
  const lifecycleEvents = collectionDocuments(documents, 'supplier_operational_alert_events')
    .filter((event) => [mediaAlert.alertId, storageAlert.alertId].includes(String(event.alertId)));
  assert.deepEqual(lifecycleEvents.map((event) => event.event).sort(), ['opened', 'resolved', 'opened', 'resolved'].sort());
});

test('queue worker resolves warning-safe Dropex media alerts after review completion', async () => {
  const queueItemId = 'dropex-worker-warning-safe';
  const primaryUrl = 'https://supplier.example/worker-primary.png';
  const oversizedUrl = 'https://supplier.example/worker-oversized.png';
  const { db, documents } = createFakeFirestore({
    [`supplier_review_queue/${queueItemId}`]: {
      ...buildSupplierQueueLifecycle(new Date(Date.now() - 1_000).toISOString()),
      status: 'Pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [primaryUrl, oversizedUrl] },
      productPayload: { id: 'worker-warning-safe-product', imageUrls: [primaryUrl, oversizedUrl] },
      managedMedia: [],
      mediaStatus: 'partial',
      mediaFailures: [{ code: SUPPLIER_MEDIA_FAILURE_CODE.IMAGE_TOO_LARGE, retryable: false }],
    },
  });
  const mediaAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'media_processing_failure',
    supplierId: 'dropex',
    queueItemId,
  });
  const storageAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'storage_failure',
    supplierId: 'dropex',
    queueItemId,
  });

  const result = await processSupplierReviewQueueItem(
    db as never,
    queueItemId,
    'warning-safe-worker',
    Date.now(),
    { mediaDependencies: mediaDependencies(pngBody, undefined, undefined, oversizedUrl) },
  );

  const queue = documents.get(`supplier_review_queue/${queueItemId}`)!;
  assert.deepEqual(result, { queueItemId, outcome: 'completed', state: 'review_pending' });
  assert.equal(queue.queueState, 'review_pending');
  assert.equal(queue.mediaReadiness, 'publication_safe_with_media_warnings');
  assert.equal((queue.mediaFailures as Array<Record<string, unknown>>).length, 1);
  assert.equal(documents.get(`supplier_operational_alerts/${mediaAlert.alertId}`)?.status, 'resolved');
  assert.equal(documents.get(`supplier_operational_alerts/${storageAlert.alertId}`)?.status, 'resolved');
  assert.equal(documents.has('products/worker-warning-safe-product'), false);
  assert.equal(documents.has('product_private/worker-warning-safe-product'), false);
});

test('same-source partial media is reprocessed while healthy same-source media is reused', async () => {
  const imageUrl = 'https://supplier.example/same-source.png';
  const managedAsset = {
    assetId: 'existing-asset',
    contentHash: 'existing-hash',
    firebaseStorageUrl: 'https://storage.example/existing.png',
    originalSupplierUrl: imageUrl,
    imageStatus: 'ready',
    isPrimary: true,
    sortOrder: 0,
    variants: { large: { storagePath: 'supplier-review/existing/large.png' } },
  };
  const partialFetched: string[] = [];
  const partial = createFakeFirestore({
    'supplier_review_queue/dropex-same-source-partial': {
      queueState: 'review_pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [imageUrl] },
      productPayload: { id: 'same-source-partial', imageUrls: [imageUrl] },
      managedMedia: [managedAsset],
      mediaStatus: 'partial',
      mediaFailures: [{ reason: 'stale failure', retryable: true }],
    },
  });
  const partialResult = await ensureSupplierReviewQueueManagedMedia(partial.db as never, 'dropex-same-source-partial', {
    imageUrls: [imageUrl],
    reprocessIncomplete: true,
    dependencies: mediaDependencies(pngBody, undefined, partialFetched),
  });
  assert.equal(partialResult.reusedExistingQueueMedia, false);
  assert.deepEqual(partialFetched, [imageUrl]);
  assert.equal(partial.documents.get('supplier_review_queue/dropex-same-source-partial')?.mediaStatus, 'ready');
  assert.deepEqual(partial.documents.get('supplier_review_queue/dropex-same-source-partial')?.mediaFailures, []);

  const healthyFetched: string[] = [];
  const healthy = createFakeFirestore({
    'supplier_review_queue/dropex-same-source-healthy': {
      queueState: 'review_pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [imageUrl] },
      productPayload: { id: 'same-source-healthy', imageUrls: [imageUrl] },
      managedMedia: [managedAsset],
      mediaStatus: 'ready',
      mediaFailures: [],
    },
  });
  const healthyResult = await ensureSupplierReviewQueueManagedMedia(healthy.db as never, 'dropex-same-source-healthy', {
    imageUrls: [imageUrl],
    dependencies: mediaDependencies(pngBody, undefined, healthyFetched),
  });
  assert.equal(healthyResult.reusedExistingQueueMedia, true);
  assert.deepEqual(healthyFetched, []);

  const failedHealthy = createFakeFirestore({
    'supplier_review_queue/dropex-same-source-with-failure': {
      queueState: 'review_pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [imageUrl] },
      productPayload: { id: 'same-source-with-failure', imageUrls: [imageUrl] },
      managedMedia: [managedAsset],
      mediaStatus: 'ready',
      mediaFailures: [{ reason: 'stale failure', retryable: false }],
    },
  });
  const failedHealthyFetched: string[] = [];
  const failedHealthyResult = await ensureSupplierReviewQueueManagedMedia(
    failedHealthy.db as never,
    'dropex-same-source-with-failure',
    { imageUrls: [imageUrl], reprocessIncomplete: true, dependencies: mediaDependencies(pngBody, undefined, failedHealthyFetched) },
  );
  assert.equal(failedHealthyResult.reusedExistingQueueMedia, false);
  assert.deepEqual(failedHealthyFetched, [imageUrl]);
});

test('media readiness allows only structured optional gallery warnings', () => {
  const sourceImageUrls = [
    'https://supplier.example/primary.png',
    'https://supplier.example/optional-large.png',
  ];
  const primary = {
    firebaseStorageUrl: 'https://storage.example/primary.png',
    originalSupplierUrl: sourceImageUrls[0],
    imageStatus: 'ready',
    isPrimary: true,
  };
  const optionalOversized = {
    code: SUPPLIER_MEDIA_FAILURE_CODE.IMAGE_TOO_LARGE,
    originalSupplierUrl: sourceImageUrls[1],
    retryable: false,
    sourceIndex: 2,
    isPrimary: false,
  };
  assert.equal(classifySupplierMediaReadiness({
    supplierId: 'dropex',
    sourceImageUrls,
    managedMedia: [primary],
    mediaFailures: [optionalOversized],
  }).status, 'publication_safe_with_media_warnings');
  assert.equal(classifySupplierMediaReadiness({
    sourceImageUrls,
    managedMedia: [primary],
    mediaFailures: [{ ...optionalOversized, isPrimary: true, sourceIndex: 1 }],
  }).publicationSafe, false);
  assert.equal(classifySupplierMediaReadiness({
    sourceImageUrls,
    managedMedia: [primary],
    mediaFailures: [{ ...optionalOversized, retryable: true }],
  }).publicationSafe, false);
  assert.equal(classifySupplierMediaReadiness({
    sourceImageUrls,
    managedMedia: [primary],
    mediaFailures: [{ originalSupplierUrl: sourceImageUrls[1], reason: 'legacy failure' }],
  }).publicationSafe, false);
  assert.equal(classifySupplierMediaReadiness({
    sourceImageUrls,
    managedMedia: [],
    mediaFailures: [],
  }).publicationSafe, false);
});

test('optional media warnings are Dropex-only and source metadata fails closed', () => {
  const sourceImageUrls = [
    'https://supplier.example/primary.png',
    'https://supplier.example/optional-large.png',
  ];
  const primary = {
    firebaseStorageUrl: 'https://storage.example/primary.png',
    originalSupplierUrl: sourceImageUrls[0],
    imageStatus: 'ready',
    isPrimary: true,
  };
  const warning = {
    code: SUPPLIER_MEDIA_FAILURE_CODE.IMAGE_TOO_LARGE,
    originalSupplierUrl: sourceImageUrls[1],
    retryable: false,
    sourceIndex: 2,
    isPrimary: false,
  };
  assert.equal(classifySupplierMediaReadiness({
    supplierId: 'dropex',
    sourceImageUrls,
    managedMedia: [primary],
    mediaFailures: [warning],
  }).publicationSafe, true);
  assert.equal(classifySupplierMediaReadiness({
    supplierId: 'a2z',
    sourceImageUrls,
    managedMedia: [primary],
    mediaFailures: [warning],
  }).publicationSafe, false);
  assert.equal(classifySupplierMediaReadiness({
    supplierId: 'dropex',
    sourceImageUrls: [sourceImageUrls[1], sourceImageUrls[0]],
    managedMedia: [{ ...primary, originalSupplierUrl: sourceImageUrls[1] }],
    mediaFailures: [warning],
  }).publicationSafe, false);
  assert.equal(classifySupplierMediaReadiness({
    supplierId: 'dropex',
    sourceImageUrls: [sourceImageUrls[0]],
    managedMedia: [primary],
    mediaFailures: [warning],
  }).publicationSafe, false);
  assert.equal(classifySupplierMediaReadiness({
    supplierId: 'dropex',
    sourceImageUrls,
    managedMedia: [{
      ...primary,
      originalSupplierUrl: sourceImageUrls[1],
    }],
    mediaFailures: [{
      code: SUPPLIER_MEDIA_FAILURE_CODE.IMAGE_TOO_LARGE,
      originalSupplierUrl: sourceImageUrls[0],
      retryable: false,
      sourceIndex: 1,
      isPrimary: true,
    }],
  }).publicationSafe, false);
  assert.equal(classifySupplierMediaReadiness({
    supplierId: 'dropex',
    sourceImageUrls,
    managedMedia: [{
      ...primary,
      originalSupplierUrl: sourceImageUrls[1],
    }],
    mediaFailures: [],
  }).publicationSafe, false);
});

test('scheduled alert evaluation skips warning-safe Dropex media and surfaces later blocking media', async () => {
  const sourceImageUrls = [
    'https://supplier.example/primary.png',
    'https://supplier.example/optional-large.png',
  ];
  const managedMedia = [{
    firebaseStorageUrl: 'https://storage.example/primary.png',
    originalSupplierUrl: sourceImageUrls[0],
    imageStatus: 'ready',
    isPrimary: true,
  }];
  const reports: Array<Record<string, unknown>> = [];
  const warningQueue = {
    queueState: 'review_pending',
    supplierId: 'dropex',
    sourceId: 'dropex',
    mediaStatus: 'partial',
    mediaSourceImageUrls: sourceImageUrls,
    managedMedia,
    mediaFailures: [{
      code: SUPPLIER_MEDIA_FAILURE_CODE.IMAGE_TOO_LARGE,
      originalSupplierUrl: sourceImageUrls[1],
      retryable: false,
      sourceIndex: 2,
      isPrimary: false,
    }],
  };
  await evaluateSupplierOperationalAlerts(
    createAlertMonitorFirestore({ warning: warningQueue }) as never,
    Date.UTC(2026, 8, 20),
    async (input) => { reports.push(input as unknown as Record<string, unknown>); },
  );
  assert.equal(reports.some((report) => report.category === 'media_processing_failure'), false);
  assert.equal(reports.some((report) => report.category === 'storage_failure'), false);

  reports.length = 0;
  await evaluateSupplierOperationalAlerts(
    createAlertMonitorFirestore({ blocking: {
      ...warningQueue,
      mediaFailures: [{ reason: 'socket hang up', retryable: true }],
    } }) as never,
    Date.UTC(2026, 8, 20),
    async (input) => { reports.push(input as unknown as Record<string, unknown>); },
  );
  assert.equal(reports.filter((report) => report.category === 'media_processing_failure').length, 1);
});

test('primary failure remains blocking even when a surviving gallery asset is ordered first', async () => {
  const primaryUrl = 'https://supplier.example/primary-failed.png';
  const galleryUrl = 'https://supplier.example/gallery-survived.png';
  const { db, documents } = createFakeFirestore({
    'supplier_review_queue/dropex-primary-failed': {
      queueState: 'review_pending',
      sourceId: 'dropex',
      supplierId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [primaryUrl, galleryUrl] },
      productPayload: { id: 'primary-failed-product', imageUrls: [primaryUrl, galleryUrl] },
      managedMedia: [],
      mediaStatus: 'partial',
      mediaFailures: [],
    },
  });
  await ensureSupplierReviewQueueManagedMedia(db as never, 'dropex-primary-failed', {
    reprocessIncomplete: true,
    dependencies: mediaDependencies(pngBody, primaryUrl),
  });
  const queue = documents.get('supplier_review_queue/dropex-primary-failed')!;
  assert.equal(queue.mediaReadiness, 'blocked');
  assert.equal((queue.productValidation as StoredDocument).readyToPublish, false);
  assert.equal(classifySupplierMediaReadiness({
    supplierId: 'dropex',
    sourceImageUrls: [primaryUrl, galleryUrl],
    managedMedia: queue.managedMedia,
    mediaFailures: queue.mediaFailures,
  }).publicationSafe, false);
  assert.equal((queue.managedMedia as Array<StoredDocument>)[0].originalSupplierUrl, galleryUrl);
});

test('optional oversized gallery media is excluded from the review payload while the item stays reviewable', async () => {
  const queueItemId = 'dropex-media-optional-warning';
  const primaryUrl = 'https://supplier.example/optional-primary.png';
  const oversizedUrl = 'https://supplier.example/optional-oversized.png';
  const galleryUrl = 'https://supplier.example/optional-gallery.png';
  const { db, documents } = createFakeFirestore({
    [`supplier_review_queue/${queueItemId}`]: {
      queueState: 'review_pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [primaryUrl, oversizedUrl, galleryUrl] },
      productPayload: { id: 'optional-warning-product', imageUrls: [primaryUrl, oversizedUrl, galleryUrl] },
      managedMedia: [],
      mediaStatus: 'partial',
      mediaFailures: [{ reason: 'legacy failure', retryable: false }],
    },
  });

  await ensureSupplierReviewQueueManagedMedia(db as never, queueItemId, {
    reprocessIncomplete: true,
    dependencies: mediaDependencies(pngBody, undefined, undefined, oversizedUrl),
  });

  const queue = documents.get(`supplier_review_queue/${queueItemId}`)!;
  assert.equal(queue.mediaStatus, 'ready');
  assert.equal(queue.mediaReadiness, 'publication_safe_with_media_warnings');
  assert.equal((queue.mediaFailures as Array<Record<string, unknown>>).length, 1);
  assert.equal((queue.mediaFailures as Array<Record<string, unknown>>)[0].code, SUPPLIER_MEDIA_FAILURE_CODE.IMAGE_TOO_LARGE);
  assert.equal((queue.managedMedia as Array<Record<string, unknown>>).length, 2);
  assert.equal((queue.productPayload as Record<string, unknown>).imageUrls instanceof Array, true);
  assert.equal(((queue.productPayload as Record<string, unknown>).imageUrls as string[]).includes(oversizedUrl), false);
  assert.equal((queue.productValidation as Record<string, unknown>).readyToPublish, true);
  assert.equal(documents.has('products/optional-warning-product'), false);
  assert.equal(documents.has('product_private/optional-warning-product'), false);
});

test('same-source partial lifecycle is requeued while healthy lifecycle is preserved', () => {
  const imageUrl = 'https://supplier.example/lifecycle.png';
  const asset = {
    assetId: 'asset',
    contentHash: 'hash',
    firebaseStorageUrl: 'https://storage.example/lifecycle.png',
    originalSupplierUrl: imageUrl,
    imageStatus: 'ready',
    isPrimary: true,
    sortOrder: 0,
    variants: { large: {} },
  };
  const partial = resolveSupplierReviewQueueUpsertLifecycle({
    existing: {
      queueState: 'review_pending',
      managedMedia: [asset],
      mediaStatus: 'partial',
      mediaFailures: [{ reason: 'old failure' }],
    },
    sourceUrls: [imageUrl],
    queueCreatedAt: '2026-09-19T00:00:00.000Z',
  });
  assert.equal(partial.requeueForMedia, true);
  assert.equal(partial.preserveReviewPending, false);

  const healthy = resolveSupplierReviewQueueUpsertLifecycle({
    existing: {
      queueState: 'review_pending',
      managedMedia: [asset],
      mediaStatus: 'ready',
      mediaFailures: [],
    },
    sourceUrls: [imageUrl],
    queueCreatedAt: '2026-09-19T00:00:00.000Z',
  });
  assert.equal(healthy.requeueForMedia, false);
  assert.equal(healthy.preserveReviewPending, true);
});

test('media alert resolution is idempotent and a resolver failure does not fail media processing', async () => {
  const queueItemId = 'dropex-media-idempotent';
  const imageUrl = 'https://supplier.example/idempotent.png';
  const { db, documents } = createFakeFirestore({
    [`supplier_review_queue/${queueItemId}`]: {
      queueState: 'review_pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [imageUrl] },
      productPayload: { id: 'idempotent-product', imageUrls: [imageUrl] },
      managedMedia: [],
      mediaStatus: 'partial',
      mediaFailures: [{ reason: 'previous failure', retryable: true }],
    },
  });
  const mediaAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'media_processing_failure',
    supplierId: 'dropex',
    queueItemId,
  });
  const storageAlert = await recordSupplierOperationalAlert(db as never, {
    category: 'storage_failure',
    supplierId: 'dropex',
    queueItemId,
  });
  await ensureSupplierReviewQueueManagedMedia(db as never, queueItemId, {
    reprocessIncomplete: true,
    dependencies: mediaDependencies(pngBody),
  });
  await ensureSupplierReviewQueueManagedMedia(db as never, queueItemId, {
    imageUrls: [imageUrl],
    dependencies: mediaDependencies(pngBody),
  });
  assert.equal(documents.get(`supplier_operational_alerts/${mediaAlert.alertId}`)?.status, 'resolved');
  assert.equal(documents.get(`supplier_operational_alerts/${storageAlert.alertId}`)?.status, 'resolved');
  const resolvedEvents = collectionDocuments(documents, 'supplier_operational_alert_events')
    .filter((event) => [mediaAlert.alertId, storageAlert.alertId].includes(String(event.alertId)) && event.event === 'resolved');
  assert.equal(resolvedEvents.length, 2);

  const failureState = createFakeFirestore({
    'supplier_review_queue/dropex-media-resolution-failure': {
      queueState: 'review_pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [imageUrl] },
      productPayload: { id: 'resolution-failure-product', imageUrls: [imageUrl] },
      managedMedia: [],
      mediaStatus: 'partial',
      mediaFailures: [{ reason: 'previous failure', retryable: true }],
    },
  });
  const failingDb = {
    collection: failureState.db.collection,
    runTransaction: async () => { throw new Error('forced alert resolution failure'); },
  };
  await assert.doesNotReject(() => ensureSupplierReviewQueueManagedMedia(
    failingDb as never,
    'dropex-media-resolution-failure',
    { reprocessIncomplete: true, dependencies: mediaDependencies(pngBody) },
  ));
  assert.equal(failureState.documents.get('supplier_review_queue/dropex-media-resolution-failure')?.mediaStatus, 'ready');
  assert.deepEqual(failureState.documents.get('supplier_review_queue/dropex-media-resolution-failure')?.mediaFailures, []);
});

test('stale media success cannot resolve an alert after a newer failure state', async () => {
  const queueItemId = 'dropex-media-stale-success';
  const imageUrl = 'https://supplier.example/stale-success.png';
  const { db, documents } = createFakeFirestore({
    [`supplier_review_queue/${queueItemId}`]: {
      queueState: 'review_pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [imageUrl] },
      productPayload: { id: 'stale-success-product', imageUrls: [imageUrl] },
      managedMedia: [{
        assetId: 'newer-asset',
        contentHash: 'newer-hash',
        firebaseStorageUrl: 'https://storage.example/newer.png',
        originalSupplierUrl: imageUrl,
        variants: { large: {} },
      }],
      mediaStatus: 'partial',
      mediaFailures: [{ reason: 'newer failure', retryable: true }],
      mediaProcessedAt: 'newer-completion',
    },
  });
  const alert = await recordSupplierOperationalAlert(db as never, {
    category: 'media_processing_failure',
    supplierId: 'dropex',
    queueItemId,
  });
  await resolveSupplierMediaOperationalAlertsSafely(db as never, {
    supplierId: 'dropex',
    queueItemId,
    mediaProcessedAt: 'stale-completion',
  });
  assert.equal(documents.get(`supplier_operational_alerts/${alert.alertId}`)?.status, 'open');
  assert.equal(collectionDocuments(documents, 'supplier_operational_alert_events')
    .filter((event) => event.alertId === alert.alertId && event.event === 'resolved').length, 0);
});

test('media alert resolution fences supplier, queue identity, review state, timestamp, and newer blocking media', async () => {
  const queueItemId = 'dropex-media-resolution-fence';
  const imageUrl = 'https://supplier.example/resolution-fence.png';
  const baseQueue = {
    queueItemId,
    queueState: 'review_pending',
    status: 'Pending',
    supplierId: 'dropex',
    sourceId: 'dropex',
    supplierSnapshot: { supplierId: 'dropex', imageUrls: [imageUrl] },
    productPayload: { id: 'resolution-fence-product', imageUrls: [imageUrl] },
    mediaSourceImageUrls: [imageUrl],
    managedMedia: [{
      firebaseStorageUrl: 'https://storage.example/resolution-fence.png',
      originalSupplierUrl: imageUrl,
      imageStatus: 'ready',
      isPrimary: true,
    }],
    mediaFailures: [],
    mediaStatus: 'ready',
    mediaProcessedAt: 'successful-completion',
  };
  const cases: Array<{ name: string; queue: StoredDocument; supplierId?: string; mediaProcessedAt?: string }> = [
    { name: 'supplier mismatch', queue: { ...baseQueue }, supplierId: 'a2z' },
    { name: 'queue identity mismatch', queue: { ...baseQueue, queueItemId: 'another-queue' } },
    { name: 'review state mismatch', queue: { ...baseQueue, queueState: 'processing' } },
    { name: 'stale completion', queue: { ...baseQueue }, mediaProcessedAt: 'stale-completion' },
    {
      name: 'newer blocking state',
      queue: {
        ...baseQueue,
        mediaStatus: 'partial',
        mediaFailures: [{ reason: 'newer socket failure', retryable: true }],
        mediaProcessedAt: 'newer-failure',
      },
    },
  ];
  for (const entry of cases) {
    const { db, documents } = createFakeFirestore({
      [`supplier_review_queue/${queueItemId}`]: entry.queue,
    });
    const alert = await recordSupplierOperationalAlert(db as never, {
      category: 'media_processing_failure',
      supplierId: entry.supplierId || 'dropex',
      queueItemId,
    });
    await resolveSupplierMediaOperationalAlertsSafely(db as never, {
      supplierId: 'dropex',
      queueItemId,
      mediaProcessedAt: entry.mediaProcessedAt || 'successful-completion',
    });
    assert.equal(documents.get(`supplier_operational_alerts/${alert.alertId}`)?.status, 'open', entry.name);
  }
});

test('still-partial supplier media remains open and does not publish or resolve alerts', async () => {
  const queueItemId = 'dropex-media-partial';
  const goodUrl = 'https://supplier.example/media-good.png';
  const badUrl = 'https://supplier.example/media-bad.png';
  const { db, documents } = createFakeFirestore({
    [`supplier_review_queue/${queueItemId}`]: {
      queueState: 'review_pending',
      status: 'Pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [goodUrl, badUrl] },
      productPayload: { id: 'partial-product', imageUrls: [goodUrl, badUrl] },
      managedMedia: [],
      mediaStatus: 'partial',
      mediaFailures: [{ reason: 'previous failure', retryable: true }],
    },
  });
  const alert = await recordSupplierOperationalAlert(db as never, {
    category: 'media_processing_failure',
    supplierId: 'dropex',
    queueItemId,
  });

  await ensureSupplierReviewQueueManagedMedia(db as never, queueItemId, {
    reprocessIncomplete: true,
    dependencies: mediaDependencies(pngBody, badUrl),
  });

  const queue = documents.get(`supplier_review_queue/${queueItemId}`)!;
  assert.equal(queue.mediaStatus, 'partial');
  assert.equal(Array.isArray(queue.mediaFailures), true);
  assert.equal((queue.mediaFailures as unknown[]).length, 1);
  assert.equal(documents.get(`supplier_operational_alerts/${alert.alertId}`)?.status, 'open');
  assert.equal(documents.has('products/partial-product'), false);
  assert.equal(documents.has('product_private/partial-product'), false);
  const resolvedEvents = collectionDocuments(documents, 'supplier_operational_alert_events')
    .filter((event) => event.alertId === alert.alertId && event.event === 'resolved');
  assert.equal(resolvedEvents.length, 0);
});

test('empty supplier media does not falsely resolve a media alert', async () => {
  const queueItemId = 'dropex-media-empty';
  const { db, documents } = createFakeFirestore({
    [`supplier_review_queue/${queueItemId}`]: {
      queueState: 'review_pending',
      status: 'Pending',
      sourceId: 'dropex',
      supplierSnapshot: { supplierId: 'dropex', imageUrls: [] },
      productPayload: { id: 'empty-media-product', imageUrls: [] },
      managedMedia: [],
      mediaStatus: 'partial',
      mediaFailures: [{ reason: 'previous failure', retryable: true }],
    },
  });
  const alert = await recordSupplierOperationalAlert(db as never, {
    category: 'media_processing_failure',
    supplierId: 'dropex',
    queueItemId,
  });

  await ensureSupplierReviewQueueManagedMedia(db as never, queueItemId, {
    reprocessIncomplete: true,
    dependencies: mediaDependencies(pngBody),
  });

  assert.equal(documents.get(`supplier_review_queue/${queueItemId}`)?.mediaStatus, 'failed');
  assert.equal(documents.get(`supplier_operational_alerts/${alert.alertId}`)?.status, 'open');
  const resolvedEvents = collectionDocuments(documents, 'supplier_operational_alert_events')
    .filter((event) => event.alertId === alert.alertId && event.event === 'resolved');
  assert.equal(resolvedEvents.length, 0);
});

test('critical supplier alert creation records the complete incident and triggers one email delivery', async () => {
  const now = Date.UTC(2026, 6, 29, 10, 0, 0);
  const { db, documents } = createFakeFirestore();
  const result = await recordSupplierOperationalAlert(db as never, {
    category: 'supplier_sync_failure',
    severity: 'critical',
    supplierId: 'supplier-a',
    jobId: 'job-a',
    batchId: 'batch-a',
    technicalMetadata: { classification: 'network', attempt: 3 },
    now,
  }, { notificationEmail: 'admin@zyro.lk' });

  assert.equal(result.created, true);
  assert.equal(result.notified, true);
  const alert = documents.get(`supplier_operational_alerts/${result.alertId}`)!;
  assert.equal(alert.alertId, result.alertId);
  assert.equal(alert.severity, 'critical');
  assert.equal(alert.category, 'supplier_sync_failure');
  assert.equal(alert.supplierId, 'supplier-a');
  assert.equal(alert.jobId, 'job-a');
  assert.equal(alert.batchId, 'batch-a');
  assert.equal(alert.firstOccurrence, new Date(now).toISOString());
  assert.equal(alert.lastOccurrence, new Date(now).toISOString());
  assert.equal(alert.status, 'open');
  assert.equal(alert.assignedAdmin, null);
  assert.match(String(alert.message), /synchronization failed/iu);
  assert.deepEqual(alert.technicalMetadata, { classification: 'network', attempt: 3 });
  assert.equal(collectionDocuments(documents, 'supplier_operational_alert_events').length, 1);
  assert.equal(collectionDocuments(documents, 'notification_outbox').length, 1);
  assert.equal(collectionDocuments(documents, 'mail').length, 1);
});

test('duplicate active alerts update occurrence time without creating unlimited alerts or notifications', async () => {
  const firstAt = Date.UTC(2026, 6, 29, 10, 0, 0);
  const secondAt = firstAt + 60_000;
  const { db, documents } = createFakeFirestore();
  const input = {
    category: 'dead_letter_created' as const,
    severity: 'critical' as const,
    supplierId: 'supplier-a',
    queueItemId: 'queue-a',
  };
  const first = await recordSupplierOperationalAlert(db as never, { ...input, now: firstAt }, { notificationEmail: 'admin@zyro.lk' });
  const duplicate = await recordSupplierOperationalAlert(db as never, {
    ...input,
    now: secondAt,
    technicalMetadata: { retryCount: 5 },
  }, { notificationEmail: 'admin@zyro.lk' });

  assert.equal(duplicate.alertId, first.alertId);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.notified, false);
  const alert = documents.get(`supplier_operational_alerts/${first.alertId}`)!;
  assert.equal(alert.firstOccurrence, new Date(firstAt).toISOString());
  assert.equal(alert.lastOccurrence, new Date(secondAt).toISOString());
  assert.equal(alert.occurrenceCount, 2);
  assert.deepEqual(alert.technicalMetadata, { retryCount: 5 });
  assert.equal(collectionDocuments(documents, 'supplier_operational_alerts').length, 1);
  assert.equal(collectionDocuments(documents, 'supplier_operational_alert_events').length, 1);
  assert.equal(collectionDocuments(documents, 'mail').length, 1);
});

test('acknowledgement and resolution preserve immutable lifecycle history and a later incident reopens safely', async () => {
  const now = Date.UTC(2026, 6, 29, 10, 0, 0);
  const { db, documents } = createFakeFirestore();
  const created = await recordSupplierOperationalAlert(db as never, {
    category: 'queue_worker_failure',
    severity: 'critical',
    dedupeScope: 'supplier-review-worker',
    now,
  }, { notificationEmail: 'admin@zyro.lk' });
  const actor = { uid: 'admin-user', email: 'admin@zyro.lk' };

  const acknowledged = await transitionSupplierOperationalAlert(db as never, created.alertId, 'acknowledged', actor, now + 1_000);
  assert.equal(acknowledged?.status, 'acknowledged');
  assert.deepEqual(acknowledged?.assignedAdmin, actor);
  const resolved = await transitionSupplierOperationalAlert(db as never, created.alertId, 'resolved', actor, now + 2_000);
  assert.equal(resolved?.status, 'resolved');
  const reopened = await recordSupplierOperationalAlert(db as never, {
    category: 'queue_worker_failure',
    severity: 'critical',
    dedupeScope: 'supplier-review-worker',
    now: now + 3_000,
  }, { notificationEmail: 'admin@zyro.lk' });

  assert.equal(reopened.reopened, true);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.notified, true);
  assert.equal(collectionDocuments(documents, 'supplier_operational_alert_events').length, 4);
  assert.equal(collectionDocuments(documents, 'mail').length, 2);
});

test('supplier alert identity isolates simultaneous supplier failures while suppressing repeats per supplier', async () => {
  const { db, documents } = createFakeFirestore();
  const first = await recordSupplierOperationalAlert(db as never, {
    category: 'supplier_connection_failure',
    supplierId: 'supplier-a',
  });
  const second = await recordSupplierOperationalAlert(db as never, {
    category: 'supplier_connection_failure',
    supplierId: 'supplier-b',
  });
  await recordSupplierOperationalAlert(db as never, {
    category: 'supplier_connection_failure',
    supplierId: 'supplier-a',
  });

  assert.notEqual(first.alertId, second.alertId);
  assert.equal(collectionDocuments(documents, 'supplier_operational_alerts').length, 2);
  assert.equal(documents.get(`supplier_operational_alerts/${first.alertId}`)?.occurrenceCount, 2);
  assert.equal(documents.get(`supplier_operational_alerts/${second.alertId}`)?.occurrenceCount, 1);
});

test('queue, scheduler, media, storage, authentication, and App Check failures retain independent alert identities', () => {
  const categories = [
    'dead_letter_created',
    'queue_age_threshold_exceeded',
    'queue_worker_failure',
    'scheduler_failure',
    'media_processing_failure',
    'storage_failure',
    'authentication_failure',
    'app_check_failure',
  ] as const;
  const ids = categories.map((category) => supplierOperationalAlertId({ category, dedupeScope: 'same-scope' }));
  assert.equal(new Set(ids).size, categories.length);
});

test('technical alert metadata strips credentials and bounds nested diagnostics', () => {
  assert.deepEqual(sanitizeSupplierAlertTechnicalMetadata({
    reason: 'safe failure',
    password: 'do-not-store',
    Authorization: 'Bearer secret',
    nested: { token: 'hidden', status: 500 },
  }), {
    reason: 'safe failure',
    nested: { status: 500 },
  });
});

test('required failure producers use the shared alert engine and lifecycle remains Functions-authoritative', () => {
  const app = readFileSync('functions/src/api/app.ts', 'utf8');
  const auth = readFileSync('functions/src/api/middleware/supplierHubAdminAuth.ts', 'utf8');
  const routes = readFileSync('functions/src/api/routes/supplier.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');
  const dispatcher = readFileSync('functions/src/scheduled/supplierSyncWorker.ts', 'utf8');
  const queue = readFileSync('functions/src/scheduled/supplierReviewQueue.ts', 'utf8');
  const queueWorker = readFileSync('functions/src/scheduled/supplierQueueWorker.ts', 'utf8');
  const media = readFileSync('functions/src/api/suppliers/supplierMediaPipeline.ts', 'utf8');
  const monitor = readFileSync('functions/src/scheduled/supplierOperationalAlerts.ts', 'utf8');
  const rules = readFileSync('firestore.rules', 'utf8');
  const index = readFileSync('functions/src/index.ts', 'utf8');

  assert.match(app, /category: "app_check_failure"/u);
  assert.match(auth, /category: "authentication_failure"/u);
  assert.match(routes, /category: "supplier_connection_failure"/u);
  assert.match(sync, /category: "supplier_sync_failure"/u);
  assert.match(dispatcher, /category: "scheduler_failure"/u);
  assert.match(queue, /category: "dead_letter_created"/u);
  assert.match(queueWorker, /category: "queue_worker_failure"/u);
  assert.match(media, /category: "storage_failure"/u);
  assert.match(monitor, /queue_age_threshold_exceeded/u);
  assert.match(index, /scheduledSupplierOperationalAlerts/u);
  assert.match(routes, /supplier-operations\/alerts\/:alertId\/action/u);
  assert.match(rules, /match \/supplier_operational_alerts\/\{docId\}[\s\S]*?allow create, update, delete: if false/u);
  assert.match(rules, /match \/supplier_operational_alert_events\/\{docId\}[\s\S]*?allow create, update, delete: if false/u);
});
