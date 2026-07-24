import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import appletConfig from '../firebase-applet-config.json';

const emailArgument = process.argv.find((argument) => argument.startsWith('--email='));
const email = String(emailArgument?.slice('--email='.length) || '').trim().toLowerCase();
const applyRequested = process.argv.includes('--apply');
const expectedProjectId = String(appletConfig.projectId || '').trim();

if (!expectedProjectId) throw new Error('firebase-applet-config.json does not contain a projectId.');
if (!email || !/^\S+@\S+\.\S+$/u.test(email)) throw new Error('Provide a valid --email=administrator@example.com value.');
if (applyRequested && process.env.ADMIN_CLAIM_MIGRATION_CONFIRM !== expectedProjectId) {
  throw new Error(`Set ADMIN_CLAIM_MIGRATION_CONFIRM=${expectedProjectId} to authorize the custom-claim migration.`);
}

const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: expectedProjectId });
const auth = getAuth(app);

async function grant(): Promise<void> {
  const user = await auth.getUserByEmail(email);
  const currentClaims = user.customClaims || {};
  const nextClaims = { ...currentClaims, admin: true, role: 'admin' };
  console.info(JSON.stringify({
    mode: applyRequested ? 'apply' : 'dry-run', projectId: expectedProjectId, email,
    uid: user.uid, addsAdminClaim: currentClaims.admin !== true || currentClaims.role !== 'admin',
  }));
  if (!applyRequested) return;
  await auth.setCustomUserClaims(user.uid, nextClaims);
  console.info(JSON.stringify({ mode: 'apply', result: 'granted', uid: user.uid, email }));
}

grant().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Admin custom-claim migration failed.');
  process.exitCode = 1;
});
