const UNSAFE_CONTENT_TAG = /<(?:script|style|iframe|object|embed|link|meta|base|form|svg|math|template|noscript)\b[^>]*>[\s\S]*?(?:<\/(?:script|style|iframe|object|embed|link|meta|base|form|svg|math|template|noscript)\s*>|$)/giu;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const HTML_TAG = /<\/?([a-z][a-z0-9:-]*)(?:\s[^>]*)?>/giu;
const ALLOWED_FORMATTING_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 'br',
]);

/** True when the value looks like supplier HTML rather than plain text. */
export function supplierDescriptionLooksLikeHtml(value: unknown): boolean {
  return /<[a-z][\s\S]*>/iu.test(String(value || ''));
}

/**
 * Strictly allow basic formatting and discard every attribute.
 * Supplier HTML is never trusted: executable/content-bearing tags and all
 * event handlers, URLs, styles, and unknown markup are removed.
 */
export function sanitizeSupplierDescriptionHtml(value: unknown): string {
  const raw = String(value || '');
  if (!raw.trim()) return '';

  return raw
    .replace(UNSAFE_CONTENT_TAG, '')
    .replace(HTML_COMMENT, '')
    .replace(HTML_TAG, (match, tagName: string) => {
      const normalizedTag = tagName.toLocaleLowerCase();
      if (!ALLOWED_FORMATTING_TAGS.has(normalizedTag)) return '';
      return match.startsWith('</') ? `</${normalizedTag}>` : `<${normalizedTag}>`;
    })
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
