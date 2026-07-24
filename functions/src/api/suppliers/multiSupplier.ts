export interface SupplierPriorityCandidate {
  supplierId: string;
  sourceId: string;
  priority: number;
}

export interface SupplierProductIdentity extends SupplierPriorityCandidate {
  sku?: string;
  barcode?: string;
  supplierProductKey?: string;
}

export interface SupplierConflict {
  reason: "duplicate_sku" | "duplicate_barcode" | "duplicate_supplier_product";
  winner: SupplierPriorityCandidate;
  rejected: SupplierPriorityCandidate;
  value: string;
}

export interface SupplierHealthInput {
  successfulRuns?: unknown;
  failedRuns?: unknown;
  averageLatencyMs?: unknown;
  lastSuccessfulSyncAt?: unknown;
  lastFailedSyncAt?: unknown;
}

const number = (value: unknown): number => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const normalized = (value: unknown): string => String(value || "").trim().toLocaleLowerCase();

/** Larger priority wins; ID makes equal-priority resolution deterministic. */
export function resolveSupplierPriority<T extends SupplierPriorityCandidate>(left: T, right: T): T {
  if (left.priority !== right.priority) return left.priority > right.priority ? left : right;
  return left.sourceId.localeCompare(right.sourceId) <= 0 ? left : right;
}

/** Detects conflicts without selecting or mutating product data. */
export function detectSupplierProductConflicts(items: readonly SupplierProductIdentity[]): SupplierConflict[] {
  const winnersBySku = new Map<string, SupplierProductIdentity>();
  const winnersByBarcode = new Map<string, SupplierProductIdentity>();
  const seenSupplierProducts = new Set<string>();
  const conflicts: SupplierConflict[] = [];
  for (const item of items) {
    const supplierProductKey = normalized(item.supplierProductKey || `${item.sourceId}:${item.sku || ""}`);
    if (supplierProductKey && seenSupplierProducts.has(supplierProductKey)) {
      conflicts.push({ reason: "duplicate_supplier_product", winner: item, rejected: item, value: supplierProductKey });
      continue;
    }
    if (supplierProductKey) seenSupplierProducts.add(supplierProductKey);
    for (const [reason, value, winners] of [
      ["duplicate_sku", normalized(item.sku), winnersBySku],
      ["duplicate_barcode", normalized(item.barcode), winnersByBarcode],
    ] as const) {
      if (!value) continue;
      const existing = winners.get(value);
      if (!existing) {
        winners.set(value, item);
        continue;
      }
      const winner = resolveSupplierPriority(existing, item);
      const rejected = winner === item ? existing : item;
      winners.set(value, winner);
      conflicts.push({ reason, winner, rejected, value });
    }
  }
  return conflicts;
}

/** Cumulative, factual health summary suitable for a source document. */
export function buildSupplierHealth(previous: SupplierHealthInput, outcome: "success" | "failure", latencyMs: number, nowIso: string): Record<string, unknown> {
  const successfulRuns = number(previous.successfulRuns) + (outcome === "success" ? 1 : 0);
  const failedRuns = number(previous.failedRuns) + (outcome === "failure" ? 1 : 0);
  const totalRuns = successfulRuns + failedRuns;
  const previousLatencySamples = Math.max(0, totalRuns - 1);
  const averageLatencyMs = Math.round(((number(previous.averageLatencyMs) * previousLatencySamples) + Math.max(0, latencyMs)) / Math.max(1, totalRuns));
  return {
    availability: outcome === "success" ? "available" : "unavailable",
    successfulRuns,
    failedRuns,
    successRate: totalRuns ? Math.round((successfulRuns / totalRuns) * 10_000) / 100 : 0,
    failureRate: totalRuns ? Math.round((failedRuns / totalRuns) * 10_000) / 100 : 0,
    averageLatencyMs,
    lastSuccessfulSyncAt: outcome === "success" ? nowIso : previous.lastSuccessfulSyncAt || null,
    lastFailedSyncAt: outcome === "failure" ? nowIso : previous.lastFailedSyncAt || null,
  };
}
