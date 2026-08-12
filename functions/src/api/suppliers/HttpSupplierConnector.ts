import { createHash } from "node:crypto";
import { SupplierCatalogPageRequest, SupplierCatalogPageResult, SupplierConnectionTestResult, SupplierConnector, SupplierConnectorSyncCapabilities, SupplierConnectorType, SupplierFetchResult } from "./types";
import { fetchSupplierOutbound, SupplierOutboundPolicy } from "../security/supplierOutboundRequest";
import { SERVER_FILTERED_FULL_CATALOG_CAPABILITIES } from "./supplierSyncCapabilities";

const MAX_HTTP_SUPPLIER_CURSOR_LENGTH = 2_048;
const LOCAL_CURSOR_PREFIX = "zyro-http-local-v1.";
const LEGACY_LOCAL_CURSOR_PATTERN = /^http-local:(\d+)$/u;

interface HttpSupplierLocalCursor {
  offset: number;
  snapshotHash: string | null;
  fetchPageSize: number;
}

interface HttpSupplierLocalSnapshot {
  products: Record<string, unknown>[];
  snapshotHash: string;
  targetUrl: string;
  fetchPageSize: number;
}

interface HttpPaginationMetadata {
  cursorPresent: boolean;
  nextCursor: string | null;
  hasMorePresent: boolean;
  hasMore: boolean | null;
  totalPresent: boolean;
  total: number | null;
}

export class SupplierPaginationIntegrityError extends Error {
  readonly code = "supplier_pagination_integrity";

  constructor(message: string) {
    super(message);
    this.name = "SupplierPaginationIntegrityError";
  }
}

const paginationFailure = (message: string): never => {
  throw new SupplierPaginationIntegrityError(message);
};

const productSnapshotHash = (products: readonly Record<string, unknown>[]): string => createHash("sha256")
  .update(JSON.stringify(products))
  .digest("hex");

const metadataValues = (
  records: readonly Record<string, unknown>[],
  names: readonly string[],
): unknown[] => records.flatMap((record) => names
  .filter((name) => Object.hasOwn(record, name))
  .map((name) => record[name]));

const oneNormalizedMetadataValue = <T>(
  values: readonly unknown[],
  label: string,
  normalize: (value: unknown) => T,
): { present: boolean; value: T | null } => {
  if (values.length === 0) return { present: false, value: null };
  const normalized = values.map(normalize);
  const identities = new Set(normalized.map((value) => JSON.stringify(value)));
  if (identities.size !== 1) paginationFailure(`Supplier pagination ${label} metadata is contradictory.`);
  return { present: true, value: normalized[0] };
};

const normalizeRemoteCursor = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  const cursor = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : paginationFailure("Supplier pagination cursor metadata is invalid.");
  if (!cursor) return null;
  if (cursor.length > MAX_HTTP_SUPPLIER_CURSOR_LENGTH || /[\u0000-\u001f\u007f]/u.test(cursor)) {
    paginationFailure("Supplier pagination cursor metadata is invalid.");
  }
  return cursor;
};

const normalizeHasMore = (value: unknown): boolean => {
  if (typeof value !== "boolean") paginationFailure("Supplier pagination hasMore metadata must be a boolean.");
  return value as boolean;
};

const normalizeTotal = (value: unknown): number => {
  const normalized = typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized < 0) {
    paginationFailure("Supplier pagination total metadata must be a non-negative safe integer.");
  }
  return normalized as number;
};

const readPaginationMetadata = (data: unknown): HttpPaginationMetadata => {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  if (Object.hasOwn(root, "pagination") && (!root.pagination || typeof root.pagination !== "object" || Array.isArray(root.pagination))) {
    return paginationFailure("Supplier pagination metadata container is invalid.");
  }
  const pagination = root.pagination && typeof root.pagination === "object"
    ? root.pagination as Record<string, unknown>
    : {};
  const meta = root.meta && typeof root.meta === "object" && !Array.isArray(root.meta)
    ? root.meta as Record<string, unknown>
    : {};
  const records = [root, pagination, meta];
  const cursor = oneNormalizedMetadataValue(
    metadataValues(records, ["nextCursor", "next_cursor"]),
    "cursor",
    normalizeRemoteCursor,
  );
  const hasMore = oneNormalizedMetadataValue(
    metadataValues(records, ["hasMore", "has_more"]),
    "hasMore",
    normalizeHasMore,
  );
  const total = oneNormalizedMetadataValue(
    // `count` commonly means the current page length. Only explicit catalogue
    // total fields are trustworthy enough to prove traversal completion.
    metadataValues(records, ["total", "totalCount", "total_count"]),
    "total",
    normalizeTotal,
  );
  return {
    cursorPresent: cursor.present,
    nextCursor: cursor.value,
    hasMorePresent: hasMore.present,
    hasMore: hasMore.value,
    totalPresent: total.present,
    total: total.value,
  };
};

const encodeLocalCursor = (cursor: HttpSupplierLocalCursor): string => `${LOCAL_CURSOR_PREFIX}${Buffer.from(JSON.stringify({
  offset: cursor.offset,
  snapshotHash: cursor.snapshotHash,
  fetchPageSize: cursor.fetchPageSize,
})).toString("base64url")}`;

const parseLocalCursor = (value: string | null): HttpSupplierLocalCursor | null => {
  if (!value) return null;
  if (value.length > MAX_HTTP_SUPPLIER_CURSOR_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    return paginationFailure("Stored supplier pagination cursor is invalid.");
  }
  const legacy = LEGACY_LOCAL_CURSOR_PATTERN.exec(value);
  if (legacy) {
    const offset = Number(legacy[1]);
    if (!Number.isSafeInteger(offset) || offset < 1) paginationFailure("Stored local supplier pagination cursor is invalid.");
    return { offset, snapshotHash: null, fetchPageSize: 100 };
  }
  if (!value.startsWith(LOCAL_CURSOR_PREFIX)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(LOCAL_CURSOR_PREFIX.length), "base64url").toString("utf8")) as Record<string, unknown>;
    const offset = Number(decoded.offset);
    const fetchPageSize = Number(decoded.fetchPageSize);
    const snapshotHash = typeof decoded.snapshotHash === "string" ? decoded.snapshotHash : "";
    if (
      !Number.isSafeInteger(offset) || offset < 1
      || !Number.isInteger(fetchPageSize) || fetchPageSize < 1 || fetchPageSize > 200
      || !/^[a-f0-9]{64}$/u.test(snapshotHash)
    ) {
      return paginationFailure("Stored local supplier pagination cursor is invalid.");
    }
    return { offset, snapshotHash, fetchPageSize };
  } catch (error) {
    if (error instanceof SupplierPaginationIntegrityError) throw error;
    return paginationFailure("Stored local supplier pagination cursor is invalid.");
  }
};

export function resolveSupplierProductArray(data: unknown, dataPath = ""): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const path = dataPath.trim();
  if (!path) throw new Error("Invalid response format. Expected a JSON array of product objects.");
  const segments = path.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => !/^[a-zA-Z0-9_-]+$/u.test(segment))) {
    throw new Error("Supplier API response data path is invalid.");
  }
  let current: unknown = data;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`Supplier API response does not contain an array at "${path}".`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (!Array.isArray(current)) throw new Error(`Supplier API response does not contain an array at "${path}".`);
  return current as Record<string, unknown>[];
}

export class HttpSupplierConnector implements SupplierConnector {
  public readonly id: string;
  public readonly name: string;
  public readonly connectorType: SupplierConnectorType;
  public readonly enabled: boolean;
  public readonly priority: number;
  public readonly capabilities: readonly string[];
  public readonly syncCapabilities: Readonly<SupplierConnectorSyncCapabilities> = SERVER_FILTERED_FULL_CATALOG_CAPABILITIES;
  private readonly outboundPolicy: SupplierOutboundPolicy;
  private readonly dataPath: string;
  private localSnapshot: HttpSupplierLocalSnapshot | null = null;

  constructor(
    private readonly targetUrl: string,
    options: {
      id?: string;
      name?: string;
      connectorType?: SupplierConnectorType;
      enabled?: boolean;
      priority?: number;
      capabilities?: readonly string[];
      dataPath?: string;
      outboundPolicy: SupplierOutboundPolicy;
    },
  ) {
    this.id = options.id || "http";
    this.name = options.name || "HTTP Supplier";
    this.connectorType = options.connectorType || "http";
    this.enabled = options.enabled !== false;
    this.priority = options.priority || 100;
    this.capabilities = options.capabilities || ["catalog.fetch", "connection.test"];
    this.dataPath = options.dataPath || "";
    this.outboundPolicy = options.outboundPolicy;
  }

  public async fetchProducts(): Promise<SupplierFetchResult> {
    const { data, targetUrl } = await this.fetchJson();
    return {
      products: resolveSupplierProductArray(data, this.dataPath),
      targetUrl,
    };
  }

  private async fetchJson(targetUrl?: string): Promise<{ data: unknown; targetUrl: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const resObj = targetUrl
        ? await fetchSupplierOutbound(targetUrl, { signal: controller.signal }, this.outboundPolicy)
        : await fetchSupplierOutbound(this.targetUrl, { signal: controller.signal }, this.outboundPolicy);

      if (!resObj.ok) {
        throw new Error(`Supplier API returned HTTP ${resObj.status}`);
      }

      return { data: await resObj.json(), targetUrl: targetUrl || this.targetUrl };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async fetchProductPage(request: SupplierCatalogPageRequest): Promise<SupplierCatalogPageResult> {
    if (request.mode === "incremental") throw new Error("This HTTP supplier connector does not support native incremental synchronization.");
    const pageSize = Math.max(1, Math.min(Number(request.pageSize) || 100, 200));
    const localCursor = parseLocalCursor(request.cursor);
    if (localCursor) {
      let snapshot = this.localSnapshot;
      if (!snapshot) {
        const snapshotUrl = new URL(this.targetUrl);
        snapshotUrl.searchParams.set("limit", String(localCursor.fetchPageSize));
        const fetched = await this.fetchJson(snapshotUrl.toString());
        const metadata = readPaginationMetadata(fetched.data);
        const products = resolveSupplierProductArray(fetched.data, this.dataPath);
        const metadataSignalsContinuation = Boolean(metadata.nextCursor)
          || metadata.hasMore === true
          || (metadata.total !== null && metadata.total > products.length);
        const metadataIsContradictory = (metadata.total !== null && metadata.total < products.length)
          || (metadata.nextCursor !== null && metadata.hasMore === false);
        if (metadataSignalsContinuation || metadataIsContradictory) {
          return paginationFailure("Supplier pagination mode changed while resuming a local catalogue snapshot.");
        }
        const snapshotHash = productSnapshotHash(products);
        if (localCursor.snapshotHash && localCursor.snapshotHash !== snapshotHash) {
          return paginationFailure("Supplier catalogue changed while resuming a local pagination snapshot.");
        }
        snapshot = { products, snapshotHash, targetUrl: fetched.targetUrl, fetchPageSize: localCursor.fetchPageSize };
        this.localSnapshot = snapshot;
      }
      if (localCursor.snapshotHash && localCursor.snapshotHash !== snapshot.snapshotHash) {
        return paginationFailure("Supplier catalogue changed while resuming a local pagination snapshot.");
      }
      if (localCursor.offset >= snapshot.products.length) {
        return paginationFailure("Stored local supplier pagination cursor is outside the catalogue snapshot.");
      }
      const products = snapshot.products.slice(localCursor.offset, localCursor.offset + pageSize);
      const consumed = localCursor.offset + products.length;
      const complete = consumed >= snapshot.products.length;
      return {
        products,
        targetUrl: snapshot.targetUrl,
        complete,
        nextCursor: complete ? null : encodeLocalCursor({
          offset: consumed,
          snapshotHash: snapshot.snapshotHash,
          fetchPageSize: snapshot.fetchPageSize,
        }),
        catalogTotal: { count: snapshot.products.length, reliability: "reported" },
      };
    }

    const remoteOffset = request.cursor && /^\d+$/u.test(request.cursor)
      ? Number(request.cursor)
      : request.cursor ? null : 0;
    if (remoteOffset !== null && (!Number.isSafeInteger(remoteOffset) || remoteOffset < 0)) {
      return paginationFailure("Stored supplier pagination cursor is invalid.");
    }
    if (request.cursor && (request.cursor.length > MAX_HTTP_SUPPLIER_CURSOR_LENGTH || /[\u0000-\u001f\u007f]/u.test(request.cursor))) {
      return paginationFailure("Stored supplier pagination cursor is invalid.");
    }
    const requestUrl = new URL(this.targetUrl);
    requestUrl.searchParams.set("limit", String(pageSize));
    if (request.cursor) {
      requestUrl.searchParams.set("cursor", request.cursor);
      if (/^\d+$/u.test(request.cursor)) requestUrl.searchParams.set("offset", request.cursor);
    }
    const { data, targetUrl } = await this.fetchJson(requestUrl.toString());
    const allProducts = resolveSupplierProductArray(data, this.dataPath);
    const metadata = readPaginationMetadata(data);
    const consumed = remoteOffset === null ? null : remoteOffset + allProducts.length;

    if (metadata.cursorPresent && metadata.nextCursor && metadata.hasMorePresent && metadata.hasMore === false) {
      return paginationFailure("Supplier pagination cursor and hasMore metadata are contradictory.");
    }
    if (metadata.cursorPresent && !metadata.nextCursor && metadata.hasMorePresent && metadata.hasMore === true) {
      return paginationFailure("Supplier pagination cursor and hasMore metadata are contradictory.");
    }
    if (consumed !== null && metadata.totalPresent && metadata.total !== null) {
      if (metadata.total < allProducts.length || (metadata.hasMore === true && consumed >= metadata.total)) {
        return paginationFailure("Supplier pagination total metadata is contradictory.");
      }
      if (metadata.hasMore === false && consumed < metadata.total) {
        return paginationFailure("Supplier pagination total metadata is contradictory.");
      }
      if (metadata.nextCursor && consumed >= metadata.total) {
        return paginationFailure("Supplier pagination cursor and total metadata are contradictory.");
      }
      if (metadata.cursorPresent && !metadata.nextCursor && consumed < metadata.total) {
        return paginationFailure("Supplier pagination cursor and total metadata are contradictory.");
      }
    }

    const signalsContinuation = Boolean(metadata.nextCursor)
      || metadata.hasMore === true
      || (consumed !== null && metadata.total !== null && consumed < metadata.total);
    const hasPaginationMetadata = metadata.cursorPresent || metadata.hasMorePresent || metadata.totalPresent;
    const isCompleteUnpaginatedSnapshot = !request.cursor
      && allProducts.length > pageSize
      && !signalsContinuation
      && !hasPaginationMetadata;

    if (isCompleteUnpaginatedSnapshot) {
      const snapshotHash = productSnapshotHash(allProducts);
      this.localSnapshot = { products: allProducts, snapshotHash, targetUrl, fetchPageSize: pageSize };
      const products = allProducts.slice(0, pageSize);
      return {
        products,
        targetUrl,
        complete: false,
        nextCursor: encodeLocalCursor({ offset: products.length, snapshotHash, fetchPageSize: pageSize }),
        catalogTotal: { count: allProducts.length, reliability: "reported" },
      };
    }

    if (allProducts.length > pageSize) {
      return paginationFailure("Supplier returned more products than the requested remote page size.");
    }

    let complete: boolean;
    let nextCursor: string | null;
    if (metadata.cursorPresent) {
      complete = metadata.nextCursor === null;
      nextCursor = metadata.nextCursor;
    } else if (metadata.hasMorePresent) {
      complete = metadata.hasMore === false;
      if (!complete && consumed === null) return paginationFailure("Supplier hasMore pagination requires a numeric offset cursor.");
      nextCursor = complete ? null : String(consumed);
    } else if (metadata.totalPresent) {
      if (consumed === null || metadata.total === null) return paginationFailure("Supplier total pagination requires a numeric offset cursor.");
      complete = consumed >= metadata.total;
      nextCursor = complete ? null : String(consumed);
    } else {
      complete = allProducts.length < pageSize;
      if (!complete && consumed === null) return paginationFailure("Supplier pagination did not provide a forward cursor.");
      nextCursor = complete ? null : String(consumed);
    }
    return {
      products: allProducts,
      targetUrl,
      nextCursor,
      complete,
      ...(metadata.total !== null
        ? { catalogTotal: { count: metadata.total, reliability: "reported" as const } }
        : {}),
    };
  }

  public async testConnection(): Promise<SupplierConnectionTestResult> {
    try {
      const result = await this.fetchProducts();
      return {
        success: true,
        status: "Connected",
        productsCount: result.products.length,
        sampleProduct: result.products[0] || null,
      };
    } catch (error: any) {
      return {
        success: false,
        status: "Failed",
        productsCount: 0,
        sampleProduct: null,
        error: error.message || "Failed to connect to the supplier endpoint.",
      };
    }
  }
}
