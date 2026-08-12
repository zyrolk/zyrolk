import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import appletConfig from '../firebase-applet-config.json';
import {
  buildCommercialFieldDeletes,
  COMMERCIAL_PRODUCT_FIELDS,
  containsCommercialProductFields,
  PRODUCT_PRIVATE_COLLECTION,
  splitProductData,
} from '../src/services/products/productCommercialData';

export const FIRESTORE_WRITE_BATCH_LIMIT = 500;
export const MAX_WRITE_OPERATIONS_PER_PRODUCT = 4;
export const PRODUCTS_PER_BATCH = 100;
export const MAX_WRITE_OPERATIONS_PER_BATCH = PRODUCTS_PER_BATCH * MAX_WRITE_OPERATIONS_PER_PRODUCT;

// Each product emits a private-document set and a public-document update. The
// private set always contains migratedAt=serverTimestamp() and may also need an
// updatedAt server timestamp, so four operation units per product is the
// conservative upper bound. One hundred products therefore stay at or below
// 400 operation units, with no additional write emitted for batch metadata.
if (MAX_WRITE_OPERATIONS_PER_BATCH >= FIRESTORE_WRITE_BATCH_LIMIT) {
  throw new Error('Product commercial-data migration batch configuration is unsafe.');
}

export interface ProductCommercialMigrationResult {
  productsScanned: number;
  productsRequiringMigration: number;
  migratedProducts: number;
  committedBatches: number;
  batchProductCounts: number[];
  unsafePublicProducts: number;
}

interface ProductCommercialMigrationOptions {
  applyRequested: boolean;
  expectedProjectId: string;
  log?: (message: string) => void;
}

export function assertProductCommercialMigrationAuthorized(
  applyRequested: boolean,
  expectedProjectId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!expectedProjectId) throw new Error('firebase-applet-config.json does not contain a projectId.');
  if (applyRequested && environment.PRODUCT_SECURITY_MIGRATION_CONFIRM !== expectedProjectId) {
    throw new Error(`Set PRODUCT_SECURITY_MIGRATION_CONFIRM=${expectedProjectId} to authorize the production migration.`);
  }
}

export function maximumWriteOperationsForProductBatch(productCount: number): number {
  return productCount * MAX_WRITE_OPERATIONS_PER_PRODUCT;
}

export async function migrateProductCommercialData(
  db: Firestore,
  options: ProductCommercialMigrationOptions,
): Promise<ProductCommercialMigrationResult> {
  const { applyRequested, expectedProjectId, log = console.info } = options;
  const snapshot = await db.collection('products').get();
  const affected = snapshot.docs.filter((document) => containsCommercialProductFields(document.data()));
  const fieldsFound = new Set<string>();

  for (const document of affected) {
    for (const field of COMMERCIAL_PRODUCT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(document.data(), field)) fieldsFound.add(field);
    }
  }

  log(JSON.stringify({
    mode: applyRequested ? 'apply' : 'dry-run',
    projectId: expectedProjectId,
    productsScanned: snapshot.size,
    productsRequiringMigration: affected.length,
    commercialFieldsFound: [...fieldsFound].sort(),
  }));

  const result: ProductCommercialMigrationResult = {
    productsScanned: snapshot.size,
    productsRequiringMigration: affected.length,
    migratedProducts: 0,
    committedBatches: 0,
    batchProductCounts: [],
    unsafePublicProducts: affected.length,
  };
  if (!applyRequested || affected.length === 0) return result;

  for (let start = 0; start < affected.length; start += PRODUCTS_PER_BATCH) {
    const documents = affected.slice(start, start + PRODUCTS_PER_BATCH);
    if (maximumWriteOperationsForProductBatch(documents.length) >= FIRESTORE_WRITE_BATCH_LIMIT) {
      throw new Error('Product commercial-data migration batch exceeds the safe Firestore write bound.');
    }
    const batch = db.batch();
    for (const document of documents) {
      const { commercialData } = splitProductData(document.data());
      batch.set(db.collection(PRODUCT_PRIVATE_COLLECTION).doc(document.id), {
        ...commercialData,
        productId: document.id,
        migratedAt: FieldValue.serverTimestamp(),
        updatedAt: document.data().updatedAt || FieldValue.serverTimestamp(),
      }, { merge: true });
      batch.update(document.ref, buildCommercialFieldDeletes(FieldValue.delete()));
    }
    await batch.commit();
    result.committedBatches += 1;
    result.migratedProducts += documents.length;
    result.batchProductCounts.push(documents.length);
  }

  const verification = await db.collection('products').get();
  const unsafeDocuments = verification.docs.filter((document) => containsCommercialProductFields(document.data()));
  result.unsafePublicProducts = unsafeDocuments.length;
  if (unsafeDocuments.length > 0) {
    throw new Error(`Migration verification failed: ${unsafeDocuments.length} public product documents still contain commercial fields.`);
  }
  log(JSON.stringify({
    mode: 'apply',
    result: 'verified',
    publicProductsChecked: verification.size,
    unsafePublicProducts: 0,
  }));
  return result;
}

async function runCli(): Promise<void> {
  const applyRequested = process.argv.includes('--apply');
  const expectedProjectId = String(appletConfig.projectId || '').trim();
  assertProductCommercialMigrationAuthorized(applyRequested, expectedProjectId);
  const app = getApps()[0] ?? initializeApp({
    credential: applicationDefault(),
    projectId: expectedProjectId,
  });
  await migrateProductCommercialData(getFirestore(app), { applyRequested, expectedProjectId });
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Product commercial-data migration failed.');
    process.exitCode = 1;
  });
}
