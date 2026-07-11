export interface SupplierSnapshotSource {
  readonly id: string;
  readonly name: string;
  readonly isEnabled: boolean;
  readonly lastSync: string | null;
}

export interface SupplierSnapshotSync {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly timestamp: string | null;
  readonly status: 'success' | 'failed' | 'unknown';
  readonly pendingReviews: number | null;
}

export interface SupplierSnapshotQueueItem {
  readonly id: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly status: string;
}

export interface SupplierSnapshotPendingChange {
  readonly id: string;
  readonly reviewQueueItemId: string;
  readonly supplierId: string;
  readonly status: string;
}

export interface SupplierSnapshot {
  readonly suppliers: readonly SupplierSnapshotSource[];
  readonly syncHistory: readonly SupplierSnapshotSync[];
  readonly reviewQueue: readonly SupplierSnapshotQueueItem[];
  readonly pendingChanges: readonly SupplierSnapshotPendingChange[];
}

export type SupplierHealthStatus = 'healthy' | 'attention' | 'critical' | 'unavailable';

export interface SupplierHealth {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly status: SupplierHealthStatus;
  readonly label: string;
  readonly reasons: readonly string[];
  readonly successRate: number | null;
  readonly pendingApprovals: number;
  readonly lastSuccessfulSync: SupplierTimestampSummary | null;
}

export interface SupplierTimestampSummary {
  readonly iso: string;
  readonly absolute: string;
  readonly relative: string;
}

export type BacklogTrendDirection = 'increased' | 'decreased' | 'unchanged' | 'unavailable';

export interface SupplierQueueSummary {
  readonly pendingReviews: number;
  readonly pendingChanges: number;
  readonly approvalBacklog: number;
  readonly backlogTrend: {
    readonly direction: BacklogTrendDirection;
    readonly current: number | null;
    readonly previous: number | null;
    readonly absoluteChange: number | null;
    readonly message: string;
  };
}

export interface SupplierSyncSummary {
  readonly totalSyncs: number;
  readonly successfulSyncs: number;
  readonly failedSyncs: number;
  readonly unknownSyncs: number;
  readonly successRate: number | null;
  readonly lastSuccessfulSync: SupplierTimestampSummary | null;
}

export interface SupplierMetrics {
  readonly hasSuppliers: boolean;
  readonly asOf: string;
  readonly totalSuppliers: number;
  readonly enabledSuppliers: number;
  readonly disabledSuppliers: number;
  readonly healthySuppliers: number;
  readonly suppliersRequiringAttention: number;
  readonly sync: SupplierSyncSummary;
  readonly queues: SupplierQueueSummary;
  readonly supplierHealth: readonly SupplierHealth[];
  readonly topHealthySuppliers: readonly SupplierHealth[];
  readonly attentionSuppliers: readonly SupplierHealth[];
}

export type SupplierInsightSeverity = 'positive' | 'attention' | 'neutral';

export interface SupplierInsight {
  readonly code: string;
  readonly severity: SupplierInsightSeverity;
  readonly message: string;
}

export interface SupplierAnalysis {
  readonly metrics: SupplierMetrics;
  readonly insights: readonly SupplierInsight[];
}
