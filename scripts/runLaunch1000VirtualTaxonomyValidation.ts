import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateSupplierProductForApproval, type StoreCategoryMappingCandidate } from "../functions/src/api/suppliers/supplierProductMapping";

type RawCandidate = {
  id: string;
  sourceId?: string;
  sku?: string;
  title?: string;
  description?: string;
  productType?: string;
  features?: unknown[];
  specifications?: Record<string, unknown>;
  brand?: string;
  supplierTaxonomy?: string[];
  stock?: number;
  price?: number;
  mediaReady?: boolean;
  supplierAttributionValid?: boolean;
  otherBlockers?: string[];
};

type SemanticResult = {
  candidateId: string;
  sku: string;
  title: string;
  classification: string;
  specDisposition?: string;
  riskFlags?: string[];
};

type Family = {
  id: string;
  parentId: string;
  parentLabel: string;
  subcategory: string;
  keywords: string[];
  kind: "virtual_subcategory" | "existing_taxonomy" | "new_top_level";
};

const OUTPUT = path.resolve(".local/launch-1000/virtual-taxonomy-validation.json");
const INPUT = path.resolve(".local/launch-1000/taxonomy-workbench-dry-run-v3.json");
const SEMANTIC = path.resolve(".local/launch-1000/image-semantic-pass-r8.json");
const TAXONOMY = path.resolve(".local/tax-ai-2/benchmark-input.json");

const families: Family[] = [
  ["F01", "fashion", "Fashion", "Bags & Travel", ["bag", "backpack", "tote bag", "purse", "wallet", "passport cover", "waist pack", "cross bag", "chest bag", "lunch bag", "dry bag", "cosmetic bag"], "virtual_subcategory"],
  ["F02", "fashion", "Fashion", "Jewelry & Accessories", ["necklace", "earring", "ear cuff", "bracelet", "choker", "pendant", "payal", "ankle bracelet", "chain"], "virtual_subcategory"],
  ["F03", "fashion", "Fashion", "Clothing & Hosiery", ["stocking", "socks", "bra", "night dress", "raincoat"], "virtual_subcategory"],
  ["F04", "fashion", "Fashion", "Watches", ["watch"], "existing_taxonomy"],
  ["F05", "health-beauty", "Health & Beauty", "Hair Accessories & Styling", ["wig", "hair band", "hair clip", "hair scarf", "hair bun", "hair colour", "hair color", "hair dye", "hair wax", "hair pomade", "hair growth", "hair oil", "hair soap", "hair curler", "hair braider", "hair clipper"], "virtual_subcategory"],
  ["F06", "health-beauty", "Health & Beauty", "Skin & Body Care", ["body butter", "cream", "lotion", "scrub", "sunscreen", "sun cream", "lip balm", "whitening", "anti aging", "anti wrinkle", "skin", "facial", "face corrector", "foot smoothing", "crack healing", "skin tag", "tattoo", "slimming", "booster balm", "body fluid", "henna"], "virtual_subcategory"],
  ["F07", "health-beauty", "Health & Beauty", "Beauty Tools", ["eyeliner", "eye liner", "manicure", "pedicure", "nail", "ear cleaning", "earwax", "massage device", "massager", "pore cleaner", "facial scrubber", "depilatory", "reading glasses", "denture", "nasal", "hearing aid", "therapy device"], "virtual_subcategory"],
  ["F08", "sports-outdoors", "Sports & Outdoors", "Fitness & Sports", ["gym", "fitness", "exercise", "push up", "resistance band", "knee pad", "knee supporter", "knee guard", "posture corrector", "punching bag", "sports", "skating shoes"], "new_top_level"],
  ["F09", "sports-outdoors", "Sports & Outdoors", "Camping & Outdoor", ["camping", "hammock", "outdoor", "inflatable sofa", "inflatable bed", "portable water can", "foldable chair"], "new_top_level"],
  ["F10", "kids-toys", "Kids & Toys", "Toys & Games", ["toy", "game", "doll", "teddy", "bubble machine", "magic sketch", "battle tank", "microscope", "magnetic sticks", "water fireworks", "water pistol", "playing cards", "games console"], "virtual_subcategory"],
  ["F11", "kids-toys", "Kids & Toys", "Learning & School", ["book", "workbook", "stationery", "stationary", "highlighter", "marker", "pencil box", "chalkboard", "alphabetical", "tracing", "multiplication", "anatomy", "school backpack", "school bag"], "virtual_subcategory"],
  ["F12", "automotive", "Automotive", "Interior & Storage", ["car phone holder", "phone holder", "visor", "arm rest", "seat storage", "gear shift", "dashboard", "dining tray", "storage net", "sunshade", "car clock", "air freshener", "car decoration", "under glow", "steering", "seat cover", "car carpet"], "virtual_subcategory"],
  ["F13", "automotive", "Automotive", "Electrical & Lighting", ["inverter", "charger", "monitor", "siren", "horn", "push to start", "battery terminal", "car interior light", "fog light", "rear view mirror", "rear view monitor", "car light", "car wind power"], "virtual_subcategory"],
  ["F14", "automotive", "Automotive", "Vehicle Care", ["wiper", "tire repair", "tyre", "paint repair", "paint removal", "rust remover", "polishing", "anti friction", "engine performance", "mud flap", "mud guard", "bumper protector", "dent puller", "leather care", "sealing spray", "scratch wax"], "virtual_subcategory"],
  ["F15", "automotive", "Automotive", "Parts & Accessories", ["vehicle combo", "car spring", "footboards", "bike", "motorcycle", "jeep", "gps tracker"], "virtual_subcategory"],
  ["F16", "home-garden", "Home & Garden", "Power Tools & Accessories", ["grinder", "drill", "impact driver", "air blower", "grass cutting", "foam cutting", "pressure gun", "revert gun", "engraver"], "virtual_subcategory"],
  ["F17", "home-garden", "Home & Garden", "Hand Tools & Measuring", ["torque", "wrench", "pliers", "screwdriver", "ruler", "protractor", "level", "wire stripper", "crimp", "cutter", "shovel", "sickle", "angle ruler", "measuring", "metal detector", "wood carving", "tile cutting", "tile chamfer", "grinding wheel", "grinding disc", "polishing wheels", "wire pulling", "key hider", "repair set", "tool set", "driver set", "cabinet jack", "fastener"], "virtual_subcategory"],
  ["F18", "home-garden", "Home & Garden", "Welding & Soldering", ["welding", "solder", "desold", "de solder"], "virtual_subcategory"],
  ["F19", "home-garden", "Home & Garden", "Storage & Organization", ["rack", "shelf", "shelves", "storage", "organizer", "hanger", "basket", "container", "shoe rack", "book rack", "drawer", "clothes rope", "laundry basket", "storage bag", "storage box", "key box"], "virtual_subcategory"],
  ["F20", "home-garden", "Home & Garden", "Decor & Wall Coverings", ["wall sticker", "wall art", "wall decor", "mirror wall", "curtain", "flower", "art print", "rug", "carpet", "door curtain", "tile border", "floor sticker", "mandala", "lucky tree", "art pin", "table cloth", "artificial flowers"], "virtual_subcategory"],
  ["F21", "solar-lighting", "Solar & Lighting", "Decorative & Portable Lighting", ["led", "lamp", "light", "lantern", "searchlight", "torch", "solar lamp", "solar light", "night light", "touch lamp", "photo clip string light", "spot light", "light bulb"], "virtual_subcategory"],
  ["F22", "home-garden", "Home & Garden", "Cleaning & Laundry", ["cleaning", "mop", "duster", "dust", "laundry", "washing machine", "soap dispenser", "soap box", "drain", "mould", "mold", "pest repeller", "mosquito", "clothes dryer"], "virtual_subcategory"],
  ["F23", "home-kitchen", "Home & Kitchen", "Cookware & Bakeware", ["cookware", "fry pan", "wok", "coffee pot", "mocha", "baking pan", "pot set", "stock pot", "milk pot", "grill", "stove top", "baking tray", "donut maker", "egg cooker", "multi cooker", "ice cream maker", "lunch box", "dinner plate", "tableware"], "virtual_subcategory"],
  ["F24", "home-kitchen", "Home & Kitchen", "Kitchen Utensils & Storage", ["kitchen", "can opener", "vegetable slicer", "cutting board", "dish rack", "faucet", "tap", "sink", "strainer", "food storage", "water bottle", "dispenser", "apron", "pizza", "chop", "fish net"], "virtual_subcategory"],
  ["F25", "home-garden", "Home & Garden", "Garden & Irrigation", ["garden", "gardening", "plant", "fertilizer", "spray machine", "sprinkler", "water pump", "water fountain", "flower pot", "grafting", "tree climbing", "mist cooling", "fence shading"], "virtual_subcategory"],
  ["F26", "electronics", "Electronics", "Audio & Portable Devices", ["speaker", "ultrapods", "airpod", "wireless ear", "drone", "camera", "recorder", "projector", "keyboard"], "virtual_subcategory"],
  ["F27", "electronics", "Electronics", "Charging & Power", ["power bank", "wireless charger", "charging cable", "ups", "power saver", "solar battery", "c type lighter"], "virtual_subcategory"],
  ["F28", "home-garden", "Home & Garden", "Pet & Aquarium", ["aquarium", "fish tank", "kitty", "pet", "cat", "dog"], "virtual_subcategory"],
  ["F29", "home-garden", "Home & Garden", "Home Repair & Adhesives", ["glue", "adhesive", "sealant", "caulk", "crack filler", "repair paste", "waterproof strip", "hinge", "door handle", "bracket", "chair leg", "frosted glass paint", "wall repair paint", "paint removal", "wire pasting", "silicon"], "virtual_subcategory"],
  ["F30", "sports-outdoors", "Sports & Outdoors", "Safety & Protective Gear", ["gloves", "helmet", "protective", "safety", "guard", "supporter", "baton", "knuckles"], "new_top_level"],
].map(([id, parentId, parentLabel, subcategory, keywords, kind]) => ({ id, parentId, parentLabel, subcategory, keywords, kind } as Family));

function normalized(value: unknown): string { return ` ${String(value || "").toLowerCase().replace(/[^a-z0-9]+/gu, " ")} `; }
function hasKeyword(title: string, keywords: readonly string[]): boolean {
  const value = normalized(title);
  return keywords.some((keyword) => value.includes(` ${keyword} `));
}
function familyFor(title: string): Family | undefined { return families.find((family) => hasKeyword(title, family.keywords)); }
function text(value: unknown): string { return String(value ?? "").trim(); }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function productTypeFor(raw: RawCandidate, family: Family): { value: string; deterministic: boolean } {
  const specs = asRecord(raw.specifications);
  const explicit = text(raw.productType || specs["Product Type"] || specs.productType);
  if (explicit) return { value: explicit, deterministic: true };
  const title = text(raw.title);
  const typeTerms = family.keywords.filter((keyword) => hasKeyword(title, [keyword]));
  if (typeTerms.length > 0) return { value: typeTerms[0].replace(/\b\w/gu, (letter) => letter.toUpperCase()), deterministic: true };
  return { value: "", deterministic: false };
}

function makeValidatorProduct(raw: RawCandidate, categoryId: string, subcategoryId: string, productType: string): Record<string, unknown> {
  const specs = { ...asRecord(raw.specifications), ...(productType ? { "Product Type": productType } : {}) };
  return {
    name: text(raw.title),
    description: text(raw.description),
    price: Number(raw.price),
    costPrice: 0,
    stock: Number(raw.stock),
    imageUrl: raw.mediaReady === true ? `https://managed-media.local/${encodeURIComponent(raw.id)}.webp` : "",
    category: categoryId,
    subcategory: subcategoryId,
    specs,
    supplierMetadata: { supplierCostAvailable: true, supplierStockAvailable: true },
    isActive: false,
    brand: text(raw.brand),
  };
}

function cloneTaxonomy(value: unknown): StoreCategoryMappingCandidate[] {
  const source = asRecord(value);
  const categories = Array.isArray(source.categories) ? source.categories : [];
  return categories.map((item) => {
    const category = asRecord(item);
    return {
      id: text(category.id),
      name: text(category.name),
      isActive: category.isActive === true,
      subcategories: Array.isArray(category.subcategories) ? category.subcategories.map((child) => {
        const subcategory = asRecord(child);
        return { id: text(subcategory.id), name: text(subcategory.name), isActive: subcategory.isActive !== false };
      }) : [],
      specificationTemplate: [{ name: "Product Type", required: true }],
    };
  }).filter((category) => category.id && category.name && category.isActive);
}

function addVirtualNodes(categories: StoreCategoryMappingCandidate[]): { categories: StoreCategoryMappingCandidate[]; collisions: string[]; nodes: Array<Record<string, unknown>> } {
  const byParent = new Map(categories.map((category) => [category.id, category]));
  const existingIds = new Set(categories.flatMap((category) => (category.subcategories || []).map((subcategory) => subcategory.id)));
  const collisions: string[] = [];
  const nodes: Array<Record<string, unknown>> = [];
  for (const family of families.filter((item) => item.kind === "virtual_subcategory")) {
    const parent = byParent.get(family.parentId);
    const slug = `virtual-${family.id.toLowerCase()}`;
    if (!parent || !parent.isActive) continue;
    if (parent.subcategories?.some((subcategory) => subcategory.name.toLowerCase() === family.subcategory.toLowerCase()) || existingIds.has(slug)) {
      collisions.push(`${family.parentId}:${family.subcategory}`);
      continue;
    }
    parent.subcategories = [...(parent.subcategories || []), { id: slug, name: family.subcategory, isActive: true }];
    existingIds.add(slug);
    nodes.push({ id: slug, parentId: family.parentId, name: family.subcategory, familyId: family.id });
  }
  return { categories, collisions, nodes };
}

function classifyOne(raw: RawCandidate, result: SemanticResult, categories: StoreCategoryMappingCandidate[], family: Family): Record<string, unknown> {
  if (family.kind === "new_top_level") return { candidateId: result.candidateId, sku: result.sku, title: result.title, familyId: family.id, outcome: "TAXONOMY_AMBIGUOUS", blockers: ["TOP_LEVEL_CATEGORY_REQUIRED"] };
  const parent = categories.find((category) => category.id === family.parentId);
  const subcategoryId = family.kind === "existing_taxonomy"
    ? parent?.subcategories?.find((subcategory) => subcategory.name.toLowerCase() === family.subcategory.toLowerCase())?.id || ""
    : `virtual-${family.id.toLowerCase()}`;
  if (!parent || !subcategoryId) return { candidateId: result.candidateId, sku: result.sku, title: result.title, familyId: family.id, outcome: "OTHER_BLOCKER", blockers: ["VIRTUAL_TAXONOMY_NODE_INVALID"] };
  const type = productTypeFor(raw, family);
  const product = makeValidatorProduct(raw, parent.id, subcategoryId, type.value);
  const errors = validateSupplierProductForApproval(product, categories, []);
  const blockers = errors.map((error) => `${error.field}:${error.code}`);
  if (raw.mediaReady !== true) blockers.push("MEDIA_NOT_READY");
  if (raw.supplierAttributionValid !== true) blockers.push("INVALID_ATTRIBUTION");
  if (result.riskFlags?.length) blockers.push("POLICY_REVIEW_REQUIRED");
  if (blockers.length) {
    const specBlock = blockers.some((blocker) => blocker.startsWith("specs."));
    return { candidateId: result.candidateId, sku: result.sku, title: result.title, familyId: family.id, outcome: specBlock && !type.deterministic ? "ADMIN_SPEC_CHOICE" : "OTHER_BLOCKER", taxonomy: { categoryId: parent.id, subcategoryId }, deterministicProductType: type.deterministic, blockers };
  }
  return { candidateId: result.candidateId, sku: result.sku, title: result.title, familyId: family.id, outcome: type.deterministic && !text(raw.productType) ? "CLEAN_AFTER_DETERMINISTIC_SPEC" : "CLEAN_AFTER_TAXONOMY", taxonomy: { categoryId: parent.id, subcategoryId }, deterministicProductType: type.deterministic, blockers: [] };
}

const base = JSON.parse(await readFile(INPUT, "utf8")) as { candidates: RawCandidate[] };
const semantic = JSON.parse(await readFile(SEMANTIC, "utf8")) as { results: SemanticResult[] };
const taxonomyInput = JSON.parse(await readFile(TAXONOMY, "utf8")) as { taxonomy: unknown };
const rawById = new Map(base.candidates.map((candidate) => [candidate.id, candidate]));
const semanticById = new Map(semantic.results.map((result) => [result.candidateId, result]));
const candidates = semantic.results.filter((result) => result.classification === "NEW_TAXONOMY_NEEDED");
const familyAssignments = candidates.map((result) => ({ result, raw: rawById.get(result.candidateId), family: familyFor(result.title) })).filter((item): item is { result: SemanticResult; raw: RawCandidate; family: Family } => Boolean(item.raw && item.family));
const familyCandidateIds = new Set(familyAssignments.map((item) => item.result.candidateId));
const categories = cloneTaxonomy(taxonomyInput.taxonomy);
const overlay = addVirtualNodes(categories);
const familyResults = familyAssignments.map((item) => classifyOne(item.raw, item.result, overlay.categories, item.family));
const adminCandidates = semantic.results.filter((result) => result.classification === "ADMIN_CHOICE");
const adminResults = adminCandidates.map((result) => {
  const raw = rawById.get(result.candidateId);
  const family = raw ? familyFor(result.title) : undefined;
  if (!raw || !family || family.kind === "new_top_level") return { candidateId: result.candidateId, sku: result.sku, title: result.title, outcome: "ADMIN_CHOICE_STILL_REQUIRED" };
  return { ...classifyOne(raw, result, overlay.categories, family), adminResolution: family.kind === "existing_taxonomy" ? "CLEAR_EXISTING_TAXONOMY" : "CLEAR_VIRTUAL_SUBCATEGORY" };
});
const counts = (items: Array<Record<string, unknown>>) => items.reduce<Record<string, number>>((out, item) => { const key = text(item.outcome); out[key] = (out[key] || 0) + 1; return out; }, {});
const byFamily = new Map<string, { family: Family; count: number; clean: number; examples: string[] }>();
for (const item of familyAssignments) {
  const existing = byFamily.get(item.family.id) || { family: item.family, count: 0, clean: 0, examples: [] };
  existing.count += 1;
  if (item.result && (familyResults.find((result) => result.candidateId === item.result.candidateId)?.outcome === "CLEAN_AFTER_TAXONOMY" || familyResults.find((result) => result.candidateId === item.result.candidateId)?.outcome === "CLEAN_AFTER_DETERMINISTIC_SPEC")) existing.clean += 1;
  if (existing.examples.length < 5) existing.examples.push(item.result.title);
  byFamily.set(item.family.id, existing);
}
const mismatchIds = new Set(["dropex-atfch-313"]);
const mismatchResults = [...familyResults, ...adminResults].filter((result) => mismatchIds.has(text(result.candidateId)));
const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  inputReconciliation: {
    existingSafeTaxonomy: semantic.results.filter((result) => result.classification === "HIGH_CONFIDENCE_EXISTING_TAXONOMY").length,
    draftFamilyCandidates: familyAssignments.length,
    adminChoiceCandidates: adminCandidates.length,
    unclusteredNoMatch: candidates.length - familyAssignments.length,
    policyHolds: semantic.results.filter((result) => result.classification === "POLICY_HOLD").length,
    total: semantic.results.length,
    overlapFree: familyAssignments.length + (candidates.length - familyAssignments.length) + adminCandidates.length + semantic.results.filter((result) => result.classification === "POLICY_HOLD").length + semantic.results.filter((result) => result.classification === "HIGH_CONFIDENCE_EXISTING_TAXONOMY").length === semantic.results.length,
  },
  virtualTaxonomy: { nodes: overlay.nodes, nodeCount: overlay.nodes.length, collisions: overlay.collisions, sportsIncluded: false },
  familyCounts: [...byFamily.values()].sort((a, b) => b.count - a.count).map((item) => ({ familyId: item.family.id, parentId: item.family.parentId, parentLabel: item.family.parentLabel, proposedSubcategory: item.family.subcategory, kind: item.family.kind, candidateCount: item.count, simulatedClean: item.clean, examples: item.examples })),
  familyResults,
  familyOutcomeCounts: counts(familyResults),
  adminOutcomeCounts: counts(adminResults),
  adminResults,
  imageMismatchCount: mismatchResults.length,
  imageMismatchIds: [...mismatchIds].filter((id) => mismatchResults.some((result) => text(result.candidateId) === id)),
  limitations: [
    "Virtual IDs are local only and were never written to Firestore.",
    "The local candidate artifact proves managed-media readiness but does not persist every raw managed URL; simulation uses a local placeholder URL after the mediaReady gate.",
    "The local taxonomy snapshot does not preserve every production specification template; Product Type is applied conservatively as a required virtual template.",
    "Only the previously fetched representative image sample was available; no full 410-image visual review was performed.",
  ],
};
await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  input: report.inputReconciliation,
  virtualNodeCount: overlay.nodes.length,
  familyOutcomeCounts: report.familyOutcomeCounts,
  adminOutcomeCounts: report.adminOutcomeCounts,
  topFamilies: report.familyCounts.slice(0, 30),
  reportPath: OUTPUT,
}, null, 2));
