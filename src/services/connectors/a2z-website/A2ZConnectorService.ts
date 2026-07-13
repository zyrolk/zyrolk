import { RawA2ZProduct } from './types';
import { ProductParser } from './ProductParser';

export class A2ZConnectorService {
  // In-memory cookie jar to maintain sessions across requests on the server
  private static sessionCookie: string | null = null;
  private static lastLoginTime: number = 0;
  private static readonly SESSION_TTL = 15 * 60 * 1000; // 15-minute cache lifespan
  private static readonly REQUEST_TIMEOUT_MS = 15000;
  private static readonly BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

  private static async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private static encodeJQueryFormComponent(value: string): string {
    return encodeURIComponent(value).replace(/%20/g, '+');
  }

  private static buildBrowserLoginBody(username: string, password: string): string {
    return `un=${this.encodeJQueryFormComponent(username)}&pw=${this.encodeJQueryFormComponent(password)}`;
  }

  /**
   * Cleans and extracts the base domain from the provided URL.
   */
  private static getBaseDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.host}`;
    } catch {
      let clean = url.trim();
      if (clean.includes('/dash')) {
        clean = clean.split('/dash')[0];
      }
      if (clean.endsWith('/')) {
        clean = clean.slice(0, -1);
      }
      return clean;
    }
  }

  /**
   * Parses Set-Cookie headers into a clean format suitable for subsequent Cookie request headers.
   */
  private static extractCleanCookies(cookieHeaders: string[] | string | null): string {
    if (!cookieHeaders) return '';
    const headersArray = Array.isArray(cookieHeaders) 
      ? cookieHeaders 
      : typeof cookieHeaders === 'string' 
        ? cookieHeaders.split(/,(?=[^;]*=)/)
        : [];
        
    const cleanCookies: string[] = [];
    for (const header of headersArray) {
      const parts = header.split(';');
      if (parts.length > 0) {
        const pair = parts[0].trim();
        if (pair && pair.includes('=')) {
          cleanCookies.push(pair);
        }
      }
    }
    return cleanCookies.join('; ');
  }

  /**
   * Merges existing and new cookies, updating values for existing keys.
   */
  private static mergeCookies(oldCookieStr: string | null, newCookieStr: string | null): string {
    const cookieMap = new Map<string, string>();
    const parse = (str: string | null) => {
      if (!str) return;
      const parts = str.split(';');
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.substring(0, eqIdx).trim();
          const val = trimmed.substring(eqIdx + 1).trim();
          const lowerKey = key.toLowerCase();
          if (['path', 'expires', 'max-age', 'domain', 'samesite', 'httponly', 'secure'].includes(lowerKey)) {
            continue;
          }
          cookieMap.set(key, val);
        }
      }
    };
    parse(oldCookieStr);
    parse(newCookieStr);
    
    return Array.from(cookieMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /**
   * Authenticates against the supplier's website/portal and preserves the session cookies.
   */
  public static async login(
    baseUrl: string,
    credentials: { username?: string; password?: string }
  ): Promise<string> {
    const baseDomain = this.getBaseDomain(baseUrl);
    console.log(`[A2Z-Connector] Triggering authentic login sequence for domain: ${baseDomain}`);

    const username = credentials.username;
    const password = credentials.password;

    if (!username || !password) {
      throw new Error('A2Z credentials are required before attempting supplier login.');
    }

    try {
      // Step 1: Pre-authenticate GET request to initialize session cookies
      const preLoginUrl = `${baseDomain}/dash`;
      console.log(`[A2Z-Connector] Pre-authenticating GET request to: ${preLoginUrl}`);
      
      const preRes = await this.fetchWithTimeout(preLoginUrl, {
        redirect: 'follow',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': this.BROWSER_USER_AGENT,
        },
      });
      const preSetCookie = preRes.headers.get('set-cookie');
      let preCookieStr = '';
      if (typeof preRes.headers.getSetCookie === 'function') {
        preCookieStr = preRes.headers.getSetCookie().join('; ');
      } else if (preSetCookie) {
        preCookieStr = preSetCookie;
      }
      const cleanPreCookie = this.extractCleanCookies(preCookieStr);
      console.info('[A2Z-Connector]', JSON.stringify({
        event: 'a2z_integration_diagnostic',
        authenticationStage: 'pre-authentication',
        endpoint: preLoginUrl,
        method: 'GET',
        httpStatus: preRes.status,
        cookieNames: cleanPreCookie
          .split(';')
          .map((cookie) => cookie.split('=', 1)[0]?.trim())
          .filter(Boolean),
      }));

      // Step 2: Post credentials to /Login/auth
      const authUrl = `${baseDomain}/Login/auth`;
      console.log(`[A2Z-Connector] Posting credentials to: ${authUrl}`);

      const loginBody = this.buildBrowserLoginBody(username, password);

      const authRes = await this.fetchWithTimeout(authUrl, {
        method: 'POST',
        redirect: 'follow',
        headers: {
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-US,en;q=0.9',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Cookie': cleanPreCookie,
          'Origin': baseDomain,
          'Referer': `${baseDomain}/dash`,
          'User-Agent': this.BROWSER_USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: loginBody
      });

      const authBody = await authRes.text();
      console.info('[A2Z-Connector]', JSON.stringify({
        event: 'a2z_integration_diagnostic',
        authenticationStage: 'credential-submission',
        endpoint: authUrl,
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
        requestPayloadKeys: ['un', 'pw'],
        requestHeaderNames: ['Accept', 'Accept-Language', 'Content-Type', 'Cookie', 'Origin', 'Referer', 'User-Agent', 'X-Requested-With'],
        redirectMode: 'follow',
        timeoutMs: this.REQUEST_TIMEOUT_MS,
        httpStatus: authRes.status,
        responseBody: authBody.replace(/[\r\n\t]+/g, ' ').slice(0, 500),
      }));

      // A2Z returns a JSON status like {"status":"success","url":"/Drop_dash"} on success
      let isSuccess = false;
      try {
        const json = JSON.parse(authBody);
        if (json && json.status === 'success') {
          isSuccess = true;
        }
      } catch {
        if (authBody.includes('"status":"success"')) {
          isSuccess = true;
        }
      }

      if (!isSuccess) {
        throw new Error(`Authentication rejected by A2Z. Message: ${authBody.substring(0, 200)}`);
      }

      // Step 3: Extract and merge final authenticated session cookies
      const authSetCookie = authRes.headers.get('set-cookie');
      let authCookieStr = '';
      if (typeof authRes.headers.getSetCookie === 'function') {
        authCookieStr = authRes.headers.getSetCookie().join('; ');
      } else if (authSetCookie) {
        authCookieStr = authSetCookie;
      }
      const cleanAuthCookie = this.extractCleanCookies(authCookieStr);

      const finalCookie = this.mergeCookies(cleanPreCookie, cleanAuthCookie);
      this.sessionCookie = finalCookie;
      this.lastLoginTime = Date.now();

      console.log('[A2Z-Connector] Authentication successfully completed. Preserved clean session cookie.');
      return finalCookie;

    } catch (err: any) {
      console.error('[A2Z-Connector] Authentication failed:', err.message || err);
      // Clear current stale cookie
      this.sessionCookie = null;
      this.lastLoginTime = 0;
      throw new Error(`A2Z Authentication Failed: ${err.message || 'Unknown Error'}`);
    }
  }

  /**
   * Orchestrates secure connection, retrieves raw products, maps and returns only live products.
   */
  public static async fetchCatalog(
    baseUrl: string,
    credentials: { username?: string; password?: string }
  ): Promise<RawA2ZProduct[]> {
    if (!baseUrl) {
      throw new Error('A2Z Connector Service requires a valid websiteUrl base path.');
    }

    const baseDomain = this.getBaseDomain(baseUrl);
    const productsUrl = `${baseDomain}/Product/getAllproducts2`;

    // Determine if we need to log in / refresh session
    const isSessionExpired = Date.now() - this.lastLoginTime > this.SESSION_TTL;
    if (!this.sessionCookie || isSessionExpired) {
      console.log('[A2Z-Connector] Preserved session is missing or expired. Authenticating...');
      await this.login(baseUrl, credentials);
    }

    console.log(`[A2Z-Connector] Fetching catalog from target API: ${productsUrl}`);

    let fetchResponse: Response;
    let responseBodyText = '';
    
    const executeFetch = async (): Promise<boolean> => {
      try {
        fetchResponse = await this.fetchWithTimeout(productsUrl, {
          method: 'GET',
          redirect: 'error',
          headers: {
            'Cookie': this.sessionCookie || '',
            'Accept': 'application/json'
          }
        });

        responseBodyText = await fetchResponse.text();
        console.info('[A2Z-Connector]', JSON.stringify({
          event: 'a2z_integration_diagnostic',
          authenticationStage: 'catalog-fetch',
          endpoint: productsUrl,
          method: 'GET',
          requestPayloadKeys: [],
          redirectMode: 'error',
          timeoutMs: this.REQUEST_TIMEOUT_MS,
          httpStatus: fetchResponse.status,
          responseBody: responseBodyText.replace(/[\r\n\t]+/g, ' ').slice(0, 500),
        }));

        if (fetchResponse.status === 200) {
          // If response is HTML (login page), the session is invalid/expired
          if (responseBodyText.trim().startsWith('<!DOCTYPE html')) {
            console.log('[A2Z-Connector] Received HTML response instead of JSON. Session is likely invalid.');
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

    // If fetch failed or session was invalid, re-authenticate once and retry
    if (!isSuccess) {
      console.log('[A2Z-Connector] Session invalidated or fetch failed. Retrying login...');
      await this.login(baseUrl, credentials);
      isSuccess = await executeFetch();
    }

    if (!isSuccess) {
      throw new Error('Failed to retrieve products from A2Z. Service is either unavailable or session expired.');
    }

    // Parse the JSON list
    let responseBody: any;
    try {
      responseBody = JSON.parse(responseBodyText);
    } catch (err: any) {
      throw new Error(`Failed to parse product catalog as JSON: ${err.message}`);
    }
    
    // Extract array of products from the response payload
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
      console.warn('[A2Z-Connector] Unrecognized API response structure. Attempting to parse body as single product.', responseBody);
      if (responseBody && typeof responseBody === 'object') {
        rawList = [responseBody];
      }
    }

    const parsedProducts: RawA2ZProduct[] = [];

    for (const item of rawList) {
      try {
        const parsed = ProductParser.parseJsonPayload(item);
        
        // Filter rule: "returns only live products"
        const isLiveStatus = item.status !== 'inactive' && item.active !== false;
        const hasStock = parsed.inventoryLevel > 0;
        
        if (parsed.sku && parsed.title && isLiveStatus && hasStock) {
          parsedProducts.push(parsed);
        } else {
          console.log(`[A2Z-Connector] Filtering out inactive or out-of-stock product SKU: ${parsed.sku}`);
        }
      } catch (parseErr) {
        console.warn('[A2Z-Connector] Error parsing catalog product item:', parseErr);
      }
    }

    console.log(`[A2Z-Connector] Successfully retrieved, parsed, and mapped ${parsedProducts.length} live products.`);
    return parsedProducts;
  }
}
