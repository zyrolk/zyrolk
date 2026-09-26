import { createContext, useCallback, useContext } from 'react';
import type { Category } from '../types';
import { resolveCategoryDisplayName } from '../services/storefront/launchMerchandising';

/** Read-only storefront presentation data: the already-loaded public categories. Never fetches or writes. */
const CategoryDisplayContext = createContext<readonly Category[]>([]);

export const CategoryDisplayProvider = CategoryDisplayContext.Provider;

export const useCategoryDisplayName = (): ((categoryId: string | undefined) => string) => {
  const categories = useContext(CategoryDisplayContext);
  return useCallback((categoryId: string | undefined) => resolveCategoryDisplayName(categoryId, categories), [categories]);
};
