import {
  isSafeManagedImageReference,
  safeTaxAiReview,
  type TaxAiClassification,
  type TaxAiProductEvidence,
  type TaxAiTaxonomyCatalog,
} from "./taxAiFoundation";

export interface TaxAiProviderRequest {
  readonly evidence: TaxAiProductEvidence;
  readonly taxonomy: TaxAiTaxonomyCatalog;
  readonly promptVersion: string;
}

export interface TaxAiProvider {
  readonly id: string;
  readonly model: string;
  readonly lastMediaInputStatus?: TaxAiMediaInputStatus;
  classify(request: TaxAiProviderRequest): Promise<unknown>;
}

export type TaxAiMediaInputStatus = "present" | "unavailable" | "not-requested";

export class TaxAiProviderError extends Error {
  readonly code: "UNAVAILABLE" | "HTTP_ERROR" | "INVALID_RESPONSE";

  constructor(code: TaxAiProviderError["code"], message: string) {
    super(message);
    this.name = "TaxAiProviderError";
    this.code = code;
  }
}

/** Safe default used by local shadow runs when no provider is configured. */
export class UnavailableTaxAiProvider implements TaxAiProvider {
  readonly id = "unavailable";
  readonly model = "none";

  async classify(_request: TaxAiProviderRequest): Promise<unknown> {
    throw new TaxAiProviderError("UNAVAILABLE", "No server-side Tax-AI provider is configured.");
  }
}

export interface GeminiTaxAiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly fetcher?: typeof fetch;
  readonly imageFetcher?: typeof fetch;
  readonly maxImageBytes?: number;
}

function promptFor(request: TaxAiProviderRequest, mediaUnavailable: boolean): string {
  const candidates = request.taxonomy.categories
    .filter((category) => category.isActive === true && category.taxonomyCandidate !== true)
    .map((category) => ({
      categoryId: category.id,
      categoryName: category.name,
      subcategories: (category.subcategories || [])
        .filter((subcategory) => subcategory.isActive !== false && subcategory.taxonomyCandidate !== true)
        .map((subcategory) => ({ subcategoryId: subcategory.id, subcategoryName: subcategory.name })),
    }));
  return [
    "You are a read-only advisory taxonomy and product-risk classifier for an ecommerce catalog.",
    "Return JSON only. Select only one active category/subcategory pair from the supplied taxonomy; never invent IDs.",
    "Supplier taxonomy is secondary evidence and must not override product-owned evidence.",
    "A policy risk flag must produce POLICY_HOLD or REVIEW, never HIGH_CONFIDENCE.",
    `Prompt schema version: ${request.promptVersion}`,
    JSON.stringify({ evidence: request.evidence, mediaUnavailable, allowedTaxonomy: candidates }),
    JSON.stringify({
      taxonomy: {
        categoryId: "string|null",
        subcategoryId: "string|null",
        confidence: "number 0..1",
        alternateCandidates: [{ categoryId: "string", subcategoryId: "string|null" }],
        needsNewTaxonomy: "boolean",
        proposedTaxonomy: { categoryName: "string?", subcategoryName: "string?", reason: "string?" },
        evidence: ["short evidence string"],
      },
      risk: { policyReviewRequired: "boolean", flags: ["string"] },
      decision: "HIGH_CONFIDENCE|REVIEW|NO_MATCH|POLICY_HOLD",
      reasons: ["short reason string"],
    }),
  ].join("\n");
}

function extractText(payload: unknown): string {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const first = candidates[0] && typeof candidates[0] === "object" ? candidates[0] as Record<string, unknown> : {};
  const content = first.content && typeof first.content === "object" ? first.content as Record<string, unknown> : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .map((part) => part && typeof part === "object" ? String((part as Record<string, unknown>).text || "") : "")
    .join("\n")
    .trim();
}

function parseJson(text: string): unknown {
  const unfenced = text.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  try { return JSON.parse(unfenced) as unknown; }
  catch { throw new TaxAiProviderError("INVALID_RESPONSE", "Gemini returned non-JSON Tax-AI output."); }
}

/**
 * Server-side-only adapter. It accepts an injected secret and never reads a
 * browser environment or writes product data. It is intentionally not wired
 * to a deployed route or scheduled job in TAX-AI-1.
 */
export class GeminiTaxAiProvider implements TaxAiProvider {
  readonly id = "gemini";
  readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly imageFetcher: typeof fetch;
  private readonly maxImageBytes: number;
  lastMediaInputStatus: TaxAiMediaInputStatus = "not-requested";

  constructor(private readonly options: GeminiTaxAiProviderOptions) {
    if (!options.apiKey.trim()) throw new TaxAiProviderError("UNAVAILABLE", "A Gemini API key must be injected by a server-side caller.");
    if (!options.model.trim()) throw new TaxAiProviderError("UNAVAILABLE", "A Gemini model is required.");
    this.model = options.model;
    this.endpoint = options.endpoint || "https://generativelanguage.googleapis.com/v1beta/models";
    this.fetcher = options.fetcher || fetch;
    this.imageFetcher = options.imageFetcher || fetch;
    this.maxImageBytes = Math.max(16_384, Math.min(4_000_000, Math.floor(options.maxImageBytes || 2_000_000)));
  }

  async classify(request: TaxAiProviderRequest): Promise<unknown> {
    this.lastMediaInputStatus = "not-requested";
    const parts: Array<Record<string, unknown>> = [];
    let mediaUnavailable = false;
    const managedImage = request.evidence.managedPrimaryImage;
    if (isSafeManagedImageReference(managedImage)) {
      try {
        const imageResponse = await this.imageFetcher(managedImage.url, { method: "GET" });
        const contentType = (imageResponse.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
        const contentLength = Number(imageResponse.headers.get("content-length") || 0);
        const allowedMime = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
        if (!imageResponse.ok || !allowedMime.has(contentType) || (contentLength > 0 && contentLength > this.maxImageBytes)) {
          throw new Error("Managed image response was not an accepted bounded image.");
        }
        const bytes = new Uint8Array(await imageResponse.arrayBuffer());
        if (bytes.byteLength > this.maxImageBytes) throw new Error("Managed image exceeded the local benchmark size limit.");
        parts.push({ inlineData: { mimeType: contentType, data: Buffer.from(bytes).toString("base64") } });
        this.lastMediaInputStatus = "present";
      } catch {
        mediaUnavailable = true;
        this.lastMediaInputStatus = "unavailable";
      }
    }
    parts.unshift({ text: promptFor(request, mediaUnavailable) });
    const response = await this.fetcher(`${this.endpoint}/${encodeURIComponent(this.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.options.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });
    if (!response.ok) throw new TaxAiProviderError("HTTP_ERROR", `Gemini request failed with HTTP ${response.status}.`);
    return parseJson(extractText(await response.json() as unknown));
  }
}

export function unavailableClassification(reason = "AI_PENDING"): TaxAiClassification {
  return safeTaxAiReview(reason, "none");
}
