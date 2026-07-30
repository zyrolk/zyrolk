import { createHash } from "node:crypto";
import { ProductParser } from "./ProductParser";
import { RawA2ZProduct } from "./types";
import { getCookieNames, sanitizeA2ZResponseBody, sanitizeA2ZResponseHeaders } from "./diagnostics";
import {
  assertA2ZCredentialByteSafety,
  buildA2ZBrowserLoginBody,
  fingerprintA2ZCredentials,
} from "./credentialForensics";
import { fetchSupplierOutbound, SupplierOutboundPolicy, SupplierOutboundResponse } from "../../security/supplierOutboundRequest";
import { SupplierCatalogPageRequest, SupplierCatalogPageResult } from "../types";

export interface A2ZSessionScope {
  supplierId: string;
  sourceId: string;
  targetUrl: string;
  credentialReference: string;
}

interface A2ZAuthenticatedSession {
  cookie: string;
  authenticatedAt: number;
  scopeKey: string;
  credentialFingerprint: string;
}

interface A2ZConnectorServiceDependencies {
  fetchOutbound?: typeof fetchSupplierOutbound;
  now?: () => number;
}

const normalizeScopeValue = (value: string, field: string): string => {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`A2Z session ${field} is required.`);
  return normalized;
};

export function buildA2ZSessionScopeKey(scope: A2ZSessionScope): string {
  const supplierId = normalizeScopeValue(scope.supplierId, "supplier ID");
  const sourceId = normalizeScopeValue(scope.sourceId, "source ID");
  const credentialReference = normalizeScopeValue(scope.credentialReference, "credential reference");
  const targetHost = new URL(normalizeScopeValue(scope.targetUrl, "target URL")).host.toLowerCase();
  const parts = [supplierId, sourceId, targetHost, credentialReference];
  const encoded = parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

export class A2ZConnectorService {
  private session: A2ZAuthenticatedSession | null = null;
  private loginInFlight: Promise<A2ZAuthenticatedSession> | null = null;
  private readonly sessionScopeKey: string;
  private readonly fetchOutbound: typeof fetchSupplierOutbound;
  private readonly now: () => number;
  private readonly SESSION_TTL = 15 * 60 * 1000;
  private readonly REQUEST_TIMEOUT_MS = 15000;
  private readonly BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  constructor(
    private readonly scope: A2ZSessionScope,
    dependencies: A2ZConnectorServiceDependencies = {},
  ) {
    this.sessionScopeKey = buildA2ZSessionScopeKey(scope);
    this.fetchOutbound = dependencies.fetchOutbound || fetchSupplierOutbound;
    this.now = dependencies.now || Date.now;
  }

  private debugLog(...values: unknown[]): void {
    if (process.env.SUPPLIER_DEBUG_LOGS === "true") console.info(...values);
  }

  private logDiagnostic(authenticationStage: string, details: Record<string, unknown>): void {
    this.debugLog("[A2Z-Connector]", JSON.stringify({
      event: "a2z_integration_diagnostic",
      authenticationStage,
      ...details,
    }));
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    outboundPolicy: SupplierOutboundPolicy,
  ): Promise<SupplierOutboundResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

    try {
      return await this.fetchOutbound(url, { ...init, signal: controller.signal }, outboundPolicy);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private getBaseDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.host}`;
    } catch {
      let clean = url.trim();
      if (clean.includes("/dash")) {
        clean = clean.split("/dash")[0];
      }
      if (clean.endsWith("/")) {
        clean = clean.slice(0, -1);
      }
      return clean;
    }
  }

  private extractCleanCookies(cookieHeaders: string[] | string | null): string {
    if (!cookieHeaders) {
      return "";
    }

    const headersArray = Array.isArray(cookieHeaders)
      ? cookieHeaders
      : cookieHeaders.split(/,(?=[^;]*=)/);

    const cleanCookies: string[] = [];
    for (const header of headersArray) {
      const parts = header.split(";");
      if (parts.length > 0) {
        const pair = parts[0].trim();
        if (pair && pair.includes("=")) {
          cleanCookies.push(pair);
        }
      }
    }

    return cleanCookies.join("; ");
  }

  private mergeCookies(oldCookieStr: string | null, newCookieStr: string | null): string {
    const cookieMap = new Map<string, string>();
    const parse = (str: string | null) => {
      if (!str) {
        return;
      }

      const parts = str.split(";");
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) {
          continue;
        }

        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.substring(0, eqIdx).trim();
          const val = trimmed.substring(eqIdx + 1).trim();
          const lowerKey = key.toLowerCase();
          if (["path", "expires", "max-age", "domain", "samesite", "httponly", "secure"].includes(lowerKey)) {
            continue;
          }
          cookieMap.set(key, val);
        }
      }
    };

    parse(oldCookieStr);
    parse(newCookieStr);

    return Array.from(cookieMap.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  private credentialFingerprint(credentials: { username?: string; password?: string }): string {
    const username = credentials.username;
    const password = credentials.password;
    if (!username || !password) {
      throw new Error("A2Z credentials are required before attempting supplier login.");
    }
    const fingerprint = fingerprintA2ZCredentials(username, password);
    return `${fingerprint.usernameSha256}:${fingerprint.passwordSha256}`;
  }

  private assertScopedTarget(baseUrl: string): void {
    const expectedHost = new URL(this.scope.targetUrl).host.toLowerCase();
    const requestedHost = new URL(baseUrl).host.toLowerCase();
    if (requestedHost !== expectedHost) {
      throw new Error("A2Z session target does not match its isolated supplier scope.");
    }
  }

  private reusableSession(credentials: { username?: string; password?: string }): A2ZAuthenticatedSession | null {
    const credentialFingerprint = this.credentialFingerprint(credentials);
    if (!this.session
      || this.session.scopeKey !== this.sessionScopeKey
      || this.session.credentialFingerprint !== credentialFingerprint
      || this.now() - this.session.authenticatedAt > this.SESSION_TTL) {
      return null;
    }
    return this.session;
  }

  private async performLogin(
    baseUrl: string,
    credentials: { username?: string; password?: string },
    outboundPolicy: SupplierOutboundPolicy,
    credentialFingerprint: string,
  ): Promise<A2ZAuthenticatedSession> {
    this.assertScopedTarget(baseUrl);
    const baseDomain = this.getBaseDomain(baseUrl);
    this.debugLog(`[A2Z-Connector] Triggering authentic login sequence for domain: ${baseDomain}`);

    const username = credentials.username;
    const password = credentials.password;

    if (!username || !password) {
      throw new Error("A2Z credentials are required before attempting supplier login.");
    }

    assertA2ZCredentialByteSafety(username, password);
    this.debugLog(JSON.stringify(fingerprintA2ZCredentials(username, password)));

    try {
      const preLoginUrl = `${baseDomain}/dash`;
      this.debugLog(`[A2Z-Connector] Pre-authenticating GET request to: ${preLoginUrl}`);

      const preRes = await this.fetchWithTimeout(preLoginUrl, {
          redirect: "manual",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": this.BROWSER_USER_AGENT,
        },
      }, outboundPolicy);
      const preSetCookie = preRes.headers.get("set-cookie");
      let preCookieStr = "";
      if (typeof preRes.headers.getSetCookie === "function") {
        preCookieStr = preRes.headers.getSetCookie().join("; ");
      } else if (preSetCookie) {
        preCookieStr = preSetCookie;
      }
      const cleanPreCookie = this.extractCleanCookies(preCookieStr);
      this.logDiagnostic("pre-authentication", {
        endpoint: preLoginUrl,
        method: "GET",
        httpStatus: preRes.status,
        responseHeaders: sanitizeA2ZResponseHeaders(preRes.headers),
        responseBody: "[login page body omitted]",
        cookieNames: getCookieNames(cleanPreCookie),
      });

      const authUrl = `${baseDomain}/Login/auth`;
      this.debugLog(`[A2Z-Connector] Posting credentials to: ${authUrl}`);

      const loginBody = buildA2ZBrowserLoginBody(username, password);

      const authRes = await this.fetchWithTimeout(authUrl, {
        method: "POST",
          redirect: "manual",
        headers: {
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "en-US,en;q=0.9",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Cookie": cleanPreCookie,
          "Origin": baseDomain,
          "Referer": `${baseDomain}/dash`,
          "User-Agent": this.BROWSER_USER_AGENT,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: loginBody
      }, outboundPolicy);

      const authBody = await authRes.text();
      this.logDiagnostic("credential-submission", {
        endpoint: authUrl,
        method: "POST",
        contentType: "application/x-www-form-urlencoded; charset=UTF-8",
        requestPayloadKeys: ["un", "pw"],
        requestHeaderNames: ["Accept", "Accept-Language", "Content-Type", "Cookie", "Origin", "Referer", "User-Agent", "X-Requested-With"],
        redirectMode: "validated-manual",
        timeoutMs: this.REQUEST_TIMEOUT_MS,
        httpStatus: authRes.status,
        responseHeaders: sanitizeA2ZResponseHeaders(authRes.headers),
        responseBody: sanitizeA2ZResponseBody(authBody),
      });

      let isSuccess = false;
      try {
        const json = JSON.parse(authBody);
        if (json && json.status === "success") {
          isSuccess = true;
        }
      } catch {
        if (authBody.includes("\"status\":\"success\"")) {
          isSuccess = true;
        }
      }

      if (!isSuccess) {
        throw new Error(`Authentication rejected by A2Z. Message: ${authBody.substring(0, 200)}`);
      }

      const authSetCookie = authRes.headers.get("set-cookie");
      let authCookieStr = "";
      if (typeof authRes.headers.getSetCookie === "function") {
        authCookieStr = authRes.headers.getSetCookie().join("; ");
      } else if (authSetCookie) {
        authCookieStr = authSetCookie;
      }
      const cleanAuthCookie = this.extractCleanCookies(authCookieStr);

      const finalCookie = this.mergeCookies(cleanPreCookie, cleanAuthCookie);
      if (!finalCookie) throw new Error("A2Z authentication did not return a usable session cookie.");

      this.debugLog("[A2Z-Connector] Authentication successfully completed. Preserved clean session cookie.");
      return {
        cookie: finalCookie,
        authenticatedAt: this.now(),
        scopeKey: this.sessionScopeKey,
        credentialFingerprint,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown Error";
      console.error("[A2Z-Connector] Authentication failed:", message);
      throw new Error(`A2Z Authentication Failed: ${message}`);
    }
  }

  public async login(
    baseUrl: string,
    credentials: { username?: string; password?: string },
    outboundPolicy: SupplierOutboundPolicy,
  ): Promise<string> {
    this.assertScopedTarget(baseUrl);
    const credentialFingerprint = this.credentialFingerprint(credentials);
    if (this.loginInFlight) {
      const sharedSession = await this.loginInFlight;
      this.session = sharedSession;
      return sharedSession.cookie;
    }

    const pendingLogin = this.performLogin(baseUrl, credentials, outboundPolicy, credentialFingerprint);
    this.loginInFlight = pendingLogin;
    try {
      const session = await pendingLogin;
      this.session = session;
      return session.cookie;
    } catch (error) {
      this.session = null;
      throw error;
    } finally {
      if (this.loginInFlight === pendingLogin) this.loginInFlight = null;
    }
  }

  private async fetchCatalogInternal(
    baseUrl: string,
    credentials: { username?: string; password?: string },
    outboundPolicy: SupplierOutboundPolicy,
    pageRequest?: SupplierCatalogPageRequest,
  ): Promise<SupplierCatalogPageResult> {
    if (!baseUrl) {
      throw new Error("A2Z Connector Service requires a valid websiteUrl base path.");
    }
    this.assertScopedTarget(baseUrl);

    const baseDomain = this.getBaseDomain(baseUrl);
    const requestedOffset = pageRequest?.cursor?.startsWith("a2z-local:")
      ? Math.max(0, Number(pageRequest.cursor.slice("a2z-local:".length)) || 0)
      : Math.max(0, Number(pageRequest?.cursor) || 0);
    const pageSize = Math.max(1, Math.min(Number(pageRequest?.pageSize) || 100, 200));
    const productsUrlObject = new URL(`${baseDomain}/Product/getAllproducts2`);
    if (pageRequest && !pageRequest.cursor?.startsWith("a2z-local:")) {
      productsUrlObject.searchParams.set("start", String(requestedOffset));
      productsUrlObject.searchParams.set("length", String(pageSize));
    }
    const productsUrl = productsUrlObject.toString();
    let activeSession = this.reusableSession(credentials);
    if (!activeSession) {
      this.debugLog("[A2Z-Connector] Preserved session is missing or expired. Authenticating...");
      await this.login(baseUrl, credentials, outboundPolicy);
      activeSession = this.reusableSession(credentials);
    }
    if (!activeSession) throw new Error("A2Z authentication did not create a reusable scoped session.");

    this.debugLog(`[A2Z-Connector] Fetching catalog from target API: ${productsUrl}`);

    let responseBodyText = "";

    const executeFetch = async (sessionCookie: string): Promise<boolean> => {
      try {
        const fetchResponse = await this.fetchWithTimeout(productsUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            "Cookie": sessionCookie,
            "Accept": "application/json"
          }
        }, outboundPolicy);

        responseBodyText = await fetchResponse.text();
        this.logDiagnostic("catalog-fetch", {
          endpoint: productsUrl,
          method: "GET",
          requestPayloadKeys: [],
          redirectMode: "validated-manual",
          timeoutMs: this.REQUEST_TIMEOUT_MS,
          httpStatus: fetchResponse.status,
          responseHeaders: sanitizeA2ZResponseHeaders(fetchResponse.headers),
          responseBody: sanitizeA2ZResponseBody(responseBodyText),
        });

        if (fetchResponse.status === 200) {
          if (responseBodyText.trim().startsWith("<!DOCTYPE html")) {
            this.debugLog("[A2Z-Connector] Received HTML response instead of JSON. Session is likely invalid.");
            return false;
          }
          return true;
        }
        return false;
      } catch (error: unknown) {
        console.warn(`[A2Z-Connector] Fetch attempt failed: ${error instanceof Error ? error.message : "Unknown Error"}`);
        return false;
      }
    };

    const attemptedCookie = activeSession.cookie;
    let isSuccess = await executeFetch(attemptedCookie);

    if (!isSuccess) {
      this.debugLog("[A2Z-Connector] Session invalidated or fetch failed. Retrying login...");
      if (this.session?.cookie === attemptedCookie) this.session = null;
      const refreshedCookie = await this.login(baseUrl, credentials, outboundPolicy);
      isSuccess = await executeFetch(refreshedCookie);
    }

    if (!isSuccess) {
      throw new Error("Failed to retrieve products from A2Z. Service is either unavailable or session expired.");
    }

    let responseBody: any;
    try {
      responseBody = JSON.parse(responseBodyText);
    } catch (err: any) {
      throw new Error(`Failed to parse product catalog as JSON: ${err.message}`);
    }

    let rawList: any[] = [];
    if (responseBody && Array.isArray(responseBody.d)) {
      rawList = responseBody.d;
    } else if (Array.isArray(responseBody)) {
      rawList = responseBody;
    } else if (responseBody && Array.isArray(responseBody.products)) {
      rawList = responseBody.products;
    } else if (responseBody && Array.isArray(responseBody.data)) {
      rawList = responseBody.data;
    } else {
      console.warn("[A2Z-Connector] Unrecognized API response structure. Attempting to parse body as single product.", responseBody);
      if (responseBody && typeof responseBody === "object") {
        rawList = [responseBody];
      }
    }

    const reportedTotal = Number(responseBody?.recordsTotal ?? responseBody?.total ?? responseBody?.count);
    const usesLocalPagination = Boolean(pageRequest && rawList.length > pageSize) || pageRequest?.cursor?.startsWith("a2z-local:") === true;
    const productsForPage = pageRequest && usesLocalPagination
      ? rawList.slice(requestedOffset, requestedOffset + pageSize)
      : rawList;
    const parsedProducts: RawA2ZProduct[] = [];
    let invalidProducts = 0;

    for (const item of productsForPage) {
      try {
        const parsed = ProductParser.parseJsonPayload(item, baseDomain);
        const isLiveStatus = item.status !== "inactive" && item.active !== false;
        if (parsed.sku && parsed.title && isLiveStatus) {
          parsedProducts.push(parsed);
        } else if (isLiveStatus) {
          invalidProducts += 1;
        } else {
          this.debugLog(`[A2Z-Connector] Filtering out inactive or invalid product SKU: ${parsed.sku}`);
        }
      } catch (parseErr) {
        invalidProducts += 1;
        console.warn("[A2Z-Connector] Error parsing catalog product item:", parseErr);
      }
    }

    const remotePagination = pageRequest && !usesLocalPagination && Number.isFinite(reportedTotal);
    const consumed = requestedOffset + productsForPage.length;
    const complete = !pageRequest
      || (usesLocalPagination
        ? consumed >= rawList.length
        : remotePagination
          ? consumed >= reportedTotal
          : productsForPage.length < pageSize);
    const nextCursor = complete
      ? null
      : usesLocalPagination
        ? `a2z-local:${consumed}`
        : String(consumed);
    this.debugLog(`[A2Z-Connector] Successfully retrieved, parsed, and mapped ${parsedProducts.length} live products.`);
    return { products: parsedProducts, targetUrl: productsUrl, nextCursor, complete, invalidProducts };
  }

  public async fetchCatalog(
    baseUrl: string,
    credentials: { username?: string; password?: string },
    outboundPolicy: SupplierOutboundPolicy,
  ): Promise<RawA2ZProduct[]> {
    return (await this.fetchCatalogInternal(baseUrl, credentials, outboundPolicy)).products as RawA2ZProduct[];
  }

  public async fetchCatalogPage(
    baseUrl: string,
    credentials: { username?: string; password?: string },
    outboundPolicy: SupplierOutboundPolicy,
    request: SupplierCatalogPageRequest,
  ): Promise<SupplierCatalogPageResult> {
    return this.fetchCatalogInternal(baseUrl, credentials, outboundPolicy, request);
  }
}
