import { ProductParser } from "./ProductParser";
import { RawA2ZProduct } from "./types";
import { getCookieNames, sanitizeA2ZResponseBody, sanitizeA2ZResponseHeaders } from "./diagnostics";
import {
  assertA2ZCredentialByteSafety,
  buildA2ZBrowserLoginBody,
  fingerprintA2ZCredentials,
} from "./credentialForensics";

export class A2ZConnectorService {
  private static sessionCookie: string | null = null;
  private static lastLoginTime = 0;
  private static readonly SESSION_TTL = 15 * 60 * 1000;
  private static readonly REQUEST_TIMEOUT_MS = 15000;
  private static readonly BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  private static logDiagnostic(authenticationStage: string, details: Record<string, unknown>): void {
    console.info("[A2Z-Connector]", JSON.stringify({
      event: "a2z_integration_diagnostic",
      authenticationStage,
      ...details,
    }));
  }

  private static async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private static getBaseDomain(url: string): string {
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

  private static extractCleanCookies(cookieHeaders: string[] | string | null): string {
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

  private static mergeCookies(oldCookieStr: string | null, newCookieStr: string | null): string {
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

  public static async login(
    baseUrl: string,
    credentials: { username?: string; password?: string }
  ): Promise<string> {
    const baseDomain = this.getBaseDomain(baseUrl);
    console.log(`[A2Z-Connector] Triggering authentic login sequence for domain: ${baseDomain}`);

    const username = credentials.username;
    const password = credentials.password;

    if (!username || !password) {
      throw new Error("A2Z credentials are required before attempting supplier login.");
    }

    assertA2ZCredentialByteSafety(username, password);
    console.info(JSON.stringify(fingerprintA2ZCredentials(username, password)));

    try {
      const preLoginUrl = `${baseDomain}/dash`;
      console.log(`[A2Z-Connector] Pre-authenticating GET request to: ${preLoginUrl}`);

      const preRes = await this.fetchWithTimeout(preLoginUrl, {
        redirect: "follow",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": this.BROWSER_USER_AGENT,
        },
      });
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
      console.log(`[A2Z-Connector] Posting credentials to: ${authUrl}`);

      const loginBody = buildA2ZBrowserLoginBody(username, password);

      const authRes = await this.fetchWithTimeout(authUrl, {
        method: "POST",
        redirect: "follow",
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
      });

      const authBody = await authRes.text();
      this.logDiagnostic("credential-submission", {
        endpoint: authUrl,
        method: "POST",
        contentType: "application/x-www-form-urlencoded; charset=UTF-8",
        requestPayloadKeys: ["un", "pw"],
        requestHeaderNames: ["Accept", "Accept-Language", "Content-Type", "Cookie", "Origin", "Referer", "User-Agent", "X-Requested-With"],
        redirectMode: "follow",
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
      this.sessionCookie = finalCookie;
      this.lastLoginTime = Date.now();

      console.log("[A2Z-Connector] Authentication successfully completed. Preserved clean session cookie.");
      return finalCookie;
    } catch (err: any) {
      console.error("[A2Z-Connector] Authentication failed:", err.message || err);
      this.sessionCookie = null;
      this.lastLoginTime = 0;
      throw new Error(`A2Z Authentication Failed: ${err.message || "Unknown Error"}`);
    }
  }

  public static async fetchCatalog(
    baseUrl: string,
    credentials: { username?: string; password?: string }
  ): Promise<RawA2ZProduct[]> {
    if (!baseUrl) {
      throw new Error("A2Z Connector Service requires a valid websiteUrl base path.");
    }

    const baseDomain = this.getBaseDomain(baseUrl);
    const productsUrl = `${baseDomain}/Product/getAllproducts2`;
    const isSessionExpired = Date.now() - this.lastLoginTime > this.SESSION_TTL;

    if (!this.sessionCookie || isSessionExpired) {
      console.log("[A2Z-Connector] Preserved session is missing or expired. Authenticating...");
      await this.login(baseUrl, credentials);
    }

    console.log(`[A2Z-Connector] Fetching catalog from target API: ${productsUrl}`);

    let responseBodyText = "";

    const executeFetch = async (): Promise<boolean> => {
      try {
        const fetchResponse = await this.fetchWithTimeout(productsUrl, {
          method: "GET",
          redirect: "error",
          headers: {
            "Cookie": this.sessionCookie || "",
            "Accept": "application/json"
          }
        });

        responseBodyText = await fetchResponse.text();
        this.logDiagnostic("catalog-fetch", {
          endpoint: productsUrl,
          method: "GET",
          requestPayloadKeys: [],
          redirectMode: "error",
          timeoutMs: this.REQUEST_TIMEOUT_MS,
          httpStatus: fetchResponse.status,
          responseHeaders: sanitizeA2ZResponseHeaders(fetchResponse.headers),
          responseBody: sanitizeA2ZResponseBody(responseBodyText),
        });

        if (fetchResponse.status === 200) {
          if (responseBodyText.trim().startsWith("<!DOCTYPE html")) {
            console.log("[A2Z-Connector] Received HTML response instead of JSON. Session is likely invalid.");
            return false;
          }
          return true;
        }
        return false;
      } catch (err: any) {
        console.warn(`[A2Z-Connector] Fetch attempt failed: ${err.message}`);
        return false;
      }
    };

    let isSuccess = await executeFetch();

    if (!isSuccess) {
      console.log("[A2Z-Connector] Session invalidated or fetch failed. Retrying login...");
      await this.login(baseUrl, credentials);
      isSuccess = await executeFetch();
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

    const parsedProducts: RawA2ZProduct[] = [];

    for (const item of rawList) {
      try {
        const parsed = ProductParser.parseJsonPayload(item, baseDomain);
        const isLiveStatus = item.status !== "inactive" && item.active !== false;
        const hasStock = parsed.inventoryLevel > 0;

        if (parsed.sku && parsed.title && isLiveStatus && hasStock) {
          parsedProducts.push(parsed);
        } else {
          console.log(`[A2Z-Connector] Filtering out inactive or out-of-stock product SKU: ${parsed.sku}`);
        }
      } catch (parseErr) {
        console.warn("[A2Z-Connector] Error parsing catalog product item:", parseErr);
      }
    }

    console.log(`[A2Z-Connector] Successfully retrieved, parsed, and mapped ${parsedProducts.length} live products.`);
    return parsedProducts;
  }
}
