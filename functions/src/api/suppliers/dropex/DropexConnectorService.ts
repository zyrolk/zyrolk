import { createHash } from "node:crypto";
import { ProductParser, DropexCategoryLookup } from "./ProductParser";
import { RawA2ZProduct } from "../a2z/types";
import { sanitizeDropexResponseBody, sanitizeDropexResponseHeaders } from "./diagnostics";
import {
  DROPEX_CREDENTIAL_TARGET_URL,
  DROPEX_INVENTORY_SERVICE_URL,
  DROPEX_USER_SERVICE_URL,
} from "./constants";
import { fetchSupplierOutbound, SupplierOutboundPolicy, SupplierOutboundResponse } from "../../security/supplierOutboundRequest";
import { SupplierCatalogPageRequest, SupplierCatalogPageResult } from "../types";
import {
  DropexHttpError,
  DROPEX_TRANSIENT_HTTP_MAX_ATTEMPTS,
  classifyDropexHttpStatus,
  transientRetryDelayMs,
} from "./dropexHttpErrors";

export interface DropexSessionScope {
  supplierId: string;
  sourceId: string;
  credentialReference: string;
}

interface DropexAuthenticatedSession {
  token: string;
  expiresAt: number;
  reSellerAccountId: string;
  scopeKey: string;
  credentialFingerprint: string;
}

interface DropexConnectorServiceDependencies {
  fetchOutbound?: typeof fetchSupplierOutbound;
  now?: () => number;
}

interface DropexLoginResponse {
  access_token?: string;
  token?: string;
  accessToken?: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;

const normalizeScopeValue = (value: string, field: string): string => {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Dropex session ${field} is required.`);
  return normalized;
};

export function buildDropexSessionScopeKey(scope: DropexSessionScope): string {
  const supplierId = normalizeScopeValue(scope.supplierId, "supplier ID");
  const sourceId = normalizeScopeValue(scope.sourceId, "source ID");
  const credentialReference = normalizeScopeValue(scope.credentialReference, "credential reference");
  const parts = [supplierId, sourceId, credentialReference];
  const encoded = parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Dropex authentication returned an invalid access token.");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Dropex authentication returned a malformed access token.");
  }
}

function extractReSellerAccountId(payload: Record<string, unknown>): string {
  const account = payload.account;
  if (account && typeof account === "object" && !Array.isArray(account)) {
    const accountId = (account as Record<string, unknown>).id;
    if (accountId !== undefined && accountId !== null) return String(accountId);
  }
  const fallback = payload.accountId ?? payload.reSellerAccountId ?? payload.sub;
  if (fallback !== undefined && fallback !== null) return String(fallback);
  throw new Error("Dropex authentication token did not include a reseller account identifier.");
}

function extractTokenExpiryMs(payload: Record<string, unknown>, now: number): number {
  const exp = Number(payload.exp);
  if (Number.isFinite(exp) && exp > 0) return Math.max(now, exp * 1000 - TOKEN_REFRESH_SKEW_MS);
  return now + (15 * 60 * 1000);
}

function extractAccessToken(body: DropexLoginResponse): string {
  const token = body.access_token || body.accessToken || body.token;
  if (!token || typeof token !== "string") {
    throw new Error("Dropex authentication response did not include an access token.");
  }
  return token.trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

export function isDropexFieldAbsent(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === "string" && !value.trim());
}

function isDropexSupplierCostAbsent(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
): boolean {
  return [
    item.reSellingPrice,
    item.resellingPrice,
    item.reSellerPrice,
    item.buyingPrice,
    item.price,
    detail.reSellingPrice,
    detail.resellingPrice,
    detail.reSellerPrice,
    detail.buyingPrice,
    detail.price,
  ].every(isDropexFieldAbsent);
}

function needsDropexProductEnrichment(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
): boolean {
  const retailPriceAbsent = isDropexFieldAbsent(detail.sellingPrice)
    && isDropexFieldAbsent(item.sellingPrice)
    && isDropexFieldAbsent(item.marketPrice);
  const descriptionAbsent = isDropexFieldAbsent(detail.description)
    && isDropexFieldAbsent(item.description);
  const imageAbsent = isDropexFieldAbsent(detail.image)
    && isDropexFieldAbsent(item.image);
  const inventoryAbsent = isDropexFieldAbsent(detail.onHandInventory)
    && isDropexFieldAbsent(item.onHandInventory)
    && isDropexFieldAbsent(item.stock);
  const categoryAbsent = [
    detail.productCategoryId,
    detail.categoryId,
    item.productCategoryId,
    item.categoryId,
    detail.categoryName,
    detail.category,
    item.categoryName,
    item.category,
    detail.productCategory,
    item.productCategory,
  ].every(isDropexFieldAbsent);

  return retailPriceAbsent
    || descriptionAbsent
    || imageAbsent
    || isDropexSupplierCostAbsent(item, detail)
    || inventoryAbsent
    || categoryAbsent;
}

export class DropexConnectorService {
  private session: DropexAuthenticatedSession | null = null;
  private loginInFlight: { credentialFingerprint: string; promise: Promise<DropexAuthenticatedSession> } | null = null;
  private categoryLookup: DropexCategoryLookup | null = null;
  private readonly sessionScopeKey: string;
  private readonly fetchOutbound: typeof fetchSupplierOutbound;
  private readonly now: () => number;

  constructor(
    scope: DropexSessionScope,
    dependencies: DropexConnectorServiceDependencies = {},
  ) {
    this.sessionScopeKey = buildDropexSessionScopeKey(scope);
    this.fetchOutbound = dependencies.fetchOutbound || fetchSupplierOutbound;
    this.now = dependencies.now || Date.now;
  }

  private debugLog(...values: unknown[]): void {
    if (process.env.SUPPLIER_DEBUG_LOGS === "true") console.info(...values);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private logDiagnostic(authenticationStage: string, details: Record<string, unknown>): void {
    this.debugLog("[Dropex-Connector]", JSON.stringify({
      event: "dropex_integration_diagnostic",
      authenticationStage,
      ...details,
    }));
  }

  private credentialFingerprint(credentials: { username?: string; password?: string }): string {
    const username = credentials.username;
    const password = credentials.password;
    if (!username || !password) {
      throw new Error("Dropex credentials are required before attempting supplier login.");
    }
    return createHash("sha256").update(`${username}:${password}`, "utf8").digest("hex");
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    outboundPolicy: SupplierOutboundPolicy,
  ): Promise<SupplierOutboundResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchOutbound(url, { ...init, signal: controller.signal }, outboundPolicy);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private reusableSession(credentials: { username?: string; password?: string }): DropexAuthenticatedSession | null {
    const credentialFingerprint = this.credentialFingerprint(credentials);
    if (!this.session
      || this.session.scopeKey !== this.sessionScopeKey
      || this.session.credentialFingerprint !== credentialFingerprint
      || this.session.expiresAt <= this.now()) {
      return null;
    }
    return this.session;
  }

  private async login(
    credentials: { username: string; password: string },
    outboundPolicy: SupplierOutboundPolicy,
  ): Promise<DropexAuthenticatedSession> {
    const credentialFingerprint = this.credentialFingerprint(credentials);
    if (this.loginInFlight?.credentialFingerprint === credentialFingerprint) {
      return this.loginInFlight.promise;
    }

    const promise = (async () => {
      const response = await this.fetchWithTimeout(`${DROPEX_USER_SERVICE_URL}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          username: credentials.username,
          password: credentials.password,
        }),
      }, outboundPolicy);

      const responseBodyText = await response.text();
      this.logDiagnostic("login", {
        endpoint: `${DROPEX_USER_SERVICE_URL}/auth/login`,
        method: "POST",
        httpStatus: response.status,
        responseHeaders: sanitizeDropexResponseHeaders(response.headers),
        responseBody: sanitizeDropexResponseBody(responseBodyText),
      });

      const httpError = classifyDropexHttpStatus(response.status, response.headers.get("retry-after"), this.now());
      if (httpError) throw httpError;

      let parsed: DropexLoginResponse;
      try {
        parsed = JSON.parse(responseBodyText) as DropexLoginResponse;
      } catch {
        throw new Error("Dropex authentication response was not valid JSON.");
      }

      const token = extractAccessToken(parsed);
      const payload = decodeJwtPayload(token);
      const session: DropexAuthenticatedSession = {
        token,
        expiresAt: extractTokenExpiryMs(payload, this.now()),
        reSellerAccountId: extractReSellerAccountId(payload),
        scopeKey: this.sessionScopeKey,
        credentialFingerprint,
      };
      this.session = session;
      this.categoryLookup = null;
      return session;
    })();

    this.loginInFlight = { credentialFingerprint, promise };
    try {
      return await promise;
    } finally {
      if (this.loginInFlight?.promise === promise) this.loginInFlight = null;
    }
  }

  private async authorizedRequest(
    credentials: { username: string; password: string },
    outboundPolicy: SupplierOutboundPolicy,
    buildRequest: (token: string) => { url: string; init: RequestInit },
    allowAuthRetry = true,
  ): Promise<{ response: SupplierOutboundResponse; bodyText: string }> {
    let activeSession = this.reusableSession(credentials);
    if (!activeSession) {
      activeSession = await this.login(credentials, outboundPolicy);
    }

    const execute = async (session: DropexAuthenticatedSession) => {
      const request = buildRequest(session.token);
      const response = await this.fetchWithTimeout(request.url, {
        ...request.init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
          ...(request.init.headers || {}),
        },
      }, outboundPolicy);
      const bodyText = await response.text();
      return { response, bodyText };
    };

    let result = await execute(activeSession);
    const authFailure = result.response.status === 401 || result.response.status === 403;
    if (authFailure && allowAuthRetry) {
      this.session = null;
      const refreshed = await this.login(credentials, outboundPolicy);
      result = await execute(refreshed);
    }
    return result;
  }

  private async loadCategoryLookup(
    credentials: { username: string; password: string },
    outboundPolicy: SupplierOutboundPolicy,
  ): Promise<DropexCategoryLookup> {
    if (this.categoryLookup) return this.categoryLookup;

    const { response, bodyText } = await this.authorizedRequest(credentials, outboundPolicy, (token) => ({
      url: `${DROPEX_INVENTORY_SERVICE_URL}/api/v1/product-categories`,
      init: {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    }));

    this.logDiagnostic("category-fetch", {
      endpoint: `${DROPEX_INVENTORY_SERVICE_URL}/api/v1/product-categories`,
      method: "GET",
      httpStatus: response.status,
      responseHeaders: sanitizeDropexResponseHeaders(response.headers),
      responseBody: sanitizeDropexResponseBody(bodyText),
    });

    const httpError = classifyDropexHttpStatus(response.status, response.headers.get("retry-after"), this.now());
    if (httpError) throw httpError;

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new Error("Failed to parse Dropex product categories as JSON.");
    }

    const parsedRecord = asRecord(parsed);
    const categories = Array.isArray(parsed)
      ? asRecordArray(parsed)
      : asRecordArray(parsedRecord?.content)
        .concat(asRecordArray(parsedRecord?.data));
    const byId = new Map<string, { category?: string; subcategory?: string; hierarchy?: string[] }>();

    for (const category of categories) {
      const categoryName = String(category.name || category.label || "").trim();
      const categoryId = category.id ?? category.categoryId;
      if (categoryId !== undefined && categoryName) {
        byId.set(String(categoryId), { category: categoryName, hierarchy: [categoryName] });
      }
      const subcategories = Array.isArray(category.subCategories)
        ? category.subCategories
        : Array.isArray(category.subcategories)
          ? category.subcategories
          : [];
      for (const subcategory of subcategories) {
        const subRecord = asRecord(subcategory);
        if (!subRecord) continue;
        const subName = String(subRecord.name || subRecord.label || "").trim();
        const subId = subRecord.id ?? subRecord.subCategoryId;
        if (subId === undefined || !subName) continue;
        byId.set(String(subId), {
          category: categoryName || undefined,
          subcategory: subName,
          hierarchy: [categoryName, subName].filter(Boolean),
        });
      }
    }

    this.categoryLookup = {
      resolveCategory: (value: unknown) => byId.get(String(value ?? "")) || {},
    };
    return this.categoryLookup;
  }

  private async enrichProductDto(
    credentials: { username: string; password: string },
    outboundPolicy: SupplierOutboundPolicy,
    productId: string,
  ): Promise<Record<string, unknown>> {
    const { response, bodyText } = await this.authorizedRequest(credentials, outboundPolicy, (token) => ({
      url: `${DROPEX_INVENTORY_SERVICE_URL}/api/v1/products/${encodeURIComponent(productId)}/dto`,
      init: {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    }));

    const httpError = classifyDropexHttpStatus(response.status, response.headers.get("retry-after"), this.now());
    if (httpError) throw httpError;

    try {
      const parsed = JSON.parse(bodyText);
      return asRecord(parsed) || {};
    } catch {
      throw new Error(`Failed to parse Dropex product DTO for product ${productId}.`);
    }
  }

  private async fetchCatalogPageInternal(
    credentials: { username: string; password: string },
    outboundPolicy: SupplierOutboundPolicy,
    request: SupplierCatalogPageRequest,
  ): Promise<SupplierCatalogPageResult> {
    const page = Number(request.cursor || 0);
    const pageSize = Math.max(1, request.pageSize);
    if (!Number.isInteger(page) || page < 0) {
      throw new Error("Dropex catalog pagination cursor is invalid.");
    }

    let activeSession = this.reusableSession(credentials);
    if (!activeSession) {
      activeSession = await this.login(credentials, outboundPolicy);
    }

    const catalogUrl = new URL(`${DROPEX_INVENTORY_SERVICE_URL}/api/v1/re-seller-products/get`);
    catalogUrl.searchParams.set("reSellerAccountId", activeSession.reSellerAccountId);
    catalogUrl.searchParams.set("page", String(page));
    catalogUrl.searchParams.set("size", String(pageSize));

    let responseBodyText = "";
    for (let transientAttempt = 1; transientAttempt <= DROPEX_TRANSIENT_HTTP_MAX_ATTEMPTS; transientAttempt += 1) {
      try {
        const { response, bodyText } = await this.authorizedRequest(credentials, outboundPolicy, (token) => ({
          url: catalogUrl.toString(),
          init: {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          },
        }), transientAttempt === 1);
        responseBodyText = bodyText;
        this.logDiagnostic("catalog-fetch", {
          endpoint: catalogUrl.toString(),
          method: "GET",
          httpStatus: response.status,
          responseHeaders: sanitizeDropexResponseHeaders(response.headers),
          responseBody: sanitizeDropexResponseBody(responseBodyText),
        });
        const httpError = classifyDropexHttpStatus(response.status, response.headers.get("retry-after"), this.now());
        if (httpError) throw httpError;
        break;
      } catch (error: unknown) {
        if (error instanceof DropexHttpError && error.retryable && transientAttempt < DROPEX_TRANSIENT_HTTP_MAX_ATTEMPTS) {
          await this.sleep(transientRetryDelayMs(error, transientAttempt));
          continue;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new DropexHttpError("Dropex catalogue request timed out.", 408, true);
        }
        throw error;
      }
    }

    let responseBody: unknown;
    try {
      responseBody = JSON.parse(responseBodyText);
    } catch {
      throw new Error("Failed to parse Dropex product catalog as JSON.");
    }

    const pageRecord = asRecord(responseBody);
    const rawList = Array.isArray(responseBody)
      ? asRecordArray(responseBody)
      : asRecordArray(pageRecord?.content)
        || asRecordArray(pageRecord?.data)
        || asRecordArray(pageRecord?.products)
        || (pageRecord ? [pageRecord] : []);

    const categoryLookup = await this.loadCategoryLookup(credentials, outboundPolicy);
    const parsedProducts: RawA2ZProduct[] = [];
    let invalidProducts = 0;

    for (const item of rawList) {
      try {
        const detail = asRecord(item.productDetail) || item;
        const productId = String(detail.id || item.productId || item.id || "").trim();
        let enrichment: Record<string, unknown> | undefined;
        const needsEnrichment = Boolean(productId && needsDropexProductEnrichment(item, detail));
        if (needsEnrichment) {
          enrichment = await this.enrichProductDto(credentials, outboundPolicy, productId);
        }
        const parsed = ProductParser.parseCatalogItem(item, { categoryLookup, enrichment });
        if (parsed.sku && parsed.title) {
          parsedProducts.push(parsed);
        } else {
          invalidProducts += 1;
        }
      } catch (parseErr) {
        invalidProducts += 1;
        console.warn("[Dropex-Connector] Error parsing catalog product item:", parseErr);
      }
    }

    const reportedTotal = Number(pageRecord?.totalElements ?? pageRecord?.total ?? pageRecord?.count);
    const currentPage = Number(pageRecord?.number ?? page);
    const pageComplete = pageRecord?.last === true
      || (Number.isFinite(reportedTotal) && ((currentPage + 1) * pageSize) >= reportedTotal)
      || rawList.length < pageSize;
    const nextCursor = pageComplete ? null : String(page + 1);
    const catalogTotal = Number.isSafeInteger(reportedTotal) && reportedTotal >= 0
      ? { count: reportedTotal, reliability: "reported" as const }
      : undefined;

    return {
      products: parsedProducts,
      targetUrl: catalogUrl.toString(),
      nextCursor,
      complete: pageComplete,
      invalidProducts,
      ...(catalogTotal ? { catalogTotal } : {}),
    };
  }

  public async fetchCatalogPage(
    credentials: { username?: string; password?: string },
    outboundPolicy: SupplierOutboundPolicy,
    request: SupplierCatalogPageRequest,
  ): Promise<SupplierCatalogPageResult> {
    if (!credentials.username || !credentials.password) {
      throw new Error("Dropex credentials are required.");
    }
    return this.fetchCatalogPageInternal(
      { username: credentials.username, password: credentials.password },
      outboundPolicy,
      request,
    );
  }

  public async fetchCatalog(
    credentials: { username?: string; password?: string },
    outboundPolicy: SupplierOutboundPolicy,
  ): Promise<RawA2ZProduct[]> {
    const firstPage = await this.fetchCatalogPage(credentials, outboundPolicy, {
      cursor: null,
      pageSize: 100,
    });
    return firstPage.products as RawA2ZProduct[];
  }

  public async testConnection(
    credentials: { username?: string; password?: string },
    outboundPolicy: SupplierOutboundPolicy,
  ): Promise<SupplierCatalogPageResult> {
    if (!credentials.username || !credentials.password) {
      throw new Error("Dropex credentials are required.");
    }
    await this.login(
      { username: credentials.username, password: credentials.password },
      outboundPolicy,
    );
    return this.fetchCatalogPageInternal(
      { username: credentials.username, password: credentials.password },
      outboundPolicy,
      { cursor: "0", pageSize: 1 },
    );
  }
}

export const DROPEX_CREDENTIAL_VALIDATION_TARGET = DROPEX_CREDENTIAL_TARGET_URL;
