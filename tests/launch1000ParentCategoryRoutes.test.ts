import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import Module, { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";

const functionsSourceRoot = path.resolve("functions/src") + path.sep;
const typescript = createRequire(path.resolve("functions/package.json"))("typescript") as typeof import("typescript");
const moduleExtensions = (Module as unknown as { _extensions: Record<string, (module: { _compile(code: string, filename: string): void }, filename: string) => void> })._extensions;
const tsxTypeScriptLoader = moduleExtensions[".ts"];
moduleExtensions[".ts"] = function loadFunctionsSource(module, filename) {
  if (!filename.startsWith(functionsSourceRoot)) return tsxTypeScriptLoader.call(this, module, filename);
  const { outputText } = typescript.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  });
  module._compile(outputText, filename);
};

const functionsRequire = createRequire(path.resolve("functions/package.json"));
const { createApiApp } = functionsRequire("./src/api/app.ts") as typeof import("../functions/src/api/app");
const { adminAppCheck, adminAuth, adminDb } = functionsRequire("./src/api/firebase.ts") as typeof import("../functions/src/api/firebase");
const { launch1000RecordFingerprint } = functionsRequire("./src/api/launch1000/launch1000Snapshot.ts") as typeof import("../functions/src/api/launch1000/launch1000Snapshot");
const { launch1000MissingParentProposalId } = functionsRequire("./src/api/launch1000/launch1000Governance.ts") as typeof import("../functions/src/api/launch1000/launch1000Governance");

const firestoreHost = String(process.env.FIRESTORE_EMULATOR_HOST || "").trim();
const projectId = String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "").trim();
const canRunEmulator = /^(127\.0\.0\.1|localhost):\d+$/u.test(firestoreHost) && projectId.startsWith("demo-");

const originalVerifyToken = adminAppCheck.verifyToken;
const originalVerifyIdToken = adminAuth.verifyIdToken;
const authCalls: Array<{ token: string; checkRevoked?: boolean }> = [];
let server: http.Server | null = null;

const fakeVerifyAppCheck = async (token: string) => {
  if (token === "invalid-app-check") throw new Error("invalid App Check token");
  return { appId: "demo-web-app", token: {} };
};

const fakeVerifyIdToken = async (token: string, checkRevoked?: boolean) => {
  authCalls.push({ token, checkRevoked });
  if (token === "revoked-token") throw new Error("revoked token");
  if (token === "admin-token") return { uid: "route-admin", email: "route-admin@example.invalid", supplierHubAdmin: true };
  if (token === "ordinary-token") return { uid: "ordinary-user", email: "ordinary@example.invalid" };
  throw new Error("token rejected");
};

const send = (method: string, requestPath: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: string }> => {
  if (!server) throw new Error("route test server is not running");
  const { port } = server.address() as AddressInfo;
  const payload = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: requestPath,
      headers: {
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode || 0, body: text }));
    });
    request.on("error", reject);
    request.end(payload);
  });
};

before(async () => {
  if (!canRunEmulator) return;
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.REQUIRE_APP_CHECK;
  (adminAppCheck as unknown as { verifyToken: typeof fakeVerifyAppCheck }).verifyToken = fakeVerifyAppCheck;
  (adminAuth as unknown as { verifyIdToken: typeof fakeVerifyIdToken }).verifyIdToken = fakeVerifyIdToken;
  server = createApiApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
});

after(async () => {
  (adminAppCheck as unknown as { verifyToken: typeof originalVerifyToken }).verifyToken = originalVerifyToken;
  (adminAuth as unknown as { verifyIdToken: typeof originalVerifyIdToken }).verifyIdToken = originalVerifyIdToken;
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test("missing-parent routes reject missing, non-admin, revoked, and invalid App Check requests", {
  skip: !canRunEmulator,
}, async () => {
  const suffix = randomUUID().slice(0, 8);
  const productId = `route-parent-${suffix}`;
  const proposedName = `3D Printer Filament ${suffix}`;
  const proposedSlug = `3d-printer-filament-${suffix}`;
  const updatedAt = "2026-10-10T00:00:00.000Z";
  const queueRecord = {
    id: productId,
    status: "Pending",
    queueState: "review_pending",
    updatedAt,
    supplierOfferPendingRevision: `supplier-offer-${suffix}`,
    supplierSnapshot: {
      sourceId: `source-${suffix}`,
      supplierProductId: `supplier-product-${suffix}`,
      supplierOfferId: `supplier-offer-${suffix}`,
      productPayload: {
        name: `Industrial ${proposedName}`,
        description: `Thermoplastic spool for ${proposedName}.`,
      },
    },
  };
  await adminDb.collection("supplier_review_queue").doc(productId).set(queueRecord);
  const expectedFingerprint = launch1000RecordFingerprint(queueRecord);
  const proposalBody = {
    queueItemId: productId,
    expectedPendingRevision: queueRecord.supplierOfferPendingRevision,
    expectedUpdatedAt: updatedAt,
    expectedFingerprint,
    proposedName,
    proposedSlug,
    proposedSubcategoryName: "",
    proposedSubcategorySlug: "",
    evidenceRefs: ["supplierSnapshot.productPayload.name", "supplierSnapshot.productPayload.description"],
    adminConfirmed: true,
  };
  const route = "/api/launch1000/taxonomy/parent/approve";
  const noAppCheck = await send("POST", route, {}, proposalBody);
  assert.equal(noAppCheck.status, 401);
  const noAuth = await send("POST", route, { "X-Firebase-AppCheck": "valid-app-check" }, proposalBody);
  assert.equal(noAuth.status, 401);
  const noAuthCreate = await send("POST", "/api/launch1000/taxonomy/parent/create", { "X-Firebase-AppCheck": "valid-app-check" }, {
    proposalId: "unauthorized-proposal",
    proposalRevision: "parent-category-r1",
  });
  assert.equal(noAuthCreate.status, 401);
  const ordinary = await send("POST", route, {
    "X-Firebase-AppCheck": "valid-app-check",
    Authorization: "Bearer ordinary-token",
  }, proposalBody);
  assert.equal(ordinary.status, 403);
  const revoked = await send("POST", route, {
    "X-Firebase-AppCheck": "valid-app-check",
    Authorization: "Bearer revoked-token",
  }, proposalBody);
  assert.equal(revoked.status, 401);
  const invalidAppCheck = await send("POST", route, {
    "X-Firebase-AppCheck": "invalid-app-check",
    Authorization: "Bearer admin-token",
  }, proposalBody);
  assert.equal(invalidAppCheck.status, 401);
  assert.equal(authCalls.some((call) => call.token === "admin-token" && call.checkRevoked === true), false);
  const proposalId = launch1000MissingParentProposalId(productId, expectedFingerprint);
  assert.equal((await adminDb.collection("launch1000_taxonomy_governance").doc(proposalId).get()).exists, false);
  assert.equal((await adminDb.collection("launch1000_taxonomy_audit").get()).docs.some((document) => document.data().queueItemId === productId), false);
});

test("authorized Supplier Hub Admin reaches both missing-parent routes through App Check and Auth", {
  skip: !canRunEmulator,
}, async () => {
  const suffix = randomUUID().slice(0, 8);
  const productId = `route-parent-authorized-${suffix}`;
  const proposedName = `3D Printer Filament ${suffix}`;
  const proposedSlug = `3d-printer-filament-${suffix}`;
  const updatedAt = "2026-10-10T00:00:00.000Z";
  const queueRecord = {
    id: productId,
    status: "Pending",
    queueState: "review_pending",
    updatedAt,
    supplierOfferPendingRevision: `supplier-offer-${suffix}`,
    supplierSnapshot: {
      sourceId: `source-${suffix}`,
      supplierProductId: `supplier-product-${suffix}`,
      supplierOfferId: `supplier-offer-${suffix}`,
      productPayload: {
        name: `Industrial ${proposedName}`,
        description: `Thermoplastic spool for ${proposedName}.`,
      },
    },
  };
  await adminDb.collection("supplier_review_queue").doc(productId).set(queueRecord);
  const expectedFingerprint = launch1000RecordFingerprint(queueRecord);
  const proposalBody = {
    queueItemId: productId,
    expectedPendingRevision: queueRecord.supplierOfferPendingRevision,
    expectedUpdatedAt: updatedAt,
    expectedFingerprint,
    proposedName,
    proposedSlug,
    proposedSubcategoryName: "",
    proposedSubcategorySlug: "",
    evidenceRefs: ["supplierSnapshot.productPayload.name", "supplierSnapshot.productPayload.description"],
    adminConfirmed: true,
  };
  const authHeaders = { "X-Firebase-AppCheck": "valid-app-check", Authorization: "Bearer admin-token" };
  const approval = await send("POST", "/api/launch1000/taxonomy/parent/approve", authHeaders, proposalBody);
  assert.equal(approval.status, 200);
  const approvalPayload = JSON.parse(approval.body) as { success?: boolean; result?: { proposalId?: string; proposalRevision?: string } };
  assert.equal(approvalPayload.success, true);
  assert.ok(approvalPayload.result?.proposalId);
  assert.ok(approvalPayload.result?.proposalRevision);
  const creation = await send("POST", "/api/launch1000/taxonomy/parent/create", authHeaders, {
    proposalId: approvalPayload.result?.proposalId,
    proposalRevision: approvalPayload.result?.proposalRevision,
  });
  assert.equal(creation.status, 200);
  const creationPayload = JSON.parse(creation.body) as { success?: boolean; result?: { createdCategoryId?: string } };
  assert.equal(creationPayload.success, true);
  assert.equal(creationPayload.result?.createdCategoryId, proposedSlug);
  assert.equal(authCalls.filter((call) => call.token === "admin-token").every((call) => call.checkRevoked === true), true);
});
