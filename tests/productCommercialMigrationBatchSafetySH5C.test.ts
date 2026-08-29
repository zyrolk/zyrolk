import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import {
  assertProductCommercialMigrationAuthorized,
  FIRESTORE_WRITE_BATCH_LIMIT,
  MAX_WRITE_OPERATIONS_PER_BATCH,
  migrateProductCommercialData,
  PRODUCTS_PER_BATCH,
} from '../scripts/migrateProductCommercialData';
import {
  containsCommercialProductFields,
  PRODUCT_PRIVATE_COLLECTION,
} from '../src/services/products/productCommercialData';

type StoredDocument = Record<string, unknown>;
type FakeReference = { collectionName: string; id: string; path: string };
type FakeOperation = {
  type: 'set' | 'update';
  reference: FakeReference;
  data: StoredDocument;
  merge: boolean;
};

const isTransform = (value: unknown, name: string): boolean =>
  value !== null && typeof value === 'object' && value.constructor?.name === name;

class FakeMigrationFirestore {
  readonly documents = new Map<string, StoredDocument>();
  readonly commits: Array<{ operationUnits: number; productIds: string[] }> = [];

  constructor(productCount: number) {
    for (let index = 0; index < productCount; index += 1) {
      const id = `product-${String(index).padStart(3, '0')}`;
      this.documents.set(`products/${id}`, {
        id,
        name: `Product ${index}`,
        price: 1_000 + index,
        costPrice: 500 + index,
        supplierId: 'supplier-a',
        supplierItemCode: `SUP-${index}`,
      });
    }
  }

  collection(collectionName: string) {
    return {
      doc: (id: string): FakeReference => ({ collectionName, id, path: `${collectionName}/${id}` }),
      get: async () => {
        const docs = [...this.documents.entries()]
          .filter(([path]) => path.startsWith(`${collectionName}/`))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, data]) => {
            const id = path.slice(collectionName.length + 1);
            const ref: FakeReference = { collectionName, id, path };
            return { id, ref, data: () => ({ ...data }) };
          });
        return { docs, size: docs.length };
      },
    };
  }

  batch() {
    const operations: FakeOperation[] = [];
    return {
      set: (reference: FakeReference, data: StoredDocument, options?: { merge?: boolean }) => {
        operations.push({ type: 'set', reference, data, merge: options?.merge === true });
      },
      update: (reference: FakeReference, data: StoredDocument) => {
        operations.push({ type: 'update', reference, data, merge: true });
      },
      commit: async () => {
        const operationUnits = operations.reduce((total, operation) => total + 1
          + Object.values(operation.data).filter((value) => isTransform(value, 'ServerTimestampTransform')).length, 0);
        if (operationUnits >= FIRESTORE_WRITE_BATCH_LIMIT) throw new Error('Fake Firestore rejected an unsafe batch.');

        const productIds: string[] = [];
        for (const operation of operations) {
          const current = this.documents.get(operation.reference.path) || {};
          const next = operation.merge ? { ...current } : {};
          for (const [field, value] of Object.entries(operation.data)) {
            if (isTransform(value, 'DeleteTransform')) delete next[field];
            else if (isTransform(value, 'ServerTimestampTransform')) next[field] = 'server-timestamp';
            else next[field] = value;
          }
          this.documents.set(operation.reference.path, next);
          if (operation.type === 'set' && operation.reference.collectionName === PRODUCT_PRIVATE_COLLECTION) {
            productIds.push(operation.reference.id);
          }
        }
        this.commits.push({ operationUnits, productIds });
      },
    };
  }
}

test('SH-5C migrates 251 products in bounded batches without skips or duplicates', async () => {
  const db = new FakeMigrationFirestore(251);
  const result = await migrateProductCommercialData(db as unknown as Firestore, {
    applyRequested: true,
    expectedProjectId: 'demo-zyro-sh5c',
    log: () => undefined,
  });

  assert.equal(PRODUCTS_PER_BATCH, 100);
  assert.equal(MAX_WRITE_OPERATIONS_PER_BATCH, 400);
  assert.ok(MAX_WRITE_OPERATIONS_PER_BATCH < FIRESTORE_WRITE_BATCH_LIMIT);
  assert.deepEqual(result.batchProductCounts, [100, 100, 51]);
  assert.equal(result.committedBatches, 3);
  assert.equal(result.migratedProducts, 251);
  assert.equal(result.unsafePublicProducts, 0);
  assert.equal(db.commits.length, 3);
  assert.ok(db.commits.every((commit) => commit.operationUnits <= MAX_WRITE_OPERATIONS_PER_BATCH));

  const migratedIds = db.commits.flatMap((commit) => commit.productIds);
  assert.equal(migratedIds.length, 251);
  assert.equal(new Set(migratedIds).size, 251);
  assert.equal([...db.documents.entries()].filter(([path]) => path.startsWith(`${PRODUCT_PRIVATE_COLLECTION}/`)).length, 251);
  assert.ok([...db.documents.entries()]
    .filter(([path]) => path.startsWith('products/'))
    .every(([, product]) => !containsCommercialProductFields(product)));

  const commitsBeforeRetry = db.commits.length;
  const retry = await migrateProductCommercialData(db as unknown as Firestore, {
    applyRequested: true,
    expectedProjectId: 'demo-zyro-sh5c',
    log: () => undefined,
  });
  assert.equal(retry.productsRequiringMigration, 0);
  assert.equal(retry.migratedProducts, 0);
  assert.equal(retry.committedBatches, 0);
  assert.equal(db.commits.length, commitsBeforeRetry);
});

test('SH-5C dry-run reports affected products without writing', async () => {
  const db = new FakeMigrationFirestore(251);
  const result = await migrateProductCommercialData(db as unknown as Firestore, {
    applyRequested: false,
    expectedProjectId: 'demo-zyro-sh5c',
    log: () => undefined,
  });

  assert.equal(result.productsScanned, 251);
  assert.equal(result.productsRequiringMigration, 251);
  assert.equal(result.migratedProducts, 0);
  assert.equal(result.committedBatches, 0);
  assert.equal(db.commits.length, 0);
  assert.equal([...db.documents.keys()].filter((path) => path.startsWith(`${PRODUCT_PRIVATE_COLLECTION}/`)).length, 0);
});

test('SH-5C retains explicit production confirmation for apply mode', () => {
  assert.doesNotThrow(() => assertProductCommercialMigrationAuthorized(false, 'zyrolk-e0164', {}));
  assert.throws(
    () => assertProductCommercialMigrationAuthorized(true, 'zyrolk-e0164', {}),
    /PRODUCT_SECURITY_MIGRATION_CONFIRM=zyrolk-e0164/u,
  );
  assert.doesNotThrow(() => assertProductCommercialMigrationAuthorized(true, 'zyrolk-e0164', {
    PRODUCT_SECURITY_MIGRATION_CONFIRM: 'zyrolk-e0164',
  }));
});

const emulatorHost = String(process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const EMULATOR_FIXTURE_PREFIX = 'sh5c-commercial-migration-';
const EMULATOR_FIXTURE_IDS = Array.from(
  { length: 251 },
  (_, index) => `${EMULATOR_FIXTURE_PREFIX}${String(index).padStart(3, '0')}`,
);

const readFixtureDocuments = async (db: Firestore, collectionName: string) => {
  const documents = [];
  for (let start = 0; start < EMULATOR_FIXTURE_IDS.length; start += PRODUCTS_PER_BATCH) {
    const references = EMULATOR_FIXTURE_IDS
      .slice(start, start + PRODUCTS_PER_BATCH)
      .map((id) => db.collection(collectionName).doc(id));
    documents.push(...await db.getAll(...references));
  }
  return documents;
};

const captureUnrelatedDocuments = async (db: Firestore, collectionName: string) => {
  const snapshot = await db.collection(collectionName).get();
  return new Map(snapshot.docs
    .filter((document) => !document.id.startsWith(EMULATOR_FIXTURE_PREFIX))
    .filter((document) => collectionName !== 'products' || !containsCommercialProductFields(document.data()))
    .map((document) => [document.id, document.data()]));
};

const assertUnrelatedDocumentsPreserved = async (
  db: Firestore,
  collectionName: string,
  expected: ReadonlyMap<string, Record<string, unknown>>,
) => {
  for (const [id, data] of expected) {
    const current = await db.collection(collectionName).doc(id).get();
    assert.equal(current.exists, true, `${collectionName}/${id} must remain present`);
    assert.deepEqual(current.data(), data, `${collectionName}/${id} must remain unchanged`);
  }
};

test('SH-5C migration remains bounded against Firestore Emulator', {
  skip: emulatorHost ? false : 'Firestore Emulator is required.',
}, async () => {
  const projectId = String(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '').trim();
  assert.match(projectId, /^demo-/u);
  assert.match(emulatorHost, /^(?:127\.0\.0\.1|localhost):\d+$/u);

  // Use a dedicated emulator project namespace so other permanent suites can
  // leave legitimate commercial fixtures without changing this exact proof.
  const isolatedProjectId = `${projectId}-sh5c-isolated`;
  const app = initializeApp({ projectId: isolatedProjectId }, `sh5c-${Date.now()}`);
  const db = getFirestore(app);
  try {
    const unrelatedPublicId = 'sh5c-unrelated-safe-product';
    await Promise.all([
      db.collection('products').doc(unrelatedPublicId).set({
        id: unrelatedPublicId,
        name: 'Unrelated safe product',
        isActive: true,
      }),
      db.collection(PRODUCT_PRIVATE_COLLECTION).doc(unrelatedPublicId).set({
        productId: unrelatedPublicId,
        sku: 'ZY-SH5C-UNRELATED',
      }),
    ]);
    const [unrelatedPublicBefore, unrelatedPrivateBefore] = await Promise.all([
      captureUnrelatedDocuments(db, 'products'),
      captureUnrelatedDocuments(db, PRODUCT_PRIVATE_COLLECTION),
    ]);

    for (let start = 0; start < 251; start += PRODUCTS_PER_BATCH) {
      const batch = db.batch();
      for (let index = start; index < Math.min(start + PRODUCTS_PER_BATCH, 251); index += 1) {
        const id = EMULATOR_FIXTURE_IDS[index];
        batch.set(db.collection('products').doc(id), {
          id,
          name: `Migration Product ${index}`,
          price: 1_000 + index,
          costPrice: 500 + index,
          supplierId: 'supplier-emulator',
          supplierItemCode: `EMU-${index}`,
        });
      }
      await batch.commit();
    }

    const fixturesBefore = await readFixtureDocuments(db, 'products');
    assert.equal(fixturesBefore.filter((document) => document.exists).length, 251);
    assert.ok(fixturesBefore.every((document) => containsCommercialProductFields(document.data() || {})));

    const cleanupPrivateFixtures = db.batch();
    for (const id of EMULATOR_FIXTURE_IDS) {
      cleanupPrivateFixtures.delete(db.collection(PRODUCT_PRIVATE_COLLECTION).doc(id));
    }
    await cleanupPrivateFixtures.commit();

    const dryRun = await migrateProductCommercialData(db, {
      applyRequested: false,
      expectedProjectId: isolatedProjectId,
      log: () => undefined,
    });
    assert.equal(dryRun.productsRequiringMigration, 251);
    assert.equal(dryRun.migratedProducts, 0);
    assert.equal(dryRun.committedBatches, 0);
    assert.equal((await readFixtureDocuments(db, PRODUCT_PRIVATE_COLLECTION))
      .filter((document) => document.exists).length, 0);

    const result = await migrateProductCommercialData(db, {
      applyRequested: true,
      expectedProjectId: isolatedProjectId,
      log: () => undefined,
    });
    assert.deepEqual(result.batchProductCounts, [100, 100, 51]);
    assert.equal(result.committedBatches, 3);
    assert.equal(result.migratedProducts, 251);
    assert.equal(result.unsafePublicProducts, 0);

    const [publicFixtures, privateFixtures] = await Promise.all([
      readFixtureDocuments(db, 'products'),
      readFixtureDocuments(db, PRODUCT_PRIVATE_COLLECTION),
    ]);
    assert.equal(publicFixtures.filter((document) => document.exists).length, 251);
    assert.equal(privateFixtures.filter((document) => document.exists).length, 251);
    assert.equal(new Set(publicFixtures.map((document) => document.id)).size, 251);
    assert.equal(new Set(privateFixtures.map((document) => document.id)).size, 251);
    assert.ok(publicFixtures.every((document) => !containsCommercialProductFields(document.data() || {})));
    assert.ok(privateFixtures.every((document, index) => (
      document.data()?.productId === EMULATOR_FIXTURE_IDS[index]
    )));
    await Promise.all([
      assertUnrelatedDocumentsPreserved(db, 'products', unrelatedPublicBefore),
      assertUnrelatedDocumentsPreserved(db, PRODUCT_PRIVATE_COLLECTION, unrelatedPrivateBefore),
    ]);

    const retry = await migrateProductCommercialData(db, {
      applyRequested: true,
      expectedProjectId: isolatedProjectId,
      log: () => undefined,
    });
    assert.equal(retry.productsRequiringMigration, 0);
    assert.equal(retry.migratedProducts, 0);
    assert.equal(retry.committedBatches, 0);
    await Promise.all([
      assertUnrelatedDocumentsPreserved(db, 'products', unrelatedPublicBefore),
      assertUnrelatedDocumentsPreserved(db, PRODUCT_PRIVATE_COLLECTION, unrelatedPrivateBefore),
    ]);
  } finally {
    await deleteApp(app);
  }
});
