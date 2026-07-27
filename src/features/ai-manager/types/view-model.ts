import type { AIManagerSourceData } from './snapshot';

export type AIManagerAdminSourceData = Omit<
  AIManagerSourceData,
  'supplierSources' | 'supplierReviewQueue' | 'supplierPendingChanges' | 'supplierSyncHistory'
>;

export interface AIManagerPanelProps {
  readonly sourceData: AIManagerAdminSourceData;
  readonly isDarkMode: boolean;
}
