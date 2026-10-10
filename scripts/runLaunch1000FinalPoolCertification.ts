import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applicationDefault, getApp, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { validateSupplierProductForApproval, type StoreCategoryMappingCandidate } from "../functions/src/api/suppliers/supplierProductMapping";
import { supplierReviewRecordHasPublicationReadyMedia } from "../functions/src/scheduled/supplierReviewQueue";

const PROJECT_ID = "zyrolk-e0164";
const OUT = path.resolve(".local/launch-1000/final-launch-pool-certification.json");
const WORKBENCH = path.resolve(".local/launch-1000/taxonomy-workbench-dry-run.json");
const SEMANTIC = path.resolve(".local/launch-1000/image-semantic-pass-r8.json");
const VIRTUAL = path.resolve(".local/launch-1000/virtual-taxonomy-validation.json");

type AnyRecord = Record<string, unknown>;
type Result = { id: string; sku: string; title: string; class: string; categoryId: string | null; subcategoryId: string | null; clusterId: string; blockers: string[]; specNormalization?: AnyRecord; media: AnyRecord; source: string };

function record(value: unknown): AnyRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {}; }
function text(value: unknown): string { return String(value ?? "").trim(); }
function num(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function arr(value: unknown): AnyRecord[] { return Array.isArray(value) ? value.map(record) : []; }
function first(...values: unknown[]): string { return values.map(text).find(Boolean) || ""; }

function category(value: AnyRecord, id: string): StoreCategoryMappingCandidate {
  return {
    id,
    name: first(value.name, id),
    isActive: value.isActive === true,
    taxonomyCandidate: value.taxonomyCandidate === true,
    specificationTemplate: arr(value.specificationTemplate).map((item) => ({ name: text(item.name), required: item.required === true })).filter((item) => item.name),
    subcategories: arr(value.subcategories).map((item) => ({ id: text(item.id), name: text(item.name), isActive: item.isActive !== false, taxonomyCandidate: item.taxonomyCandidate === true })).filter((item) => item.id && item.name),
  };
}

function activeCanonical(categories: readonly StoreCategoryMappingCandidate[], id: string): StoreCategoryMappingCandidate | undefined {
  return categories.find((item) => item.id === id && item.isActive === true && item.taxonomyCandidate !== true);
}

type ValidatorCategory = Omit<StoreCategoryMappingCandidate, "subcategories"> & {
  subcategories: NonNullable<StoreCategoryMappingCandidate["subcategories"]>;
};

function validatorTaxonomy(categories: readonly StoreCategoryMappingCandidate[]): ValidatorCategory[] {
  return categories.map((item): ValidatorCategory => ({ ...item, subcategories: item.subcategories || [] }));
}

function primaryMedia(raw: AnyRecord): AnyRecord | undefined {
  return arr(raw.managedMedia).find((item) => item.isPrimary === true && text(item.imageStatus).toLowerCase() === "ready" && (text(item.firebaseStorageUrl) || text(record(record(item.variants).large).storagePath) || text(record(record(item.variants).thumbnail).storagePath)));
}

function mediaSummary(raw: AnyRecord): AnyRecord {
  const item = primaryMedia(raw);
  const variants = record(item?.variants);
  const large = record(variants.large);
  const thumbnail = record(variants.thumbnail);
  return {
    publicationReadyPredicate: supplierReviewRecordHasPublicationReadyMedia(raw as never),
    primaryPresent: Boolean(item),
    imageStatus: text(item?.imageStatus),
    mimeType: first(item?.mimeType, large.mimeType, thumbnail.mimeType),
    firebaseStorageUrl: first(item?.firebaseStorageUrl, thumbnail.storageUrl),
    storagePath: first(large.storagePath, thumbnail.storagePath),
    sourceUrl: first(item?.originalSupplierUrl, item?.sourceUrl),
  };
}

function productFrom(raw: AnyRecord, categoryId: string, subcategoryId: string | null, extraSpecs: AnyRecord): AnyRecord {
  const payload = record(raw.productPayload);
  const snapshot = record(raw.supplierSnapshot);
  const payloadMeta = record(payload.supplierMetadata);
  const snapshotMeta = record(snapshot.supplierMetadata);
  const primary = primaryMedia(raw);
  const variants = record(primary?.variants);
  const thumb = record(variants.thumbnail);
  const specs = {
    ...record(snapshotMeta.specifications),
    ...record(snapshot.specifications),
    ...record(payload.specifications),
    ...record(payload.specs),
    ...extraSpecs,
  };
  const cost = num(payload.costPrice ?? payload.supplierCost ?? snapshot.costPrice ?? snapshot.supplierCost) ?? 0;
  const supplierId = first(raw.sourceId, raw.supplierCode, snapshot.supplierId, payloadMeta.supplierId, payloadMeta.supplierCode);
  return {
    name: first(payload.name, payload.title, raw.productName),
    description: first(payload.description, snapshot.description),
    price: num(payload.price ?? payload.sellingPrice),
    costPrice: cost,
    stock: num(raw.stock ?? payload.stock ?? snapshot.inventoryLevel),
    imageUrl: first(primary?.firebaseStorageUrl, thumb.storageUrl),
    category: categoryId,
    subcategory: subcategoryId || "",
    specs,
    supplierMetadata: {
      ...payloadMeta,
      supplierId,
      supplierCostAvailable: payloadMeta.supplierCostAvailable !== false,
      supplierStockAvailable: payloadMeta.supplierStockAvailable !== false,
    },
    isActive: false,
    brand: first(payload.brand, payload.brandName),
  };
}

const familyType: Record<string, string> = {
  F01: "Bag", F02: "Jewelry accessory", F03: "Clothing", F04: "Watch", F05: "Hair accessory", F06: "Skin care", F07: "Beauty tool",
  F10: "Toy", F11: "School product", F12: "Vehicle interior accessory", F13: "Vehicle electrical accessory", F14: "Vehicle care product", F15: "Vehicle accessory",
  F16: "Power tool", F17: "Hand tool", F18: "Welding or soldering tool", F19: "Storage organizer", F20: "Home decor", F21: "Light", F22: "Cleaning product",
  F23: "Cookware", F24: "Kitchen utensil", F25: "Garden tool", F26: "Audio device", F27: "Power accessory", F28: "Pet product", F29: "Home repair product",
};

const recoveryAssignments: Record<string, { categoryId: string; subcategoryId: string | null; reason: string; familyId?: string }> = {
  "dropex-atf0337": { categoryId: "phone-accessories", subcategoryId: "phone-accessories", reason: "explicit mobile combo" },
  "dropex-atf0361": { categoryId: "baby-kids", subcategoryId: "baby-care", reason: "explicit baby safety product" },
  "dropex-atfch-392": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "explicit food cover", familyId: "F24" },
  "dropex-atfch-399": { categoryId: "fashion", subcategoryId: "men-s-accessories", reason: "umbrella as personal accessory; requires visual confirmation" },
  "dropex-azk1753": { categoryId: "fashion", subcategoryId: "eyewear", reason: "explicit sunglass accessory; requires visual confirmation" },
  "dropex-azk1772": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "dish drying mat", familyId: "F24" },
  "dropex-azk1821": { categoryId: "home-kitchen", subcategoryId: "home-essentials", reason: "thermos cup", familyId: "F24" },
  "dropex-azk1848": { categoryId: "fashion", subcategoryId: "virtual-f01", reason: "chest bag", familyId: "F01" },
  "dropex-azk1849": { categoryId: "fashion", subcategoryId: "virtual-f01", reason: "chest bag", familyId: "F01" },
  "dropex-azk1855": { categoryId: "fashion", subcategoryId: "virtual-f01", reason: "handbag set", familyId: "F01" },
  "dropex-azk2044": { categoryId: "automotive", subcategoryId: "car-care-maintenance", reason: "windshield repair kit" },
  "dropex-azkch-578": { categoryId: "health-beauty", subcategoryId: "makeup", reason: "hair mascara; requires visual confirmation" },
  "dropex-azkch-588": { categoryId: "automotive", subcategoryId: "exterior-accessories", reason: "car door protective cover" },
  "dropex-azkm557": { categoryId: "automotive", subcategoryId: "exterior-accessories", reason: "car latch hook step" },
  "dropex-azkm574": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "cake decorating tool kit", familyId: "F24" },
  "dropex-c-atf0443": { categoryId: "health-beauty", subcategoryId: "hair-care", reason: "hair powder" },
  "dropex-imz0080": { categoryId: "home-kitchen", subcategoryId: "home-essentials", reason: "blanket", familyId: "F24" },
  "dropex-shx3061": { categoryId: "health-beauty", subcategoryId: "hair-styling", reason: "hair styling comb" },
  "dropex-shx3278": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "dish drying mat", familyId: "F24" },
  "dropex-shx3360": { categoryId: "health-beauty", subcategoryId: "virtual-f05", reason: "hair accessories", familyId: "F05" },
  "dropex-shxch-182": { categoryId: "automotive", subcategoryId: "car-care-cleaning", reason: "shoe shine wax; requires visual confirmation" },
  "dropex-shxch-552": { categoryId: "health-beauty", subcategoryId: "virtual-f05", reason: "hair clips", familyId: "F05" },
  "dropex-shxm880": { categoryId: "home-kitchen", subcategoryId: "small-kitchen-appliances", reason: "electric cooking pot", familyId: "F23" },
  "dropex-aju0003": { categoryId: "automotive", subcategoryId: "car-care-cleaning", reason: "vehicle aromatherapy" },
  "dropex-aju0183": { categoryId: "kids-toys", subcategoryId: null, reason: "magnetic toy kit" },
  "dropex-asn0019": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "pearl setting machine", familyId: "F17" },
  "dropex-atf0363": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "glow-in-the-dark tape", familyId: "F29" },
  "dropex-atf0366": { categoryId: "fashion", subcategoryId: "men-s-accessories", reason: "card holder" },
  "dropex-atf0387": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "furniture polish", familyId: "F29" },
  "dropex-atfch-312": { categoryId: "home-garden", subcategoryId: "virtual-f20", reason: "wall stickers", familyId: "F20" },
  "dropex-atfch-438": { categoryId: "home-garden", subcategoryId: "virtual-f29", reason: "angle brackets", familyId: "F29" },
  "dropex-atfch-550": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "wall fan", familyId: "F22" },
  "dropex-atfm0011": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "hand shower", familyId: "F22" },
  "dropex-azk1760": { categoryId: "home-garden", subcategoryId: "virtual-f29", reason: "furniture sliders", familyId: "F29" },
  "dropex-azk1831": { categoryId: "kids-toys", subcategoryId: null, reason: "magnetic toy" },
  "dropex-azk1917": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "adhesive stickers", familyId: "F29" },
  "dropex-azk2068": { categoryId: "automotive", subcategoryId: "interior-accessories", reason: "car window sunshades" },
  "dropex-azkch-1016": { categoryId: "solar-lighting", subcategoryId: "decorative-party-lights", reason: "solar string lights", familyId: "F21" },
  "dropex-azkch-1217": { categoryId: "solar-lighting", subcategoryId: "solar-equipment", reason: "solar charging panel", familyId: "F21" },
  "dropex-azkch-206": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "chair covers", familyId: "F20" },
  "dropex-azkch-423": { categoryId: "electronics", subcategoryId: "smart-devices", reason: "alarm clock", familyId: "F26" },
  "dropex-azkch-438": { categoryId: "home-garden", subcategoryId: "virtual-f20", reason: "decorative tree", familyId: "F20" },
  "dropex-azkch-448": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "chair covers", familyId: "F20" },
  "dropex-azkch-606": { categoryId: "health-beauty", subcategoryId: "beauty-personal-care", reason: "disposable face towel" },
  "dropex-azkch-678": { categoryId: "solar-lighting", subcategoryId: "solar-equipment", reason: "solar panel", familyId: "F21" },
  "dropex-azkch-777": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "clip zip storage", familyId: "F19" },
  "dropex-azkch-777b": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "clip zip storage", familyId: "F19" },
  "dropex-azkch-793c": { categoryId: "health-beauty", subcategoryId: "virtual-f05", reason: "headband", familyId: "F05" },
  "dropex-azkch-794": { categoryId: "home-garden", subcategoryId: "household", reason: "anti-slip household net", familyId: "F22" },
  "dropex-azkm504": { categoryId: "fashion", subcategoryId: "virtual-f01", reason: "backpack", familyId: "F01" },
  "dropex-azkm504g": { categoryId: "fashion", subcategoryId: "virtual-f01", reason: "backpack", familyId: "F01" },
  "dropex-azkm540": { categoryId: "automotive", subcategoryId: "exterior-accessories", reason: "mud flaps" },
  "dropex-azkm570": { categoryId: "automotive", subcategoryId: "exterior-accessories", reason: "wheel reflective strip" },
  "dropex-imz0198": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "folding step stool", familyId: "F19" },
  "dropex-imz0212": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "rolling storage cart", familyId: "F19" },
  "dropex-imz0524": { categoryId: "home-garden", subcategoryId: "virtual-f29", reason: "magic repair tape", familyId: "F29" },
  "dropex-imz0525": { categoryId: "home-garden", subcategoryId: "virtual-f29", reason: "magic repair tape", familyId: "F29" },
  "dropex-imzch-1151b": { categoryId: "home-garden", subcategoryId: "garden-tools", reason: "garden sprayer", familyId: "F25" },
  "dropex-imzch-1153b": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "switch repair kit", familyId: "F17" },
  "dropex-imzch-1156": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "baking pans", familyId: "F23" },
  "dropex-imzch-1275": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "vegetable cutter", familyId: "F24" },
  "dropex-imzch-1295": { categoryId: "home-garden", subcategoryId: "virtual-f29", reason: "door stop", familyId: "F29" },
  "dropex-imzch-1304": { categoryId: "home-garden", subcategoryId: "virtual-f20", reason: "home decor leaves", familyId: "F20" },
  "dropex-imzch-3462": { categoryId: "health-beauty", subcategoryId: "virtual-f05", reason: "hair clips", familyId: "F05" },
  "dropex-imzch-3462b": { categoryId: "health-beauty", subcategoryId: "virtual-f05", reason: "hair clips", familyId: "F05" },
  "dropex-imzch-460": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "zipper heads", familyId: "F19" },
  "dropex-imzch-466": { categoryId: "electronics", subcategoryId: "smart-devices", reason: "digital clock fan", familyId: "F26" },
  "dropex-imzch-629": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "key holder", familyId: "F19" },
  "dropex-imzch-631": { categoryId: "fashion", subcategoryId: "virtual-f02", reason: "ring", familyId: "F02" },
  "dropex-imzch-642": { categoryId: "automotive", subcategoryId: "interior-accessories", reason: "car sun shade" },
  "dropex-imzch-658": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "scissors", familyId: "F17" },
  "dropex-imzch-674": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "tool shaft extension", familyId: "F17" },
  "dropex-imzch-716": { categoryId: "home-garden", subcategoryId: "painting-tools", reason: "paint roller", familyId: "F17" },
  "dropex-imzch-741": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "grinding head", familyId: "F17" },
  "dropex-imzch-882": { categoryId: "fashion", subcategoryId: "virtual-f02", reason: "earrings", familyId: "F02" },
  "dropex-imzch-886": { categoryId: "fashion", subcategoryId: "eyewear", reason: "ear clips; requires visual confirmation" },
  "dropex-imzch-894b": { categoryId: "home-garden", subcategoryId: "home-essentials", reason: "remote holder", familyId: "F19" },
  "dropex-imzch-895": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "coffee maker", familyId: "F23" },
  "dropex-imzch-897": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "tile chamfer machine", familyId: "F17" },
  "dropex-imzch-911": { categoryId: "fashion", subcategoryId: "virtual-f02", reason: "earrings", familyId: "F02" },
  "dropex-imzch-971": { categoryId: "home-garden", subcategoryId: "household", reason: "flat mop", familyId: "F22" },
  "dropex-imzch-999": { categoryId: "home-garden", subcategoryId: "virtual-f20", reason: "decorative fence", familyId: "F20" },
  "dropex-klr0149": { categoryId: "health-beauty", subcategoryId: "virtual-f05", reason: "hair bands", familyId: "F05" },
  "dropex-klr0191": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "desoldering pump", familyId: "F17" },
  "dropex-klrch-421": { categoryId: "health-beauty", subcategoryId: "virtual-f05", reason: "hair bands", familyId: "F05" },
  "dropex-sham323": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "simmer ring", familyId: "F23" },
  "dropex-shx3003": { categoryId: "home-garden", subcategoryId: "household", reason: "steam iron", familyId: "F22" },
  "dropex-shx3108": { categoryId: "electronics", subcategoryId: "computer-accessories", reason: "wireless mouse", familyId: "F26" },
  "dropex-shx3165": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "tool set", familyId: "F17" },
  "dropex-shx3266": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "mugs", familyId: "F24" },
  "dropex-shx3381": { categoryId: "home-garden", subcategoryId: "virtual-f20", reason: "wall stickers", familyId: "F20" },
  "dropex-shx3382": { categoryId: "home-garden", subcategoryId: "virtual-f20", reason: "wall stickers", familyId: "F20" },
  "dropex-shxch-1064": { categoryId: "health-beauty", subcategoryId: "oral-care", reason: "kids toothbrush" },
  "dropex-shxch-1096": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "rotti maker", familyId: "F24" },
  "dropex-shxch-1144": { categoryId: "home-kitchen", subcategoryId: "home-essentials", reason: "blanket", familyId: "F24" },
  "dropex-shxch-1184": { categoryId: "home-garden", subcategoryId: "garden-tools", reason: "liquid transfer pump", familyId: "F25" },
  "dropex-shxch-1247": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "terminal tubes", familyId: "F17" },
  "dropex-shxch-414": { categoryId: "home-garden", subcategoryId: "painting-tools", reason: "paint roller", familyId: "F17" },
  "dropex-shxch-415": { categoryId: "fashion", subcategoryId: "eyewear", reason: "reading glasses" },
  "dropex-shxch-418": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "food cover", familyId: "F24" },
  "dropex-shxch-435": { categoryId: "home-garden", subcategoryId: "virtual-f20", reason: "crystal mandala decor", familyId: "F20" },
  "dropex-shxch-451b": { categoryId: "home-garden", subcategoryId: "virtual-f20", reason: "border stickers", familyId: "F20" },
  "dropex-shxch-512": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "pipe bending tool", familyId: "F17" },
  "dropex-shxch-535": { categoryId: "home-garden", subcategoryId: "tools-hardware", reason: "cable connection tubes", familyId: "F17" },
  "dropex-shxch-539": { categoryId: "health-beauty", subcategoryId: "virtual-f05", reason: "headband", familyId: "F05" },
  "dropex-shxch-552b": { categoryId: "health-beauty", subcategoryId: "virtual-f05", reason: "hair clips", familyId: "F05" },
  "dropex-shxch-803": { categoryId: "home-garden", subcategoryId: "virtual-f29", reason: "sealing rings", familyId: "F29" },
  "dropex-shxch-815": { categoryId: "home-garden", subcategoryId: "virtual-f29", reason: "wood filling paste", familyId: "F29" },
  "dropex-shxch-818b": { categoryId: "home-kitchen", subcategoryId: "kitchen-tools", reason: "stainless steel bowl", familyId: "F24" },
  "dropex-shxch-972": { categoryId: "automotive", subcategoryId: "interior-accessories", reason: "posture correction back seat" },
  "dropex-shxch-979": { categoryId: "solar-lighting", subcategoryId: "decorative-party-lights", reason: "solar hanging chimes", familyId: "F21" },
  "dropex-shxch172": { categoryId: "baby-kids", subcategoryId: "baby-care", reason: "kids urinal" },
  "dropex-shxm300": { categoryId: "kids-toys", subcategoryId: null, reason: "magic blow pen" },
  "dropex-shxm301": { categoryId: "kids-toys", subcategoryId: null, reason: "magic trace toy" },
  "dropex-shxm302": { categoryId: "kids-toys", subcategoryId: null, reason: "pattern painter toy" },
  "dropex-shxm304": { categoryId: "kids-toys", subcategoryId: null, reason: "sand painting toy" },
  "dropex-shxm997": { categoryId: "electronics", subcategoryId: "power-banks", reason: "uninterruptible power supply", familyId: "F27" },
};

function candidateSku(raw: AnyRecord): string { const payload = record(raw.productPayload); return first(payload.sku, payload.supplierSku, raw.supplierSku, raw.productId, raw.id); }
function rawSpec(raw: AnyRecord, name: string): string {
  const payload = record(raw.productPayload); const snapshot = record(raw.supplierSnapshot); const pm = record(payload.supplierMetadata); const sm = record(snapshot.supplierMetadata);
  return first(record(payload.specs)[name], record(payload.specifications)[name], record(snapshot.specs)[name], record(sm.specifications)[name], record(pm.specifications)[name]);
}
function selectedSpec(raw: AnyRecord, semantic: AnyRecord | undefined, familyId: string | undefined): { specs: AnyRecord; normalization?: AnyRecord; missing: string[] } {
  const specs: AnyRecord = {};
  const semanticSpec = record(semantic?.proposedSpec);
  if (semanticSpec.field && semanticSpec.value) specs[text(semanticSpec.field)] = semanticSpec.value;
  if (familyId && familyType[familyId] && !rawSpec(raw, "Product Type")) specs["Product Type"] = familyType[familyId];
  const normalization = Object.keys(specs).length > 0 ? { ...specs, evidence: semanticSpec.evidence || `deterministic family rule ${familyId || ""}` } : undefined;
  return { specs, normalization, missing: [] };
}

const source = JSON.parse(await readFile(path.resolve(".local/launch-1000/final-pool-source-read.json"), "utf8")) as { categories: Array<{ id: string; data: AnyRecord }>; rawRecords: AnyRecord[] };
const semantic = JSON.parse(await readFile(SEMANTIC, "utf8")) as { results: AnyRecord[] };
const virtual = JSON.parse(await readFile(VIRTUAL, "utf8")) as { familyResults: AnyRecord[]; adminResults: AnyRecord[]; virtualTaxonomy: { nodes: AnyRecord[] } };
const workbench = JSON.parse(await readFile(WORKBENCH, "utf8")) as { candidates: AnyRecord[] };
const semanticById = new Map(semantic.results.map((item) => [text(item.candidateId), item]));
const rawById = new Map(source.rawRecords.map((item) => [text(item.id), item]));
const categories: StoreCategoryMappingCandidate[] = source.categories.map((item) => category(item.data, item.id));
const overlay = categories.map((item) => ({ ...item, subcategories: [...(item.subcategories || [])] }));
const collisions: string[] = [];
for (const node of virtual.virtualTaxonomy.nodes) {
  const parent = overlay.find((item) => item.id === text(node.parentId));
  if (!parent || parent.isActive !== true || parent.taxonomyCandidate === true) continue;
  if (parent.subcategories?.some((item) => item.id === text(node.id) || item.name.toLowerCase() === text(node.name).toLowerCase())) collisions.push(`${parent.id}:${node.name}`);
  else parent.subcategories = [...(parent.subcategories || []), { id: text(node.id), name: text(node.name), isActive: true }];
}
const categoryIds = new Set(overlay.filter((item) => item.isActive === true && item.taxonomyCandidate !== true).map((item) => item.id));

async function validateAssignment(id: string, categoryId: string | null, subcategoryId: string | null, familyId: string | undefined, sourceKind: string, clusterId: string, taxonomy: readonly StoreCategoryMappingCandidate[] = overlay): Promise<Result> {
  const raw = rawById.get(id) || {};
  const semanticResult = semanticById.get(id);
  const media = mediaSummary(raw);
  const type = selectedSpec(raw, semanticResult, familyId);
  const blockers: string[] = [];
  const categoryRecord = categoryId ? activeCanonical(taxonomy, categoryId) : undefined;
  if (!categoryRecord) blockers.push("CATEGORY_INVALID");
  else {
    const activeSubs = (categoryRecord.subcategories || []).filter((item) => item.isActive !== false);
    if (activeSubs.length > 0 && !subcategoryId) blockers.push("SUBCATEGORY_REQUIRED");
    else if (activeSubs.length > 0 && !activeSubs.some((item) => item.id === subcategoryId)) blockers.push("SUBCATEGORY_INVALID");
  }
  if (!media.publicationReadyPredicate || !media.primaryPresent || !media.firebaseStorageUrl) blockers.push("MEDIA_NOT_READY");
  const product = productFrom(raw, categoryId || "", subcategoryId, type.specs);
  for (const error of validateSupplierProductForApproval(product, validatorTaxonomy(taxonomy), [], {})) blockers.push(`${error.field}:${error.code}`);
  const stock = num(product.stock);
  if (stock === null || !Number.isInteger(stock) || stock < 4) blockers.push("LOW_SUPPLIER_STOCK_FOR_PUBLICATION");
  const riskFlags = record(semanticResult).riskFlags;
  if (Array.isArray(riskFlags) && riskFlags.length > 0) blockers.push("POLICY_REVIEW_REQUIRED");
  return { id, sku: candidateSku(raw), title: first(record(raw.productPayload).name, record(raw.productPayload).title, raw.productName), class: blockers.length ? "OTHER_BLOCKER" : "CERTIFIED_CLEAN", categoryId, subcategoryId, clusterId, blockers: [...new Set(blockers)].sort(), specNormalization: type.normalization, media, source: sourceKind };
}

const existingIds = semantic.results.filter((item) => item.classification === "HIGH_CONFIDENCE_EXISTING_TAXONOMY").map((item) => text(item.candidateId));
const familyClean = virtual.familyResults.filter((item) => item.outcome === "CLEAN_AFTER_TAXONOMY" || item.outcome === "CLEAN_AFTER_DETERMINISTIC_SPEC");
const adminClean = virtual.adminResults.filter((item) => item.outcome === "CLEAN_AFTER_TAXONOMY" || item.outcome === "CLEAN_AFTER_DETERMINISTIC_SPEC");
const familyById = new Map([...virtual.familyResults, ...virtual.adminResults].map((item) => [text(item.candidateId), item]));
const assignments: Array<{ id: string; categoryId: string | null; subcategoryId: string | null; familyId?: string; source: string; cluster: string }> = [];
for (const id of existingIds) { const item = semanticById.get(id)!; assignments.push({ id, categoryId: text(item.categoryId) || null, subcategoryId: text(item.subcategoryId) || null, source: "existing-safe", cluster: text(item.clusterSignature) }); }
for (const item of [...familyClean, ...adminClean]) assignments.push({ id: text(item.candidateId), categoryId: text(record(item.taxonomy).categoryId) || null, subcategoryId: text(record(item.taxonomy).subcategoryId) || null, familyId: text(item.familyId), source: item.adminResolution ? "admin-clear" : "family-proposal", cluster: text(item.familyId) });
const deduped = [...new Map(assignments.map((item) => [item.id, item])).values()];
const results: Result[] = [];
for (const item of deduped) results.push(await validateAssignment(item.id, item.categoryId, item.subcategoryId, item.familyId, item.source, item.cluster, item.source === "existing-safe" ? categories : overlay));

const unresolvedAdmin = virtual.adminResults.filter((item) => item.outcome === "ADMIN_CHOICE_STILL_REQUIRED");
const assignedIds = new Set(deduped.map((item) => item.id));
const recoveryCandidates = semantic.results
  .filter((item) => !assignedIds.has(text(item.candidateId)) && recoveryAssignments[text(item.candidateId)])
  .filter((item) => item.classification === "ADMIN_CHOICE" || item.classification === "NEW_TAXONOMY_NEEDED");
const recoveryResults: Result[] = [];
for (const item of recoveryCandidates) {
  const assignment = recoveryAssignments[text(item.candidateId)];
  recoveryResults.push(await validateAssignment(text(item.candidateId), assignment.categoryId, assignment.subcategoryId, assignment.familyId, `admin-recovery:${assignment.reason}`, `recovery:${text(item.candidateId)}`));
}

const storage = getStorage(getApps().length > 0 ? getApp() : initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })).bucket("zyrolk-e0164.firebasestorage.app");
const selected = [...results, ...recoveryResults].filter((item) => item.class === "CERTIFIED_CLEAN");
const mediaChecks: Array<AnyRecord> = [];
for (let offset = 0; offset < selected.length; offset += 20) {
  const batch = selected.slice(offset, offset + 20);
  const checked = await Promise.all(batch.map(async (item) => {
    const pathValue = text(item.media.storagePath);
    if (!pathValue) return { id: item.id, readable: false, reason: "NO_MANAGED_STORAGE_PATH" };
    try {
      const [metadata] = await storage.file(pathValue).getMetadata();
      const contentType = text(metadata.contentType);
      const size = Number(metadata.size || 0);
      return { id: item.id, readable: true, contentType, size, supported: /^image\/(webp|png|jpeg)$/iu.test(contentType) && size > 0 && size <= 2_000_000 };
    } catch (error) {
      return { id: item.id, readable: false, reason: String(error) };
    }
  }));
  mediaChecks.push(...checked);
  console.error(`Managed-media metadata checks ${Math.min(offset + batch.length, selected.length)}/${selected.length}`);
}
const mediaById = new Map(mediaChecks.map((item) => [text(item.id), item]));
for (const item of selected) {
  const media = mediaById.get(item.id);
  if (!media?.readable || media.supported !== true) { item.class = "OTHER_BLOCKER"; item.blockers = [...new Set([...item.blockers, "MEDIA_READABILITY_FAILED"])]; }
}
const potentialCertified = [...results, ...recoveryResults].filter((item) => item.class === "CERTIFIED_CLEAN");
const fixedPool = potentialCertified.filter((item) => item.source !== "admin-recovery" && !item.source.startsWith("admin-recovery:"));
const excludedRecoveryIds = new Set(["dropex-atfch-399", "dropex-azk1753", "dropex-azkch-578", "dropex-shxch-182", "dropex-shxch-415", "dropex-shxch-972"]);
const selectedRecovery = recoveryResults
  .filter((item) => item.class === "CERTIFIED_CLEAN" && !excludedRecoveryIds.has(item.id) && !item.source.includes("requires visual confirmation"))
  .sort((a, b) => a.id.localeCompare(b.id))
  .slice(0, Math.max(0, 820 - fixedPool.length));
const certified = [...fixedPool, ...selectedRecovery];
const counts = (items: readonly Result[]) => items.reduce<Record<string, number>>((out, item) => { out[item.class] = (out[item.class] || 0) + 1; return out; }, {});
const manifest = certified.map((item) => ({ ...item, imageVerification: mediaById.get(item.id) || null }));
const report = {
  generatedAt: new Date().toISOString(), projectId: PROJECT_ID, readOnly: true,
  input: { productionCandidateRecords: workbench.candidates.length, existingSafeExpected: existingIds.length, familyExpected: familyClean.length, adminClearExpected: adminClean.length, unresolvedAdmin: unresolvedAdmin.length, collisions },
  liveTaxonomy: { canonicalActiveCategories: categories.filter((item) => item.isActive === true && item.taxonomyCandidate !== true).length, virtualNodeCount: virtual.virtualTaxonomy.nodes.length, requiredFieldsByCategory: categories.filter((item) => item.isActive === true && item.taxonomyCandidate !== true).map((item) => ({ id: item.id, required: (item.specificationTemplate || []).filter((field) => field.required).map((field) => field.name) })) },
  recertification: { existing322: { count: existingIds.length, results: counts(results.filter((item) => item.source === "existing-safe")) }, expansion449: { expected: familyClean.length + adminClean.length, results: counts(results.filter((item) => item.source !== "existing-safe" && item.source !== "admin-recovery")) }, adminRecovery: { candidatesEvaluated: recoveryCandidates.length, results: counts(recoveryResults) } },
  imageVerification: { selectedCandidates: selected.length, metadataChecked: mediaChecks.length, readable: mediaChecks.filter((item) => item.readable).length, supported: mediaChecks.filter((item) => item.supported === true).length, failures: mediaChecks.filter((item) => item.supported !== true).map((item) => item.id) },
  allResults: [...results, ...recoveryResults],
  potentialCertifiedNetNew: potentialCertified.length,
  finalSelection: { target: 820, fixedPool: fixedPool.length, recoveryAvailable: recoveryResults.filter((item) => item.class === "CERTIFIED_CLEAN").length, recoverySelected: selectedRecovery.length, excludedRecoveryIds: [...excludedRecoveryIds] },
  certifiedNetNew: certified.length,
  activeCapacity: 241 + certified.length,
  manifest,
};
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: OUT, input: report.input, recertification: report.recertification, imageVerification: report.imageVerification, certifiedNetNew: report.certifiedNetNew, activeCapacity: report.activeCapacity }, null, 2));
