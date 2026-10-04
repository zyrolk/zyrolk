import type { RequestHandler } from "express";

export const PUBLIC_SITE_ORIGIN = "https://zyro.lk";
export const PUBLIC_PRODUCT_METADATA_CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
export const PRIVATE_PRODUCT_METADATA_CACHE_CONTROL = "no-store";

const MAX_PRODUCT_ID_LENGTH = 240;
const APP_SHELL_CACHE_MS = 30_000;
const DESCRIPTION_MAX_LENGTH = 180;

type ProductRecord = Readonly<Record<string, unknown>>;

export interface PublicProductMetadata {
  id: string;
  name: string;
  description: string;
  canonicalUrl: string;
  imageUrl?: string;
  brand?: string;
  category?: string;
  price?: number;
  inStock: boolean;
}

export interface PublicProductReader {
  collection: (name: string) => {
    doc: (id: string) => {
      get: () => Promise<{ exists: boolean; data: () => ProductRecord | undefined }>;
    };
  };
}

export interface PublicProductMetadataHandlerOptions {
  db: PublicProductReader;
  fetchImpl?: typeof fetch;
  shellUrl?: string;
  logError?: (message: string, error: unknown) => void;
}

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const decodeBasicEntities = (value: string): string => value
  .replace(/&nbsp;/giu, " ")
  .replace(/&amp;/giu, "&")
  .replace(/&lt;/giu, "<")
  .replace(/&gt;/giu, ">")
  .replace(/&quot;/giu, '"')
  .replace(/&#39;/giu, "'");

export const plainTextExcerpt = (value: unknown, maxLength = DESCRIPTION_MAX_LENGTH): string => {
  const text = decodeBasicEntities(asText(value)
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim());
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character] || character));

const safeJsonLd = (value: unknown): string => JSON.stringify(value)
  .replace(/</gu, "\\u003c")
  .replace(/>/gu, "\\u003e")
  .replace(/&/gu, "\\u0026")
  .replace(/\u2028/gu, "\\u2028")
  .replace(/\u2029/gu, "\\u2029");

export const validatePublicProductId = (rawId: string | undefined): string | null => {
  if (!rawId) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (!decoded || decoded.length > MAX_PRODUCT_ID_LENGTH || decoded === "." || decoded === "..") return null;
  if (/[\\/\u0000-\u001f\u007f?#]/u.test(decoded)) return null;
  return decoded;
};

const safePublicImageUrl = (value: unknown): string | undefined => {
  const candidate = asText(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
};

const firstPublicImage = (record: ProductRecord): string | undefined => {
  const candidates: unknown[] = [record.imageUrl];
  if (Array.isArray(record.imageUrls)) candidates.push(...record.imageUrls);
  return candidates.map(safePublicImageUrl).find((value): value is string => Boolean(value));
};

const positiveOrZeroNumber = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
);

export const projectPublicProductMetadata = (id: string, record: ProductRecord): PublicProductMetadata | null => {
  if (record.isActive !== true) return null;
  const name = plainTextExcerpt(record.name, 140);
  if (!name) return null;
  const rawDescription = plainTextExcerpt(record.shortDescription)
    || plainTextExcerpt(record.description)
    || `Shop ${name} on Zyro.lk.`;
  const stock = positiveOrZeroNumber(record.stock);
  return {
    id,
    name,
    description: rawDescription,
    canonicalUrl: `${PUBLIC_SITE_ORIGIN}/products/${encodeURIComponent(id)}`,
    ...(firstPublicImage(record) ? { imageUrl: firstPublicImage(record) } : {}),
    ...(plainTextExcerpt(record.brand, 80) ? { brand: plainTextExcerpt(record.brand, 80) } : {}),
    ...(plainTextExcerpt(record.category, 80) ? { category: plainTextExcerpt(record.category, 80) } : {}),
    ...(positiveOrZeroNumber(record.price) !== undefined ? { price: positiveOrZeroNumber(record.price) } : {}),
    inStock: stock === undefined ? true : stock > 0,
  };
};

export const loadPublicProductMetadata = async (
  db: PublicProductReader,
  id: string,
): Promise<PublicProductMetadata | null> => {
  const snapshot = await db.collection("products").doc(id).get();
  if (!snapshot.exists) return null;
  const record = snapshot.data();
  return record ? projectPublicProductMetadata(id, record) : null;
};

const removeExistingMetadata = (shell: string): string => shell
  .replace(/<title\b[^>]*>[\s\S]*?<\/title>\s*/iu, "")
  .replace(/<link\b(?=[^>]*\brel\s*=\s*["'][^"']*canonical[^"']*["'])[^>]*>\s*/giu, "")
  .replace(/<meta\b(?=[^>]*(?:name|property)\s*=\s*["'](?:description|robots|og:[^"']+|twitter:[^"']+|product:price:[^"']+)["'])[^>]*>\s*/giu, "")
  .replace(/<script\b(?=[^>]*\bid\s*=\s*["']zyro-server-product-structured-data["'])[^>]*>[\s\S]*?<\/script>\s*/giu, "");

const renderHeadMetadata = (metadata: PublicProductMetadata): string => {
  const escapedName = escapeHtml(`${metadata.name} | Zyro.lk`);
  const escapedDescription = escapeHtml(metadata.description);
  const escapedCanonical = escapeHtml(metadata.canonicalUrl);
  const imageTags = metadata.imageUrl
    ? `\n<meta property="og:image" content="${escapeHtml(metadata.imageUrl)}">\n<meta name="twitter:image" content="${escapeHtml(metadata.imageUrl)}">`
    : "";
  const priceTags = metadata.price === undefined
    ? ""
    : `\n<meta property="product:price:amount" content="${metadata.price.toFixed(2)}">\n<meta property="product:price:currency" content="LKR">`;
  const structuredData: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: metadata.name,
    description: metadata.description,
    ...(metadata.imageUrl ? { image: [metadata.imageUrl] } : {}),
    ...(metadata.brand ? { brand: { "@type": "Brand", name: metadata.brand } } : {}),
    ...(metadata.category ? { category: metadata.category } : {}),
    ...(metadata.price === undefined ? {} : {
      offers: {
        "@type": "Offer",
        url: metadata.canonicalUrl,
        price: metadata.price,
        priceCurrency: "LKR",
        availability: `https://schema.org/${metadata.inStock ? "InStock" : "OutOfStock"}`,
      },
    }),
  };
  return `<title>${escapedName}</title>\n<meta name="description" content="${escapedDescription}">\n<link rel="canonical" href="${escapedCanonical}">\n<meta property="og:type" content="product">\n<meta property="og:site_name" content="Zyro.lk">\n<meta property="og:title" content="${escapedName}">\n<meta property="og:description" content="${escapedDescription}">\n<meta property="og:url" content="${escapedCanonical}">${imageTags}\n<meta name="twitter:card" content="${metadata.imageUrl ? "summary_large_image" : "summary"}">\n<meta name="twitter:title" content="${escapedName}">\n<meta name="twitter:description" content="${escapedDescription}">${priceTags}\n<script id="zyro-server-product-structured-data" type="application/ld+json">${safeJsonLd(structuredData)}</script>`;
};

export const renderProductMetadataIntoShell = (shell: string, metadata: PublicProductMetadata): string => {
  const cleanedShell = removeExistingMetadata(shell);
  if (!/<\/head>/iu.test(cleanedShell)) throw new Error("Current app shell has no closing head tag");
  return cleanedShell.replace(/<\/head>/iu, `${renderHeadMetadata(metadata)}\n</head>`);
};

export const renderNoIndexShell = (shell: string, canonicalUrl: string): string => {
  const cleanedShell = removeExistingMetadata(shell);
  if (!/<\/head>/iu.test(cleanedShell)) throw new Error("Current app shell has no closing head tag");
  const title = escapeHtml("Page Not Found | Zyro.lk");
  const description = escapeHtml("The requested page could not be found.");
  const canonical = escapeHtml(canonicalUrl);
  const fallback = `<title>${title}</title>\n<meta name="description" content="${description}">\n<meta name="robots" content="noindex, nofollow">\n<link rel="canonical" href="${canonical}">\n<meta property="og:type" content="website">\n<meta property="og:site_name" content="Zyro.lk">\n<meta property="og:title" content="${title}">\n<meta property="og:description" content="${description}">\n<meta property="og:url" content="${canonical}">\n<meta name="twitter:card" content="summary">\n<meta name="twitter:title" content="${title}">\n<meta name="twitter:description" content="${description}">`;
  return cleanedShell.replace(/<\/head>/iu, `${fallback}\n</head>`);
};

const requestPathIsProductMetadata = (method: string, path: string): boolean => method.toUpperCase() === "GET"
  && /^\/products\/[^/]+\/?$/iu.test(path);

export const isPublicProductMetadataRequest = requestPathIsProductMetadata;

export const createPublicProductMetadataHandler = ({
  db,
  fetchImpl = fetch,
  shellUrl = `${PUBLIC_SITE_ORIGIN}/index.html`,
  logError,
}: PublicProductMetadataHandlerOptions): RequestHandler => {
  let cachedShell: { html: string; fetchedAt: number } | null = null;

  const loadCurrentShell = async (): Promise<string> => {
    if (cachedShell && Date.now() - cachedShell.fetchedAt < APP_SHELL_CACHE_MS) return cachedShell.html;
    const response = await fetchImpl(shellUrl, { headers: { "User-Agent": "Zyro-product-metadata-renderer" } });
    if (!response.ok) throw new Error(`Current app shell request failed with ${response.status}`);
    const html = await response.text();
    if (!/<head[\s>]/iu.test(html) || !/<\/head>/iu.test(html) || !/<script\b[^>]*type=["']module["']/iu.test(html)) {
      throw new Error("Current app shell is not a valid Vite document");
    }
    cachedShell = { html, fetchedAt: Date.now() };
    return html;
  };

  return async (req, res) => {
    const rawId = req.params.documentId;
    const id = validatePublicProductId(rawId);
    const canonicalUrl = `${PUBLIC_SITE_ORIGIN}/products/${encodeURIComponent(id || rawId || "unknown")}`;
    let shell: string | undefined;
    try {
      shell = await loadCurrentShell();
      if (!id) {
        res.set("Content-Type", "text/html; charset=utf-8");
        res.set("Cache-Control", PRIVATE_PRODUCT_METADATA_CACHE_CONTROL);
        res.status(404).send(renderNoIndexShell(shell, canonicalUrl));
        return;
      }
      const metadata = await loadPublicProductMetadata(db, id);
      if (!metadata) {
        res.set("Content-Type", "text/html; charset=utf-8");
        res.set("Cache-Control", PRIVATE_PRODUCT_METADATA_CACHE_CONTROL);
        res.status(404).send(renderNoIndexShell(shell, canonicalUrl));
        return;
      }
      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("Cache-Control", PUBLIC_PRODUCT_METADATA_CACHE_CONTROL);
      res.status(200).send(renderProductMetadataIntoShell(shell, metadata));
    } catch (error) {
      logError?.("Public product metadata rendering failed.", error);
      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("Cache-Control", PRIVATE_PRODUCT_METADATA_CACHE_CONTROL);
      if (shell) {
        res.status(503).send(renderNoIndexShell(shell, canonicalUrl));
        return;
      }
      res.status(503).send("Product page temporarily unavailable");
    }
  };
};
