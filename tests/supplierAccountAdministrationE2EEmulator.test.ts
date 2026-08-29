import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { FirebaseApp, deleteApp, initializeApp } from "firebase/app";
import {
  Auth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { adminAuth, adminDb } from "../functions/src/api/firebase";

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
const canRun = Boolean(firestoreHost && authHost && functionsHost && projectId?.startsWith("demo-"));

interface TestIdentity {
  app: FirebaseApp;
  auth: Auth;
  uid: string;
  email: string;
  password: string;
}

test("trusted supplier onboarding promotes, activates, isolates, audits, and disables real Auth users", {
  skip: canRun ? undefined : "Firestore, Auth, and Functions Emulators are required.",
  timeout: 180_000,
}, async () => {
  assert.match(firestoreHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(authHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(functionsHost || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  assert.match(projectId || "", /^demo-/u);

  const suffix = randomUUID().slice(0, 8);
  const prefix = `supplier-onboarding-${suffix}`;
  const apps: FirebaseApp[] = [];
  const createIdentity = async (name: string): Promise<TestIdentity> => {
    const email = `${prefix}-${name}@example.test`;
    const password = `Zyro-${randomUUID()}!`;
    const app = initializeApp({ apiKey: "demo-key", projectId }, `${prefix}-${name}`);
    apps.push(app);
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await adminDb.collection("users").doc(credential.user.uid).set({
      uid: credential.user.uid,
      email,
      displayName: name,
      role: "customer",
      createdAt: new Date().toISOString(),
    });
    return { app, auth, uid: credential.user.uid, email, password };
  };

  const request = (token: string, path: string, method: "GET" | "POST" | "PUT" = "GET", body?: Record<string, unknown>) => fetch(
    `http://${functionsHost}/${projectId}/us-central1/api/api${path}`,
    {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  try {
    const [operator, supplierA, supplierB, protectedAdmin] = await Promise.all([
      createIdentity("operator"),
      createIdentity("supplier-a"),
      createIdentity("supplier-b"),
      createIdentity("protected-admin"),
    ]);
    await Promise.all([
      adminAuth.setCustomUserClaims(operator.uid, { admin: true }),
      adminAuth.setCustomUserClaims(protectedAdmin.uid, { supplierHubAdmin: true }),
    ]);
    await signOut(operator.auth);
    const operatorSession = await signInWithEmailAndPassword(operator.auth, operator.email, operator.password);
    const adminToken = await operatorSession.user.getIdToken(true);
    const supplierAToken = await supplierA.auth.currentUser!.getIdToken();

    const customerForbidden = await request(supplierAToken, `/supplier-accounts/lookup?query=${encodeURIComponent(supplierA.email)}`);
    assert.equal(customerForbidden.status, 403);

    const missing = await request(adminToken, "/supplier-accounts/lookup?query=missing-auth-user");
    assert.equal(missing.status, 404);

    const emailLookup = await request(adminToken, `/supplier-accounts/lookup?query=${encodeURIComponent(supplierA.email.toUpperCase())}`);
    const emailLookupBody = await emailLookup.json() as { account?: { uid?: string; userRole?: string; profileStatus?: string } };
    assert.equal(emailLookup.status, 200);
    assert.equal(emailLookupBody.account?.uid, supplierA.uid);
    assert.equal(emailLookupBody.account?.userRole, "customer");
    assert.equal(emailLookupBody.account?.profileStatus, "missing");

    const uidLookup = await request(adminToken, `/supplier-accounts/lookup?query=${encodeURIComponent(supplierA.uid)}`);
    assert.equal(uidLookup.status, 200);
    assert.equal((await uidLookup.json() as { account?: { uid?: string } }).account?.uid, supplierA.uid);

    const promote = await request(adminToken, `/supplier-accounts/${encodeURIComponent(supplierA.uid)}/promote`, "POST");
    const promoteBody = await promote.json() as { changed?: boolean; auditId?: string; account?: { userRole?: string; profileStatus?: string } };
    assert.equal(promote.status, 200);
    assert.equal(promoteBody.changed, true);
    assert.equal(promoteBody.account?.userRole, "supplier");
    assert.equal(promoteBody.account?.profileStatus, "pending");
    assert.equal(typeof promoteBody.auditId, "string");

    const [promotedUser, pendingProfile] = await Promise.all([
      adminDb.collection("users").doc(supplierA.uid).get(),
      adminDb.collection("supplier_profiles").doc(supplierA.uid).get(),
    ]);
    assert.equal(promotedUser.data()?.role, "supplier");
    assert.equal(promotedUser.data()?.email, supplierA.email);
    assert.equal(pendingProfile.exists, true);
    assert.equal(pendingProfile.data()?.supplierId, supplierA.uid);
    assert.equal(pendingProfile.data()?.email, supplierA.email);
    assert.equal(pendingProfile.data()?.profileStatus, "pending");
    assert.ok(pendingProfile.data()?.createdAt);

    const pendingWrite = await request(supplierAToken, "/supplier-portal/requests", "POST", {});
    assert.equal(pendingWrite.status, 403);
    const selfPromotion = await request(supplierAToken, `/supplier-accounts/${encodeURIComponent(supplierA.uid)}/promote`, "POST");
    assert.equal(selfPromotion.status, 403);
    const selfActivation = await request(supplierAToken, `/supplier-accounts/${encodeURIComponent(supplierA.uid)}/activate`, "POST");
    assert.equal(selfActivation.status, 403);

    const promoteRetry = await request(adminToken, `/supplier-accounts/${encodeURIComponent(supplierA.uid)}/promote`, "POST");
    const promoteRetryBody = await promoteRetry.json() as { changed?: boolean; auditId?: unknown };
    assert.equal(promoteRetry.status, 200);
    assert.equal(promoteRetryBody.changed, false);
    assert.equal(promoteRetryBody.auditId, null);

    const activate = await request(adminToken, `/supplier-accounts/${encodeURIComponent(supplierA.uid)}/activate`, "POST");
    const activateBody = await activate.json() as { changed?: boolean; account?: { profileStatus?: string } };
    assert.equal(activate.status, 200);
    assert.equal(activateBody.changed, true);
    assert.equal(activateBody.account?.profileStatus, "active");
    assert.equal((await adminDb.collection("supplier_profiles").doc(supplierA.uid).get()).data()?.profileStatus, "active");

    const activateRetry = await request(adminToken, `/supplier-accounts/${encodeURIComponent(supplierA.uid)}/activate`, "POST");
    assert.equal(activateRetry.status, 200);
    assert.equal((await activateRetry.json() as { changed?: boolean }).changed, false);

    const activePortal = await request(supplierAToken, "/supplier-portal");
    const activePortalBody = await activePortal.json() as { profile?: { supplierId?: string; profileStatus?: string } };
    assert.equal(activePortal.status, 200);
    assert.equal(activePortalBody.profile?.supplierId, supplierA.uid);
    assert.equal(activePortalBody.profile?.profileStatus, "active");

    for (const action of ["promote", "activate"] as const) {
      const response = await request(adminToken, `/supplier-accounts/${encodeURIComponent(supplierB.uid)}/${action}`, "POST");
      assert.equal(response.status, 200, await response.text());
    }
    await adminDb.collection("supplier_product_requests").doc(`${prefix}-private-request`).set({
      supplierId: supplierA.uid,
      requestType: "new_product",
      productId: `${prefix}-product`,
      productName: "Supplier A private draft",
      supplierSku: `${prefix}-sku`,
      status: "draft",
      productPayload: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const supplierBToken = await supplierB.auth.currentUser!.getIdToken();
    const supplierBPortal = await request(supplierBToken, "/supplier-portal");
    const supplierBPortalBody = await supplierBPortal.json() as { requests?: Array<{ id?: string; supplierId?: string }> };
    assert.equal(supplierBPortal.status, 200);
    assert.equal(supplierBPortalBody.requests?.some((item) => item.id === `${prefix}-private-request`), false);
    const supplierBCrossLookup = await request(supplierBToken, `/supplier-accounts/lookup?query=${encodeURIComponent(supplierA.uid)}`);
    assert.equal(supplierBCrossLookup.status, 403);

    const protectedPromotion = await request(adminToken, `/supplier-accounts/${encodeURIComponent(protectedAdmin.uid)}/promote`, "POST");
    assert.equal(protectedPromotion.status, 409);
    assert.equal((await adminDb.collection("users").doc(protectedAdmin.uid).get()).data()?.role, "customer");
    assert.equal((await adminDb.collection("supplier_profiles").doc(protectedAdmin.uid).get()).exists, false);

    const disable = await request(adminToken, `/supplier-accounts/${encodeURIComponent(supplierA.uid)}/disable`, "POST");
    const disableBody = await disable.json() as { changed?: boolean; account?: { profileStatus?: string } };
    assert.equal(disable.status, 200);
    assert.equal(disableBody.changed, true);
    assert.equal(disableBody.account?.profileStatus, "disabled");
    assert.equal((await adminDb.collection("supplier_profiles").doc(supplierA.uid).get()).data()?.profileStatus, "disabled");

    const disabledProfileWrite = await request(supplierAToken, "/supplier-portal/profile", "PUT", {
      companyName: "Disabled Supplier",
      contactPerson: "Supplier Contact",
      phone: "0771234567",
      address: "1 Supplier Road",
      businessRegistrationNumber: "",
      bankDetails: {},
    });
    assert.equal(disabledProfileWrite.status, 403);

    const disableRetry = await request(adminToken, `/supplier-accounts/${encodeURIComponent(supplierA.uid)}/disable`, "POST");
    assert.equal(disableRetry.status, 200);
    assert.equal((await disableRetry.json() as { changed?: boolean }).changed, false);

    const audits = await adminDb.collection("supplier_operations_audit").where("targetSupplierId", "==", supplierA.uid).get();
    assert.deepEqual(audits.docs.map((document) => document.data().action).sort(), [
      "supplier_activated",
      "supplier_disabled",
      "supplier_promoted",
    ]);
    for (const audit of audits.docs) {
      assert.equal(audit.data().adminUserId, operator.uid);
      assert.equal(audit.data().adminEmail, operator.email);
      assert.equal(audit.data().targetSupplierId, supplierA.uid);
    }
  } finally {
    await Promise.all(apps.map(async (app) => {
      await signOut(getAuth(app)).catch(() => undefined);
      await deleteApp(app).catch(() => undefined);
    }));
  }
});
