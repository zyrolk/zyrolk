import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import appletConfig from '../firebase-applet-config.json';
import {
  buildCommercialFieldDeletes,
  COMMERCIAL_PRODUCT_FIELDS,
  containsCommercialProductFields,
  PRODUCT_PRIVATE_COLLECTION,
  splitProductData,
} from '../src/services/products/productCommercialData';

const applyRequested = process.argv.includes('--apply');
const expectedProjectId = String(appletConfig.projectId || '').trim();

if (!expectedProjectId) throw new Error('firebase-applet-config.json does not contain a projectId.');
if (applyRequested && process.env.PRODUCT_SECURITY_MIGRATION_CONFIRM !== expectedProjectId) {
  throw new Error(`Set PRODUCT_SECURITY_MIGRATION_CONFIRM=${expectedProjectId} to authorize the production migration.`);
}

const app = getApps()[0] ?? initializeApp({
  credential: applicationDefault(),
  projectId: expectedProjectId,
});
const db = getFirestore(app);

async function migrate(): Promise<void> {
  const snapshot = await db.collection('products').get();
  const affected = snapshot.docs.filter((document) => containsCommercialProductFields(document.data()));
  const fieldsFound = new Set<string>();

  for (const document of affected) {
    for (const field of COMMERCIAL_PRODUCT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(document.data(), field)) fieldsFound.add(field);
    }
  }

  console.info(JSON.stringify({
    mode: applyRequested ? 'apply' : 'dry-run',
    projectId: expectedProjectId,
    productsScanned: snapshot.size,
    productsRequiringMigration: affected.length,
    commercialFieldsFound: [...fieldsFound].sort(),
  }));

  if (!applyRequested || affected.length === 0) return;

  for (let start = 0; start < affected.length; start += 400) {
    const batch = db.batch();
    for (const document of affected.slice(start, start + 400)) {
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
  }

  const verification = await db.collection('products').get();
  const unsafeDocuments = verification.docs.filter((document) => containsCommercialProductFields(document.data()));
  if (unsafeDocuments.length > 0) {
    throw new Error(`Migration verification failed: ${unsafeDocuments.length} public product documents still contain commercial fields.`);
  }
  console.info(JSON.stringify({
    mode: 'apply',
    result: 'verified',
    publicProductsChecked: verification.size,
    unsafePublicProducts: 0,
  }));
}

migrate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Product commercial-data migration failed.');
  process.exitCode = 1;
});
