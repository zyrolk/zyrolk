import { useMemo } from 'react';
import { buildAIManagerSnapshot } from '../services/buildAIManagerSnapshot';
import type { AIManagerSourceData } from '../types/snapshot';

export function useAIManagerSnapshot(source: AIManagerSourceData) {
  return useMemo(
    () => buildAIManagerSnapshot(source),
    [
      source.products,
      source.categories,
      source.orders,
      source.customers,
      source.reviews,
      source.supplierSources,
      source.supplierReviewQueue,
      source.supplierSyncHistory,
      source.settings,
    ],
  );
}
