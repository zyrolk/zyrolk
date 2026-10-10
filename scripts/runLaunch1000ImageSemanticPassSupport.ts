export type Launch1000RawRecord = Record<string, unknown> & { managedMedia?: unknown };

function text(value: unknown): string { return String(value ?? "").trim(); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function arrayText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" ? [item] : [text(record(item).name || record(item).value || record(item).label)].filter(Boolean));
}

export function categoryFromData(id: string, value: Record<string, unknown>) {
  const subcategories = Array.isArray(value.subcategories)
    ? value.subcategories.map((item) => { const entry = record(item); return { id: text(entry.id), name: text(entry.name), isActive: entry.isActive !== false }; }).filter((item) => item.id && item.name)
    : [];
  const specificationTemplate = Array.isArray(value.specificationTemplate)
    ? value.specificationTemplate.map((item) => { const entry = record(item); return { name: text(entry.name), required: entry.required === true }; }).filter((item) => item.name)
    : [];
  return { id, name: text(value.name || id), isActive: value.isActive === true, taxonomyCandidate: value.taxonomyCandidate === true, subcategories, specificationTemplate, keywords: arrayText(value.keywords) };
}
