import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import appletConfig from '../firebase-applet-config.json';

export const FIRESTORE_WRITE_BATCH_LIMIT = 500;
export const MAX_REVIEW_MIGRATION_OPERATION_UNITS_PER_DOCUMENT = 5;
export const REVIEW_DOCUMENTS_PER_BATCH = 80;
export const MAX_REVIEW_MIGRATION_OPERATION_UNITS_PER_BATCH =
  REVIEW_DOCUMENTS_PER_BATCH * MAX_REVIEW_MIGRATION_OPERATION_UNITS_PER_DOCUMENT;

// One private create carries a server timestamp and one public update carries two
// delete transforms. Counting both base writes and all three transforms yields
// five conservative operation units per document: 80 * 5 = 400, below 500.
if (MAX_REVIEW_MIGRATION_OPERATION_UNITS_PER_BATCH >= FIRESTORE_WRITE_BATCH_LIMIT) {
  throw new Error('Review ownership migration batch configuration is unsafe.');
}

export function maximumReviewMigrationOperationUnits(documentCount: number): number {
  return documentCount * MAX_REVIEW_MIGRATION_OPERATION_UNITS_PER_DOCUMENT;
}

export interface ReviewOwnershipMigrationResult {
  documentsScanned: number;
  documentsRequiringMigration: number;
  migratedDocuments: number;
  committedBatches: number;
  unsafePublicDocuments: number;
}

type OwnershipCollection = {
  publicName: 'reviews' | 'productQuestions';
  privateName: 'review_private' | 'product_question_private';
  idField: 'reviewId' | 'questionId';
};

interface ProtectedOwnershipEvidence {
  documentId: string;
  productId: string;
  userId: string;
  orderId: string | null;
  verifiedPurchase: boolean;
}

interface PlannedOwnershipMigration extends OwnershipCollection {
  publicReference: FirebaseFirestore.DocumentReference;
  privateReference: FirebaseFirestore.DocumentReference;
  evidence: ProtectedOwnershipEvidence;
}

export class ReviewOwnershipMigrationConflictError extends Error {
  constructor(documentPath: string, category: string) {
    super(`Review ownership migration conflict at ${documentPath}: ${category}.`);
    this.name = 'ReviewOwnershipMigrationConflictError';
  }
}

interface Options {
  applyRequested: boolean;
  expectedProjectId: string;
  log?: (message: string) => void;
}

export function assertReviewOwnershipMigrationAuthorized(
  applyRequested: boolean,
  expectedProjectId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!expectedProjectId) throw new Error('firebase-applet-config.json does not contain a projectId.');
  if (applyRequested && environment.REVIEW_OWNERSHIP_MIGRATION_CONFIRM !== expectedProjectId) {
    throw new Error(`Set REVIEW_OWNERSHIP_MIGRATION_CONFIRM=${expectedProjectId} to authorize the production migration.`);
  }
}

const hasPrivateOwnership = (data: FirebaseFirestore.DocumentData): boolean => (
  Object.hasOwn(data, 'userId') || Object.hasOwn(data, 'orderId')
);

const cleanEvidenceText = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const buildProtectedEvidence = (
  documentPath: string,
  documentId: string,
  data: FirebaseFirestore.DocumentData,
  collection: OwnershipCollection,
): ProtectedOwnershipEvidence => {
  const productId = cleanEvidenceText(data.productId);
  const userId = cleanEvidenceText(data.userId);
  const orderId = cleanEvidenceText(data.orderId) || null;
  if (!productId) throw new Error(`${documentPath} contains invalid product ownership data.`);
  if (!userId) throw new Error(`${documentPath} contains invalid user ownership data.`);
  if (collection.publicName === 'reviews' && (!orderId || data.verifiedPurchase !== true)) {
    throw new Error(`${documentPath} contains invalid verified-purchase ownership data.`);
  }
  return {
    documentId,
    productId,
    userId,
    orderId,
    verifiedPurchase: data.verifiedPurchase === true,
  };
};

const assertProtectedEvidenceMatches = (
  documentPath: string,
  data: FirebaseFirestore.DocumentData,
  collection: OwnershipCollection,
  expected: ProtectedOwnershipEvidence,
): void => {
  const checks: Array<[string, unknown, unknown]> = [
    [collection.idField, cleanEvidenceText(data[collection.idField]), expected.documentId],
    ['productId', cleanEvidenceText(data.productId), expected.productId],
    ['userId', cleanEvidenceText(data.userId), expected.userId],
    ['orderId', cleanEvidenceText(data.orderId) || null, expected.orderId],
    ['verifiedPurchase', data.verifiedPurchase === true, expected.verifiedPurchase],
  ];
  const conflict = checks.find(([, actual, wanted]) => actual !== wanted);
  if (conflict) throw new ReviewOwnershipMigrationConflictError(documentPath, conflict[0]);
};

const getAllBounded = async (
  db: Firestore,
  references: FirebaseFirestore.DocumentReference[],
): Promise<FirebaseFirestore.DocumentSnapshot[]> => {
  const snapshots: FirebaseFirestore.DocumentSnapshot[] = [];
  for (let start = 0; start < references.length; start += 200) {
    snapshots.push(...await db.getAll(...references.slice(start, start + 200)));
  }
  return snapshots;
};

export async function migrateReviewOwnershipData(db: Firestore, options: Options): Promise<ReviewOwnershipMigrationResult> {
  const { applyRequested, expectedProjectId, log = console.info } = options;
  const collections: OwnershipCollection[] = [
    { publicName: 'reviews', privateName: 'review_private', idField: 'reviewId' },
    { publicName: 'productQuestions', privateName: 'product_question_private', idField: 'questionId' },
  ];
  const snapshots = await Promise.all(collections.map((entry) => db.collection(entry.publicName).get()));
  const affected: PlannedOwnershipMigration[] = snapshots.flatMap((snapshot, index) => snapshot.docs
    .filter((document) => hasPrivateOwnership(document.data()))
    .map((document) => {
      const collection = collections[index];
      return {
        ...collection,
        publicReference: document.ref,
        privateReference: db.collection(collection.privateName).doc(document.id),
        evidence: buildProtectedEvidence(document.ref.path, document.id, document.data(), collection),
      };
    }));

  const existingCompanions = await getAllBounded(db, affected.map((item) => item.privateReference));
  existingCompanions.forEach((companion, index) => {
    if (companion.exists) {
      assertProtectedEvidenceMatches(companion.ref.path, companion.data() || {}, affected[index], affected[index].evidence);
    }
  });
  const result: ReviewOwnershipMigrationResult = {
    documentsScanned: snapshots.reduce((total, snapshot) => total + snapshot.size, 0),
    documentsRequiringMigration: affected.length,
    migratedDocuments: 0,
    committedBatches: 0,
    unsafePublicDocuments: affected.length,
  };
  log(JSON.stringify({
    mode: applyRequested ? 'apply' : 'dry-run',
    projectId: expectedProjectId,
    documentsScanned: result.documentsScanned,
    documentsRequiringMigration: result.documentsRequiringMigration,
  }));
  if (!applyRequested || affected.length === 0) return result;

  for (let start = 0; start < affected.length; start += REVIEW_DOCUMENTS_PER_BATCH) {
    const documents = affected.slice(start, start + REVIEW_DOCUMENTS_PER_BATCH);
    if (maximumReviewMigrationOperationUnits(documents.length) >= FIRESTORE_WRITE_BATCH_LIMIT) {
      throw new Error('Review ownership migration batch exceeds the safe Firestore write bound.');
    }
    const migratedInBatch = await db.runTransaction(async (transaction) => {
      const currentSnapshots = await Promise.all(documents.flatMap((item) => [
        transaction.get(item.publicReference),
        transaction.get(item.privateReference),
      ]));
      let migrated = 0;
      documents.forEach((item, index) => {
        const publicSnapshot = currentSnapshots[index * 2];
        const privateSnapshot = currentSnapshots[(index * 2) + 1];
        if (!publicSnapshot.exists) {
          throw new ReviewOwnershipMigrationConflictError(item.publicReference.path, 'public document missing');
        }
        const publicData = publicSnapshot.data() || {};
        const stillUnsafe = hasPrivateOwnership(publicData);
        if (stillUnsafe) {
          const currentEvidence = buildProtectedEvidence(
            publicSnapshot.ref.path,
            publicSnapshot.id,
            publicData,
            item,
          );
          assertProtectedEvidenceMatches(
            publicSnapshot.ref.path,
            {
              [item.idField]: currentEvidence.documentId,
              ...currentEvidence,
            },
            item,
            item.evidence,
          );
        }
        if (privateSnapshot.exists) {
          assertProtectedEvidenceMatches(privateSnapshot.ref.path, privateSnapshot.data() || {}, item, item.evidence);
        } else if (!stillUnsafe) {
          throw new ReviewOwnershipMigrationConflictError(item.privateReference.path, 'private companion missing');
        } else {
          transaction.create(item.privateReference, {
            schemaVersion: 1,
            [item.idField]: item.evidence.documentId,
            productId: item.evidence.productId,
            userId: item.evidence.userId,
            ...(item.evidence.orderId ? { orderId: item.evidence.orderId } : {}),
            ...(item.evidence.verifiedPurchase ? { verifiedPurchase: true } : {}),
            migratedAt: FieldValue.serverTimestamp(),
          });
        }
        if (stillUnsafe) {
          transaction.update(item.publicReference, {
            userId: FieldValue.delete(),
            orderId: FieldValue.delete(),
          });
          migrated += 1;
        }
      });
      return migrated;
    });
    result.migratedDocuments += migratedInBatch;
    if (migratedInBatch > 0) result.committedBatches += 1;
  }

  const verification = await Promise.all(collections.map((entry) => db.collection(entry.publicName).get()));
  result.unsafePublicDocuments = verification.reduce((total, snapshot) => (
    total + snapshot.docs.filter((document) => hasPrivateOwnership(document.data())).length
  ), 0);
  if (result.unsafePublicDocuments > 0) {
    throw new Error(`Migration verification failed: ${result.unsafePublicDocuments} public review documents still expose ownership fields.`);
  }
  const [verifiedPublic, verifiedPrivate] = await Promise.all([
    getAllBounded(db, affected.map((item) => item.publicReference)),
    getAllBounded(db, affected.map((item) => item.privateReference)),
  ]);
  affected.forEach((item, index) => {
    if (!verifiedPublic[index].exists || hasPrivateOwnership(verifiedPublic[index].data() || {})) {
      throw new Error(`Migration verification failed for ${item.publicReference.path}: unsafe public ownership data remains.`);
    }
    if (!verifiedPrivate[index].exists) {
      throw new Error(`Migration verification failed for ${item.privateReference.path}: private companion is missing.`);
    }
    assertProtectedEvidenceMatches(
      verifiedPrivate[index].ref.path,
      verifiedPrivate[index].data() || {},
      item,
      item.evidence,
    );
  });
  log(JSON.stringify({ mode: 'apply', result: 'verified', unsafePublicDocuments: 0 }));
  return result;
}

async function runCli(): Promise<void> {
  const applyRequested = process.argv.includes('--apply');
  const expectedProjectId = String(appletConfig.projectId || '').trim();
  assertReviewOwnershipMigrationAuthorized(applyRequested, expectedProjectId);
  const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: expectedProjectId });
  await migrateReviewOwnershipData(getFirestore(app), { applyRequested, expectedProjectId });
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Review ownership migration failed.');
    process.exitCode = 1;
  });
}
