import { adminDb } from "../functions/src/api/firebase";
import { getApp } from "firebase-admin/app";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapSupplierLocalDemandForOrder } from "../functions/src/api/orders/supplierInventoryReconciliation";

export const BOOTSTRAP_PRODUCTION_PROJECT = "zyrolk-e0164";

export interface SupplierLocalDemandBootstrapSafetyInput {
  initializedProjectId: unknown;
  requestedProjectId?: unknown;
  firestoreEmulatorHost?: unknown;
  apply: boolean;
  productionConfirmation?: unknown;
}

export const assertSupplierLocalDemandBootstrapSafety = (
  input: SupplierLocalDemandBootstrapSafetyInput,
): void => {
  const initializedProjectId = typeof input.initializedProjectId === "string" ? input.initializedProjectId.trim() : "";
  const requestedProjectId = typeof input.requestedProjectId === "string" ? input.requestedProjectId.trim() : "";
  const emulatorHost = typeof input.firestoreEmulatorHost === "string" ? input.firestoreEmulatorHost.trim() : "";
  const productionConfirmation = typeof input.productionConfirmation === "string"
    ? input.productionConfirmation.trim()
    : "";

  if (!initializedProjectId) throw new Error("Firebase project ID could not be determined; bootstrap stopped.");
  if (!requestedProjectId) throw new Error("An explicit --project=<project-id> is required; bootstrap stopped.");
  if (requestedProjectId !== initializedProjectId) {
    throw new Error("Requested Firebase project does not match the initialized Admin SDK project; bootstrap stopped.");
  }

  const emulatorActive = Boolean(emulatorHost);
  const isDemoProject = initializedProjectId.startsWith("demo-");
  const isProductionProject = initializedProjectId === BOOTSTRAP_PRODUCTION_PROJECT;
  if (!isDemoProject && !isProductionProject) {
    throw new Error("Bootstrap is restricted to an emulator demo-* project or the reviewed production project.");
  }
  if (isDemoProject && !emulatorActive) {
    throw new Error("A demo-* project requires FIRESTORE_EMULATOR_HOST; bootstrap stopped.");
  }
  if (isProductionProject && emulatorActive) {
    throw new Error("The production project cannot run with FIRESTORE_EMULATOR_HOST; bootstrap stopped.");
  }
  if (input.apply && isProductionProject && productionConfirmation !== BOOTSTRAP_PRODUCTION_PROJECT) {
    throw new Error("Production apply requires --confirm-production=zyrolk-e0164; bootstrap stopped.");
  }
};

const args = process.argv.slice(2);
const dryRun = !args.includes("--apply");
const argumentValue = (name: string): string | undefined => {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const requestedProjectId = argumentValue("--project");
const productionConfirmation = argumentValue("--confirm-production");
const explicitOrderIds = args.flatMap((argument, index) => (
  argument === "--order-id" && typeof args[index + 1] === "string" ? [args[index + 1]] : []
));

const activeStatuses = new Set(["confirmed", "processing", "packed", "shipped"]);

const orderIds = async (): Promise<string[]> => {
  if (explicitOrderIds.length > 0) return [...new Set(explicitOrderIds)];
  const snapshot = await adminDb.collection("orders")
    .where("stockReservationStatus", "==", "committed")
    .limit(50)
    .get();
  return snapshot.docs
    .filter((document) => activeStatuses.has(String(document.data().status || "").toLowerCase()))
    .map((document) => document.id);
};

const main = async (): Promise<void> => {
  assertSupplierLocalDemandBootstrapSafety({
    initializedProjectId: getApp().options.projectId,
    requestedProjectId,
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    apply: !dryRun,
    productionConfirmation,
  });
  const ids = await orderIds();
  const results = [];
  for (const orderId of ids) {
    results.push(await bootstrapSupplierLocalDemandForOrder(adminDb, orderId, { dryRun }));
  }
  console.log(JSON.stringify({ dryRun, orderCount: ids.length, results }, null, 2));
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
