import { Auth, UserRecord } from "firebase-admin/auth";
import { FieldValue, Firestore } from "firebase-admin/firestore";
import { ApiError } from "../errors";
import { SupplierHubAdminIdentity } from "../middleware/supplierHubAdminAuth";

export type SupplierProfileStatus = "pending" | "active" | "disabled";

export interface SupplierAccountView {
  uid: string;
  email: string;
  displayName: string;
  authDisabled: boolean;
  userRole: string;
  profileStatus: SupplierProfileStatus | "missing";
  companyName: string;
  protectedAccount: boolean;
}

export interface SupplierAccountTransitionResult {
  account: SupplierAccountView;
  changed: boolean;
  auditId: string | null;
}

const VALID_PROFILE_STATUSES = new Set<SupplierProfileStatus>(["pending", "active", "disabled"]);
const PROTECTED_AUTH_ROLES = new Set(["admin", "owner", "super_admin", "super-admin"]);

const cleanEmail = (value: unknown): string => typeof value === "string" ? value.trim().toLowerCase().slice(0, 320) : "";
const cleanText = (value: unknown, maximum: number): string => typeof value === "string" ? value.trim().slice(0, maximum) : "";

export function normalizeSupplierProfileStatus(value: unknown): SupplierProfileStatus | null {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_PROFILE_STATUSES.has(status as SupplierProfileStatus) ? status as SupplierProfileStatus : null;
}

export function supplierPromotionProfileStatus(value: unknown): SupplierProfileStatus {
  return normalizeSupplierProfileStatus(value) || "pending";
}

export function isProtectedSupplierAccount(user: Pick<UserRecord, "customClaims">, firestoreRole?: unknown): boolean {
  const claims = user.customClaims || {};
  const claimRole = cleanText(claims.role, 40).toLowerCase();
  const storedRole = cleanText(firestoreRole, 40).toLowerCase();
  return claims.admin === true
    || claims.supplierHubAdmin === true
    || claims.superAdmin === true
    || claims.supplierHubSuperAdmin === true
    || PROTECTED_AUTH_ROLES.has(claimRole)
    || PROTECTED_AUTH_ROLES.has(storedRole);
}

const readLookup = (value: unknown): { kind: "email" | "uid"; value: string } => {
  if (typeof value !== "string") throw new ApiError("Enter a Firebase Auth email or UID.", 400);
  const query = value.trim();
  if (!query || query.length > 320 || query.includes("/")) {
    throw new ApiError("Enter a valid Firebase Auth email or UID.", 400);
  }
  if (query.includes("@")) {
    const email = query.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new ApiError("Enter a valid Firebase Auth email.", 400);
    return { kind: "email", value: email };
  }
  if (query.length > 128) throw new ApiError("Enter a valid Firebase Auth UID.", 400);
  return { kind: "uid", value: query };
};

const authUserNotFound = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  return code === "auth/user-not-found" || code === "auth/invalid-uid";
};

async function getRequiredAuthUser(auth: Auth, uid: string): Promise<UserRecord> {
  try {
    return await auth.getUser(uid);
  } catch (error) {
    if (authUserNotFound(error)) throw new ApiError("Firebase Auth user was not found.", 404);
    throw error;
  }
}

async function findRequiredAuthUser(auth: Auth, query: unknown): Promise<UserRecord> {
  const lookup = readLookup(query);
  try {
    return lookup.kind === "email"
      ? await auth.getUserByEmail(lookup.value)
      : await auth.getUser(lookup.value);
  } catch (error) {
    if (authUserNotFound(error)) throw new ApiError("Firebase Auth user was not found.", 404);
    throw error;
  }
}

function projectSupplierAccount(
  user: UserRecord,
  userData: Record<string, unknown>,
  profileData: Record<string, unknown> | null,
): SupplierAccountView {
  return {
    uid: user.uid,
    email: cleanEmail(user.email || userData.email),
    displayName: cleanText(user.displayName || userData.displayName, 120),
    authDisabled: user.disabled === true,
    userRole: cleanText(userData.role, 40) || "missing",
    profileStatus: profileData ? supplierPromotionProfileStatus(profileData.profileStatus) : "missing",
    companyName: cleanText(profileData?.companyName, 160),
    protectedAccount: isProtectedSupplierAccount(user, userData.role),
  };
}

async function loadSupplierAccountView(db: Firestore, user: UserRecord): Promise<SupplierAccountView> {
  const [userSnapshot, profileSnapshot] = await Promise.all([
    db.collection("users").doc(user.uid).get(),
    db.collection("supplier_profiles").doc(user.uid).get(),
  ]);
  return projectSupplierAccount(
    user,
    userSnapshot.data() || {},
    profileSnapshot.exists ? profileSnapshot.data() || {} : null,
  );
}

export async function findSupplierAccount(auth: Auth, db: Firestore, query: unknown): Promise<SupplierAccountView> {
  const user = await findRequiredAuthUser(auth, query);
  return loadSupplierAccountView(db, user);
}

function assertMutableSupplierTarget(user: UserRecord, firestoreRole?: unknown): void {
  if (isProtectedSupplierAccount(user, firestoreRole)) {
    throw new ApiError("Administrator accounts cannot be converted to suppliers.", 409);
  }
}

function auditPayload(input: {
  auditId: string;
  action: "supplier_promoted" | "supplier_activated" | "supplier_disabled";
  actor: SupplierHubAdminIdentity;
  user: UserRecord;
  previousRole: string;
  newRole: string;
  previousProfileStatus: string;
  newProfileStatus: SupplierProfileStatus;
}): Record<string, unknown> {
  return {
    id: input.auditId,
    eventId: input.auditId,
    module: "supplier_account",
    action: input.action,
    supplierId: input.user.uid,
    targetSupplierId: input.user.uid,
    targetEmail: cleanEmail(input.user.email),
    adminUserId: input.actor.uid,
    adminEmail: input.actor.email,
    timestamp: FieldValue.serverTimestamp(),
    previousRole: input.previousRole || null,
    newRole: input.newRole,
    previousProfileStatus: input.previousProfileStatus || "missing",
    newProfileStatus: input.newProfileStatus,
  };
}

export async function promoteSupplierAccount(
  auth: Auth,
  db: Firestore,
  uid: string,
  actor: SupplierHubAdminIdentity,
): Promise<SupplierAccountTransitionResult> {
  const user = await getRequiredAuthUser(auth, uid);
  assertMutableSupplierTarget(user);
  if (user.disabled) throw new ApiError("The Firebase Auth user is disabled and cannot be promoted.", 409);

  const userReference = db.collection("users").doc(user.uid);
  const profileReference = db.collection("supplier_profiles").doc(user.uid);
  const auditReference = db.collection("supplier_operations_audit").doc();
  let changed = false;
  let auditId: string | null = null;

  await db.runTransaction(async (transaction) => {
    // Firestore may rerun this callback after a concurrent write. Reset result
    // metadata so an earlier aborted attempt cannot be reported as committed.
    changed = false;
    auditId = null;
    const [userSnapshot, profileSnapshot] = await Promise.all([
      transaction.get(userReference),
      transaction.get(profileReference),
    ]);
    const userData = userSnapshot.data() || {};
    const profileData = profileSnapshot.data() || {};
    assertMutableSupplierTarget(user, userData.role);
    const previousRole = cleanText(userData.role, 40);
    if (previousRole && previousRole !== "customer" && previousRole !== "supplier") {
      throw new ApiError("Only customer accounts can be promoted to supplier.", 409);
    }
    const previousProfileStatus = profileSnapshot.exists ? cleanText(profileData.profileStatus, 40).toLowerCase() : "missing";
    const profileStatus = supplierPromotionProfileStatus(profileData.profileStatus);
    const roleChanged = previousRole !== "supplier";
    const profileChanged = !profileSnapshot.exists
      || profileData.supplierId !== user.uid
      || cleanEmail(profileData.email) !== cleanEmail(user.email)
      || normalizeSupplierProfileStatus(profileData.profileStatus) === null;
    changed = roleChanged || profileChanged;
    if (!changed) return;

    transaction.set(userReference, {
      uid: user.uid,
      email: cleanEmail(user.email || userData.email),
      role: "supplier",
      updatedAt: FieldValue.serverTimestamp(),
      supplierPromotedAt: roleChanged ? FieldValue.serverTimestamp() : userData.supplierPromotedAt || FieldValue.serverTimestamp(),
      supplierPromotedBy: roleChanged ? actor.uid : userData.supplierPromotedBy || actor.uid,
    }, { merge: true });
    transaction.set(profileReference, {
      supplierId: user.uid,
      email: cleanEmail(user.email || profileData.email),
      profileStatus,
      createdAt: profileSnapshot.exists ? profileData.createdAt || FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.create(auditReference, auditPayload({
      auditId: auditReference.id,
      action: "supplier_promoted",
      actor,
      user,
      previousRole,
      newRole: "supplier",
      previousProfileStatus,
      newProfileStatus: profileStatus,
    }));
    auditId = auditReference.id;
  });

  return { account: await loadSupplierAccountView(db, user), changed, auditId };
}

export async function setSupplierAccountStatus(
  auth: Auth,
  db: Firestore,
  uid: string,
  status: "active" | "disabled",
  actor: SupplierHubAdminIdentity,
): Promise<SupplierAccountTransitionResult> {
  const user = await getRequiredAuthUser(auth, uid);
  assertMutableSupplierTarget(user);
  const userReference = db.collection("users").doc(user.uid);
  const profileReference = db.collection("supplier_profiles").doc(user.uid);
  const auditReference = db.collection("supplier_operations_audit").doc();
  let changed = false;
  let auditId: string | null = null;

  await db.runTransaction(async (transaction) => {
    changed = false;
    auditId = null;
    const [userSnapshot, profileSnapshot] = await Promise.all([
      transaction.get(userReference),
      transaction.get(profileReference),
    ]);
    const userData = userSnapshot.data() || {};
    const profileData = profileSnapshot.data() || {};
    assertMutableSupplierTarget(user, userData.role);
    if (!userSnapshot.exists || userData.role !== "supplier") {
      throw new ApiError("Promote the customer account to supplier before changing profile status.", 409);
    }
    if (!profileSnapshot.exists) throw new ApiError("Supplier profile was not found. Promote the account first.", 409);
    const previousProfileStatus = cleanText(profileData.profileStatus, 40).toLowerCase() || "pending";
    if (normalizeSupplierProfileStatus(profileData.profileStatus) === status) return;

    changed = true;
    transaction.set(profileReference, {
      supplierId: user.uid,
      email: cleanEmail(user.email || profileData.email),
      profileStatus: status,
      updatedAt: FieldValue.serverTimestamp(),
      statusUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedBy: actor.uid,
    }, { merge: true });
    transaction.create(auditReference, auditPayload({
      auditId: auditReference.id,
      action: status === "active" ? "supplier_activated" : "supplier_disabled",
      actor,
      user,
      previousRole: "supplier",
      newRole: "supplier",
      previousProfileStatus,
      newProfileStatus: status,
    }));
    auditId = auditReference.id;
  });

  return { account: await loadSupplierAccountView(db, user), changed, auditId };
}
