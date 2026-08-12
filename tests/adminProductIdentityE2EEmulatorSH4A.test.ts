import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { adminDb } from "../functions/src/api/firebase";
import {
  archiveAdminProduct,
  createAdminProduct,
  updateAdminProduct,
} from "../functions/src/api/products/adminProductManagement";
import { buildZyroSkuClaimId } from "../functions/src/api/suppliers/supplierProductIdentity";

const canRun = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const runPrefix = randomUUID().slice(0, 8);
const actor = { uid: `sh4a-admin-${runPrefix}`, email: "admin@example.test" };
const categoryId = `sh4a-category-${runPrefix}`;
const brandId = `sh4a-brand-${runPrefix}`;

const draft = (label: string, overrides: Record<string, unknown> = {}) => ({
  name: `SH-4A ${label}`,
  description: "Server-authoritative manually managed product.",
  shortDescription: "Manual product",
  price: 1_250,
  originalPrice: 1_500,
  imageUrl: `https://cdn.example.test/${label}.jpg`,
  imageUrls: [`https://cdn.example.test/${label}.jpg`],
  category: categoryId,
  subcategory: "phones",
  brand: brandId,
  model: `MODEL-${label}`,
  barcode: "1234567890123",
  productType: "physical",
  tags: ["manual"],
  keyFeatures: ["Server assigned identity"],
  whatsIncluded: ["Product"],
  stock: 10,
  specs: { Model: `MODEL-${label}` },
  isNew: false,
  isFeatured: false,
  isBestSeller: false,
  isActive: true,
  ...overrides,
});

const seedCatalog = async (): Promise<void> => {
  await Promise.all([
    adminDb.collection("categories").doc(categoryId).set({
      name: "Electronics",
      isActive: true,
      subcategories: [{ id: "phones", name: "Phones", isActive: true }],
      specificationTemplate: [{ name: "Model", required: true }],
    }),
    adminDb.collection("brands").doc(brandId).set({
      name: "Test Brand",
      isActive: true,
    }),
  ]);
};

test("SH-4A manual products share one transactional identity and SKU boundary", {
  skip: canRun ? undefined : "Firestore Emulator is required.",
  timeout: 180_000,
}, async (t) => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || "", /^(127\.0\.0\.1|localhost):\d+$/u);
  await seedCatalog();

  await t.test("two simultaneous manual creates receive independent server identities and SKUs", async () => {
    const [left, right] = await Promise.all([
      createAdminProduct(adminDb, actor, randomUUID(), draft("concurrent-a")),
      createAdminProduct(adminDb, actor, randomUUID(), draft("concurrent-b", { barcode: "2234567890123" })),
    ]);
    assert.notEqual(left.productId, right.productId);
    assert.notEqual(left.sku, right.sku);
    assert.match(left.productId, /^zyro-[a-f0-9]{32}$/u);
    assert.match(left.sku, /^ZY-[A-F0-9]{12}$/u);
    for (const result of [left, right]) {
      assert.equal((await adminDb.collection("products").doc(result.productId).get()).exists, true);
      const privateProduct = (await adminDb.collection("product_private").doc(result.productId).get()).data()!;
      assert.equal(privateProduct.sku, result.sku);
    }
  });

  await t.test("an exact concurrent retry resolves to one logical product and one creation audit", async () => {
    const requestId = randomUUID();
    const requestDraft = draft("idempotent", { barcode: "3234567890123" });
    const [left, right] = await Promise.all([
      createAdminProduct(adminDb, actor, requestId, requestDraft),
      createAdminProduct(adminDb, actor, requestId, requestDraft),
    ]);
    assert.equal(left.productId, right.productId);
    assert.equal(left.sku, right.sku);
    assert.equal([left.idempotent, right.idempotent].filter(Boolean).length, 1);
    const audit = await adminDb.collection("admin_product_audit")
      .where("productId", "==", left.productId)
      .where("action", "==", "create")
      .get();
    assert.equal(audit.size, 1);
    assert.equal(audit.docs[0].data().actor.uid, actor.uid);
    assert.equal(typeof audit.docs[0].data().timestamp, "string");
    const networkRetry = await createAdminProduct(adminDb, actor, requestId, requestDraft);
    assert.equal(networkRetry.idempotent, true);
    assert.equal(networkRetry.productId, left.productId);
    assert.equal(networkRetry.sku, left.sku);
    await assert.rejects(
      createAdminProduct(adminDb, actor, requestId, draft("changed-payload", { barcode: "4234567890123" })),
      /idempotency key was already used/u,
    );
  });

  await t.test("a forced first-candidate collision allocates one shared candidate and one bounded fallback", async () => {
    const shared = "ZY-SH4ASHARED01";
    const fallbackA = "ZY-SH4AFALLBA1";
    const fallbackB = "ZY-SH4AFALLBB1";
    const [left, right] = await Promise.all([
      createAdminProduct(adminDb, actor, randomUUID(), draft("collision-a", { barcode: "5234567890123" }), {
        buildSkuCandidates: () => [shared, fallbackA],
      }),
      createAdminProduct(adminDb, actor, randomUUID(), draft("collision-b", { barcode: "6234567890123" }), {
        buildSkuCandidates: () => [shared, fallbackB],
      }),
    ]);
    assert.notEqual(left.sku, right.sku);
    assert.ok([left.sku, right.sku].includes(shared));
    assert.ok([left.sku, right.sku].some((sku) => sku === fallbackA || sku === fallbackB));
  });

  await t.test("concurrent manual creates cannot publish the same barcode", async () => {
    const barcode = "8234567890123";
    const results = await Promise.allSettled([
      createAdminProduct(adminDb, actor, randomUUID(), draft("barcode-a", { barcode })),
      createAdminProduct(adminDb, actor, randomUUID(), draft("barcode-b", { barcode })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.match(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason), /already uses this barcode/u);
    assert.equal((await adminDb.collection("products").where("barcode", "==", barcode).get()).size, 1);
    const created = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{ productId: string }>).value;
    assert.equal((await adminDb.collection("product_private").doc(created.productId).get()).exists, true);
  });

  await t.test("an archived SKU claim remains owned and cannot be recycled", async () => {
    const archivedCandidate = `ZY-A${runPrefix.toUpperCase()}01`;
    const fallback = `ZY-B${runPrefix.toUpperCase()}01`;
    const first = await createAdminProduct(
      adminDb,
      actor,
      randomUUID(),
      draft("archive-claim", { barcode: "9234567890123" }),
      { buildSkuCandidates: () => [archivedCandidate] },
    );
    await archiveAdminProduct(adminDb, first.productId, actor);
    const claimId = buildZyroSkuClaimId(archivedCandidate);
    assert.equal((await adminDb.collection("zyro_sku_claims").doc(claimId).get()).data()?.productId, first.productId);

    const second = await createAdminProduct(
      adminDb,
      actor,
      randomUUID(),
      draft("archive-claim-reuse", { barcode: "1334567890123" }),
      { buildSkuCandidates: () => [archivedCandidate, fallback] },
    );
    assert.equal(second.sku, fallback);
    assert.equal((await adminDb.collection("zyro_sku_claims").doc(claimId).get()).data()?.productId, first.productId);
  });

  await t.test("legacy update preserves Product ID and SKU, while archive retains both documents and the historical SKU", async () => {
    const productId = `legacy-manual-${runPrefix}`;
    const legacySku = "ZY-LEGACYSH4A1";
    await Promise.all([
      adminDb.collection("products").doc(productId).set({
        id: productId,
        sku: legacySku,
        name: "Legacy Product",
        description: "Legacy description",
        price: 1_000,
        imageUrl: "https://cdn.example.test/legacy.jpg",
        category: categoryId,
        brand: brandId,
        stock: 2,
        specs: { Model: "LEGACY" },
        isActive: true,
        rating: 4.5,
        reviewsCount: 7,
      }),
      adminDb.collection("product_private").doc(productId).set({
        productId,
        costPrice: 700,
        supplierOfferSelection: { activeOfferId: "legacy-offer", failoverEnabled: true },
        supplierMetadata: { legacyMapping: true },
      }),
    ]);

    const updated = await updateAdminProduct(adminDb, productId, actor, draft("legacy-updated", {
      id: productId,
      sku: legacySku,
      barcode: "7234567890123",
    }));
    assert.equal(updated.productId, productId);
    assert.equal(updated.sku, legacySku);
    const updatedPrivate = (await adminDb.collection("product_private").doc(productId).get()).data()!;
    assert.equal(updatedPrivate.sku, legacySku);
    assert.equal(updatedPrivate.supplierOfferSelection.activeOfferId, "legacy-offer");
    assert.equal(updatedPrivate.supplierMetadata.legacyMapping, true);
    const updatedPublic = (await adminDb.collection("products").doc(productId).get()).data()!;
    assert.equal(updatedPublic.rating, 4.5);
    assert.equal(updatedPublic.reviewsCount, 7);

    const fallbackSku = `ZY-L${runPrefix.toUpperCase()}01`;
    const legacyCollision = await createAdminProduct(
      adminDb,
      actor,
      randomUUID(),
      draft("legacy-collision", { barcode: "2334567890123" }),
      { buildSkuCandidates: () => [legacySku, fallbackSku] },
    );
    assert.equal(legacyCollision.sku, fallbackSku);

    const archived = await archiveAdminProduct(adminDb, productId, actor);
    const archiveRetry = await archiveAdminProduct(adminDb, productId, actor);
    assert.equal(archived.archived, true);
    assert.equal(archiveRetry.idempotent, true);
    const product = (await adminDb.collection("products").doc(productId).get()).data()!;
    const privateProduct = (await adminDb.collection("product_private").doc(productId).get()).data()!;
    assert.equal(product.isActive, false);
    assert.equal(product.visible, false);
    assert.equal(privateProduct.sku, legacySku);
    assert.equal((await adminDb.collection("products").doc(productId).get()).exists, true);
    assert.equal((await adminDb.collection("product_private").doc(productId).get()).exists, true);
    assert.equal((await adminDb.collection("zyro_sku_claims").doc(buildZyroSkuClaimId(legacySku)).get()).exists, false);
    const audits = await adminDb.collection("admin_product_audit").where("productId", "==", productId).get();
    assert.deepEqual(
      audits.docs.map((document) => document.data().action).sort(),
      ["archive", "update"],
    );
    audits.docs.forEach((document) => {
      assert.equal(document.data().actor.uid, actor.uid);
      assert.equal(document.data().zyroSku, legacySku);
      assert.equal(typeof document.data().timestamp, "string");
    });
  });
});
