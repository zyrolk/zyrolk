export type SupplierProductFieldOwner = 'admin' | 'supplier';

export interface SupplierProductFieldOwnershipEntry {
  owner: SupplierProductFieldOwner;
  sourceId: string | null;
  updatedAt: unknown;
  updatedBy: string;
  reason: 'admin_product_edit' | 'review_decision' | 'supplier_import' | 'legacy_default';
}

export type SupplierProductFieldOwnership = Record<string, SupplierProductFieldOwnershipEntry>;

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

export function parseSupplierProductFieldOwnership(value: unknown): SupplierProductFieldOwnership {
  const result: SupplierProductFieldOwnership = {};
  for (const [field, rawEntry] of Object.entries(asRecord(value))) {
    const entry = asRecord(rawEntry);
    const rawOwner = typeof rawEntry === 'string' ? rawEntry : entry.owner;
    if (rawOwner !== 'admin' && rawOwner !== 'supplier') continue;
    result[field] = {
      owner: rawOwner,
      sourceId: typeof entry.sourceId === 'string' && entry.sourceId.trim() ? entry.sourceId.trim() : null,
      updatedAt: entry.updatedAt ?? null,
      updatedBy: typeof entry.updatedBy === 'string' ? entry.updatedBy : 'legacy',
      reason: entry.reason === 'admin_product_edit'
        || entry.reason === 'review_decision'
        || entry.reason === 'supplier_import'
        || entry.reason === 'legacy_default'
        ? entry.reason
        : 'legacy_default',
    };
  }
  return result;
}

export function claimAdminProductFieldOwnership(
  current: unknown,
  fields: readonly string[],
  updatedBy: string,
  updatedAt: unknown,
): SupplierProductFieldOwnership {
  const result = parseSupplierProductFieldOwnership(current);
  for (const field of fields) {
    result[field] = {
      owner: 'admin',
      sourceId: null,
      updatedAt,
      updatedBy,
      reason: 'admin_product_edit',
    };
  }
  return result;
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value ?? null;
};

export function changedProductOwnershipFields(
  previous: Readonly<Record<string, unknown>> | undefined,
  next: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): string[] {
  if (!previous) return [...fields];
  return fields.filter((field) => JSON.stringify(canonical(previous[field])) !== JSON.stringify(canonical(next[field])));
}
