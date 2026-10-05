export interface SupplierReviewPaginationQuery {
  view: string;
  filter: string;
  media: string;
  search: string;
  sort: string;
  pageSize: number;
}

export const buildSupplierReviewQueryKey = (query: SupplierReviewPaginationQuery): string => JSON.stringify({
  view: query.view,
  filter: query.filter,
  media: query.media,
  search: query.search.trim(),
  sort: query.sort,
  pageSize: query.pageSize,
});

/**
 * Keeps only opaque cursor anchors, never product payloads. The bounded cache
 * lets numbered navigation reuse a resolved page without turning the browser
 * into a second queue store.
 */
export class SupplierReviewAnchorCache {
  private readonly pages = new Map<string, Map<number, string | null>>();

  get(queryKey: string, page: number): string | null | undefined {
    return this.pages.get(queryKey)?.get(page);
  }

  set(queryKey: string, page: number, cursor: string | null): void {
    let anchors = this.pages.get(queryKey);
    if (!anchors) {
      anchors = new Map<number, string | null>();
      this.pages.set(queryKey, anchors);
    }
    anchors.set(page, cursor);
    if (anchors.size > 32) {
      const oldest = anchors.keys().next().value;
      if (typeof oldest === 'number' && oldest !== 1) anchors.delete(oldest);
    }
    if (this.pages.size > 8) {
      const oldestQuery = this.pages.keys().next().value;
      if (typeof oldestQuery === 'string' && oldestQuery !== queryKey) this.pages.delete(oldestQuery);
    }
  }

  nearest(queryKey: string, page: number): { page: number; cursor: string | null } | null {
    const anchors = this.pages.get(queryKey);
    if (!anchors) return null;
    let best: { page: number; cursor: string | null } | null = null;
    for (const [anchorPage, cursor] of anchors) {
      if (anchorPage <= page && (!best || anchorPage > best.page)) best = { page: anchorPage, cursor };
    }
    return best;
  }

  clear(queryKey?: string): void {
    if (queryKey) this.pages.delete(queryKey);
    else this.pages.clear();
  }
}
