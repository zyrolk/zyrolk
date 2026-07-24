import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import appletConfig from '../firebase-applet-config.json';

const applyRequested = process.argv.includes('--apply');
const expectedProjectId = String(appletConfig.projectId || '').trim();
const confirmationVariable = 'SUPPLIER_SOURCE_CREDENTIAL_MIGRATION_CONFIRM';

if (!expectedProjectId) throw new Error('firebase-applet-config.json does not contain a projectId.');
if (applyRequested && process.env[confirmationVariable] !== expectedProjectId) {
  throw new Error(`Set ${confirmationVariable}=${expectedProjectId} to authorize the supplier credential cleanup.`);
}

const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: expectedProjectId });
const db = getFirestore(app);

const credentialPaths = [
  ['username'], ['password'], ['apiKey'], ['apiToken'], ['token'], ['secret'], ['authorization'],
  ['config', 'username'], ['config', 'password'], ['config', 'apiHeaders'], ['config', 'apiKey'], ['config', 'apiToken'], ['config', 'authorization'],
  ['settings', 'username'], ['settings', 'password'], ['settings', 'apiKey'], ['settings', 'apiToken'], ['settings', 'authorization'],
] as const;

const hasPath = (value: Record<string, unknown>, path: readonly string[]): boolean => {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return true;
};

async function migrate(): Promise<void> {
  const sources = await db.collection('supplierSources').get();
  const affected = sources.docs.filter((source) => credentialPaths.some((path) => hasPath(source.data(), path)));
  const foundPaths = new Set<string>();
  affected.forEach((source) => credentialPaths.forEach((path) => {
    if (hasPath(source.data(), path)) foundPaths.add(path.join('.'));
  }));

  console.info(JSON.stringify({
    mode: applyRequested ? 'apply' : 'dry-run', projectId: expectedProjectId,
    sourcesScanned: sources.size, sourcesRequiringCredentialRemoval: affected.length,
    credentialPathsFound: [...foundPaths].sort(),
  }));
  if (!applyRequested || affected.length === 0) return;

  for (let offset = 0; offset < affected.length; offset += 400) {
    const batch = db.batch();
    for (const source of affected.slice(offset, offset + 400)) {
      const updates: Record<string, unknown> = {};
      credentialPaths.filter((path) => hasPath(source.data(), path)).forEach((path) => {
        updates[path.join('.')] = FieldValue.delete();
      });
      if (Object.keys(updates).length) batch.set(source.ref, updates, { merge: true });
    }
    await batch.commit();
  }

  const verification = await db.collection('supplierSources').get();
  const remaining = verification.docs.filter((source) => credentialPaths.some((path) => hasPath(source.data(), path)));
  if (remaining.length) throw new Error(`Credential cleanup verification failed for ${remaining.length} supplier source(s).`);
  console.info(JSON.stringify({ mode: 'apply', result: 'verified', sourcesChecked: verification.size, sourcesWithCredentials: 0 }));
}

migrate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Supplier credential cleanup failed.');
  process.exitCode = 1;
});
