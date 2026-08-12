import {
  SupplierCatalogFilterExecution,
  SupplierConnectorSyncCapabilities,
} from "./types";

const filterExecution = (value: unknown): SupplierCatalogFilterExecution => (
  value === "supplier_native" || value === "server_side" ? value : "unsupported"
);

export const UNSUPPORTED_SUPPLIER_SYNC_CAPABILITIES: Readonly<SupplierConnectorSyncCapabilities> = Object.freeze({
  incremental: Object.freeze({ supported: false, mechanism: "unsupported", deletionSemantics: "none" }),
  categoryFilter: "unsupported",
  subcategoryFilter: "unsupported",
  searchFilter: "unsupported",
});

/** A2Z and generic HTTP expose full pages only; normalized fields permit honest local filtering. */
export const SERVER_FILTERED_FULL_CATALOG_CAPABILITIES: Readonly<SupplierConnectorSyncCapabilities> = Object.freeze({
  incremental: Object.freeze({ supported: false, mechanism: "unsupported", deletionSemantics: "none" }),
  categoryFilter: "server_side",
  subcategoryFilter: "server_side",
  searchFilter: "server_side",
});

export function normalizeSupplierConnectorSyncCapabilities(
  value: unknown,
): Readonly<SupplierConnectorSyncCapabilities> {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const incremental = record.incremental && typeof record.incremental === "object"
    ? record.incremental as Record<string, unknown>
    : {};
  const supported = incremental.supported === true;
  const mechanism = supported && ["updated_since", "delta_token", "change_cursor"].includes(String(incremental.mechanism))
    ? String(incremental.mechanism) as "updated_since" | "delta_token" | "change_cursor"
    : "unsupported";
  return Object.freeze({
    incremental: Object.freeze({
      supported: supported && mechanism !== "unsupported",
      mechanism,
      deletionSemantics: incremental.deletionSemantics === "tombstones" ? "tombstones" : "none",
    }),
    categoryFilter: filterExecution(record.categoryFilter),
    subcategoryFilter: filterExecution(record.subcategoryFilter),
    searchFilter: filterExecution(record.searchFilter),
  });
}
