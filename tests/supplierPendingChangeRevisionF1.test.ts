import assert from "node:assert/strict";
import test from "node:test";
import { supplierPendingChangeMatchesQueue } from "../functions/src/api/suppliers/supplierApproval";

const revisionA = "a".repeat(64);
const revisionB = "b".repeat(64);

test("F1: a pending change overlays the queue record only at the same observation revision", () => {
  assert.equal(supplierPendingChangeMatchesQueue(
    { supplierOfferPendingRevision: revisionA },
    { supplierOfferPendingRevision: revisionA },
  ), true);
  assert.equal(supplierPendingChangeMatchesQueue(
    { supplierOfferPendingRevision: ` ${revisionA} ` },
    { supplierOfferPendingRevision: revisionA },
  ), true);
});

test("F1: a pending change from an older observation is ignored", () => {
  assert.equal(supplierPendingChangeMatchesQueue(
    { supplierOfferPendingRevision: revisionB },
    { supplierOfferPendingRevision: revisionA },
  ), false);
  assert.equal(supplierPendingChangeMatchesQueue(
    { supplierOfferPendingRevision: revisionB },
    {},
  ), false);
  assert.equal(supplierPendingChangeMatchesQueue(
    {},
    { supplierOfferPendingRevision: revisionA },
  ), false);
});

test("F1: a missing pending change never overlays and a pending change without a queue record is kept", () => {
  assert.equal(supplierPendingChangeMatchesQueue({ supplierOfferPendingRevision: revisionA }, undefined), false);
  assert.equal(supplierPendingChangeMatchesQueue(undefined, undefined), false);
  assert.equal(supplierPendingChangeMatchesQueue(undefined, { supplierOfferPendingRevision: revisionA }), true);
});

test("F1: legacy records without revisions keep their previous merge behavior", () => {
  assert.equal(supplierPendingChangeMatchesQueue({}, {}), true);
  assert.equal(supplierPendingChangeMatchesQueue({ supplierOfferPendingRevision: null }, { supplierOfferPendingRevision: "" }), true);
});
