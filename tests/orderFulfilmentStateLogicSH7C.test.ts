import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInitialFulfilmentGroups,
  deriveOrderStatusFromFulfilmentGroups,
  type GroupableOrderPrivateLine,
  type OrderFulfilmentGroup,
} from "../functions/src/api/orders/orderFulfilmentGroups";
import { verifySupplierPortalIdentityToken } from "../functions/src/api/routes/supplierPortal";

const at = "2026-08-10T00:00:00.000Z";
const line = (
  lineId: string,
  account: string | null,
  source: string | null,
  fulfilmentMode: "supplier" | "internal" = "supplier",
): GroupableOrderPrivateLine => ({ lineId, productId: `product-${lineId}`, supplierAccountId: account, supplierSourceId: source, fulfilmentMode });

const withStatus = (group: OrderFulfilmentGroup, status: OrderFulfilmentGroup["status"]): OrderFulfilmentGroup => ({
  ...group,
  status,
});

test("SH-7C constructs deterministic bounded supplier groups from immutable line attribution", () => {
  const groups = buildInitialFulfilmentGroups([
    line("a-1", "supplier-a", "source-a-1"),
    line("b-1", "supplier-b", "source-b"),
    line("a-2", "supplier-a", "source-a-2"),
    line("internal", null, null, "internal"),
  ], at);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((group) => group.supplierAccountId === "supplier-a")?.lineIds, ["a-1", "a-2"]);
  assert.deepEqual(groups.find((group) => group.supplierAccountId === "supplier-a")?.supplierSourceIds, ["source-a-1", "source-a-2"]);
  assert.deepEqual(groups.map((group) => group.status), ["unassigned", "unassigned"]);
  assert.equal(groups.every((group) => group.revision === 1), true);
  assert.deepEqual(buildInitialFulfilmentGroups([
    line("a-2", "supplier-a", "source-a-2"),
    line("a-1", "supplier-a", "source-a-1"),
    line("b-1", "supplier-b", "source-b"),
  ], at), groups);
});

test("SH-7C rejects incomplete supplier routing while allowing internal lines without groups", () => {
  assert.throws(() => buildInitialFulfilmentGroups([line("missing-account", null, "source")], at), /attribution.*incomplete/i);
  assert.throws(() => buildInitialFulfilmentGroups([line("missing-source", "supplier", null)], at), /attribution.*incomplete/i);
  assert.deepEqual(buildInitialFulfilmentGroups([line("internal", null, null, "internal")], at), []);
});

test("SH-7C derives the main order state across partial multi-supplier progress", () => {
  const [groupA, groupB] = buildInitialFulfilmentGroups([
    line("a", "supplier-a", "source-a"),
    line("b", "supplier-b", "source-b"),
  ], at);

  assert.equal(deriveOrderStatusFromFulfilmentGroups([groupA, groupB]), "confirmed");
  assert.equal(deriveOrderStatusFromFulfilmentGroups([withStatus(groupA, "accepted"), groupB]), "processing");
  assert.equal(deriveOrderStatusFromFulfilmentGroups([withStatus(groupA, "shipped"), withStatus(groupB, "processing")]), "processing");
  assert.equal(deriveOrderStatusFromFulfilmentGroups([withStatus(groupA, "packed"), withStatus(groupB, "packed")]), "packed");
  assert.equal(deriveOrderStatusFromFulfilmentGroups([withStatus(groupA, "shipped"), withStatus(groupB, "packed")]), "packed");
  assert.equal(deriveOrderStatusFromFulfilmentGroups([withStatus(groupA, "shipped"), withStatus(groupB, "shipped")]), "shipped");
  assert.equal(deriveOrderStatusFromFulfilmentGroups([withStatus(groupA, "delivered"), withStatus(groupB, "delivered")]), "delivered");
});

test("SH-7C Supplier Portal authentication requests revocation-aware verification", async () => {
  const calls: Array<boolean | undefined> = [];
  const identity = await verifySupplierPortalIdentityToken({
    verifyIdToken: async (_token, checkRevoked) => {
      calls.push(checkRevoked);
      return { uid: "supplier-a", email: "supplier-a@example.test" };
    },
  }, "valid-token", true);
  assert.equal(identity.uid, "supplier-a");
  assert.deepEqual(calls, [true]);

  await assert.rejects(
    verifySupplierPortalIdentityToken({
      verifyIdToken: async (_token, checkRevoked) => {
        assert.equal(checkRevoked, true);
        throw Object.assign(new Error("ID token revoked"), { code: "auth/id-token-revoked" });
      },
    }, "revoked-token", true),
    /revoked/i,
  );
});
