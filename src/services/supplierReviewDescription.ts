const BLOCKED_TAGS = /<\/?(?:script|style|iframe|object|embed|link|meta|base|form)[^>]*>/giu;
const EVENT_HANDLER_ATTR = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu;
const JAVASCRIPT_URL = /\s+(?:href|src|xlink:href)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/giu;

/** True when the value looks like supplier HTML rather than plain text. */
export function supplierDescriptionLooksLikeHtml(value: unknown): boolean {
  return /<[a-z][\s\S]*>/iu.test(String(value || ''));
}

/** Strip unsafe markup while preserving common formatting tags for read-only display. */
export function sanitizeSupplierDescriptionHtml(value: unknown): string {
  const raw = String(value || '');
  if (!raw.trim()) return '';

  return raw
    .replace(BLOCKED_TAGS, '')
    .replace(EVENT_HANDLER_ATTR, '')
    .replace(JAVASCRIPT_URL, '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .trim();
}

/** Plain-text fallback when HTML should not be rendered. */
export function supplierDescriptionPlainText(value: unknown): string {
  const raw = String(value || '');
  if (!raw.trim()) return '';
  if (!supplierDescriptionLooksLikeHtml(raw)) return raw;

  return raw
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/p>/giu, '\n\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&#39;/giu, "'")
    .replace(/&quot;/giu, '"')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
