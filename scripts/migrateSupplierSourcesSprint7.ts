import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import appletConfig from "../firebase-applet-config.json";
import { buildSupplierSourceCompatibilityMigration } from "../functions/src/api/suppliers/supplierSourceCompatibility";

const applyRequested = process.argv.includes("--apply");
const expectedProjectId = String(appletConfig.projectId || "").trim();
const confirmationVariable = "SUPPLIER_SOURCE_REGISTRY_MIGRATION_CONFIRM";
const PAGE_SIZE = 200;

if (!expectedProjectId) throw new Error("firebase-applet-config.json does not contain a projectId.");
if (applyRequested && process.env[confirmationVariable] !== expectedProjectId) {
  throw new Error(`Set ${confirmationVariable}=${expectedProjectId} to authorize the supplier registry migration.`);
}

const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: expectedProjectId });
const db = getFirestore(app);

interface MigrationSummary {
  scanned: number;
  requiringMigration: number;
  recognizedA2Z: number;
  migrated: number;
}

async function migrate(): Promise<void> {
  const summary: MigrationSummary = { scanned: 0, requiringMigration: 0, recognizedA2Z: 0, migrated: 0 };
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  do {
    let query = db.collection("supplierSources").orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    cursor = snapshot.docs.at(-1);
    const migrations = snapshot.docs.map((document) => ({
      document,
      migration: buildSupplierSourceCompatibilityMigration(document.id, document.data()),
    }));

    summary.scanned += snapshot.size;
    summary.requiringMigration += migrations.filter(({ migration }) => migration.needsMigration).length;
    summary.recognizedA2Z += migrations.filter(({ migration }) => migration.config.connectorType === "a2z").length;

    if (applyRequested) {
      const pending = migrations.filter(({ migration }) => migration.needsMigration);
      for (let offset = 0; offset < pending.length; offset += 400) {
        const batch = db.batch();
        for (const { document, migration } of pending.slice(offset, offset + 400)) {
          batch.set(document.ref, migration.patch, { merge: true });
        }
        await batch.commit();
        summary.migrated += pending.slice(offset, offset + 400).length;
      }
    }

    if (snapshot.size < PAGE_SIZE) break;
  } while (cursor);

  console.info(JSON.stringify({
    mode: applyRequested ? "apply" : "dry-run",
    projectId: expectedProjectId,
    ...summary,
    guarantees: ["merge-only", "no source deletion", "no config/settings overwrite", "no credential values written"],
  }));
}

migrate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Supplier registry migration failed.");
  process.exitCode = 1;
});
