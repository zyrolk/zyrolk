import { existsSync, readFileSync } from "node:fs";

const readText = (path: string): string => {
  if (!existsSync(path)) throw new Error(`Required production file is missing: ${path}`);
  return readFileSync(path, "utf8");
};

const readJson = <T>(path: string): T => JSON.parse(readText(path)) as T;

const requireCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

interface FirebaseConfig {
  firestore?: { rules?: string; indexes?: string };
  functions?: Array<{ source?: string; predeploy?: string[] }>;
  hosting?: {
    public?: string;
    rewrites?: Array<{ source?: string; function?: string; destination?: string }>;
  };
  storage?: { rules?: string };
  emulators?: Record<string, { host?: string; port?: number } | boolean>;
}

const firebase = readJson<FirebaseConfig>("firebase.json");
const projects = readJson<{ projects?: { default?: string } }>(".firebaserc");
requireCondition(projects.projects?.default === "zyrolk-e0164", ".firebaserc must target the reviewed Zyro.lk project.");
requireCondition(firebase.firestore?.rules === "firestore.rules", "firebase.json must deploy the reviewed Firestore Rules.");
requireCondition(firebase.firestore?.indexes === "firestore.indexes.json", "firebase.json must deploy the reviewed Firestore indexes.");
requireCondition(firebase.storage?.rules === "storage.rules", "firebase.json must deploy the reviewed Storage Rules.");
requireCondition(firebase.functions?.some((entry) => entry.source === "functions"
  && entry.predeploy?.some((command) => command.includes("run build"))), "Functions must build before deployment.");
requireCondition(firebase.hosting?.public === "dist", "Hosting must publish the production build from dist.");

const rewrites = firebase.hosting?.rewrites || [];
requireCondition(rewrites.some((entry) => entry.source === "/sitemap.xml" && entry.function === "api"), "The sitemap must use the API Function.");
requireCondition(rewrites.some((entry) => entry.source === "/api/**" && entry.function === "api"), "Hosting must route /api/** to the API Function.");
requireCondition(rewrites.at(-1)?.source === "**" && rewrites.at(-1)?.destination === "/index.html", "The SPA fallback must remain the last Hosting rewrite.");

for (const emulator of ["auth", "functions", "firestore", "storage"]) {
  const configuration = firebase.emulators?.[emulator];
  requireCondition(typeof configuration === "object"
    && configuration.host === "127.0.0.1"
    && Number.isInteger(configuration.port), `${emulator} emulator must use a fixed loopback port.`);
}

const environmentExample = readText(".env.example");
for (const variable of [
  "API_ALLOWED_ORIGINS",
  "ALLOWED_SUPPLIER_DOMAINS",
  "A2Z_USERNAME",
  "A2Z_PASSWORD",
  "REQUIRE_APP_CHECK",
  "VITE_FIREBASE_APP_CHECK_SITE_KEY",
  "PUBLIC_SITE_URL",
  "SUPPLIER_SYNC_SCHEDULE",
  "SUPPLIER_SYNC_JOB_DISPATCH_SCHEDULE",
  "SUPPLIER_QUEUE_WORKER_SCHEDULE",
  "SUPPLIER_OPERATIONAL_ALERT_MONITOR_SCHEDULE",
]) {
  requireCondition(new RegExp(`^${variable}=`, "mu").test(environmentExample), `.env.example must document ${variable}.`);
}

const secretDefinitions = readText("functions/src/config/secrets.ts");
requireCondition(secretDefinitions.includes('defineSecret("A2Z_USERNAME")'), "The A2Z username must remain a Function secret.");
requireCondition(secretDefinitions.includes('defineSecret("A2Z_PASSWORD")'), "The A2Z password must remain a Function secret.");

const functionsIndex = readText("functions/src/index.ts");
for (const exportedFunction of [
  "scheduledSupplierSync",
  "scheduledSupplierSyncJobDispatcher",
  "supplierSyncJobCreated",
  "scheduledSupplierQueueWorker",
  "scheduledSupplierOperationalAlerts",
  "expirePaymentReservations",
  "sendOrderNotifications",
  "trackOrderNotificationDelivery",
  "retryOrderNotifications",
]) {
  requireCondition(functionsIndex.includes(exportedFunction), `Functions export is missing: ${exportedFunction}.`);
}

interface FirestoreIndexEntry {
  collectionGroup?: string;
  queryScope?: string;
  fields?: Array<{ fieldPath?: string; order?: string; arrayConfig?: string }>;
}

const indexes = readJson<{ indexes?: FirestoreIndexEntry[] }>("firestore.indexes.json");
const indexedCollections = new Set((indexes.indexes || []).map((entry) => entry.collectionGroup));
for (const collection of ["orders", "products", "reviews", "supplier_review_queue", "supplier_approval_audit", "supplier_sync_jobs"]) {
  requireCondition(indexedCollections.has(collection), `Required Firestore index group is missing: ${collection}.`);
}

const hasCompositeIndex = (
  collectionGroup: string,
  fields: Array<{ fieldPath: string; order: "ASCENDING" | "DESCENDING" }>,
): boolean => (indexes.indexes || []).some((entry) => (
  entry.collectionGroup === collectionGroup
  && entry.queryScope === "COLLECTION"
  && entry.fields?.length === fields.length
  && entry.fields.every((field, index) => (
    field.fieldPath === fields[index].fieldPath && field.order === fields[index].order
  ))
));

for (const requiredIndex of [
  {
    collectionGroup: "products",
    fields: [
      { fieldPath: "isActive", order: "ASCENDING" as const },
      { fieldPath: "discount", order: "ASCENDING" as const },
    ],
  },
  {
    collectionGroup: "supplier_review_queue",
    fields: [
      { fieldPath: "batchId", order: "ASCENDING" as const },
      { fieldPath: "createdAt", order: "ASCENDING" as const },
    ],
  },
]) {
  requireCondition(
    hasCompositeIndex(requiredIndex.collectionGroup, requiredIndex.fields),
    `Required Firestore composite index is missing: ${requiredIndex.collectionGroup}(${requiredIndex.fields.map((field) => `${field.fieldPath} ${field.order}`).join(", ")}).`,
  );
}

for (const path of [
  "monitoring/supplier-hub/supplier_sync_success.yaml",
  "monitoring/supplier-hub/supplier_sync_failure.yaml",
  "monitoring/supplier-hub/supplier_queue_depth.yaml",
  "monitoring/supplier-hub/supplier_queue_processing_duration_ms.yaml",
  "monitoring/supplier-hub/supplier_investigation_requests.yaml",
  "monitoring/supplier-hub/supplier_manual_sync_requests.yaml",
  "monitoring/supplier-hub/alert-policies/sync-failure.json",
  "monitoring/supplier-hub/alert-policies/queue-backlog.json",
  "monitoring/supplier-hub/alert-policies/queue-latency.json",
]) readText(path);

const runbook = readText("docs/PRODUCTION_OPERATIONS_RUNBOOK.md");
for (const requiredSection of [
  "Release and change freeze",
  "Admin custom claims",
  "A2Z credential profiles",
  "Security migration gate",
  "Production Console gates",
  "Production smoke-test checklist",
]) {
  requireCondition(runbook.includes(requiredSection), `Production runbook section is missing: ${requiredSection}.`);
}

console.info(JSON.stringify({
  status: "repository-production-configuration-valid",
  projectId: projects.projects?.default,
  externalOperatorGates: [
    "production Firebase project and IAM",
    "Auth providers and authorized domains",
    "App Check registration and enforcement",
    "Secret Manager values and A2Z host-bound profiles",
    "Firestore index READY state",
    "Trigger Email sender and delivery",
    "Cloud Monitoring notification channels",
    "Firestore backup and Storage retention/versioning",
    "deployed Function and scheduler health",
    "credentialed production smoke tests",
  ],
}));
