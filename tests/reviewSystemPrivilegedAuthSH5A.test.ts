import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { DecodedIdToken } from "firebase-admin/auth";

// functions/ is a CommonJS package in the Node 20 production runtime. Load the
// error class and route from one cache so instanceof assertions remain stable.
const requireFunctions = createRequire(import.meta.url);
const { ReviewSystemError } = requireFunctions("../functions/src/api/reviews/reviewSystemLogic.ts") as typeof import("../functions/src/api/reviews/reviewSystemLogic");
const { verifyReviewSystemUser } = requireFunctions("../functions/src/api/routes/reviewSystem.ts") as typeof import("../functions/src/api/routes/reviewSystem");

const token = (claims: Partial<DecodedIdToken>): DecodedIdToken => ({
  aud: "demo-zyro-sh5a",
  auth_time: 0,
  exp: 9_999_999_999,
  firebase: { identities: {}, sign_in_provider: "password" },
  iat: 0,
  iss: "https://securetoken.google.com/demo-zyro-sh5a",
  sub: String(claims.uid || "test-user"),
  uid: String(claims.uid || "test-user"),
  ...claims,
});

test("valid privileged review moderation requires revocation-aware token verification", async () => {
  const calls: Array<{ bearer: string; checkRevoked: boolean | undefined }> = [];
  const result = await verifyReviewSystemUser(async (bearer, checkRevoked) => {
    calls.push({ bearer, checkRevoked });
    return token({ uid: "admin-1", admin: true });
  }, "valid-admin-token", "privileged");

  assert.equal(result.uid, "admin-1");
  assert.deepEqual(calls, [{ bearer: "valid-admin-token", checkRevoked: true }]);
});

test("revoked privileged review moderation token is rejected", async () => {
  const revoked = Object.assign(new Error("ID token has been revoked"), { code: "auth/id-token-revoked" });
  await assert.rejects(
    verifyReviewSystemUser(async (_bearer, checkRevoked) => {
      assert.equal(checkRevoked, true);
      throw revoked;
    }, "revoked-admin-token", "privileged"),
    (error: unknown) => error instanceof ReviewSystemError
      && error.statusCode === 401
      && error.message === "Invalid or expired authentication token",
  );
});

test("authenticated non-privileged user cannot perform review moderation", async () => {
  await assert.rejects(
    verifyReviewSystemUser(async (_bearer, checkRevoked) => {
      assert.equal(checkRevoked, true);
      return token({ uid: "customer-1", role: "customer" });
    }, "customer-token", "privileged"),
    (error: unknown) => error instanceof ReviewSystemError
      && error.statusCode === 403
      && error.message === "Seller access required",
  );
});

test("ordinary customer review authentication does not require a revocation lookup", async () => {
  const result = await verifyReviewSystemUser(async (_bearer, checkRevoked) => {
    assert.equal(checkRevoked, false);
    return token({ uid: "customer-2", role: "customer" });
  }, "ordinary-customer-token", "customer");

  assert.equal(result.uid, "customer-2");
});
