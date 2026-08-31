import { Firestore } from "firebase-admin/firestore";
import { normalizeSupplierProfileStatus } from "./supplierAccountAdministration";
import { SUPPLIER_PORTAL_SOURCE_ID } from "./supplierPortalLogic";

export type SupplierAccountSyncGuardStatus =
  | "active"
  | "unassigned"
  | "missing"
  | "pending"
  | "disabled"
  | "malformed";

export interface SupplierAccountSyncGuardResult {
  allowed: boolean;
  status: SupplierAccountSyncGuardStatus;
  message: string;
}

export function evaluateSupplierAccountForExternalSync(
  supplierAccountId: unknown,
  profileExists: boolean,
  profileStatus: unknown,
): SupplierAccountSyncGuardResult {
  const accountId = String(supplierAccountId || "").trim();
  if (!accountId) {
    return {
      allowed: false,
      status: "unassigned",
      message: "Select an active Supplier Portal account before synchronizing this external source.",
    };
  }
  if (!profileExists) {
    return {
      allowed: false,
      status: "missing",
      message: `Supplier Portal account ${accountId} was not found.`,
    };
  }
  const normalizedStatus = normalizeSupplierProfileStatus(profileStatus);
  if (!normalizedStatus) {
    return {
      allowed: false,
      status: "malformed",
      message: `Supplier Portal account ${accountId} has an invalid profile status.`,
    };
  }
  if (normalizedStatus === "pending") {
    return {
      allowed: false,
      status: "pending",
      message: `Supplier Portal account ${accountId} is pending approval and cannot synchronize external catalogues.`,
    };
  }
  if (normalizedStatus === "disabled") {
    return {
      allowed: false,
      status: "disabled",
      message: `Supplier Portal account ${accountId} is disabled and cannot synchronize external catalogues.`,
    };
  }
  return {
    allowed: true,
    status: "active",
    message: "",
  };
}

export async function resolveSupplierAccountSyncGuard(
  db: Firestore,
  supplierAccountId: unknown,
): Promise<SupplierAccountSyncGuardResult> {
  const accountId = String(supplierAccountId || "").trim();
  if (!accountId) {
    return evaluateSupplierAccountForExternalSync(accountId, false, null);
  }
  const snapshot = await db.collection("supplier_profiles").doc(accountId).get();
  return evaluateSupplierAccountForExternalSync(accountId, snapshot.exists, snapshot.data()?.profileStatus);
}

export function shouldValidateExternalSourceSupplierAccount(sourceId: string): boolean {
  return String(sourceId || "").trim() !== SUPPLIER_PORTAL_SOURCE_ID;
}
