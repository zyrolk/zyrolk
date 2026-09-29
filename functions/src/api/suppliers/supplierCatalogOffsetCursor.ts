const OFFSET_CURSOR_PATTERN = /^offset:(0|[1-9][0-9]*)$/u;

/** Canonical cursor for connectors that declare `catalogPosition: "absolute_raw_offset"`. */
export function encodeSupplierCatalogOffsetCursor(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Supplier catalogue offset must be a non-negative safe integer.");
  }
  return `offset:${offset}`;
}

/** Returns the raw rows already consumed, or null when the value is not a canonical offset cursor. */
export function parseSupplierCatalogOffsetCursor(cursor: unknown): number | null {
  if (typeof cursor !== "string") return null;
  const match = OFFSET_CURSOR_PATTERN.exec(cursor);
  if (!match) return null;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? offset : null;
}
