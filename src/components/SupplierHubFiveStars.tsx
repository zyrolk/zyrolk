import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion } from 'motion/react';
import {
  Activity,
  RefreshCw,
  UserCheck,
  Info,
  AlertCircle,
  Globe,
  Settings,
  SlidersHorizontal,
  Save,
  Plus,
  X,
  Check,
  ArrowRight,
  Search,
  Trash2
} from 'lucide-react';
import { doc, onSnapshot } from 'firebase/firestore';
import { onIdTokenChanged } from 'firebase/auth';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import { Product } from '../types';
import { getSupplierApi, patchSupplierApi, postSupplierApi, requestSupplierApi } from '../services/supplierHubApi';
import { buildSupplierReviewQueryKey, SupplierReviewAnchorCache } from '../services/supplierReviewPagination';
import {
  SupplierReviewMediaEvidence,
  supplierReviewMediaEvidence,
} from '../services/supplierMediaObservability';
import {
  fetchSupplierMediaForensics,
  SupplierMediaForensicEvidence,
} from '../services/supplierMediaForensics';
import {
  normalizeSupplierSourceForUi,
  supplierSourceAutoSyncSchedule,
} from '../services/supplierSourceUtils';
import { buildSupplierOnboardingSource, SupplierOnboardingType } from '../services/supplierSourceOnboarding';
import { reportClientIssue } from '../services/observability/clientDiagnostics';
import SupplierReviewEditorModal from './SupplierReviewEditorModal';
import SupplierReviewHistoryModal, { SupplierReviewAuditEvent } from './SupplierReviewHistoryModal';
import SupplierReviewQuickCard from './SupplierReviewQuickCard';
import SupplierReviewPagination from './SupplierReviewPagination';
import SupplierOperationsDashboard from './supplier-operations/SupplierOperationsDashboard';
import SupplierManagementDashboard from './supplier-management/SupplierManagementDashboard';
import SupplierManualSyncDialog from './supplier-management/SupplierManualSyncDialog';
import SupplierConnectionBadge from './supplier-ui/SupplierConnectionBadge';
import { calculateSupplierProfit, createSupplierReviewDraft, SupplierReviewDraft } from '../services/supplierReviewEditor';
import { projectSupplierReviewCatalogTaxonomy, supplierReviewValidCategoryIds } from '../services/supplierReviewCatalog';
import { normalizeCategoryBlueprint } from '../services/products/productBlueprint';
import { sortCategoriesAlphabetically } from '../services/categories/categoryUtils';
import { sortBrandsAlphabetically } from '../services/brands/brandUtils';
import { normalizeSupplierCategory, supplierCategoryMappingUiKey } from '../services/supplierCategoryMapping';
import {
  sortSupplierOffers,
  SupplierOfferSelectionView,
  SupplierOffersResponse,
  SupplierOfferView,
} from '../services/supplierOffers';
import {
  formatSupplierSyncEta,
  formatSupplierSyncProgress,
  clearPendingReviewBatchPollTimer,
  isSupplierSyncJobActive,
  isSupplierSyncJobTerminal,
  isPendingReviewBatchJobActive,
  isSupplierSyncProgressDeterminate,
  pendingReviewBatchPollDelayMs,
  selectSupplierSyncJobViews,
  supplierSyncJobDetailLine,
  supplierSyncJobHeadline,
  SupplierSyncJobView,
} from '../services/supplierSyncJobs';
import { SupplierManualSyncRequest } from '../services/supplierManualSync';
import {
  PRODUCT_REVIEW_FILTERS,
  ProductReviewFilter,
  hasSupplierHubAdvancedAccess,
  supplierHealthLabel,
  supplierConnectionPresentation,
  SupplierHubSection,
  supplierReviewDecisionReady,
  supplierReviewCanReject,
  supplierReviewCanRemove,
  supplierReviewCanQuickApprove,
  supplierReviewChangeLabel,
  supplierReviewDisplayLabel,
  supplierReviewIsPreparing,
  supplierReviewDisplayImageUrl,
  supplierReviewManagedImageUrl,
  supplierReviewOperatorProblems,
  supplierReviewRawMetadata,
  supplierReviewApiState,
  supplierReviewCanRetryMedia,
  supplierReviewStatusLabel,
  supplierReviewTerminalLabel,
  supplierReviewStorefrontLabel,
  supplierReviewTerminalItem,
  supplierReviewActionableQueueCount,
  supplierReviewLowStockHoldQueueCount,
  supplierBusinessErrorMessage,
  isSupplierReviewStaleObservationError,
  SUPPLIER_REVIEW_STALE_REFRESH_MESSAGE,
  SUPPLIER_REVIEW_FRESHNESS_REFRESH_MESSAGE,
  SUPPLIER_REVIEW_FRESHNESS_HOLD_MESSAGE,
  formatSupplierTimestamp,
  formatSupplierDuration,
  supplierAdministratorLabel,
} from '../services/supplierHubPresentation';

interface SupplierHubFiveStarsProps {
  isDarkMode?: boolean;
  initialSubTab?: SupplierHubSection;
  onSubTabChange?: (tab: SupplierHubSection) => void;
  onNestedNavigationChange?: (state: { active: boolean; title: string; onBack: () => void } | null) => void;
}

const SUPPLIER_AUTO_SYNC_SCHEDULES = ['1 Hour', '3 Hours', '6 Hours', 'Daily'] as const;
const PENDING_REVIEW_BATCH_SIZES = [25, 50, 100] as const;
type PendingReviewBatchSize = typeof PENDING_REVIEW_BATCH_SIZES[number];
const PRODUCT_REVIEW_PAGE_SIZES = [25, 50, 100] as const;
type ProductReviewPageSize = typeof PRODUCT_REVIEW_PAGE_SIZES[number];
type SupplierReviewQueueView = 'actionable' | 'ready' | 'new' | 'updates' | 'issues' | 'waiting' | 'history' | 'low_stock';
type SupplierReviewQueueMode = 'ready' | 'waiting' | 'advanced';

const PRODUCT_REVIEW_URL_VIEWS: Record<ProductReviewFilter, string> = {
  actionable: 'actionable',
  new_products: 'new',
  product_updates: 'updates',
  removed_products: 'removed',
  conflicts: 'conflicts',
  needs_attention: 'attention',
  low_stock_hold: 'low_stock',
  approved_history: 'history',
};

const reviewQueueViewFromState = (
  filter: ProductReviewFilter,
  media: 'all' | 'ready' | 'processing' | 'issues',
): SupplierReviewQueueView => {
  if (filter === 'approved_history') return 'history';
  if (filter === 'low_stock_hold') return 'low_stock';
  if (filter === 'actionable' && media === 'all') return 'actionable';
  if (media === 'processing') return 'waiting';
  if (media === 'issues' || filter === 'needs_attention') return 'issues';
  if (media === 'ready') return 'ready';
  if (filter === 'product_updates') return 'updates';
  return 'new';
};

const reviewQueueModeFromState = (
  filter: ProductReviewFilter,
  media: 'all' | 'ready' | 'processing' | 'issues',
): SupplierReviewQueueMode => {
  if (filter === 'new_products' && media === 'ready') return 'ready';
  if (filter === 'new_products' && media === 'processing') return 'waiting';
  return 'advanced';
};

const readProductReviewUrlState = (): {
  filter: ProductReviewFilter;
  media: 'all' | 'ready' | 'processing' | 'issues';
  sort: 'created' | 'updated';
  search: string;
  page: number;
  pageSize: ProductReviewPageSize;
  queueMode: SupplierReviewQueueMode;
} => {
  const defaults = {
    filter: 'actionable' as ProductReviewFilter,
    media: 'all' as const,
    sort: 'created' as const,
    search: '',
    page: 1,
    pageSize: 50 as ProductReviewPageSize,
    queueMode: 'advanced' as SupplierReviewQueueMode,
  };
  if (typeof window === 'undefined') return defaults;
  const parameters = new URLSearchParams(window.location.search);
  const view = parameters.get('view') || '';
  const filter = (Object.entries(PRODUCT_REVIEW_URL_VIEWS).find(([, value]) => value === view)?.[0] || view) as ProductReviewFilter;
  const pageSizeValue = Number(parameters.get('pageSize'));
  const pageValue = Number(parameters.get('page'));
  const resolvedFilter = PRODUCT_REVIEW_FILTERS.some((item) => item.id === filter) ? filter : defaults.filter;
  const resolvedMedia = ['all', 'ready', 'processing', 'issues'].includes(parameters.get('media') || '')
    ? parameters.get('media') as 'all' | 'ready' | 'processing' | 'issues'
    : defaults.media;
  const queueMode = parameters.get('queue') === 'ready' || parameters.get('queue') === 'waiting'
    || parameters.get('queue') === 'advanced'
    ? parameters.get('queue') as SupplierReviewQueueMode
    : reviewQueueModeFromState(resolvedFilter, resolvedMedia);
  return {
    filter: resolvedFilter,
    media: resolvedMedia,
    sort: parameters.get('sort') === 'updated' ? 'updated' : defaults.sort,
    search: (parameters.get('q') || '').trim(),
    page: Number.isInteger(pageValue) && pageValue > 0 ? Math.min(pageValue, 10_000) : defaults.page,
    pageSize: PRODUCT_REVIEW_PAGE_SIZES.includes(pageSizeValue as ProductReviewPageSize) ? pageSizeValue as ProductReviewPageSize : defaults.pageSize,
    queueMode,
  };
};

const writeProductReviewUrlState = (
  state: { filter: ProductReviewFilter; media: 'all' | 'ready' | 'processing' | 'issues'; sort: 'created' | 'updated'; search: string; page: number; pageSize: ProductReviewPageSize; queueMode: SupplierReviewQueueMode },
  mode: 'push' | 'replace' = 'push',
): void => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('view', PRODUCT_REVIEW_URL_VIEWS[state.filter]);
  if (state.page > 1) url.searchParams.set('page', String(state.page)); else url.searchParams.delete('page');
  url.searchParams.set('pageSize', String(state.pageSize));
  if (state.sort === 'updated') url.searchParams.set('sort', 'updated'); else url.searchParams.delete('sort');
  if (state.search.trim()) url.searchParams.set('q', state.search.trim()); else url.searchParams.delete('q');
  if (state.media !== 'all') url.searchParams.set('media', state.media); else url.searchParams.delete('media');
  url.searchParams.set('queue', state.queueMode);
  window.history[`${mode}State`]({}, '', `${url.pathname}${url.search}${url.hash}`);
};

const SUPPLIER_HUB_SECTIONS = ['overview', 'review', 'suppliers', 'operations', 'settings'] as const;
type SupplierHubPrimarySection = typeof SUPPLIER_HUB_SECTIONS[number];

const readSupplierHubSection = (fallback: SupplierHubSection): SupplierHubPrimarySection => {
  if (typeof window !== 'undefined') {
    const section = new URLSearchParams(window.location.search).get('section');
    if (SUPPLIER_HUB_SECTIONS.includes(section as SupplierHubPrimarySection)) {
      return section as SupplierHubPrimarySection;
    }
  }
  if (fallback === 'activity') return 'operations';
  // Supplier Hub is the legacy entry point; the V2 landing destination is the
  // calm operational overview. Deep links to Product Review remain intact.
  return fallback === 'suppliers' ? 'overview' : fallback as SupplierHubPrimarySection;
};

const writeSupplierHubSectionUrl = (section: SupplierHubPrimarySection): void => {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('section', section);
  window.history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
};

export interface ComparisonResult {
  matchFound: boolean;
  matchedProductId: string | null;
  comparisonStatus: 'NEW_PRODUCT' | 'PRICE_CHANGED' | 'STOCK_CHANGED' | 'DESCRIPTION_CHANGED' | 'IMAGE_CHANGED' | 'SUPPLIER_OFFER_REMOVED' | 'UNCHANGED';
  changedFields: string[];
  fieldChanges?: Array<{
    field: string;
    label: string;
    auditKey?: string;
    auditRepresentation?: string;
    before: unknown;
    after: unknown;
    changeType?: 'added' | 'changed' | 'invalid_removal';
    syncGroup?: string;
    emptyBehavior?: string;
    adminEditable?: boolean;
  }>;
}

export interface ReviewQueueItem {
  id: string;
  status: 'Pending' | 'CONFLICT' | 'Approved' | 'Rejected';
  reviewStatus?: string;
  queueState?: string;
  supplierCode: string;
  productName: string;
  costPrice: number;
  marketPrice: number;
  stock: number;
  imageUrl?: string;
  currentValue?: string | number;
  supplierValue?: string | number;
  comparisonStatus?: 'NEW_PRODUCT' | 'PRICE_CHANGED' | 'STOCK_CHANGED' | 'DESCRIPTION_CHANGED' | 'IMAGE_CHANGED' | 'SUPPLIER_OFFER_REMOVED' | 'UNCHANGED';
  comparison?: ComparisonResult;
  productPayload?: Product & Record<string, unknown>; // Full product data to be written on approval
  matchedProductId?: string | null; // ID of existing product if match found
  supplierName?: string;
  source?: 'Website' | 'WhatsApp' | 'Supplier Portal';
  connector?: string;
  portalRequestId?: string;
  supplierId?: string;
  supplierSkuClaimId?: string;
  productFingerprintClaimId?: string;
  sourceId?: string;
  batchId?: string;
  createdAt?: string;
  updatedAt?: string;
  mediaProcessedAt?: string;
  supplierSnapshot?: Record<string, unknown>;
  supplierOfferPendingRevision?: string;
  managedMedia?: Array<Record<string, unknown>>;
  mediaFailures?: Array<{ originalSupplierUrl?: string; reason?: string; retryable?: boolean; failedAt?: string }>;
  mediaStatus?: string;
  media?: SupplierReviewMediaEvidence;
  categoryMapping?: {
    supplierCategory?: string;
    supplierSubcategory?: string;
    targetCategoryId?: string;
    targetSubcategoryId?: string;
    candidateCategoryId?: string;
    candidateSubcategoryId?: string;
    confidence?: number;
    mappingType?: string;
    autoSelected?: boolean;
    requiresManualSelection?: boolean;
  };
  brandMapping?: {
    supplierBrand?: string;
    mappedBrandId?: string;
    confidence?: number;
    mappingType?: string;
    autoSelected?: boolean;
    requiresManualSelection?: boolean;
  };
  productValidation?: {
    readyToPublish?: boolean;
    missingFields?: string[];
    errors?: Array<{ field: string; code: string; message: string }>;
    warnings?: Array<{ field: string; code: string; message: string; severity?: string }>;
    lowStockHold?: boolean;
  };
  approvalConflict?: {
    reason?: string;
    changedFields?: string[];
    previousVersion?: string;
    currentVersion?: string;
  };
  supplierOfferId?: string;
  reconciliationAction?: string;
  decisionAction?: 'approved' | 'rejected' | 'deleted';
  decisionCompletedAt?: unknown;
  decisionCompletedBy?: unknown;
}

interface SupplierQueuePageResponse {
  success?: boolean;
  items?: Array<Record<string, unknown> & { id: string }>;
  page?: number;
  pageSize?: number;
  totalCount?: number | null;
  totalPages?: number | null;
  countStatus?: 'exact' | 'unavailable';
  countReason?: string;
  previousCursor?: string | null;
  queryFingerprint?: string;
  queryRevision?: string;
  generatedAt?: string;
  searchCapabilities?: { exactSupplierIdentity?: boolean; productNamePrefix?: boolean };
  mediaSummary?: {
    countStatus?: 'partial' | 'unavailable';
    counts?: {
      ready?: number | null;
      processing?: number | null;
      retryScheduled?: number | null;
      needsAttention?: number | null;
      supplierImageUnavailable?: number | null;
      permanentMediaIssue?: number | null;
      legacyUnknown?: number | null;
    };
    oldestProcessingAgeSeconds?: number | null;
    possiblyStuckCount?: number | null;
    unavailableReasons?: string[];
  };
  nextCursor?: string | null;
  error?: string;
}

interface SupplierReviewOverviewReadModel {
  actionableReviewCount: number | null;
  needsAttentionReviewCount?: number | null;
  lowStockHoldReviewCount?: number | null;
  mediaReadyCount: number | null;
  mediaProcessingCount: number | null;
  mediaIssueCount: number | null;
  approvedCount: number | null;
  publishedCount: number | null;
  countStatus: 'exact' | 'partial' | 'unavailable';
  inventoryRefresh: {
    schedule: string;
    lastRunAt: string | null;
    status: 'unknown';
  };
}

interface PendingReviewBatchResponse {
  success?: boolean;
  job?: PendingReviewBatchJobView;
  error?: string;
}

interface PendingReviewBatchJobView {
  jobId: string;
  jobType?: 'pending_review_refresh';
  state: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | string;
  status?: string;
  batchSize: PendingReviewBatchSize;
  selected?: number;
  attempted?: number;
  completed?: number;
  refreshedSuccessfully?: number;
  nowReadyToPublish?: number;
  stillBlocked?: number;
  supplierRemovedOrNotFound?: number;
  failed?: number;
  unchanged?: number;
  items?: Array<{ queueItemId: string; outcome: string; error?: string }>;
  updatedAt?: string;
  finishedAt?: string | null;
}

interface SupplierCategoryMappingView {
  id?: string;
  sourceId: string;
  supplierCategory: string;
  normalizedCategory: string;
  supplierSubcategory?: string;
  normalizedSupplierSubcategory?: string;
  supplierSubcategoryId?: string;
  mappingScope?: 'parent' | 'child';
  targetCategoryId: string;
  targetSubcategoryId: string;
  confidence?: number;
  mappingType?: string;
}

const mergeSupplierQueuePage = <T extends { id: string }>(current: T[], page: T[]): T[] => {
  const items = new Map(current.map((item) => [item.id, item]));
  page.forEach((item) => items.set(item.id, item));
  return Array.from(items.values());
};

function SupplierHubFiveStars({ isDarkMode = true, initialSubTab = 'suppliers', onSubTabChange, onNestedNavigationChange }: SupplierHubFiveStarsProps) {
  // Product review workspace state
  const initialProductReviewUrlStateRef = useRef(readProductReviewUrlState());
  const initialProductReviewUrlState = initialProductReviewUrlStateRef.current;
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [supplierReviewCursor, setSupplierReviewCursor] = useState<string | null>(null);
  const [supplierReviewLoading, setSupplierReviewLoading] = useState(false);
  const [supplierReviewPage, setSupplierReviewPage] = useState(initialProductReviewUrlState.page);
  const [supplierReviewPageSize, setSupplierReviewPageSize] = useState<ProductReviewPageSize>(initialProductReviewUrlState.pageSize);
  const [supplierReviewTotalCount, setSupplierReviewTotalCount] = useState<number | null>(null);
  const [supplierReviewTotalPages, setSupplierReviewTotalPages] = useState<number | null>(null);
  const [supplierReviewCountStatus, setSupplierReviewCountStatus] = useState<'exact' | 'unavailable' | null>(null);
  const [supplierReviewPageNavigationError, setSupplierReviewPageNavigationError] = useState<string | null>(null);
  const [supplierReviewActionableCount, setSupplierReviewActionableCount] = useState<number | null>(null);
  const [supplierReviewLowStockHoldCount, setSupplierReviewLowStockHoldCount] = useState<number | null>(null);
  const [supplierReviewMediaSummary, setSupplierReviewMediaSummary] = useState<SupplierQueuePageResponse['mediaSummary'] | null>(null);
  const [supplierReviewOverview, setSupplierReviewOverview] = useState<SupplierReviewOverviewReadModel | null>(null);
  const [mediaForensicItemId, setMediaForensicItemId] = useState<string | null>(null);
  const [mediaForensicEvidence, setMediaForensicEvidence] = useState<SupplierMediaForensicEvidence | null>(null);
  const [mediaForensicLoading, setMediaForensicLoading] = useState(false);
  const [mediaForensicError, setMediaForensicError] = useState<string | null>(null);
  const [supplierQueueError, setSupplierQueueError] = useState<string | null>(null);
  const supplierQueueRequestIdRef = useRef(0);
  const supplierReviewAnchorCacheRef = useRef(new SupplierReviewAnchorCache());
  const supplierReviewQueryRevisionRef = useRef<string | null>(null);
  const supplierReviewQueryKeyRef = useRef<string | null>(null);
  const supplierAuditRequestIdRef = useRef(0);
  const supplierReviewCountRequestIdRef = useRef(0);
  
  // Syncing state
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [syncErrorMsg, setSyncErrorMsg] = useState<string | null>(null);
  const [currentSyncJob, setCurrentSyncJob] = useState<SupplierSyncJobView | null>(null);
  const [lastSyncJob, setLastSyncJob] = useState<SupplierSyncJobView | null>(null);
  const [operationsRefreshKey, setOperationsRefreshKey] = useState(0);
  const [syncJobAction, setSyncJobAction] = useState<'cancel' | 'retry' | 'resume' | null>(null);
  const syncStartInFlightRef = useRef(false);
  const currentSyncJobRef = useRef<SupplierSyncJobView | null>(null);
  const pendingSupplierSettingsRef = useRef<Record<string, unknown> | null>(null);
  const applySyncJobViews = useCallback((jobs: SupplierSyncJobView[]) => {
    const { current, lastCatalogSync } = selectSupplierSyncJobViews(jobs);
    currentSyncJobRef.current = current;
    setCurrentSyncJob(current);
    setLastSyncJob(lastCatalogSync);
    const active = isSupplierSyncJobActive(current);
    syncStartInFlightRef.current = active;
    setIsSyncing(active);
  }, []);
  const applyStartedSyncJob = useCallback((job: SupplierSyncJobView) => {
    currentSyncJobRef.current = job;
    setCurrentSyncJob(job);
    const active = isSupplierSyncJobActive(job);
    syncStartInFlightRef.current = active;
    setIsSyncing(active);
  }, []);

  // Supplier Hub navigation and interaction state
  const [activeSubTab, setActiveSubTab] = useState<SupplierHubPrimarySection>(() => readSupplierHubSection(initialSubTab));
  const [showOperationsDiagnostics, setShowOperationsDiagnostics] = useState(false);
  const [canAccessAdvanced, setCanAccessAdvanced] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<ProductReviewFilter>(initialProductReviewUrlState.filter);
  const [reviewMediaFilter, setReviewMediaFilter] = useState<'all' | 'ready' | 'processing' | 'issues'>(initialProductReviewUrlState.media);
  const [reviewQueueMode, setReviewQueueMode] = useState<SupplierReviewQueueMode>(initialProductReviewUrlState.queueMode);
  const [reviewSort, setReviewSort] = useState<'created' | 'updated'>(initialProductReviewUrlState.sort);
  const [pendingReviewBatchSize, setPendingReviewBatchSize] = useState<PendingReviewBatchSize>(25);
  const [pendingReviewBatchRefreshing, setPendingReviewBatchRefreshing] = useState(false);
  const [pendingReviewBatchJob, setPendingReviewBatchJob] = useState<PendingReviewBatchJobView | null>(null);
  const [pendingReviewBatchResult, setPendingReviewBatchResult] = useState<PendingReviewBatchJobView | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [reviewSearch, setReviewSearch] = useState<string>(initialProductReviewUrlState.search);

  // 1. Supplier Sources & Connect states
  const [supplierSources, setSupplierSources] = useState<any[]>([]);
  const [supplierSourcesLoaded, setSupplierSourcesLoaded] = useState(false);
  const [supplierAccounts, setSupplierAccounts] = useState<Array<{ id: string; companyName: string; email: string }>>([]);
  const [showConnectModal, setShowConnectModal] = useState<boolean>(false);
  const [newSupplierName, setNewSupplierName] = useState<string>("");
  const [newSupplierType, setNewSupplierType] = useState<SupplierOnboardingType>("a2z");
  const [newSupplierCode, setNewSupplierCode] = useState<string>("");
  
  const [newSupplierUrl, setNewSupplierUrl] = useState<string>("");
  const [newSupplierCredentialProfile, setNewSupplierCredentialProfile] = useState<string>('');
  const [newSupplierAccountId, setNewSupplierAccountId] = useState<string>('');

  // API specific
  const [apiEndpoint, setApiEndpoint] = useState<string>("");
  const [apiMethod, setApiMethod] = useState<string>("GET");
  const [apiDataPath, setApiDataPath] = useState<string>("products");

  const [savingSupplier, setSavingSupplier] = useState<boolean>(false);
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null);
  const [manualSyncSource, setManualSyncSource] = useState<any | null>(null);
  
  // Connection Testing states
  const [testingSourceId, setTestingSourceId] = useState<string | null>(null);
  const [modalTestStatus, setModalTestStatus] = useState<'idle' | 'testing' | 'Connected' | 'Failed'>('idle');
  const [modalTestError, setModalTestError] = useState<string | null>(null);
  const [modalTestProductsCount, setModalTestProductsCount] = useState<number | null>(null);
  const testedSupplierConfigurationRef = useRef<string | null>(null);
  const connectDialogRef = useRef<HTMLDivElement>(null);
  const connectCloseButtonRef = useRef<HTMLButtonElement>(null);
  const connectPreviousFocusRef = useRef<HTMLElement | null>(null);
  const connectModalBusyRef = useRef(false);

  const refreshSupplierReviewActionableCount = useCallback(async (): Promise<void> => {
    const requestId = ++supplierReviewCountRequestIdRef.current;
    try {
      const response = await getSupplierApi('/api/supplier-operations/summary');
      const result = await response.json().catch(() => ({})) as {
        success?: boolean;
        queues?: Record<string, unknown>;
        reviewOverview?: SupplierReviewOverviewReadModel;
      };
      if (!response.ok || result.success !== true || !result.queues) return;
      if (requestId === supplierReviewCountRequestIdRef.current) {
        setSupplierReviewOverview(result.reviewOverview || null);
        setSupplierReviewActionableCount(result.reviewOverview?.actionableReviewCount ?? supplierReviewActionableQueueCount(result.queues));
        setSupplierReviewLowStockHoldCount(supplierReviewLowStockHoldQueueCount(result.queues));
      }
    } catch {
      // Keep the last authoritative count while a transient summary request fails.
    }
  }, []);

  const closeConnectModal = useCallback(() => {
    setShowConnectModal(false);
    setModalTestStatus('idle');
    setModalTestError(null);
    setModalTestProductsCount(null);
    testedSupplierConfigurationRef.current = null;
  }, []);

  connectModalBusyRef.current = savingSupplier || modalTestStatus === 'testing';

  useEffect(() => {
    if (!showConnectModal) return;
    connectPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => connectCloseButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !connectModalBusyRef.current) {
        event.preventDefault();
        closeConnectModal();
        return;
      }
      if (event.key !== 'Tab' || !connectDialogRef.current) return;
      const focusable = Array.from<HTMLElement>(connectDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      connectPreviousFocusRef.current?.focus();
    };
  }, [closeConnectModal, showConnectModal]);

  // Supplier source definitions are deliberately projected by Functions. This
  // keeps legacy credential fields out of every browser response.
  const loadSources = useCallback(async () => {
    const [response, jobsResponse, accountsResponse] = await Promise.all([
      getSupplierApi('/api/supplier-sources'),
      // Scheduled no-op lifecycle jobs are intentionally retained in the
      // activity feed. Keep a bounded window for activity, then resolve the
      // authoritative catalog checkpoint job below so heartbeats cannot hide
      // the last real catalog traversal.
      getSupplierApi('/api/supplier-sync/jobs?limit=100'),
      getSupplierApi('/api/supplier-accounts'),
    ]);
    const result = await response.json().catch(() => ({})) as { success?: boolean; sources?: any[]; error?: string };
    const jobsResult = await jobsResponse.json().catch(() => ({})) as { success?: boolean; jobs?: SupplierSyncJobView[] };
    const accountsResult = await accountsResponse.json().catch(() => ({})) as {
      success?: boolean;
      accounts?: Array<{ id: string; companyName: string; email: string }>;
    };
    if (!response.ok || result.success !== true || !Array.isArray(result.sources)) {
      throw new Error(result.error || 'Supplier sources could not be loaded.');
    }
    setSupplierSources(result.sources.map(normalizeSupplierSourceForUi));
    if (!accountsResponse.ok || accountsResult.success !== true || !Array.isArray(accountsResult.accounts)) {
      throw new Error('Active supplier accounts could not be loaded.');
    }
    setSupplierAccounts(accountsResult.accounts);
    setSupplierSourcesLoaded(true);
    setErrorMsg(null);
    if (jobsResponse.ok && jobsResult.success === true && Array.isArray(jobsResult.jobs)) {
      setSyncErrorMsg(null);
      const referencedCatalogJobIds = [...new Set(result.sources
        .map((source: Record<string, any>) => source.catalogSync?.syncJobId)
        .filter((jobId: unknown): jobId is string => typeof jobId === 'string' && jobId.trim().length > 0)
        .map((jobId: string) => jobId.trim()))];
      const knownJobIds = new Set(jobsResult.jobs.map((job) => job.id));
      const referencedJobs = await Promise.all(referencedCatalogJobIds
        .filter((jobId) => !knownJobIds.has(jobId))
        .slice(0, 10)
        .map(async (jobId) => {
          try {
            const response = await getSupplierApi(`/api/supplier-sync/jobs/${encodeURIComponent(jobId)}`);
            const payload = await response.json().catch(() => ({})) as { success?: boolean; job?: SupplierSyncJobView };
            return response.ok && payload.success === true && payload.job ? payload.job : null;
          } catch {
            return null;
          }
        }));
      applySyncJobViews([
        ...jobsResult.jobs,
        ...referencedJobs.filter((job): job is SupplierSyncJobView => Boolean(job)),
      ]);
    }
    void refreshSupplierReviewActionableCount();
  }, [applySyncJobViews, refreshSupplierReviewActionableCount]);

  useEffect(() => {
    let cancelled = false;
    // Firebase may restore a persisted session after this lazy panel mounts.
    // Load once the ID-token observer confirms an authenticated user, and load
    // again after a token refresh so requests never depend on a stale snapshot.
    const unsubscribeAuth = onIdTokenChanged(auth, (currentUser) => {
      if (!currentUser) {
        setCanAccessAdvanced(false);
        return;
      }
      void currentUser.getIdTokenResult().then((token) => {
        if (!cancelled) setCanAccessAdvanced(hasSupplierHubAdvancedAccess(token.claims));
      }).catch(() => {
        if (!cancelled) setCanAccessAdvanced(false);
      });
      void loadSources().catch((error) => {
        if (!cancelled) {
          setSupplierSourcesLoaded(false);
          setErrorMsg(supplierBusinessErrorMessage(error, 'Supplier sources could not be loaded.'));
          handleFirestoreError(error, OperationType.GET, 'supplierSources API');
        }
      });
    });
    return () => {
      cancelled = true;
      unsubscribeAuth();
    };
  }, [loadSources]);

  const [categories, setCategories] = useState<any[]>([]);
  const [brands, setBrands] = useState<any[]>([]);
  const [supplierCategoryMappings, setSupplierCategoryMappings] = useState<SupplierCategoryMappingView[]>([]);
  const [supplierCategoryMappingDrafts, setSupplierCategoryMappingDrafts] = useState<Record<string, { targetCategoryId: string; targetSubcategoryId: string }>>({});
  const [savingSupplierCategoryMapping, setSavingSupplierCategoryMapping] = useState<string | null>(null);
  const [removingSupplierCategoryMapping, setRemovingSupplierCategoryMapping] = useState<string | null>(null);

  const loadReviewCatalog = useCallback(async () => {
    try {
      const response = await getSupplierApi('/api/supplier-review-catalog');
      if (!response.ok) throw new Error(`Supplier review catalog request failed with status ${response.status}`);
      const payload = await response.json();
      const taxonomy = projectSupplierReviewCatalogTaxonomy(payload);
      setCategories(sortCategoriesAlphabetically(
        taxonomy.categories.map((category) => normalizeCategoryBlueprint(category)),
      ));
      setBrands(sortBrandsAlphabetically(taxonomy.brands));
      try {
        const mappingsResponse = await getSupplierApi('/api/supplier-category-mappings');
        const mappingsPayload = mappingsResponse.ok
          ? await mappingsResponse.json() as { mappings?: SupplierCategoryMappingView[] }
          : {};
        const mappings = Array.isArray(mappingsPayload.mappings) ? mappingsPayload.mappings : [];
        setSupplierCategoryMappings(mappings);
        setSupplierCategoryMappingDrafts(Object.fromEntries(mappings.map((mapping) => [
          supplierCategoryMappingUiKey(
            mapping.sourceId,
            mapping.normalizedCategory,
            mapping.mappingScope === 'child' ? mapping.supplierSubcategory : undefined,
            mapping.mappingScope === 'child' ? mapping.supplierSubcategoryId : undefined,
          ),
          {
            targetCategoryId: mapping.targetCategoryId,
            targetSubcategoryId: mapping.supplierSubcategory || mapping.supplierSubcategoryId
              ? mapping.targetSubcategoryId || ''
              : '',
          },
        ])));
      } catch {
        setSupplierCategoryMappings([]);
      }
    } catch (error) {
      console.error('Supplier review catalog fetch error:', error);
      setCategories([]);
      setBrands([]);
    }
  }, []);

  useEffect(() => {
    if (!['review', 'suppliers', 'settings', 'overview'].includes(activeSubTab)) return;
    void loadReviewCatalog();
  }, [activeSubTab, loadReviewCatalog]);

  useEffect(() => {
    if (activeSubTab !== 'settings') return;
    const unsubscribe = onSnapshot(
      doc(db, "supplier_settings", "config"),
      (snapshot) => {
        if (snapshot.exists()) {
          const persistedSettings = snapshot.data();
          const pendingSettings = pendingSupplierSettingsRef.current;
          const pendingConfirmed = pendingSettings !== null && Object.entries(pendingSettings).every(([key, value]) => (
            JSON.stringify(persistedSettings[key]) === JSON.stringify(value)
          ));
          if (pendingConfirmed) pendingSupplierSettingsRef.current = null;
          setSupplierSettings(prev => ({
            ...prev,
            ...persistedSettings,
            ...(pendingSettings && !pendingConfirmed ? pendingSettings : {}),
          }));
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, "supplier_settings/config");
      }
    );

    return () => unsubscribe();
  }, [activeSubTab]);

  // The API already applies the selected business/media/search query. Keep the
  // browser page bounded and render only the authoritative page returned by it.
  const visibleReviewItems = reviewQueue;
  const validCategoryIds = useMemo(() => supplierReviewValidCategoryIds(categories), [categories]);
  const supplierCategoryOptions = useMemo(() => {
    const values = new Map<string, {
      key: string;
      sourceId: string;
      supplierCategory: string;
      supplierSubcategory?: string;
      supplierSubcategoryId?: string;
      label: string;
    }>();
    const addCategories = (
      sourceId: string,
      source: unknown,
      sourceLabel?: string,
      supplierSubcategory?: string,
      supplierSubcategoryId?: string,
    ) => {
      if (!Array.isArray(source)) return;
      source.forEach((value) => {
        const label = String(value || '').trim();
        const normalized = normalizeSupplierCategory(label);
        if (normalized && sourceId) {
          const key = supplierCategoryMappingUiKey(sourceId, normalized, supplierSubcategory, supplierSubcategoryId);
          const existing = values.get(key);
          if (!existing) {
            const displayLabel = `${sourceLabel || sourceId} · ${label}${supplierSubcategory ? ` / ${supplierSubcategory}` : ''}`;
            values.set(key, {
              key,
              sourceId,
              supplierCategory: label,
              ...(supplierSubcategory ? { supplierSubcategory } : {}),
              ...(supplierSubcategoryId ? { supplierSubcategoryId } : {}),
              label: displayLabel,
            });
          }
        }
      });
    };

    reviewQueue.forEach((item) => {
      const hierarchy = item.supplierSnapshot?.categoryHierarchy;
      const supplierSubcategory = Array.isArray(hierarchy) ? String(hierarchy[1] || '').trim() : '';
      const supplierSubcategoryId = String(
        item.supplierSnapshot?.supplierSubcategoryId
        || (item.supplierSnapshot?.extraAttributes as Record<string, unknown> | undefined)?.supplierSubcategoryId
        || '',
      ).trim();
      const parent = Array.isArray(hierarchy) ? hierarchy.slice(0, 1) : hierarchy;
      addCategories(String(item.sourceId || item.supplierId || ''), parent, item.supplierName, supplierSubcategory, supplierSubcategoryId);
    });
    supplierSources.forEach((source) => addCategories(String(source.id || ''), source.settings?.discoveredCategories, source.supplierName || source.name));
    supplierCategoryMappings.forEach((mapping) => addCategories(
      mapping.sourceId,
      [mapping.supplierCategory],
      mapping.sourceId,
      mapping.mappingScope === 'child' ? mapping.supplierSubcategory : undefined,
      mapping.mappingScope === 'child' ? mapping.supplierSubcategoryId : undefined,
    ));
    return Array.from(values.values()).sort((left, right) => left.label.localeCompare(right.label));
  }, [reviewQueue, supplierSources, supplierCategoryMappings]);
  const supplierSourceById = useMemo(
    () => new Map(supplierSources.map((source) => [String(source.id), source])),
    [supplierSources],
  );
  const compactSupplierAttribution = useCallback((item: ReviewQueueItem): string => {
    const source = supplierSourceById.get(String(item.sourceId || item.supplierId || ''));
    const supplierLabel = String(item.supplierName || source?.supplierName || source?.name || 'Supplier').trim();
    const connectorValue = String(item.connector || source?.connectorType || source?.supplierType || item.source || 'Supplier source').trim();
    const connectorLabel = connectorValue.toLowerCase().includes('a2z')
      ? 'A2Z'
      : connectorValue.toLowerCase().includes('dropex')
        ? 'Dropex'
        : connectorValue.replaceAll('_', ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase());
    return `${supplierLabel} · ${connectorLabel}`;
  }, [supplierSourceById]);
  const sourceIsSyncing = useCallback((sourceId: string): boolean => Boolean(
    currentSyncJob
    && isSupplierSyncJobActive(currentSyncJob)
    && (currentSyncJob.sourceIds.includes(sourceId) || currentSyncJob.progress.currentSourceId === sourceId)
  ), [currentSyncJob]);

  // Supplier Settings Engine state
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editSupplierName, setEditSupplierName] = useState<string>('');
  const [editWebsiteUrl, setEditWebsiteUrl] = useState<string>('');
  const [editEndpoint, setEditEndpoint] = useState<string>('');
  const [editCredentialProfile, setEditCredentialProfile] = useState<string>('');
  const [editSupplierAccountId, setEditSupplierAccountId] = useState<string>('');
  const [editSyncMode, setEditSyncMode] = useState<'manual' | 'auto'>('manual');
  const [editAutoSyncSchedule, setEditAutoSyncSchedule] = useState<string>('1 Hour');
  
  // Sync settings
  const [editCategoriesFilter, setEditCategoriesFilter] = useState<string[]>([]);
  const [editBrandFilter, setEditBrandFilter] = useState<string>('');
  const [editProductLimit, setEditProductLimit] = useState<string>('All');
  
  const [savingSettingsSourceId, setSavingSettingsSourceId] = useState<string | null>(null);

  const selectSubTab = useCallback((tab: SupplierHubSection) => {
    const nextSection: SupplierHubPrimarySection = tab === 'activity' ? 'operations' : tab as SupplierHubPrimarySection;
    setActiveSubTab(nextSection);
    writeSupplierHubSectionUrl(nextSection);
    onSubTabChange?.(nextSection);
  }, [onSubTabChange]);

  useEffect(() => {
    if (!onNestedNavigationChange || activeSubTab !== 'suppliers') {
      onNestedNavigationChange?.(null);
      return;
    }
    if (editingSourceId) {
      onNestedNavigationChange({
        active: true,
        title: 'Supplier Details',
        onBack: () => setEditingSourceId(null),
      });
      return;
    }
    onNestedNavigationChange(null);
  }, [activeSubTab, editingSourceId, onNestedNavigationChange]);

  const [processingChangeId, setProcessingChangeId] = useState<string | null>(null);
  const [savingReviewDraftId, setSavingReviewDraftId] = useState<string | null>(null);
  const [refreshingReviewItemId, setRefreshingReviewItemId] = useState<string | null>(null);
  const refreshingReviewItemIdRef = useRef<string | null>(null);
  const [refreshFeedback, setRefreshFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const refreshFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryingMediaId, setRetryingMediaId] = useState<string | null>(null);
  const [editingReviewItem, setEditingReviewItem] = useState<ReviewQueueItem | null>(null);

  useEffect(() => {
    if (!editingReviewItem) return;
    void loadReviewCatalog();
  }, [editingReviewItem, loadReviewCatalog]);

  const [supplierOffers, setSupplierOffers] = useState<SupplierOfferView[]>([]);
  const [supplierOfferSelection, setSupplierOfferSelection] = useState<SupplierOfferSelectionView>({ activeOfferId: null, lockedOfferId: null, failoverEnabled: true });
  const [supplierOffersLoading, setSupplierOffersLoading] = useState(false);
  const [supplierOfferActionId, setSupplierOfferActionId] = useState<string | null>(null);
  const [supplierOfferError, setSupplierOfferError] = useState<string | null>(null);
  const [rejectingReviewItem, setRejectingReviewItem] = useState<ReviewQueueItem | null>(null);
  const [rejectionReasonDraft, setRejectionReasonDraft] = useState('');
  const [removingReviewItem, setRemovingReviewItem] = useState<ReviewQueueItem | null>(null);
  const [historyReviewItem, setHistoryReviewItem] = useState<ReviewQueueItem | null>(null);
  const [reviewAuditEvents, setReviewAuditEvents] = useState<SupplierReviewAuditEvent[]>([]);
  const [reviewAuditCursor, setReviewAuditCursor] = useState<string | null>(null);
  const [reviewAuditLoading, setReviewAuditLoading] = useState(false);
  const [reviewAuditError, setReviewAuditError] = useState<string | null>(null);
  // 3. Settings states
  const [supplierSettings, setSupplierSettings] = useState<any>({
    autoSyncEnabled: false,
    syncInterval: '1 Hour',
    maxProducts: 5,
    lastSync: "",
    nextSync: "",
    defaultProfitMargin: 15,
    defaultMarkup: 10,
    defaultImageLimit: 5,
    categoryMappings: {},
    lastUpdated: "",
    updatedBy: ""
  });
  const [savingSupplierSettings, setSavingSupplierSettings] = useState<boolean>(false);

  const generateSlug = (name: string): string => {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') 
      .replace(/[\s_]+/g, '-')   
      .replace(/-+/g, '-')      
      .replace(/^-+|-+$/g, '');  
  };

  const loadSupplierQueueView = async (
    options: {
      page?: number;
      reviewState?: 'active' | 'conflict' | 'history';
    } = {},
  ): Promise<boolean> => {
    const targetPage = Math.max(1, Math.min(10_000, options.page || supplierReviewPage));
    const dedicatedMediaQueue = reviewQueueMode === 'ready' || reviewQueueMode === 'waiting';
    const queryFilter = dedicatedMediaQueue ? '' : reviewFilter;
    const queryMedia = dedicatedMediaQueue
      ? reviewQueueMode === 'ready' ? 'ready' as const : 'processing' as const
      : reviewMediaFilter;
    const queryKey = buildSupplierReviewQueryKey({
      view: 'review',
      filter: queryFilter,
      media: queryMedia,
      search: reviewSearch,
      sort: reviewSort,
      pageSize: supplierReviewPageSize,
    });
    if (supplierReviewQueryKeyRef.current !== queryKey) {
      supplierReviewAnchorCacheRef.current.clear();
      supplierReviewQueryRevisionRef.current = null;
      supplierReviewQueryKeyRef.current = queryKey;
      setSupplierReviewMediaSummary(null);
      setReviewQueue([]);
    }
    const requestId = ++supplierQueueRequestIdRef.current;
    setSupplierReviewPageNavigationError(null);
    setSupplierReviewLoading(true);
    try {
      const nearest = targetPage === 1
        ? { page: 1, cursor: null as string | null }
        : supplierReviewAnchorCacheRef.current.nearest(queryKey, targetPage) || { page: 1, cursor: null as string | null };
      if (targetPage - nearest.page > 10) {
        throw new Error('Page position is being re-established. Try a nearer page or use Next.');
      }
      let scanCursor = nearest.cursor;
      let scanPage = nearest.page;
      let nextCursor: string | null = null;
      let items: ReviewQueueItem[] = [];
      let finalResult: SupplierQueuePageResponse | null = null;
      while (scanPage <= targetPage) {
        const parameters = new URLSearchParams({ view: 'review', limit: '50' });
        parameters.set('page', String(scanPage));
        parameters.set('limit', String(supplierReviewPageSize));
        parameters.set('pageSize', String(supplierReviewPageSize));
        parameters.set('state', options.reviewState || supplierReviewApiState(queryFilter as ProductReviewFilter));
        if (reviewSort === 'updated') parameters.set('sort', 'updated');
        if (queryFilter) parameters.set('filter', queryFilter);
        if (queryMedia !== 'all') parameters.set('media', queryMedia);
        if (reviewSearch.trim()) {
          parameters.set('search', reviewSearch.trim());
          parameters.set('searchMode', 'exact');
        }
        if (supplierReviewQueryRevisionRef.current) parameters.set('revision', supplierReviewQueryRevisionRef.current);
        if (scanCursor) parameters.set('cursor', scanCursor);
        const response = await getSupplierApi(`/api/supplier-review-queue?${parameters.toString()}`);
        const result = await response.json().catch(() => ({})) as SupplierQueuePageResponse;
        if (!response.ok || result.success !== true || !Array.isArray(result.items)) {
          throw new Error(result.error || 'Supplier products could not be loaded.');
        }
        if (requestId !== supplierQueueRequestIdRef.current) return false;
        finalResult = result;
        nextCursor = result.nextCursor || null;
        if (result.queryRevision) supplierReviewQueryRevisionRef.current = result.queryRevision;
        if (result.mediaSummary) setSupplierReviewMediaSummary(result.mediaSummary);
        const responseQueryKey = result.queryFingerprint || queryKey;
        supplierReviewAnchorCacheRef.current.set(responseQueryKey, scanPage, scanCursor || null);
        if (nextCursor) supplierReviewAnchorCacheRef.current.set(responseQueryKey, scanPage + 1, nextCursor);
        if (scanPage === targetPage) {
          items = result.items as unknown as ReviewQueueItem[];
          break;
        }
        if (!nextCursor) throw new Error('The requested Product Review page does not exist.');
        scanCursor = nextCursor;
        scanPage += 1;
      }
      if (!finalResult) throw new Error('Product Review page could not be loaded.');
      // PR-3 replaces the visible Load More model with one bounded server page at
      // a time. Polling reloads only the current page and preserves its anchors.
      setReviewQueue(items);
      setSupplierReviewCursor(nextCursor);
      setSupplierReviewTotalCount(finalResult.totalCount ?? null);
      setSupplierReviewTotalPages(finalResult.totalPages ?? null);
      setSupplierReviewCountStatus(finalResult.countStatus || null);
      setSupplierQueueError(null);
      setSupplierReviewPageNavigationError(null);
      return true;
    } catch (error) {
      if (requestId === supplierQueueRequestIdRef.current) {
        const message = error instanceof Error ? error.message : 'Supplier products could not be loaded.';
        if (message.includes('Page position') || message.includes('page does not exist')) {
          setSupplierReviewPageNavigationError(message);
        } else {
          setSupplierQueueError(message);
        }
      }
      return false;
    } finally {
      if (requestId === supplierQueueRequestIdRef.current) {
        setSupplierReviewLoading(false);
      }
    }
  };

  const refreshSupplierQueueViews = async (): Promise<boolean> => {
    void refreshSupplierReviewActionableCount();
    return loadSupplierQueueView({ page: supplierReviewPage });
  };

  useEffect(() => {
    if (!['review', 'overview'].includes(activeSubTab) || !auth.currentUser) return;
    let cancelled = false;
    let refreshTimer: number | null = null;
    const poll = async () => {
      // Overview uses the bounded summary read model. It must not load a
      // Product Review page merely to populate headline counts.
      if (activeSubTab === 'review') await refreshSupplierQueueViews();
      else await refreshSupplierReviewActionableCount();
      if (!cancelled) refreshTimer = window.setTimeout(() => {
        if (auth.currentUser) void poll();
      }, 30_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [activeSubTab, refreshSupplierReviewActionableCount, reviewFilter, reviewMediaFilter, reviewQueueMode, reviewSort, reviewSearch, supplierReviewPage, supplierReviewPageSize]);

  const updateProductReviewUrl = (
    patch: Partial<{ filter: ProductReviewFilter; media: 'all' | 'ready' | 'processing' | 'issues'; queueMode: SupplierReviewQueueMode; sort: 'created' | 'updated'; search: string; page: number; pageSize: ProductReviewPageSize }>,
    mode: 'push' | 'replace' = 'push',
  ): void => {
    writeProductReviewUrlState({
      filter: reviewFilter,
      media: reviewMediaFilter,
      queueMode: reviewQueueMode,
      sort: reviewSort,
      search: reviewSearch,
      page: supplierReviewPage,
      pageSize: supplierReviewPageSize,
      ...patch,
    }, mode);
  };

  const handleReviewFilterChange = (filter: ProductReviewFilter): void => {
    setReviewFilter(filter);
    setReviewQueueMode('advanced');
    setSupplierReviewPage(1);
    updateProductReviewUrl({ filter, queueMode: 'advanced', page: 1 });
  };

  const handleReviewMediaFilterChange = (media: 'all' | 'ready' | 'processing' | 'issues'): void => {
    setReviewMediaFilter(media);
    setReviewQueueMode('advanced');
    setSupplierReviewPage(1);
    updateProductReviewUrl({ media, queueMode: 'advanced', page: 1 });
  };

  const handleReviewQueueViewChange = (view: SupplierReviewQueueView): void => {
    const applyQueueQuery = (filter: ProductReviewFilter, media: 'all' | 'ready' | 'processing' | 'issues'): void => {
      setReviewFilter(filter);
      setReviewMediaFilter(media);
      setReviewQueueMode(view === 'ready' ? 'ready' : view === 'waiting' ? 'waiting' : 'advanced');
      setSupplierReviewPage(1);
      updateProductReviewUrl({
        filter,
        media,
        queueMode: view === 'ready' ? 'ready' : view === 'waiting' ? 'waiting' : 'advanced',
        page: 1,
      });
    };
    if (view === 'ready') {
      applyQueueQuery('new_products', 'ready');
      return;
    }
    if (view === 'actionable') {
      applyQueueQuery('actionable', 'all');
      return;
    }
    if (view === 'waiting') {
      applyQueueQuery('new_products', 'processing');
      return;
    }
    if (view === 'issues') {
      applyQueueQuery('needs_attention', 'all');
      return;
    }
    if (view === 'history') {
      applyQueueQuery('approved_history', 'all');
      return;
    }
    if (view === 'updates') {
      applyQueueQuery('product_updates', 'all');
      return;
    }
    applyQueueQuery('new_products', 'all');
  };

  const handleReviewSortChange = (sort: 'created' | 'updated'): void => {
    setReviewSort(sort);
    setSupplierReviewPage(1);
    updateProductReviewUrl({ sort, page: 1 });
  };

  const handleReviewSearchChange = (search: string): void => {
    setReviewSearch(search);
    setSupplierReviewPage(1);
    updateProductReviewUrl({ search, page: 1 }, 'replace');
  };

  const handleReviewPageSizeChange = (pageSize: ProductReviewPageSize): void => {
    setSupplierReviewPageSize(pageSize);
    setSupplierReviewPage(1);
    updateProductReviewUrl({ pageSize, page: 1 });
  };

  const handleReviewPageChange = (page: number): void => {
    if (page < 1 || page === supplierReviewPage || supplierReviewLoading) return;
    if (supplierReviewTotalPages !== null && page > supplierReviewTotalPages) return;
    setSupplierReviewPage(page);
    updateProductReviewUrl({ page });
  };

  const loadMediaForensics = async (item: ReviewQueueItem): Promise<void> => {
    setMediaForensicItemId(item.id);
    setMediaForensicLoading(true);
    setMediaForensicError(null);
    try {
      const evidence = await fetchSupplierMediaForensics({ queueItemId: item.id });
      setMediaForensicEvidence(evidence);
    } catch (error) {
      setMediaForensicEvidence(null);
      setMediaForensicError(error instanceof Error ? error.message : 'Supplier media diagnostics could not be loaded.');
    } finally {
      setMediaForensicLoading(false);
    }
  };

  useEffect(() => {
    const handleProductReviewPopState = (): void => {
      const next = readProductReviewUrlState();
      const nextSection = readSupplierHubSection(activeSubTab);
      setActiveSubTab(nextSection);
      onSubTabChange?.(nextSection);
      setReviewFilter(next.filter);
      setReviewMediaFilter(next.media);
      setReviewSort(next.sort);
      setReviewSearch(next.search);
      setSupplierReviewPage(next.page);
      setSupplierReviewPageSize(next.pageSize);
    };
    window.addEventListener('popstate', handleProductReviewPopState);
    return () => window.removeEventListener('popstate', handleProductReviewPopState);
  }, [activeSubTab, onSubTabChange]);

  useEffect(() => {
    if (!['review', 'overview'].includes(activeSubTab) || !auth.currentUser) return;
    let cancelled = false;
    let timer: number | null = null;
    let lastObserved: PendingReviewBatchJobView | null = null;
    const poll = async () => {
      try {
        const response = await getSupplierApi('/api/supplier-review-queue/refresh-batch/jobs?limit=10');
        const result = await response.json().catch(() => ({})) as { success?: boolean; jobs?: PendingReviewBatchJobView[] };
        if (!response.ok || result.success !== true || !Array.isArray(result.jobs)) throw new Error('Pending review refresh status could not be loaded.');
        if (cancelled) return;
        const active = result.jobs.find((job) => isPendingReviewBatchJobActive(job)) || result.jobs[0] || null;
        lastObserved = active;
        setPendingReviewBatchJob(active);
        if (active) setPendingReviewBatchResult(active);
        const delay = pendingReviewBatchPollDelayMs(active);
        if (delay !== null) timer = window.setTimeout(poll, delay);
      } catch {
        if (!cancelled && pendingReviewBatchPollDelayMs(lastObserved) !== null) timer = window.setTimeout(poll, 10_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearPendingReviewBatchPollTimer(timer, window.clearTimeout);
    };
  }, [activeSubTab]);

  useEffect(() => {
    if (!editingReviewItem) return;
    const fresh = reviewQueue.find((item) => item.id === editingReviewItem.id);
    if (!fresh) {
      setEditingReviewItem(null);
      setSupplierOffers([]);
      setSupplierOfferError(null);
      return;
    }
    if (
      fresh.supplierOfferPendingRevision !== editingReviewItem.supplierOfferPendingRevision
      || fresh.queueState !== editingReviewItem.queueState
      || fresh.status !== editingReviewItem.status
    ) {
      if (!supplierReviewDecisionReady(fresh) || supplierReviewIsPreparing(fresh)) {
        setEditingReviewItem(null);
        setSupplierOffers([]);
        setSupplierOfferError(null);
        setSuccessMsg(SUPPLIER_REVIEW_STALE_REFRESH_MESSAGE);
        setTimeout(() => setSuccessMsg(null), 6000);
        return;
      }
      setEditingReviewItem(fresh);
    }
  }, [editingReviewItem, reviewQueue]);

  useEffect(() => {
    const jobId = currentSyncJob?.id;
    if (!jobId || !isSupplierSyncJobActive(currentSyncJob)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const response = await getSupplierApi(`/api/supplier-sync/jobs/${encodeURIComponent(jobId)}`);
        const result = await response.json().catch(() => ({})) as { success?: boolean; job?: SupplierSyncJobView; error?: string };
        if (!response.ok || result.success !== true || !result.job) throw new Error(result.error || 'Synchronization status could not be loaded.');
        if (cancelled) return;
        const active = isSupplierSyncJobActive(result.job);
        if (active) applyStartedSyncJob(result.job);
        setSyncErrorMsg(null);
        if (!active) {
          setOperationsRefreshKey((current) => current + 1);
          void refreshSupplierQueueViews();
          const jobsResponse = await getSupplierApi('/api/supplier-sync/jobs?limit=20');
          const jobsResult = await jobsResponse.json().catch(() => ({})) as {
            success?: boolean;
            jobs?: SupplierSyncJobView[];
          };
          if (!cancelled && jobsResponse.ok && jobsResult.success === true && Array.isArray(jobsResult.jobs)) {
            applySyncJobViews(jobsResult.jobs);
          } else if (currentSyncJobRef.current?.id === jobId) {
            applySyncJobViews([]);
          }
        }
        if (active) timer = setTimeout(poll, 2_000);
      } catch (error) {
        if (cancelled) return;
        setSyncErrorMsg(error instanceof Error ? error.message : 'Synchronization status could not be loaded.');
        timer = setTimeout(poll, 5_000);
      }
    };

    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [applyStartedSyncJob, applySyncJobViews, currentSyncJob?.id, currentSyncJob?.state]);

  const handleSyncJobAction = async (action: 'cancel' | 'retry' | 'resume', job: SupplierSyncJobView) => {
    setSyncJobAction(action);
    setSyncErrorMsg(null);
    try {
      const response = await postSupplierApi(`/api/supplier-sync/jobs/${encodeURIComponent(job.id)}/${action}`, {});
      const result = await response.json().catch(() => ({})) as { success?: boolean; job?: SupplierSyncJobView; error?: string };
      if (!response.ok || result.success !== true || !result.job) throw new Error(result.error || `Synchronization could not ${action}.`);
      if (isSupplierSyncJobActive(result.job)) {
        applyStartedSyncJob(result.job);
      } else {
        const jobsResponse = await getSupplierApi('/api/supplier-sync/jobs?limit=20');
        const jobsResult = await jobsResponse.json().catch(() => ({})) as { success?: boolean; jobs?: SupplierSyncJobView[] };
        if (jobsResponse.ok && jobsResult.success === true && Array.isArray(jobsResult.jobs)) {
          applySyncJobViews(jobsResult.jobs);
        } else {
          setLastSyncJob(result.job);
          setCurrentSyncJob(null);
          currentSyncJobRef.current = null;
          setIsSyncing(false);
        }
      }
    } catch (error) {
      setSyncErrorMsg(error instanceof Error ? error.message : `Synchronization could not ${action}.`);
    } finally {
      setSyncJobAction(null);
    }
  };

  const supplierReviewProductId = (item: ReviewQueueItem | null): string => String(
    item?.productPayload?.id || item?.matchedProductId || item?.comparison?.matchedProductId || '',
  ).trim();

  const loadSupplierOffers = async (item: ReviewQueueItem | null = editingReviewItem) => {
    const productId = supplierReviewProductId(item);
    if (!productId) {
      setSupplierOffers([]);
      setSupplierOfferSelection({ activeOfferId: null, lockedOfferId: null, failoverEnabled: true });
      return;
    }
    setSupplierOffersLoading(true);
    setSupplierOfferError(null);
    try {
      const response = await getSupplierApi(`/api/supplier-products/${encodeURIComponent(productId)}/offers`);
      const result = await response.json().catch(() => ({})) as SupplierOffersResponse;
      if (!response.ok || result.success !== true || !Array.isArray(result.offers)) {
        throw new Error(result.error || 'Supplier offers could not be loaded.');
      }
      setSupplierOffers(sortSupplierOffers(result.offers));
      setSupplierOfferSelection(result.selection || { activeOfferId: null, lockedOfferId: null, failoverEnabled: true });
    } catch (error) {
      setSupplierOfferError(error instanceof Error ? error.message : 'Supplier offers could not be loaded.');
    } finally {
      setSupplierOffersLoading(false);
    }
  };

  const openSupplierReviewEditor = (item: ReviewQueueItem) => {
    setEditingReviewItem(item);
    void loadSupplierOffers(item);
  };

  const configureSupplierOffer = async (offerId: string, patch: { priority?: number; enabled?: boolean }) => {
    const productId = supplierReviewProductId(editingReviewItem);
    if (!productId) return;
    setSupplierOfferActionId(offerId);
    setSupplierOfferError(null);
    try {
      const response = await patchSupplierApi(
        `/api/supplier-products/${encodeURIComponent(productId)}/offers/${encodeURIComponent(offerId)}`,
        { offer: patch },
      );
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Supplier offer could not be updated.');
      await loadSupplierOffers(editingReviewItem);
    } catch (error) {
      setSupplierOfferError(error instanceof Error ? error.message : 'Supplier offer could not be updated.');
    } finally {
      setSupplierOfferActionId(null);
    }
  };

  const selectSupplierOffer = async (offerId: string, options: { locked: boolean; failoverEnabled: boolean }) => {
    const productId = supplierReviewProductId(editingReviewItem);
    if (!productId) return;
    setSupplierOfferActionId(offerId);
    setSupplierOfferError(null);
    try {
      const response = await postSupplierApi(`/api/supplier-products/${encodeURIComponent(productId)}/offers/select`, {
        offerId,
        ...options,
      });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'The active supplier offer could not be changed.');
      await loadSupplierOffers(editingReviewItem);
    } catch (error) {
      setSupplierOfferError(error instanceof Error ? error.message : 'The active supplier offer could not be changed.');
    } finally {
      setSupplierOfferActionId(null);
    }
  };

  const decideSupplierReviewQueueItem = async (
    queueItemId: string,
    action: 'approve' | 'reject' | 'delete',
    body: Record<string, unknown> = {},
  ) => {
    const response = await postSupplierApi(`/api/supplier-review-queue/${encodeURIComponent(queueItemId)}/${action}`, body);
    const result = await response.json().catch(() => ({})) as {
      success?: boolean;
      error?: string;
      status?: string;
      conflict?: ReviewQueueItem['approvalConflict'];
      details?: { code?: string };
    };
    if (response.status === 409 && result.status === 'conflict' && result.conflict) return result;
    if (result.details?.code === 'SUPPLIER_DATA_CHANGED') {
      return { success: false, status: 'supplier_freshness_conflict', error: result.error };
    }
    if (result.details?.code === 'SUPPLIER_DATA_UNVERIFIED') {
      return { success: false, status: 'supplier_freshness_unverified', error: result.error };
    }
    if (response.status === 409 && isSupplierReviewStaleObservationError(result.error)) {
      return { success: false, status: 'stale_observation', error: result.error };
    }
    if (!response.ok || result.success !== true) {
      throw new Error(result.error || 'Supplier review action could not be completed.');
    }
    return result;
  };

  const supplierReviewRefreshEligible = (item: ReviewQueueItem | null): boolean => {
    if (!item) return false;
    const connector = String(item.connector || '').trim().toLowerCase();
    const source = String(item.sourceId || '').trim().toLowerCase();
    const state = String(item.queueState || '').trim().toLowerCase();
    const status = String(item.status || '').trim().toLowerCase();
    return (connector === 'dropex' || source === 'dropex')
      && state === 'review_pending'
      && (status === 'pending' || status === '');
  };

  const showRefreshFeedback = (feedback: { kind: 'success' | 'error'; message: string }) => {
    if (refreshFeedbackTimerRef.current !== null) clearTimeout(refreshFeedbackTimerRef.current);
    setRefreshFeedback(feedback);
    refreshFeedbackTimerRef.current = setTimeout(() => {
      setRefreshFeedback(null);
      refreshFeedbackTimerRef.current = null;
    }, 5000);
  };

  const handleRefreshSupplierReviewItem = async (item: ReviewQueueItem) => {
    if (processingChangeId || refreshingReviewItemIdRef.current || !supplierReviewRefreshEligible(item)) return;
    refreshingReviewItemIdRef.current = item.id;
    setRefreshingReviewItemId(item.id);
    setRefreshFeedback(null);
    try {
      const response = await postSupplierApi(`/api/supplier-review-queue/${encodeURIComponent(item.id)}/refresh`, {});
      const result = await response.json().catch(() => ({})) as {
        success?: boolean;
        error?: string;
        item?: Record<string, unknown> & { id?: string };
      };
      if (!response.ok || result.success !== true || !result.item) {
        throw new Error(result.error || 'Supplier review item could not be refreshed.');
      }
      const refreshedItem = result.item as unknown as ReviewQueueItem;
      setReviewQueue((current) => current.map((candidate) => candidate.id === item.id ? refreshedItem : candidate));
      setEditingReviewItem(refreshedItem);
      refreshingReviewItemIdRef.current = null;
      setRefreshingReviewItemId(null);
      const refreshMessage = 'Supplier review refreshed from the current Dropex observation. No approval or publication was performed.';
      showRefreshFeedback({ kind: 'success', message: refreshMessage });
      setSuccessMsg(refreshMessage);
      setTimeout(() => setSuccessMsg(null), 5000);
      void Promise.all([loadSupplierOffers(refreshedItem), refreshSupplierQueueViews()]);
    } catch (error) {
      const refreshMessage = error instanceof Error ? error.message : 'Supplier review item could not be refreshed.';
      showRefreshFeedback({ kind: 'error', message: refreshMessage });
      setErrorMsg(refreshMessage);
      setTimeout(() => setErrorMsg(null), 5000);
    } finally {
      if (refreshingReviewItemIdRef.current === item.id) {
        refreshingReviewItemIdRef.current = null;
        setRefreshingReviewItemId(null);
      }
    }
  };

  const handleSaveSupplierReviewDraft = async (
    item: ReviewQueueItem,
    draft: { category: string; subcategory: string },
  ): Promise<void> => {
    if (processingChangeId || savingReviewDraftId || refreshingReviewItemId) return;
    setSavingReviewDraftId(item.id);
    try {
      const response = await patchSupplierApi(`/api/supplier-review-queue/${encodeURIComponent(item.id)}/draft`, {
        categoryId: draft.category,
        subcategoryId: draft.subcategory,
        expectedPendingRevision: item.supplierOfferPendingRevision,
        expectedUpdatedAt: item.updatedAt,
      });
      const result = await response.json().catch(() => ({})) as {
        success?: boolean;
        status?: string;
        error?: string;
        item?: Record<string, unknown> & { id?: string };
      };
      if (!response.ok || result.success !== true || !result.item?.id) {
        throw new Error(response.status === 409
          ? (result.error || 'This review changed after it was opened. Reload before saving.')
          : (result.error || 'Supplier review changes could not be saved.'));
      }
      const savedItem = result.item as unknown as ReviewQueueItem;
      setReviewQueue((current) => current.map((candidate) => candidate.id === item.id ? savedItem : candidate));
      setEditingReviewItem(savedItem);
      setSuccessMsg('Changes saved. The review remains pending.');
      setTimeout(() => setSuccessMsg(null), 5000);
      void refreshSupplierQueueViews();
    } finally {
      setSavingReviewDraftId(null);
    }
  };

  const handleRefreshPendingReviewBatch = async (): Promise<void> => {
    if (pendingReviewBatchRefreshing || isPendingReviewBatchJobActive(pendingReviewBatchJob)) return;
    const confirmed = window.confirm(
      `Refresh up to ${pendingReviewBatchSize} existing pending Supplier Review items from their suppliers? No item will be approved or published.`,
    );
    if (!confirmed) return;
    setPendingReviewBatchRefreshing(true);
    setPendingReviewBatchResult(null);
    try {
      const response = await postSupplierApi('/api/supplier-review-queue/refresh-batch', { limit: pendingReviewBatchSize });
      const result = await response.json().catch(() => ({})) as PendingReviewBatchResponse;
      if (!response.ok || result.success !== true || !result.job) {
        throw new Error(result.error || 'Pending supplier reviews could not be refreshed.');
      }
      setPendingReviewBatchJob(result.job);
      setPendingReviewBatchResult(result.job);
      await refreshSupplierQueueViews();
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Pending supplier reviews could not be refreshed.');
    } finally {
      setPendingReviewBatchRefreshing(false);
    }
  };

  const handleRetryDeadLetterMedia = async (item: ReviewQueueItem) => {
    setRetryingMediaId(item.id);
    try {
      const response = await postSupplierApi(`/api/supplier-review-queue/${encodeURIComponent(item.id)}/retry`, {});
      const result = await response.json().catch(() => ({})) as { success?: boolean; state?: string; error?: string };
      if (!response.ok || result.success !== true || result.state !== 'queued') {
        throw new Error(result.error || 'Media retry could not be queued.');
      }
      await loadSupplierQueueView({ page: supplierReviewPage });
    } catch (error) {
      setSupplierQueueError(supplierBusinessErrorMessage(error, 'Media retry could not be queued.'));
    } finally {
      setRetryingMediaId(null);
    }
  };

  const loadSupplierReviewAudit = async (item: ReviewQueueItem, after?: string, append = false): Promise<void> => {
    const requestId = ++supplierAuditRequestIdRef.current;
    setReviewAuditLoading(true);
    if (!append) {
      setReviewAuditEvents([]);
      setReviewAuditCursor(null);
      setReviewAuditError(null);
    }
    try {
      const parameters = new URLSearchParams({ limit: '50' });
      if (after) parameters.set('after', after);
      const response = await getSupplierApi(`/api/supplier-review-queue/${encodeURIComponent(item.id)}/audit?${parameters.toString()}`);
      const result = await response.json().catch(() => ({})) as {
        success?: boolean;
        events?: SupplierReviewAuditEvent[];
        nextCursor?: string | null;
        error?: string;
      };
      if (!response.ok || result.success !== true || !Array.isArray(result.events)) {
        throw new Error(result.error || 'Review history could not be loaded.');
      }
      if (requestId !== supplierAuditRequestIdRef.current) return;
      setReviewAuditEvents((current) => append ? mergeSupplierQueuePage(current, result.events || []) : result.events || []);
      setReviewAuditCursor(result.nextCursor || null);
      setReviewAuditError(null);
    } catch (error) {
      if (requestId === supplierAuditRequestIdRef.current) {
        setReviewAuditError(error instanceof Error ? error.message : 'Review history could not be loaded.');
      }
    } finally {
      if (requestId === supplierAuditRequestIdRef.current) setReviewAuditLoading(false);
    }
  };

  const openSupplierReviewHistory = (item: ReviewQueueItem) => {
    setHistoryReviewItem(item);
    void loadSupplierReviewAudit(item);
  };

  const handleSyncSupplier = useCallback(async (request: SupplierManualSyncRequest): Promise<boolean> => {
    const currentJob = currentSyncJobRef.current;
    if (syncStartInFlightRef.current || isSupplierSyncJobActive(currentJob)) {
      return false;
    }
    let accepted = false;
    syncStartInFlightRef.current = true;
    setIsSyncing(true);
    setSyncErrorMsg(null);
    try {
      const response = await postSupplierApi('/api/supplier-sync', { ...request });
      const result = await response.json().catch(() => ({})) as {
        success?: boolean;
        accepted?: boolean;
        created?: boolean;
        deduplicated?: boolean;
        job?: SupplierSyncJobView;
        jobId?: string;
        status?: string;
        error?: string;
      };
      const followsExistingActiveJob = result.deduplicated === true && Boolean(result.job) && isSupplierSyncJobActive(result.job);
      if ((!response.ok && !followsExistingActiveJob) || result.success !== true || !result.job) {
        throw new Error(result.error || 'Supplier synchronization could not be completed.');
      }
      applyStartedSyncJob(result.job);
      accepted = true;
      return true;
    } catch (error: any) {
      setSyncErrorMsg(error.message || 'Supplier synchronization failed.');
      return false;
    } finally {
      if (!accepted) {
        syncStartInFlightRef.current = false;
        setIsSyncing(false);
      }
    }
  }, [applyStartedSyncJob, postSupplierApi]);

  // --- CONNECT SUPPLIER HANDLERS ---
  const buildNewSupplierSource = (
    connectionStatus = modalTestStatus === 'Connected' ? 'connected' : 'Not Synced',
    lastError = modalTestError,
  ) => {
    const code = newSupplierCode.trim() || generateSlug(newSupplierName);
    return buildSupplierOnboardingSource({
      id: code,
      supplierName: newSupplierName,
      supplierAccountId: newSupplierAccountId,
      supplierType: newSupplierType,
      websiteUrl: newSupplierUrl,
      endpoint: apiEndpoint,
      credentialProfile: newSupplierCredentialProfile,
      apiMethod,
      apiDataPath,
      connectionStatus,
      lastError,
    });
  };

  const buildNewSupplierConfigurationFingerprint = () => JSON.stringify(
    buildNewSupplierSource('Not Synced', null),
  );

  const handleModalTestConnection = async () => {
    testedSupplierConfigurationRef.current = null;
    if (!newSupplierName.trim()) {
      setModalTestStatus('Failed');
      setModalTestError("Supplier name is required to test the selected connector.");
      return;
    }
    if ((newSupplierType === 'website' || newSupplierType === 'a2z') && !newSupplierUrl.trim()) {
      setModalTestStatus('Failed');
      setModalTestError("Website URL is required to test connection.");
      return;
    }
    if (newSupplierType === 'dropex' && !newSupplierCredentialProfile.trim()) {
      setModalTestStatus('Failed');
      setModalTestError('A server-configured credential profile ID is required to test Dropex.');
      return;
    }
    if (newSupplierType === 'api' && !apiEndpoint.trim()) {
      setModalTestStatus('Failed');
      setModalTestError("REST endpoint URL is required to test connection.");
      return;
    }

    setModalTestStatus('testing');
    setModalTestError(null);
    setModalTestProductsCount(null);
    const source = buildNewSupplierSource('Not Synced', null);
    const testedConfiguration = buildNewSupplierConfigurationFingerprint();

    try {
      const response = await postSupplierApi('/api/test-supplier', {
        id: newSupplierCode.trim() || generateSlug(newSupplierName),
        source,
      });

      const result = await response.json();

      if (result.success) {
        testedSupplierConfigurationRef.current = testedConfiguration;
        setModalTestStatus('Connected');
        setModalTestProductsCount(result.productsCount);
      } else {
        testedSupplierConfigurationRef.current = null;
        setModalTestStatus('Failed');
        setModalTestError(result.error || "The endpoint did not respond successfully.");
      }
    } catch (err: any) {
      testedSupplierConfigurationRef.current = null;
      console.error("Modal connection test error:", err);
      setModalTestStatus('Failed');
      setModalTestError(err.message || "Failed to make a connection request to the server.");
    }
  };

  const handleTestExistingConnection = async (source: any) => {
    const urlToTest = source.websiteUrl || source.config?.targetUrl || '';

    if (!urlToTest) {
      setErrorMsg(`Missing Website URL for supplier: ${source.name}`);
      setTimeout(() => setErrorMsg(null), 4000);
      return;
    }

    setTestingSourceId(source.id);
    setSuccessMsg(`Testing connection to ${source.name}...`);
    
    try {
      const response = await postSupplierApi('/api/test-supplier', {
        sourceId: source.id,
      });

      const result = await response.json();

      if (result.success) {
        setSupplierSources((current) => current.map((item) => item.id === source.id
          ? { ...item, connectionStatus: 'connected', lastError: 'None' }
          : item));
        setSuccessMsg(`Connection successful! Discovered ${result.productsCount} products for ${source.name}.`);
        setTimeout(() => setSuccessMsg(null), 4000);
        
      } else {
        setSupplierSources((current) => current.map((item) => item.id === source.id
          ? { ...item, connectionStatus: 'Failed', lastError: result.error || 'Endpoint returned error response.' }
          : item));
        setErrorMsg(`Connection failed for ${source.name}: ${result.error || 'Endpoint returned error response.'}`);
        setTimeout(() => setErrorMsg(null), 5000);

      }
    } catch (err: any) {
      console.error("Test connection error:", err);
      setErrorMsg(`Network error during connection test: ${err.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 5000);

    } finally {
      setTestingSourceId(null);
    }
  };

  const handleConnectSupplierSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSupplierName.trim()) return;
    if (!newSupplierAccountId) {
      setErrorMsg('Select the active Supplier Portal account that owns this source.');
      return;
    }
    const proposedConfiguration = JSON.stringify(buildNewSupplierSource('Not Synced'));
    if (modalTestStatus !== 'Connected' || testedSupplierConfigurationRef.current !== proposedConfiguration) {
      setErrorMsg('Test this exact supplier configuration before saving and starting the initial sync.');
      setTimeout(() => setErrorMsg(null), 5000);
      return;
    }
    if ((newSupplierType === 'a2z' || newSupplierType === 'dropex') && !newSupplierCredentialProfile.trim()) {
      setModalTestStatus('Failed');
      setModalTestError('A server-configured credential profile ID is required to test this supplier.');
      return;
    }
    
    // Generate code if empty
    const code = newSupplierCode.trim() || generateSlug(newSupplierName);
    setSavingSupplier(true);

    const newSource = buildNewSupplierSource();

    try {
      const response = await postSupplierApi('/api/supplier-sources', {
        id: code,
        source: newSource,
        startInitialSync: false,
      });
      const result = await response.json().catch(() => ({})) as {
        success?: boolean;
        source?: Record<string, any> & { id: string };
        connectionTest?: { success?: boolean; error?: string };
        job?: SupplierSyncJobView;
        error?: string;
      };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Supplier source could not be created.');
      if (result.source) {
        const normalizedSource = normalizeSupplierSourceForUi(result.source);
        setSupplierSources((current) => [
          ...current.filter((source) => source.id !== normalizedSource.id),
          normalizedSource,
        ]);
      }
      
      // Reset form fields, test states, and modal
      setNewSupplierName("");
      setNewSupplierCode("");
      setNewSupplierType("a2z");
      setNewSupplierUrl("");
      setApiEndpoint("");
      setApiMethod("GET");
      setApiDataPath("products");
      setNewSupplierCredentialProfile('');
      setNewSupplierAccountId('');
      
      setModalTestStatus('idle');
      setModalTestError(null);
      setModalTestProductsCount(null);
      testedSupplierConfigurationRef.current = null;
      
      setShowConnectModal(false);
      setSuccessMsg(`Supplier "${newSupplierName}" saved. Run Initial Sync when you are ready.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err) {
      console.error("Firestore save error:", err);
      setErrorMsg(err instanceof Error ? err.message : "Failed to save supplier configuration.");
      setTimeout(() => setErrorMsg(null), 5000);
      handleFirestoreError(err, OperationType.WRITE, `supplierSources/${code}`);
    } finally {
      setSavingSupplier(false);
    }
  };

  const runManualSupplierSync = async (request: SupplierManualSyncRequest): Promise<boolean> => {
    const sourceId = request.sourceIds[0] || '';
    let succeeded = false;
    setSyncingSourceId(sourceId);
    setSuccessMsg('Checking this supplier for catalog updates...');
    try {
      succeeded = await handleSyncSupplier(request);
      if (succeeded) {
        setSuccessMsg('Supplier update started. Progress will update automatically.');
      } else {
        setSuccessMsg(null);
      }
    } catch (err: any) {
      console.error("Sync error:", err);
      setErrorMsg(`Supplier synchronization failed: ${err.message || err}`);
      setTimeout(() => setErrorMsg(null), 5000);
    } finally {
      setSyncingSourceId(null);
      setTimeout(() => setSuccessMsg(null), 3000);
    }
    return succeeded;
  };

  const handleTriggerSync = async (id: string) => {
    const source = supplierSources.find((item) => String(item.id) === id);
    if (!source) {
      setErrorMsg('Supplier was not found.');
      return;
    }
    // Initial Sync and Sync Now both open the controlled dialog so page size
    // and traversal product-count limit remain separate operator choices.
    setManualSyncSource(source);
  };

  const handleOpenSettings = (source: any) => {
    setEditingSourceId(source.id === editingSourceId ? null : source.id);
    
    // Initialize form fields from current source values
    setEditSupplierName(source.supplierName || source.name || '');
    setEditWebsiteUrl(source.websiteUrl || '');
    setEditEndpoint(source.endpoint || '');
    setEditCredentialProfile(String(source.authentication?.secretRef || source.authentication?.credentialProfile || ''));
    setEditSupplierAccountId(String(source.supplierAccountId || ''));
    // Initialize advanced source settings without changing the supplier workflow.
    const currentSettings = source.settings || {};
    setEditCategoriesFilter(currentSettings.categoriesFilter || []);
    setEditBrandFilter(currentSettings.brandFilter || '');
    setEditProductLimit(currentSettings.productLimit || 'All');
    const configuredSchedule = supplierSourceAutoSyncSchedule(source);
    setEditSyncMode(configuredSchedule.toLowerCase() === 'off' ? 'manual' : 'auto');
    setEditAutoSyncSchedule(configuredSchedule.toLowerCase() === 'off' ? '1 Hour' : configuredSchedule);
    
  };

  const handleSaveSupplierProfile = async (sourceId: string) => {
    setSavingSettingsSourceId(sourceId);
    try {
      const currentSource = supplierSources.find((source) => source.id === sourceId);
      if (!currentSource) throw new Error('Supplier was not found.');
      if (!editSupplierName.trim()) throw new Error('Supplier name is required.');
      if (!editSupplierAccountId) throw new Error('Select an active Supplier Portal account.');
      if (String(currentSource.connectorType || '').toLowerCase() === 'a2z' && !editCredentialProfile.trim()) {
        throw new Error('A server-configured credential profile ID is required for A2Z sources.');
      }
      if (String(currentSource.connectorType || '').toLowerCase() === 'dropex' && !editCredentialProfile.trim()) {
        throw new Error('A server-configured credential profile ID is required for Dropex sources.');
      }
      const connectorType = String(currentSource.connectorType || '').toLowerCase();
      if (connectorType !== 'dropex') {
        let supplierUrl: URL;
        try {
          supplierUrl = new URL(editWebsiteUrl.trim());
        } catch {
          throw new Error('Enter a valid supplier website URL.');
        }
        if (!['http:', 'https:'].includes(supplierUrl.protocol)) {
          throw new Error('Supplier website URL must use HTTP or HTTPS.');
        }
      }

      const syncSchedule = editSyncMode === 'auto' ? editAutoSyncSchedule : 'Off';
      const updatedData = {
        supplierName: editSupplierName.trim(),
        name: editSupplierName.trim(), // for backwards compatibility
        supplierAccountId: editSupplierAccountId,
        websiteUrl: editWebsiteUrl.trim(),
        syncSchedule,
        settings: {
          ...(currentSource.settings || {}),
          autoSync: syncSchedule,
        },
        ...(String(currentSource.connectorType || '').toLowerCase() === 'a2z' || String(currentSource.connectorType || '').toLowerCase() === 'dropex' ? {
          authentication: {
            mode: 'secret_manager',
            credentialProfile: editCredentialProfile.trim(),
          },
        } : {}),
      };
      
      const response = await patchSupplierApi(`/api/supplier-sources/${encodeURIComponent(sourceId)}`, { source: updatedData });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Supplier source could not be updated.');
      setSupplierSources((current) => current.map((source) => source.id === sourceId
        ? normalizeSupplierSourceForUi({
            ...source,
            ...updatedData,
          })
        : source));
      setErrorMsg(null);

      setSuccessMsg("Supplier details saved.");
      setTimeout(() => setSuccessMsg(null), 3000);
      setEditingSourceId(null); // collapse panel after saving
    } catch (err: any) {
      console.error("Save settings error:", err);
      setErrorMsg(err.message || "Failed to save supplier settings.");
      setTimeout(() => setErrorMsg(null), 4000);
    } finally {
      setSavingSettingsSourceId(null);
    }
  };

  // --- REVIEW QUEUE APPROVAL HANDLERS ---
  const reconcileStaleSupplierReviewItem = async (
    item: ReviewQueueItem,
    message = SUPPLIER_REVIEW_STALE_REFRESH_MESSAGE,
  ) => {
    setRejectingReviewItem((current) => (current?.id === item.id ? null : current));
    setRejectionReasonDraft('');
    setEditingReviewItem((current) => (current?.id === item.id ? null : current));
    setSupplierOffers([]);
    setSupplierOfferError(null);
    await refreshSupplierQueueViews();
    setErrorMsg(null);
    setSuccessMsg(message);
    setTimeout(() => setSuccessMsg(null), 6000);
  };

  const handleApproveReviewItem = async (item: ReviewQueueItem, draft: SupplierReviewDraft) => {
    if (processingChangeId) return;
    setProcessingChangeId(item.id);
    try {
      const result = await decideSupplierReviewQueueItem(item.id, 'approve', {
        draft,
        resolveConflict: item.queueState === 'conflict' || item.status === 'CONFLICT',
        expectedPendingRevision: item.supplierOfferPendingRevision,
      });
      if (result.status === 'stale_observation') {
        await reconcileStaleSupplierReviewItem(item);
        return;
      }
      if (result.status === 'supplier_freshness_conflict') {
        await reconcileStaleSupplierReviewItem(item, SUPPLIER_REVIEW_FRESHNESS_REFRESH_MESSAGE);
        return;
      }
      if (result.status === 'supplier_freshness_unverified') {
        void refreshSupplierQueueViews();
        setErrorMsg(result.error || SUPPLIER_REVIEW_FRESHNESS_HOLD_MESSAGE);
        setTimeout(() => setErrorMsg(null), 6000);
        return;
      }
      if (result.success !== true && result.status === 'conflict') {
        setEditingReviewItem({
          ...item,
          status: 'CONFLICT',
          queueState: 'conflict',
          approvalConflict: result.conflict,
        });
        setErrorMsg(result.error || 'The live product changed. Review the conflict before publishing.');
        setTimeout(() => setErrorMsg(null), 6000);
        return;
      }

      setEditingReviewItem(null);
      setSupplierOffers([]);
      setSupplierOfferError(null);
      setReviewQueue((current) => current.map((candidate) => candidate.id === item.id
        ? supplierReviewTerminalItem(candidate, 'approved')
        : candidate));
      const refreshSucceeded = await refreshSupplierQueueViews();
      setSuccessMsg(refreshSucceeded
        ? `Approved: "${draft.productName.trim()}" is no longer actionable.`
        : `Approved: "${draft.productName.trim()}". Queue refresh failed, so this decision remains locked locally; reload or open Review History to confirm.`);
      setTimeout(() => setSuccessMsg(null), refreshSucceeded ? 3000 : 7000);
    } catch (error: any) {
      console.error("Review approval error:", error);
      if (isSupplierReviewStaleObservationError(error?.message)) {
        await reconcileStaleSupplierReviewItem(item);
        return;
      }
      void refreshSupplierQueueViews();
      setErrorMsg(`Failed to approve: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 4000);
    } finally {
      setProcessingChangeId(null);
    }
  };

  const handleRejectReviewItem = async (item: ReviewQueueItem, rejectionReason: string) => {
    if (processingChangeId) return;
    setProcessingChangeId(item.id);
    try {
      const result = await decideSupplierReviewQueueItem(item.id, 'reject', {
        rejectionReason: rejectionReason.trim(),
        expectedPendingRevision: item.supplierOfferPendingRevision,
      });
      if (result.status === 'stale_observation') {
        await reconcileStaleSupplierReviewItem(item);
        return;
      }
      setRejectingReviewItem(null);
      setRejectionReasonDraft('');
      setReviewQueue((current) => current.map((candidate) => candidate.id === item.id
        ? supplierReviewTerminalItem(candidate, 'rejected')
        : candidate));
      const refreshSucceeded = await refreshSupplierQueueViews();
      setSuccessMsg(refreshSucceeded
        ? `Rejected: "${item.productName}" is no longer actionable.`
        : `Rejected: "${item.productName}". Queue refresh failed, so this decision remains locked locally; reload or open Review History to confirm.`);
      setTimeout(() => setSuccessMsg(null), refreshSucceeded ? 3000 : 7000);
    } catch (error: any) {
      console.error("Review rejection error:", error);
      if (isSupplierReviewStaleObservationError(error?.message)) {
        await reconcileStaleSupplierReviewItem(item);
        return;
      }
      setErrorMsg(`Failed to reject: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 4000);
    } finally {
      setProcessingChangeId(null);
    }
  };

  const handleRemoveReviewItem = async (item: ReviewQueueItem) => {
    if (processingChangeId) return;
    setProcessingChangeId(item.id);
    try {
      const result = await decideSupplierReviewQueueItem(item.id, 'delete', {
        deletionReason: 'review_removed_by_admin',
        expectedPendingRevision: item.supplierOfferPendingRevision,
      });
      if (result.status === 'stale_observation') {
        setRemovingReviewItem(null);
        await reconcileStaleSupplierReviewItem(item);
        return;
      }
      setRemovingReviewItem(null);
      setEditingReviewItem((current) => current?.id === item.id ? null : current);
      setSupplierOffers([]);
      setSupplierOfferError(null);
      setReviewQueue((current) => current.filter((candidate) => candidate.id !== item.id));
      const refreshSucceeded = await refreshSupplierQueueViews();
      setSuccessMsg(refreshSucceeded
        ? `Removed: "${item.productName}" is no longer in Product Review.`
        : `Removed: "${item.productName}". Queue refresh failed; reload to confirm counts.`);
      setTimeout(() => setSuccessMsg(null), refreshSucceeded ? 3000 : 7000);
    } catch (error: any) {
      if (isSupplierReviewStaleObservationError(error?.message)) {
        setRemovingReviewItem(null);
        await reconcileStaleSupplierReviewItem(item);
        return;
      }
      setErrorMsg(`Failed to remove from Product Review: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 4000);
    } finally {
      setProcessingChangeId(null);
    }
  };

  // --- SETTINGS CONFIGURATION HANDLERS ---
  const handleSaveSupplierSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSupplierSettings(true);
    let submittedSettings: Record<string, unknown> | null = null;
    try {
      const maxProducts = Number(supplierSettings.maxProducts);
      const imageLimit = Number(supplierSettings.defaultImageLimit);
      const markup = Number(supplierSettings.defaultMarkup);
      const profitMargin = Number(supplierSettings.defaultProfitMargin);
      if (!Number.isInteger(maxProducts) || maxProducts < 1 || maxProducts > 250) {
        throw new Error('Scheduled Max Products must be a whole number from 1 to 250.');
      }
      if (!Number.isInteger(imageLimit) || imageLimit < 1 || imageLimit > 20) {
        throw new Error('Maximum Image Limit must be a whole number from 1 to 20.');
      }
      if (!Number.isFinite(markup) || markup < 0 || markup > 200) {
        throw new Error('Default Markup Rate must be between 0 and 200%.');
      }
      if (!Number.isFinite(profitMargin) || profitMargin < 0 || profitMargin > 100) {
        throw new Error('Default Profit Margin must be between 0 and 100%.');
      }

      const payload = {
        autoSyncEnabled: supplierSettings.autoSyncEnabled === true,
        syncInterval: String(supplierSettings.syncInterval || '1 Hour'),
        maxProducts,
        defaultImageLimit: imageLimit,
        defaultMarkup: markup,
        defaultProfitMargin: profitMargin,
        categoryMappings: validCategoryIds.length > 0
          ? Object.fromEntries(
              Object.entries(supplierSettings.categoryMappings || {}).filter(([, categoryId]) =>
                validCategoryIds.includes(String(categoryId)),
              ),
            )
          : supplierSettings.categoryMappings || {},
      };
      submittedSettings = {
        autoSyncEnabled: payload.autoSyncEnabled === true,
        syncInterval: payload.syncInterval,
        maxProducts: payload.maxProducts,
        defaultProfitMargin: payload.defaultProfitMargin,
        defaultMarkup: payload.defaultMarkup,
        defaultImageLimit: payload.defaultImageLimit,
        categoryMappings: payload.categoryMappings,
      };
      pendingSupplierSettingsRef.current = submittedSettings;
      const response = await postSupplierApi('/api/supplier-settings', { settings: payload });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Supplier Hub settings could not be saved.');
      setSupplierSettings((current: any) => ({
        ...current,
        ...submittedSettings,
        lastUpdated: new Date().toISOString(),
        updatedBy: auth.currentUser?.uid || current.updatedBy,
      }));
      setErrorMsg(null);
      setSavingSupplierSettings(false);
      setSuccessMsg("Supplier Hub control settings saved successfully.");
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      if (pendingSupplierSettingsRef.current === submittedSettings) pendingSupplierSettingsRef.current = null;
      console.error("Save supplier settings failed:", error);
      setErrorMsg(error.message || "Failed to save supplier settings.");
      setTimeout(() => setErrorMsg(null), 4000);
      setSavingSupplierSettings(false);
    }
  };

  const handleSaveSupplierCategoryMapping = async (option: {
    key: string;
    sourceId: string;
    supplierCategory: string;
    supplierSubcategory?: string;
    supplierSubcategoryId?: string;
  }) => {
    const draft = supplierCategoryMappingDrafts[option.key] || { targetCategoryId: '', targetSubcategoryId: '' };
    if (!draft.targetCategoryId) {
      setErrorMsg('Select an active Zyro category before saving the supplier mapping.');
      return;
    }
    setSavingSupplierCategoryMapping(option.key);
    try {
      const response = await postSupplierApi('/api/supplier-category-mappings', {
        sourceId: option.sourceId,
        supplierCategory: option.supplierCategory,
        ...(option.supplierSubcategory ? { supplierSubcategory: option.supplierSubcategory } : {}),
        ...(option.supplierSubcategoryId ? { supplierSubcategoryId: option.supplierSubcategoryId } : {}),
        targetCategoryId: draft.targetCategoryId,
        targetSubcategoryId: option.supplierSubcategory || option.supplierSubcategoryId
          ? draft.targetSubcategoryId || undefined
          : undefined,
      });
      const result = await response.json().catch(() => ({})) as { success?: boolean; mapping?: SupplierCategoryMappingView; error?: string };
      if (!response.ok || result.success !== true || !result.mapping) throw new Error(result.error || 'Supplier category mapping could not be saved.');
      setSupplierCategoryMappings((current) => [
        ...current.filter((mapping) => supplierCategoryMappingUiKey(
          mapping.sourceId,
          mapping.normalizedCategory,
          mapping.mappingScope === 'child' ? mapping.supplierSubcategory : undefined,
          mapping.mappingScope === 'child' ? mapping.supplierSubcategoryId : undefined,
        ) !== supplierCategoryMappingUiKey(
          result.mapping!.sourceId,
          result.mapping!.normalizedCategory,
          result.mapping!.mappingScope === 'child' ? result.mapping!.supplierSubcategory : undefined,
          result.mapping!.mappingScope === 'child' ? result.mapping!.supplierSubcategoryId : undefined,
        )),
        result.mapping!,
      ]);
      setSuccessMsg(`Mapped ${option.supplierCategory} to the selected Zyro category.`);
      setErrorMsg(null);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      setErrorMsg(error instanceof Error ? error.message : 'Supplier category mapping could not be saved.');
    } finally {
      setSavingSupplierCategoryMapping(null);
    }
  };

  const handleRemoveSupplierCategoryMapping = async (mapping: SupplierCategoryMappingView, optionLabel: string) => {
    if (!mapping.id || mapping.mappingScope !== 'child') return;
    const targetCategory = categories.find((category) => category.id === mapping.targetCategoryId);
    const targetSubcategory = targetCategory?.subcategories?.find((subcategory: any) => subcategory.id === mapping.targetSubcategoryId);
    const targetLabel = `${targetCategory?.name || mapping.targetCategoryId}${targetSubcategory ? ` / ${targetSubcategory.name || targetSubcategory.id}` : ''}`;
    const pathLabel = `${optionLabel}${mapping.supplierSubcategory ? ` / ${mapping.supplierSubcategory}` : ''}`;
    if (!window.confirm(`Remove supplier category mapping?\n\n${pathLabel}\n→ ${targetLabel}`)) return;
    setRemovingSupplierCategoryMapping(mapping.id);
    try {
      const response = await postSupplierApi('/api/supplier-category-mappings/unmap', {
        mappingId: mapping.id,
        sourceId: mapping.sourceId,
        supplierCategory: mapping.supplierCategory,
        ...(mapping.supplierSubcategory ? { supplierSubcategory: mapping.supplierSubcategory } : {}),
        ...(mapping.supplierSubcategoryId ? { supplierSubcategoryId: mapping.supplierSubcategoryId } : {}),
      });
      const result = await response.json().catch(() => ({})) as { success?: boolean; result?: { removed?: boolean }; error?: string };
      if (!response.ok || result.success !== true || result.result?.removed !== true) {
        throw new Error(result.error || 'Supplier category mapping could not be removed.');
      }
      await loadReviewCatalog();
      setSuccessMsg(`Unmapped ${pathLabel}. Future products will use the parent category mapping.`);
      setErrorMsg(null);
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (error: any) {
      setErrorMsg(error instanceof Error ? error.message : 'Supplier category mapping could not be removed.');
    } finally {
      setRemovingSupplierCategoryMapping(null);
    }
  };

  const handleSaveAdvancedSourceSettings = async (sourceId: string) => {
    setSavingSettingsSourceId(sourceId);
    try {
      const source = supplierSources.find((item) => item.id === sourceId);
      if (!source) throw new Error('Supplier was not found.');
      const settings = {
        ...(source.settings || {}),
        categoriesFilter: editCategoriesFilter,
        brandFilter: editBrandFilter.trim(),
        productLimit: editProductLimit,
      };
      const response = await patchSupplierApi(`/api/supplier-sources/${encodeURIComponent(sourceId)}`, {
        source: { endpoint: editEndpoint.trim(), settings },
      });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Advanced supplier settings could not be saved.');
      setSupplierSources((current) => current.map((item) => item.id === sourceId
        ? normalizeSupplierSourceForUi({
            ...item,
            endpoint: editEndpoint.trim(),
            syncSchedule: supplierSourceAutoSyncSchedule({ ...item, settings }),
            settings,
          })
        : item));
      setSuccessMsg('Advanced supplier settings saved.');
      setTimeout(() => setSuccessMsg(null), 3000);
      setEditingSourceId(null);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Advanced supplier settings could not be saved.');
    } finally {
      setSavingSettingsSourceId(null);
    }
  };

  const handleToggleSupplierAutoSync = async (source: any) => {
    const currentSchedule = supplierSourceAutoSyncSchedule(source);
    const enabled = currentSchedule.toLowerCase() !== 'off';
    const defaultSchedule = String(supplierSettings.syncInterval || '1 Hour');
    const nextSchedule = enabled ? 'Off' : (currentSchedule && currentSchedule.toLowerCase() !== 'off' ? currentSchedule : defaultSchedule);
    setSavingSettingsSourceId(source.id);
    try {
      const settings = { ...(source.settings || {}), autoSync: nextSchedule };
      const response = await patchSupplierApi(`/api/supplier-sources/${encodeURIComponent(source.id)}`, {
        source: { syncSchedule: nextSchedule, settings },
      });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Automatic synchronization could not be updated.');
      setSupplierSources((current) => current.map((item) => item.id === source.id
        ? normalizeSupplierSourceForUi({ ...item, syncSchedule: nextSchedule, settings })
        : item));
      setSuccessMsg(`Auto Sync ${enabled ? 'disabled' : 'enabled'} for ${source.name || source.supplierName}.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Automatic synchronization could not be updated.');
    } finally {
      setSavingSettingsSourceId(null);
    }
  };

  const handleSupplierPauseAction = async (source: any) => {
    const sourceStatus = String(source.sourceStatus || source.status || '').toLowerCase();
    const isPaused = String(source.operationalState || '').toLowerCase() === 'paused'
      || source.enabled === false
      || source.isEnabled === false
      || sourceStatus === 'paused'
      || sourceStatus === 'disabled'
      || sourceStatus === 'inactive';
    const action = isPaused ? 'resume' : 'pause';
    setSavingSettingsSourceId(source.id);
    setErrorMsg(null);
    try {
      const response = await postSupplierApi(`/api/supplier-operations/suppliers/${encodeURIComponent(source.id)}/action`, { action });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success === false) throw new Error(result.error || `Supplier could not be ${action}d.`);
      await loadSources();
      setSuccessMsg(isPaused ? 'Supplier resumed.' : 'Supplier paused.');
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : `Supplier could not be ${action}d.`);
    } finally {
      setSavingSettingsSourceId(null);
    }
  };

  const handleDeleteSupplier = async (source: any) => {
    const supplierName = String(source.supplierName || source.name || 'this supplier');
    if (!window.confirm(`Delete ${supplierName}? Its historical records will be retained and synchronization will be disabled.`)) return;
    setSavingSettingsSourceId(source.id);
    setErrorMsg(null);
    try {
      const response = await postSupplierApi(`/api/supplier-operations/suppliers/${encodeURIComponent(source.id)}/action`, { action: 'disable' });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success === false) throw new Error(result.error || 'Supplier could not be deleted.');
      await loadSources();
      setSuccessMsg(`${supplierName} was removed from active supplier operations.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error) {
      setErrorMsg(supplierBusinessErrorMessage(error, 'Supplier could not be deleted.'));
    } finally {
      setSavingSettingsSourceId(null);
    }
  };

  const newSupplierConfigurationVerified = modalTestStatus === 'Connected'
    && testedSupplierConfigurationRef.current === buildNewSupplierConfigurationFingerprint();
  const supplierHasCompletedInitialSync = (source: any): boolean => Boolean(
    source.lastSuccessfulSync
    || source.lastSuccess
    || source.lastSync
    || source.catalogSync?.status === 'completed',
  );
  const visibleErrorMsg = errorMsg || syncErrorMsg
    ? supplierBusinessErrorMessage(errorMsg || syncErrorMsg)
    : null;
  const overviewMediaCounts = supplierReviewOverview
    ? {
      ready: supplierReviewOverview.mediaReadyCount,
      processing: supplierReviewOverview.mediaProcessingCount,
      issues: supplierReviewOverview.mediaIssueCount,
    }
    : null;
  const overviewWaitingCount = overviewMediaCounts?.processing ?? null;
  const overviewHealth = lastSyncJob?.state === 'completed' && lastSyncJob.reconciliationStatus === 'VERIFIED'
    ? 'Healthy'
    : lastSyncJob
      ? 'Attention'
      : null;
  const mediaHealth = overviewMediaCounts
    ? overviewMediaCounts.processing && overviewMediaCounts.processing > 0
      ? 'Processing'
      : overviewMediaCounts.issues && overviewMediaCounts.issues > 0
        ? 'Attention'
        : 'Healthy'
    : 'Health unavailable';
  // Supplier source health is connection evidence, not proof that the
  // scheduled inventory refresh ran successfully. Keep the latter unknown
  // until the read model exposes a run-level refresh signal.
  const inventoryHealth = null;
  const reviewQueueView = reviewQueueMode === 'ready'
    ? 'ready'
    : reviewQueueMode === 'waiting'
      ? 'waiting'
      : reviewQueueViewFromState(reviewFilter, reviewMediaFilter);

  useEffect(() => {
    const technicalError = errorMsg || syncErrorMsg || supplierQueueError || modalTestError || supplierOfferError;
    if (technicalError) reportClientIssue('supplier-hub', new Error(technicalError));
  }, [errorMsg, modalTestError, supplierOfferError, supplierQueueError, syncErrorMsg]);

  return (
    <motion.div 
      initial={{ opacity: 0 }} 
      animate={{ opacity: 1 }} 
      className="space-y-8 text-left"
    >
      {/* 1. Header Section */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-100 dark:border-slate-800/60 pb-5">
        <div>
          <h2 className="text-xl md:text-2xl font-black tracking-tight text-slate-900 dark:text-white font-display flex items-center gap-2">
            Supplier Hub
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Manage suppliers, review product changes, and keep your catalog current.
          </p>
        </div>

        {/* Dynamic header button based on active subtab */}
        <div />
      </div>

      {/* Notifications and messages */}
      {(['overview', 'operations'].includes(activeSubTab)) && currentSyncJob && isSupplierSyncJobActive(currentSyncJob) && (
        <section
          aria-label="Current supplier catalog update"
          className="rounded-2xl border border-slate-200/70 bg-white/80 p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-[9px] font-black uppercase tracking-wider text-blue-600 dark:text-blue-400">Current sync</p>
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-blue-500" aria-hidden="true" />
                <p className="text-xs font-extrabold text-slate-900 dark:text-white">
                  {supplierSyncJobHeadline(currentSyncJob)}
                </p>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400" aria-live="polite">
                {supplierSyncJobDetailLine(currentSyncJob)}
              </p>
              {currentSyncJob.state === 'waiting' && currentSyncJob.waitingReason ? (
                <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                  Supplier update is waiting to continue.
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {activeSubTab === 'settings' && canAccessAdvanced && ['pending', 'running', 'waiting'].includes(currentSyncJob.state) && (
                <button
                  type="button"
                  onClick={() => handleSyncJobAction('cancel', currentSyncJob)}
                  disabled={syncJobAction !== null || currentSyncJob.cancellationRequestedAt != null}
                  className="min-h-10 rounded-xl border border-rose-200 px-3 text-[11px] font-bold text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-900/60 dark:hover:bg-rose-950/30"
                >
                  {currentSyncJob.cancellationRequestedAt ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
              {activeSubTab === 'settings' && canAccessAdvanced && (currentSyncJob.state === 'waiting' || currentSyncJob.state === 'cancelled') && (
                <button
                  type="button"
                  onClick={() => handleSyncJobAction('resume', currentSyncJob)}
                  disabled={syncJobAction !== null}
                  className="min-h-10 rounded-xl bg-blue-600 px-3 text-[11px] font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Resume
                </button>
              )}
            </div>
          </div>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
            role="progressbar"
            aria-label="Supplier catalog update progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={isSupplierSyncProgressDeterminate(currentSyncJob) ? currentSyncJob.progress.percent : undefined}
            aria-valuetext={formatSupplierSyncProgress(currentSyncJob)}
          >
            <div
              className={`h-full rounded-full bg-gradient-to-r from-blue-600 to-cyan-500 transition-[width] duration-500 motion-reduce:transition-none ${isSupplierSyncProgressDeterminate(currentSyncJob) ? '' : 'w-1/3 animate-pulse motion-reduce:animate-none'}`}
              style={isSupplierSyncProgressDeterminate(currentSyncJob)
                ? { width: `${Math.max(0, Math.min(100, currentSyncJob.progress.percent))}%` }
                : undefined}
            />
          </div>
        </section>
      )}

      {(['overview', 'suppliers', 'operations'].includes(activeSubTab)) && lastSyncJob && isSupplierSyncJobTerminal(lastSyncJob) && (!currentSyncJob || lastSyncJob.id !== currentSyncJob.id) && (
        <section
          aria-label="Last supplier catalog update"
          className="rounded-2xl border border-slate-200/70 bg-white/80 p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">Last catalog sync</p>
              <div className="flex items-center gap-2">
                <Activity className={`h-4 w-4 ${lastSyncJob.state === 'failed' ? 'text-rose-500' : 'text-emerald-500'}`} aria-hidden="true" />
                <p className="text-xs font-extrabold text-slate-900 dark:text-white">
                  {supplierSyncJobHeadline(lastSyncJob)}
                </p>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {supplierSyncJobDetailLine(lastSyncJob)}
              </p>
              {lastSyncJob.state === 'failed' && lastSyncJob.lastFailureReason ? (
                <p className="text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                  {lastSyncJob.lastFailureReason}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {lastSyncJob.state === 'failed' && (
                <button
                  type="button"
                  onClick={() => handleSyncJobAction('retry', lastSyncJob)}
                  disabled={syncJobAction !== null || isSupplierSyncJobActive(currentSyncJob)}
                  className="min-h-10 rounded-xl bg-blue-600 px-3 text-[11px] font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        </section>
      )}
      {successMsg && (
        <motion.div 
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-3.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold rounded-2xl border border-emerald-500/20 flex items-center gap-2"
        >
          <Check className="h-4 w-4 shrink-0" />
          <span>{successMsg}</span>
        </motion.div>
      )}

      {visibleErrorMsg && (
        <motion.div 
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-3.5 bg-red-500/10 text-red-500 text-xs font-semibold rounded-2xl border border-red-500/20 flex items-center gap-2"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
          <span>{visibleErrorMsg}</span>
        </motion.div>
      )}

      {/* Primary V2 navigation. The select keeps the same destinations usable at
          360–430px without an overflowing tab strip. */}
      <nav aria-label="Supplier Hub sections" className="rounded-2xl border border-slate-200/70 bg-white/80 p-2 shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
        <label className="sr-only" htmlFor="supplier-hub-section-mobile">Supplier Hub section</label>
        <select
          id="supplier-hub-section-mobile"
          value={activeSubTab}
          onChange={(event) => selectSubTab(event.target.value as SupplierHubPrimarySection)}
          className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 md:hidden"
          aria-label="Supplier Hub section"
        >
          <option value="overview">Overview</option>
          <option value="review">Review Queue</option>
          <option value="suppliers">Suppliers</option>
          <option value="operations">Operations</option>
          <option value="settings">Settings</option>
        </select>
        <div className="hidden flex-wrap items-center gap-1.5 md:flex">
          {[
            { id: 'overview', label: 'Overview', badge: null, icon: Activity },
            { id: 'review', label: 'Review Queue', badge: supplierReviewActionableCount, icon: UserCheck, badgeColor: 'bg-blue-500 text-white' },
            { id: 'suppliers', label: 'Suppliers', badge: supplierSources.length, icon: Globe },
            { id: 'operations', label: 'Operations', badge: null, icon: Activity },
            { id: 'settings', label: 'Settings', badge: null, icon: Settings },
          ].map((tab) => {
            const TabIcon = tab.icon;
            const isSubActive = activeSubTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                aria-current={isSubActive ? 'page' : undefined}
                onClick={() => selectSubTab(tab.id as SupplierHubPrimarySection)}
                className={`min-h-10 rounded-xl border px-3 py-2 font-bold text-xs transition-all ${
                  isSubActive
                    ? 'border-blue-600 bg-blue-600 text-white shadow-md shadow-blue-500/10'
                    : 'border-slate-200/50 bg-slate-50 text-slate-500 hover:bg-slate-100 dark:border-slate-800/60 dark:bg-slate-900/40 dark:text-slate-400 dark:hover:bg-slate-800'
                }`}
              >
                <span className="inline-flex items-center gap-2"><TabIcon className="h-4 w-4" aria-hidden="true" /><span>{tab.label}</span>
                  {tab.badge !== null && tab.badge > 0 && <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-mono font-black ${tab.badgeColor || 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>{tab.badge}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* SUB-TAB CONTENTS */}
      <div className="min-h-[400px]">

        {activeSubTab === 'overview' && (
          <section aria-labelledby="supplier-hub-overview-title" className="space-y-5">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-400">Supplier Hub</p>
              <h3 id="supplier-hub-overview-title" className="mt-1 text-xl font-black tracking-tight text-slate-900 dark:text-white">What needs attention?</h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Review actionable products and check supplier health at a glance.</p>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Supplier Hub actionable summary">
              {[
                { label: 'Actionable review', value: supplierReviewOverview?.actionableReviewCount ?? null, tone: 'emerald' },
                { label: 'Media ready', value: overviewMediaCounts?.ready ?? null, tone: 'teal' },
                { label: 'Waiting for media', value: overviewWaitingCount, tone: 'blue' },
                { label: 'Needs attention', value: supplierReviewOverview?.needsAttentionReviewCount ?? null, tone: 'amber' },
                { label: 'Approved', value: supplierReviewOverview?.approvedCount ?? null, tone: 'slate' },
              ].map((metric) => (
                <div key={metric.label} className="rounded-2xl border border-slate-200/70 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-950">
                  <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">{metric.label}</p>
                  <p className="mt-2 text-xl font-black text-slate-900 dark:text-white" title={metric.value === null || metric.value === undefined ? 'This population is not available as one exact read-model count.' : undefined}>{metric.value === null || metric.value === undefined ? '—' : metric.value.toLocaleString()}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-3" aria-label="Supplier system health">
              {[
                { label: 'Catalog Sync', supplier: 'Dropex', status: overviewHealth, detail: lastSyncJob ? `${lastSyncJob.progress.productsScanned} scanned · ${lastSyncJob.reconciliationStatus === 'VERIFIED' ? 'Verified' : 'Evidence needs attention'}` : 'Not recorded' },
                { label: 'Inventory Refresh', supplier: 'Dropex · scheduled', status: inventoryHealth || 'Scheduled', detail: supplierReviewOverview?.inventoryRefresh ? `Scheduled every 15 min · last run unavailable` : 'Schedule status unavailable' },
                { label: 'Media Processing', supplier: 'Review queue', status: mediaHealth, detail: overviewWaitingCount === null ? 'Processing count unavailable' : `${overviewWaitingCount.toLocaleString()} waiting for media` },
              ].map((health) => (
                <div key={health.label} className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-black text-slate-900 dark:text-white">{health.label}</p>
                      <p className="mt-1 text-[10px] font-semibold text-slate-400">{health.supplier}</p>
                    </div>
                    <span className="rounded-full border border-slate-200 px-2 py-1 text-[10px] font-black text-slate-600 dark:border-slate-700 dark:text-slate-300">{health.status || 'Unknown'}</span>
                  </div>
                  <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">{health.detail}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2" aria-label="Supplier Hub quick actions">
              <button type="button" onClick={() => selectSubTab('review')} className="min-h-11 rounded-xl bg-blue-600 px-4 text-xs font-black text-white hover:bg-blue-700">Review media-ready products</button>
              <button type="button" onClick={() => selectSubTab('review')} className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">View issues</button>
              <button type="button" onClick={() => selectSubTab('suppliers')} className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">Suppliers</button>
              <button type="button" onClick={() => selectSubTab('operations')} className="min-h-11 rounded-xl border border-slate-200 bg-white px-4 text-xs font-black text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">Operations</button>
            </div>
          </section>
        )}

        {activeSubTab === 'operations' && supplierSourcesLoaded && supplierSources.length === 0 && (
          <div className="w-full rounded-3xl border border-dashed border-slate-200 bg-slate-50/50 p-8 text-center dark:border-slate-800 dark:bg-slate-900/10 sm:p-12">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500"><Activity className="h-8 w-8" aria-hidden="true" /></span>
            <h3 className="mt-3 text-sm font-bold text-slate-900 dark:text-white">No supplier activity yet.</h3>
            <p className="mt-1 text-xs text-slate-400">Supplier account, product review, and synchronization activity will appear here.</p>
          </div>
        )}

        {activeSubTab === 'operations' && (!supplierSourcesLoaded || supplierSources.length > 0) && (
          <div className="space-y-5">
            <details className="rounded-2xl border border-slate-200/70 bg-white/80 px-4 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
              <summary className="cursor-pointer list-none text-sm font-black text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-white">Review maintenance</summary>
              <div className="mt-3 flex flex-col gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-950/60 sm:flex-row sm:items-center sm:justify-between" aria-label="Refresh pending reviews">
                <div>
                  <p className="text-xs font-black text-slate-800 dark:text-slate-100">Refresh pending reviews</p>
                  <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">Refreshes existing pending items only. Review and approve them separately.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    <span className="sr-only">Pending review refresh batch size</span>
                    <select value={pendingReviewBatchSize} onChange={(event) => setPendingReviewBatchSize(Number(event.target.value) as PendingReviewBatchSize)} aria-label="Pending review refresh batch size" disabled={pendingReviewBatchRefreshing || isPendingReviewBatchJobActive(pendingReviewBatchJob)} className="min-h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold normal-case tracking-normal text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                      {PENDING_REVIEW_BATCH_SIZES.map((size) => <option key={size} value={size}>{size} items</option>)}
                    </select>
                  </label>
                  <button type="button" onClick={() => void handleRefreshPendingReviewBatch()} disabled={pendingReviewBatchRefreshing || isPendingReviewBatchJobActive(pendingReviewBatchJob)} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-blue-200 bg-blue-600 px-3 text-[11px] font-black text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                    <RefreshCw className={`h-3.5 w-3.5 ${pendingReviewBatchRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                    {pendingReviewBatchRefreshing || isPendingReviewBatchJobActive(pendingReviewBatchJob) ? 'Refresh in progress…' : 'Refresh pending reviews'}
                  </button>
                </div>
                {pendingReviewBatchResult && <p role="status" className="basis-full text-[10px] font-semibold text-slate-600 dark:text-slate-300">{pendingReviewBatchResult.state} · selected {pendingReviewBatchResult.selected ?? 0}; completed {pendingReviewBatchResult.completed ?? 0}; ready {pendingReviewBatchResult.nowReadyToPublish ?? 0}; blocked {pendingReviewBatchResult.stillBlocked ?? 0}.</p>}
              </div>
            </details>
            <SupplierOperationsDashboard
              requestApi={requestSupplierApi}
              activeSyncJob={currentSyncJob}
              refreshKey={operationsRefreshKey}
              mode="activity"
              supplierSources={supplierSources}
              onOpenProductReview={() => selectSubTab('review')}
            />
            {canAccessAdvanced && (
              <section className="rounded-2xl border border-slate-200/70 bg-white/80 p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/50" aria-labelledby="supplier-technical-operations-title">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 id="supplier-technical-operations-title" className="text-sm font-black text-slate-900 dark:text-white">Technical operations</h3>
                    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Queue health, media diagnostics, retries and forensic evidence.</p>
                  </div>
                  <button type="button" onClick={() => setShowOperationsDiagnostics((current) => !current)} aria-expanded={showOperationsDiagnostics} className="min-h-10 rounded-xl border border-slate-200 px-3 text-[10px] font-black text-slate-600 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                    {showOperationsDiagnostics ? 'Hide details' : 'View details'}
                  </button>
                </div>
                {showOperationsDiagnostics && <div className="mt-4"><SupplierOperationsDashboard requestApi={requestSupplierApi} activeSyncJob={currentSyncJob} refreshKey={operationsRefreshKey} mode="advanced" supplierSources={supplierSources} onOpenProductReview={() => selectSubTab('review')} /></div>}
              </section>
            )}
          </div>
        )}

        {activeSubTab === 'review' && (
          <div className="space-y-8">
            <section aria-labelledby="product-review-filters-title" className="rounded-3xl border border-slate-200/70 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950 sm:p-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 id="product-review-filters-title" className="text-lg font-black tracking-tight text-slate-900 dark:text-white">Review Queue</h3>
                    <span className="rounded-full bg-blue-500/10 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-blue-700 dark:text-blue-300">Product Review</span>
                  </div>
                  <p className="mt-1 max-w-xl text-xs text-slate-500 dark:text-slate-400">Review actionable supplier products before they appear in your store.</p>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:min-w-[25rem]">
                  {supplierReviewActionableCount !== null && <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/60"><p className="text-[9px] font-black uppercase tracking-wider text-slate-400">Pending</p><p className="mt-1 text-lg font-black text-slate-900 dark:text-white">{supplierReviewActionableCount.toLocaleString()}</p></div>}
                  {supplierReviewMediaSummary?.counts?.processing !== null && supplierReviewMediaSummary?.counts?.processing !== undefined && <div className="rounded-2xl border border-blue-100 bg-blue-50/60 px-3 py-2 dark:border-blue-900/40 dark:bg-blue-950/20"><p className="text-[9px] font-black uppercase tracking-wider text-blue-700 dark:text-blue-300">Processing</p><p className="mt-1 text-lg font-black text-blue-800 dark:text-blue-200">{supplierReviewMediaSummary.counts.processing.toLocaleString()}</p></div>}
                  {supplierReviewMediaSummary?.counts?.retryScheduled !== null && supplierReviewMediaSummary?.counts?.retryScheduled !== undefined && <div className="rounded-2xl border border-amber-100 bg-amber-50/60 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/20"><p className="text-[9px] font-black uppercase tracking-wider text-amber-700 dark:text-amber-300">Retry scheduled</p><p className="mt-1 text-lg font-black text-amber-800 dark:text-amber-200">{supplierReviewMediaSummary.counts.retryScheduled.toLocaleString()}</p></div>}
                </div>
              </div>
              <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end">
                <div className="relative min-w-0">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                  <input
                    type="search"
                    value={reviewSearch}
                    onChange={(event) => handleReviewSearchChange(event.target.value)}
                    placeholder="Search SKU, supplier ID or item code"
                    aria-label="Search Product Review by exact supplier SKU, ID or item code"
                    className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-slate-800 dark:bg-slate-900/50"
                  />
                </div>
                <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-slate-400">
                  <span>Sort</span>
                  <select
                    value={reviewSort}
                    onChange={(event) => handleReviewSortChange(event.target.value as 'created' | 'updated')}
                    aria-label="Sort Product Review items"
                    className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold normal-case tracking-normal text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                  >
                    <option value="created">Recently added</option>
                    <option value="updated">Recently updated</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-slate-400">
                  <span>Page size</span>
                  <select
                    value={supplierReviewPageSize}
                    onChange={(event) => handleReviewPageSizeChange(Number(event.target.value) as ProductReviewPageSize)}
                    aria-label="Product Review page size"
                    className="min-h-11 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold normal-case tracking-normal text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
                  >
                    {PRODUCT_REVIEW_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                  </select>
                </label>
              </div>
              <p className="mt-2 text-[10px] text-slate-400">Search by exact supplier SKU, product ID or item code. Product-name search is not enabled.</p>
              <div className="mt-4 flex min-w-0 flex-wrap gap-1.5" role="tablist" aria-label="Product review queue views">
                {([
                  ['actionable', 'Actionable'],
                  ['ready', 'Media ready'],
                  ['new', 'New'],
                  ['updates', 'Updates'],
                  ['issues', 'Needs attention'],
                  ['waiting', 'Waiting'],
                  ['history', 'History'],
                ] as const).map(([value, label]) => (
                  <button key={value} type="button" role="tab" aria-selected={reviewQueueView === value} onClick={() => handleReviewQueueViewChange(value)} className={`min-h-10 rounded-xl px-3 text-[11px] font-black transition-colors ${reviewQueueView === value ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <details className="mt-3 rounded-xl border border-slate-200/70 px-3 py-2 dark:border-slate-800">
                <summary className="cursor-pointer list-none text-[10px] font-black text-slate-500 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-300">More filters</summary>
                <div className="mt-3 flex min-w-0 flex-wrap gap-1.5" role="tablist" aria-label="Product review filters">
                  {PRODUCT_REVIEW_FILTERS.map((filter) => (
                    <button key={filter.id} type="button" role="tab" aria-selected={reviewFilter === filter.id} onClick={() => handleReviewFilterChange(filter.id)} className={`min-h-9 rounded-lg px-2.5 text-[10px] font-black transition-colors ${reviewFilter === filter.id ? 'bg-slate-800 text-white dark:bg-white dark:text-slate-900' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
                      {filter.label}
                      {filter.id === 'low_stock_hold' && supplierReviewLowStockHoldCount !== null && <span className="ml-1.5" aria-label={`${supplierReviewLowStockHoldCount} products on low stock hold`}>{supplierReviewLowStockHoldCount}</span>}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Product review media filters">
                  <span className="mr-1 self-center text-[10px] font-black uppercase tracking-wider text-slate-400">Media</span>
                  {([['all', 'All'], ['ready', 'Media ready'], ['processing', 'Waiting'], ['issues', 'Media issues']] as const).map(([value, label]) => (
                    <button key={value} type="button" role="tab" aria-selected={reviewMediaFilter === value} onClick={() => handleReviewMediaFilterChange(value)} className={`min-h-9 rounded-lg px-2.5 text-[10px] font-black transition-colors ${reviewMediaFilter === value ? 'bg-slate-800 text-white dark:bg-white dark:text-slate-900' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'}`}>{label}</button>
                  ))}
                </div>
              </details>
            </section>
            <div className={`rounded-3xl border p-4 sm:p-6 ${
              isDarkMode ? 'bg-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
            }`}>
              <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-left">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="flex items-center gap-1.5 text-sm font-extrabold uppercase tracking-wider text-slate-900 dark:text-white">
                      <UserCheck className="h-4 w-4 text-blue-500" aria-hidden="true" />
                      <span>{({ actionable: 'Actionable', ready: 'Media ready', new: 'New', updates: 'Updates', issues: 'Needs attention', waiting: 'Waiting', history: 'History', low_stock: 'Low Stock Hold' } as Record<SupplierReviewQueueView, string>)[reviewQueueView]}</span>
                    </h3>
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black text-slate-500 dark:bg-slate-900 dark:text-slate-300">{reviewMediaFilter === 'all' ? 'All media' : reviewMediaFilter === 'ready' ? 'Media ready' : reviewMediaFilter === 'processing' ? 'Waiting for media' : 'Media issues'}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">Page {supplierReviewPage}{supplierReviewTotalPages !== null ? ` of ${supplierReviewTotalPages}` : ''} · {supplierReviewTotalCount !== null ? `${supplierReviewTotalCount.toLocaleString()} matching records` : 'Count unavailable for this derived filter'}</p>
                  {reviewQueueView === 'ready' && <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Media ready means the managed image is ready; category, stock, and other approval checks may still be required.</p>}
                </div>
                <div className="flex items-center gap-3 text-[10px] font-bold text-slate-400">
                  {supplierReviewLoading && <span role="status" className="inline-flex items-center gap-1.5 text-blue-600 dark:text-blue-300"><RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Updating page…</span>}
                  {supplierReviewCountStatus === 'unavailable' && <span title="This filter does not have one exact countable Firestore predicate">Bounded result view</span>}
                </div>
              </div>

              <div className="py-4" aria-label="Product Review pagination top">
                <SupplierReviewPagination
                  currentPage={supplierReviewPage}
                  totalPages={supplierReviewTotalPages}
                  hasNext={Boolean(supplierReviewCursor) && (supplierReviewTotalPages === null || supplierReviewPage < supplierReviewTotalPages)}
                  loading={supplierReviewLoading}
                  onPageChange={handleReviewPageChange}
                />
                {supplierReviewPageNavigationError && <p role="alert" className="mx-auto mt-3 max-w-lg rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-[11px] font-semibold text-amber-700 dark:text-amber-300">{supplierReviewPageNavigationError}</p>}
              </div>

              {supplierQueueError && (
                <p role="alert" className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600">
                  {supplierBusinessErrorMessage(supplierQueueError, 'Supplier products could not be loaded.')}
                </p>
              )}

              {supplierReviewLoading && reviewQueue.length === 0 ? (
                <div className="grid gap-3" role="status" aria-label="Loading Product Review products">
                  {Array.from({ length: Math.min(3, supplierReviewPageSize / 25) }, (_, index) => <div key={index} className="h-40 animate-pulse rounded-2xl border border-slate-200 bg-slate-100/70 dark:border-slate-800 dark:bg-slate-900/60" />)}
                </div>
              ) : visibleReviewItems.length === 0 ? (
                <div className="space-y-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50/50 p-12 text-center dark:border-slate-800 dark:bg-slate-900/10">
                  <UserCheck className="mx-auto h-10 w-10 text-slate-300" aria-hidden="true" />
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-slate-900 dark:text-white">{reviewSearch.trim() ? 'No exact supplier identity match' : reviewMediaFilter === 'ready' ? 'No media-ready items' : reviewMediaFilter === 'processing' ? 'No products waiting for media' : reviewMediaFilter === 'issues' ? 'No media issues' : 'No products in this filter'}</p>
                    <p className="text-xs text-slate-400">{reviewSearch.trim() ? 'Search by exact supplier SKU, product ID or item code.' : 'Supplier product submissions and synced catalogue changes will appear here.'}</p>
                  </div>
                </div>
              ) : (
                <div className="supplier-review-results space-y-2" aria-label="Products awaiting review" aria-busy={supplierReviewLoading}>
                  {/* Product Review page: one bounded server-backed page, never an accumulating Load More list. */}
                  {/* Launch-ready quick review list: one bounded page, no bulk actions. */}
                  {visibleReviewItems.map((item) => {
                    const draft = createSupplierReviewDraft(item);
                    const profit = calculateSupplierProfit(draft.sellingPrice, draft.costPrice, draft.supplierCostAvailable);
                    const managedImageUrl = supplierReviewDisplayImageUrl(item);
                    const isPreparing = supplierReviewIsPreparing(item);
                    const canQuickApprove = supplierReviewCanQuickApprove(item);
                    const needsResolution = supplierReviewDecisionReady(item) && !canQuickApprove;
                    const category = categories.find((candidate) => String(candidate.id) === draft.category);
                    const categoryLabel = supplierReviewDisplayLabel(draft.category, categories);
                    const activeSubcategories = (category?.subcategories || []).filter((subcategory) => subcategory.isActive !== false);
                    const showSubcategory = activeSubcategories.length > 0 || Boolean(draft.subcategory);
                    const subcategoryLabel = showSubcategory
                      ? supplierReviewDisplayLabel(draft.subcategory, activeSubcategories)
                      : undefined;
                    const brandLabel = supplierReviewDisplayLabel(draft.brand, brands);
                    const rawMetadata = supplierReviewRawMetadata(item);
                    const statusLabel = supplierReviewStatusLabel(item);
                    const terminalState = supplierReviewTerminalLabel(item);
                    const blockingProblems = supplierReviewOperatorProblems(item);
                    const mediaEvidence = supplierReviewMediaEvidence(item);
                    return (
                      <SupplierReviewQuickCard
                        key={item.id}
                        productName={draft.productName}
                        supplierItemCode={draft.supplierItemCode}
                        managedImageUrl={managedImageUrl}
                        statusLabel={statusLabel}
                        changeLabel={supplierReviewChangeLabel(item.comparison)}
                        sellingPrice={draft.sellingPrice}
                        supplierCost={draft.costPrice}
                        supplierCostAvailable={draft.supplierCostAvailable}
                        profit={profit.profit}
                        marginPercent={profit.marginPercent}
                        profitAvailable={profit.available}
                        stock={draft.stock}
                        supplierStockAvailable={draft.supplierStockAvailable}
                        brandLabel={brandLabel}
                        categoryLabel={categoryLabel}
                        subcategoryLabel={subcategoryLabel}
                        rawSupplierCategory={rawMetadata.supplierCategory}
                        rawSupplierSubcategory={rawMetadata.supplierSubcategory}
                        rawSupplierBrand={rawMetadata.supplierBrand}
                        storefrontVisible={draft.isActive}
                        storefrontStatusLabel={supplierReviewStorefrontLabel(item, draft.isActive)}
                        supplierAttribution={compactSupplierAttribution(item)}
                        blockingProblems={blockingProblems}
                        media={mediaEvidence}
                        compact
                        mediaForensics={mediaForensicItemId === item.id ? mediaForensicEvidence : null}
                        mediaForensicsLoading={mediaForensicItemId === item.id && mediaForensicLoading}
                        mediaForensicsError={mediaForensicItemId === item.id ? mediaForensicError : null}
                        onLoadMediaForensics={() => void loadMediaForensics(item)}
                        isPreparing={isPreparing}
                        decisionReady={supplierReviewDecisionReady(item)}
                        canQuickApprove={canQuickApprove}
                        canReject={supplierReviewCanReject(item)}
                        canRemove={supplierReviewCanRemove(item)}
                        needsResolution={needsResolution}
                        processing={processingChangeId === item.id}
                        canRetryMedia={supplierReviewCanRetryMedia(item)}
                        retryingMedia={retryingMediaId === item.id}
                        terminalState={terminalState}
                        onApprove={() => void handleApproveReviewItem(item, draft)}
                        onReject={() => { setRejectingReviewItem(item); setRejectionReasonDraft(''); }}
                        onRemove={() => setRemovingReviewItem(item)}
                        onViewDetails={() => openSupplierReviewEditor(item)}
                        onViewHistory={() => openSupplierReviewHistory(item)}
                        onRetryMedia={() => void handleRetryDeadLetterMedia(item)}
                      />
                    );
                  })}
                  {/* End launch-ready quick review list. */}
                </div>
              )}
              <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800" aria-label="Product Review pagination bottom">
                <SupplierReviewPagination
                  currentPage={supplierReviewPage}
                  totalPages={supplierReviewTotalPages}
                  hasNext={Boolean(supplierReviewCursor) && (supplierReviewTotalPages === null || supplierReviewPage < supplierReviewTotalPages)}
                  loading={supplierReviewLoading}
                  onPageChange={handleReviewPageChange}
                />
              </div>
            </div>

          </div>
        )}

        {/* Suppliers */}
        {activeSubTab === 'suppliers' && (
          <div className="space-y-8">
            <section aria-labelledby="supplier-accounts-title" className="space-y-4">
              <div>
                <h3 id="supplier-accounts-title" className="text-sm font-extrabold uppercase tracking-wider text-slate-900 dark:text-white">Supplier Accounts</h3>
                <p className="mt-1 text-[11px] text-slate-400">Find an existing Zyro.lk account, promote it to supplier, and activate portal access.</p>
              </div>
              <SupplierManagementDashboard requestApi={requestSupplierApi} refreshKey={operationsRefreshKey} onAccountChanged={loadSources} />
            </section>

            <section aria-labelledby="connected-sources-title" className="space-y-4 border-t border-slate-100 pt-6 dark:border-slate-800/80">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 id="connected-sources-title" className="text-sm font-extrabold uppercase tracking-wider text-slate-900 dark:text-white">Connected Sources</h3>
                  <p className="mt-1 text-[11px] text-slate-400">API and catalog integrations such as A2Z. These sources sync products automatically.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowConnectModal(true)}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-extrabold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 sm:w-auto"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>Connect External Supplier</span>
                </button>
              </div>

            {supplierSources.length === 0 ? (
              <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-500/10 text-slate-500"><Globe className="h-8 w-8" aria-hidden="true" /></span>
                <div className="space-y-1">
                  <p className="text-sm font-bold text-slate-900 dark:text-white">No connected sources yet</p>
                  <p className="text-xs text-slate-400">Connect an external supplier integration when you are ready to sync an API or catalog feed.</p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {supplierSources.map((source) => (
                  <div 
                    key={source.id}
                    className={`p-5 rounded-3xl border ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-xl shadow-slate-950/20' : 'bg-white border-slate-200 shadow-xs'} transition-all relative overflow-hidden`}
                  >
                    <div className="absolute bottom-0 left-0 top-0 w-1 bg-blue-500" aria-hidden="true" />
                    
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-extrabold text-sm text-slate-900 dark:text-white">{source.supplierName || source.name}</span>
                        </div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          Supplier Platform · {String(source.connectorType || source.type || 'Supplier').replaceAll('_', ' ')}
                        </p>
                      </div>

                      <SupplierConnectionBadge source={source} isSyncing={sourceIsSyncing(String(source.id))} />
                    </div>

                    <div className="mt-6 grid grid-cols-2 gap-4 rounded-2xl border border-slate-100/50 bg-slate-50 p-3 text-xs dark:border-slate-800/40 dark:bg-slate-900/40">
                      <div className="space-y-0.5">
                        <span className="block text-[10px] font-bold uppercase text-slate-400">Current Status</span>
                        <button type="button" onClick={() => void handleSupplierPauseAction(source)} disabled={savingSettingsSourceId !== null} className="font-bold text-blue-600 disabled:opacity-50">
                          {supplierConnectionPresentation(source, sourceIsSyncing(String(source.id))).label}
                        </button>
                      </div>
                      <div className="space-y-0.5">
                        <span className="text-slate-400 font-bold block text-[10px] uppercase">Auto Sync</span>
                        <button type="button" onClick={() => void handleToggleSupplierAutoSync(source)} disabled={savingSettingsSourceId !== null || !supplierHasCompletedInitialSync(source)} title={supplierHasCompletedInitialSync(source) ? 'Enable or disable automatic synchronization' : 'Run Initial Sync before enabling Auto Sync'} className={`font-bold disabled:cursor-not-allowed disabled:opacity-50 ${supplierSourceAutoSyncSchedule(source).toLowerCase() === 'off' ? 'text-slate-500' : 'text-emerald-500'}`}>
                          {supplierSourceAutoSyncSchedule(source).toLowerCase() === 'off'
                            ? 'Manual Mode'
                            : `Auto · ${supplierSourceAutoSyncSchedule(source)}`}
                        </button>
                      </div>
                      <div className="space-y-0.5 border-t border-slate-100 pt-2 dark:border-slate-800/40">
                        <span className="text-slate-400 font-bold block text-[10px] uppercase">Last Sync</span>
                        <span className="text-slate-700 dark:text-slate-200 font-medium">{formatSupplierTimestamp(source.lastSync, 'Not updated yet')}</span>
                      </div>
                      <div className="space-y-0.5 border-t border-slate-100 pt-2 dark:border-slate-800/40">
                        <span className="block text-[10px] font-bold uppercase text-slate-400">Next Sync</span>
                        <span className="font-medium text-slate-700 dark:text-slate-200">{formatSupplierTimestamp(source.nextScheduledSyncAt || source.nextScheduledSync || source.nextSyncAt || source.schedule?.nextRunAt, 'Manual mode')}</span>
                      </div>
                      <div className="space-y-0.5 border-t border-slate-100 pt-2 dark:border-slate-800/40">
                        <span className="text-slate-400 font-bold block text-[10px] uppercase">Last Successful Sync</span>
                        <span className="text-slate-700 dark:text-slate-200 font-medium">{formatSupplierTimestamp(source.lastSuccessfulSyncAt || source.lastSuccessfulSync || source.lastSuccess, 'Not available in supplier summary')}</span>
                      </div>
                      <div className="space-y-0.5 border-t border-slate-100 pt-2 dark:border-slate-800/40">
                        <span className="block text-[10px] font-bold uppercase text-slate-400">Last Failed Sync</span>
                        <span className="font-medium text-slate-700 dark:text-slate-200">{formatSupplierTimestamp(source.lastFailedSyncAt || source.lastFailure, 'No failures')}</span>
                      </div>
                      <div className="space-y-0.5 border-t border-slate-100 pt-2 dark:border-slate-800/40">
                        <span className="block text-[10px] font-bold uppercase text-slate-400">Sync Duration</span>
                        <span className="font-medium text-slate-700 dark:text-slate-200">{formatSupplierDuration(source.syncMetrics?.durationMs ?? source.syncHealth?.averageLatencyMs)}</span>
                      </div>
                      <div className="space-y-0.5 border-t border-slate-100 pt-2 dark:border-slate-800/40">
                        <span className="text-slate-400 font-bold block text-[10px] uppercase">Health</span>
                        <span className={`inline-flex rounded-full px-2 py-0.5 font-black ${supplierHealthLabel(source) === 'Needs attention' ? 'bg-rose-500/10 text-rose-500' : supplierHealthLabel(source) === 'Healthy' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-500/10 text-slate-500'}`}>{supplierHealthLabel(source) === 'Needs attention' ? 'Needs Attention' : supplierHealthLabel(source)}</span>
                      </div>
                    </div>

                    <div className="mt-5 flex w-full flex-wrap items-center gap-3 sm:justify-end">
                      <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
                        <button
                          onClick={() => handleOpenSettings(source)}
                          className={`px-3.5 py-1.5 font-bold rounded-lg text-[10px] flex items-center gap-1.5 cursor-pointer transition-all border ${
                            editingSourceId === source.id 
                            ? 'grow bg-amber-500 text-slate-900 border-amber-500 hover:bg-amber-600 sm:grow-0'
                              : 'grow bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border-slate-200/50 dark:border-slate-700/50 sm:grow-0'
                          }`}
                        >
                          <Settings className={`h-3.5 w-3.5 ${editingSourceId === source.id ? 'animate-spin' : ''}`} />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteSupplier(source)}
                          disabled={savingSettingsSourceId !== null || isSyncing}
                          className="flex grow items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-1.5 text-[10px] font-bold text-red-600 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-400 sm:grow-0"
                          aria-label={`Delete ${source.supplierName || source.name || 'supplier'}`}
                          title="Disable this supplier while retaining its history"
                        >
                          <Trash2 className="h-3 w-3" />
                          <span>Delete</span>
                        </button>
                        <button
                          onClick={() => handleTestExistingConnection(source)}
                          disabled={testingSourceId !== null || syncingSourceId !== null}
                          className="flex grow cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-slate-200/50 bg-slate-100 px-3.5 py-1.5 text-[10px] font-bold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:border-slate-700/50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 sm:grow-0"
                        >
                          <RefreshCw className={`h-3 w-3 ${testingSourceId === source.id ? 'animate-spin' : ''}`} />
                          <span>{testingSourceId === source.id ? 'Testing...' : 'Test Connection'}</span>
                        </button>
                        <button
                          onClick={() => handleTriggerSync(source.id)}
                          disabled={isSyncing || syncingSourceId !== null || testingSourceId !== null}
                          className="flex grow cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-[10px] font-bold text-white transition-colors hover:bg-blue-700 disabled:bg-slate-700 disabled:opacity-50 sm:grow-0"
                        >
                          <RefreshCw className={`h-3 w-3 ${syncingSourceId === source.id ? 'animate-spin' : ''}`} />
                          <span>{syncingSourceId === source.id ? 'Syncing...' : supplierHasCompletedInitialSync(source) ? 'Sync Now' : 'Run Initial Sync'}</span>
                        </button>
                        {supplierHasCompletedInitialSync(source) && reviewQueue.length > 0 && (
                          <button type="button" onClick={() => selectSubTab('review')} className="px-3.5 py-1.5 bg-emerald-100 text-emerald-700 font-bold rounded-lg text-[10px]">
                            Go to Product Review
                          </button>
                        )}
                      </div>
                    </div>

                    {editingSourceId === source.id && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        transition={{ duration: 0.2 }}
                        className="mt-6 pt-6 border-t border-slate-200 dark:border-slate-800/80 space-y-6"
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <Settings className="h-4 w-4 text-amber-500" />
                          <h4 className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-wider">
                            Edit Supplier
                          </h4>
                        </div>

                        {/* GENERAL CONFIGURATION */}
                        <div className="space-y-4">
                          <div className="border-b border-slate-100 dark:border-slate-800 pb-1.5">
                            <span className="text-[10px] font-extrabold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                              Supplier Details
                            </span>
                          </div>
                          
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="space-y-1">
                              <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500">
                                Supplier Name
                              </label>
                              <input
                                type="text"
                                required
                                value={editSupplierName}
                                onChange={(e) => setEditSupplierName(e.target.value)}
                                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white font-semibold"
                                placeholder="Supplier name"
                              />
                            </div>

                            <div className="space-y-1">
                              <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500">
                                Fulfilment Supplier Account
                              </label>
                              <select
                                required
                                value={editSupplierAccountId}
                                onChange={(event) => setEditSupplierAccountId(event.target.value)}
                                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white font-semibold"
                              >
                                <option value="">Select an active supplier account</option>
                                {supplierAccounts.map((account) => (
                                  <option key={account.id} value={account.id}>{account.companyName || account.email || account.id}</option>
                                ))}
                              </select>
                              <span className="block text-[9px] text-slate-400">This is the active Supplier Portal account that receives fulfilment groups for products imported from this external source.</span>
                            </div>
                            
                            <div className="space-y-1 col-span-1 sm:col-span-2">
                              <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500">
                                Website URL
                              </label>
                              <input
                                type="url"
                                required
                                value={editWebsiteUrl}
                                onChange={(e) => setEditWebsiteUrl(e.target.value)}
                                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white font-semibold"
                                placeholder="https://example-supplier.com"
                              />
                            </div>

                            <div className="space-y-1">
                              <span className="block text-[10px] font-bold text-slate-400 dark:text-slate-500">Platform</span>
                              <span className="block rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold capitalize text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                                {String(source.connectorType || source.type || 'Supplier').replaceAll('_', ' ')}
                              </span>
                            </div>

                            <div className="space-y-1">
                              <span className="block text-[10px] font-bold text-slate-400 dark:text-slate-500">Username</span>
                              <span className="block rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                                {source.authentication?.mode === 'none' ? 'Not required' : 'Managed in Secret Manager'}
                              </span>
                            </div>

                            <div className="space-y-1 sm:col-span-2">
                              <label className="block text-[10px] font-bold text-slate-400 dark:text-slate-500" htmlFor={`supplier-credential-profile-${source.id}`}>
                                Credential profile ID (required)
                              </label>
                              {['a2z', 'dropex'].includes(String(source.connectorType || '').toLowerCase()) ? (
                                <input
                                  id={`supplier-credential-profile-${source.id}`}
                                  type="text"
                                  required
                                  maxLength={160}
                                  pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,159}"
                                  value={editCredentialProfile}
                                  onChange={(event) => setEditCredentialProfile(event.target.value)}
                                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-[10px] font-semibold text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200"
                                />
                              ) : (
                                <span className="block rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-semibold text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                                  {source.authentication?.mode === 'none' ? 'No authentication required' : 'Managed server-side'}
                                </span>
                              )}
                              <span className="block text-[9px] text-slate-400">Only a server-configured identifier is stored. Credential values remain in Secret Manager.</span>
                            </div>

                            <label className="space-y-1">
                              <span className="block text-[10px] font-bold text-slate-400 dark:text-slate-500">Synchronization Mode</span>
                              <select
                                value={editSyncMode}
                                onChange={(event) => setEditSyncMode(event.target.value as 'manual' | 'auto')}
                                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold dark:border-slate-800 dark:bg-slate-950 dark:text-white"
                              >
                                <option value="manual">Manual Mode</option>
                                <option value="auto">Auto Mode</option>
                              </select>
                            </label>

                            <label className="space-y-1">
                              <span className="block text-[10px] font-bold text-slate-400 dark:text-slate-500">Auto Sync Schedule</span>
                              <select
                                value={editAutoSyncSchedule}
                                onChange={(event) => setEditAutoSyncSchedule(event.target.value)}
                                disabled={editSyncMode !== 'auto'}
                                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-800 dark:bg-slate-950 dark:text-white"
                              >
                                {!SUPPLIER_AUTO_SYNC_SCHEDULES.includes(editAutoSyncSchedule as typeof SUPPLIER_AUTO_SYNC_SCHEDULES[number]) && (
                                  <option value={editAutoSyncSchedule}>{editAutoSyncSchedule} (legacy schedule)</option>
                                )}
                                {SUPPLIER_AUTO_SYNC_SCHEDULES.map((schedule) => <option key={schedule} value={schedule}>{schedule === '1 Hour' ? 'Hourly' : schedule === 'Daily' ? 'Daily' : `Every ${schedule}`}</option>)}
                              </select>
                            </label>

                          </div>
                        </div>

                        {/* ACTION BUTTONS */}
                        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-800">
                          <button
                            type="button"
                            onClick={() => setEditingSourceId(null)}
                            className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-extrabold rounded-xl text-xs transition-colors cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSaveSupplierProfile(source.id)}
                            disabled={savingSettingsSourceId !== null}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold rounded-xl text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors shadow-md shadow-emerald-500/10 hover:shadow-lg hover:shadow-emerald-500/20 disabled:opacity-50"
                          >
                            {savingSettingsSourceId === source.id ? (
                              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Save className="h-3.5 w-3.5" />
                            )}
                            <span>{savingSettingsSourceId === source.id ? 'Saving...' : 'Connect Source'}</span>
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </div>
                ))}
              </div>
              )}
            </section>
          </div>
        )}

        {/* Settings keeps business controls available while protecting technical operations. */}
        {activeSubTab === 'settings' && (
          <div className="space-y-6 text-left">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900/20 p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Settings</h3>
                <p className="text-[11px] text-slate-400">Configure sync, pricing, and catalogue defaults for external supplier integrations.</p>
              </div>
              {supplierSettings && (supplierSettings.lastUpdated || supplierSettings.updatedBy) && (
                <div className="text-left sm:text-right text-[10px] text-slate-400 font-mono">
                  <div>Last updated: {formatSupplierTimestamp(supplierSettings.lastUpdated)}</div>
                  {supplierSettings.updatedBy && (
                    <div>Updated by: {supplierAdministratorLabel(supplierSettings.updatedBy, auth.currentUser)}</div>
                  )}
                </div>
              )}
            </div>

            <section aria-labelledby="supplier-business-settings-title" className="space-y-4">
              <div>
                <h3 id="supplier-business-settings-title" className="text-sm font-black text-slate-900 dark:text-white">Supplier Sync Settings</h3>
                <p className="mt-1 text-[11px] text-slate-400">Integration and synchronization defaults for connected external sources. Manual Supplier Portal accounts are managed separately.</p>
              </div>
            <form onSubmit={handleSaveSupplierSettings} className="p-6 rounded-3xl border border-slate-200/50 dark:border-slate-800/60 bg-slate-50/50 dark:bg-[#101827]/30 text-xs space-y-6">
              
              {/* Business: automatic synchronization */}
              <div className="space-y-4">
                <h4 className="text-[10px] font-black uppercase text-blue-500 tracking-wider">Auto Sync</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  
                  {/* Automated Sync Jobs */}
                  <div className="p-4 bg-white dark:bg-slate-900/60 border border-slate-150 dark:border-slate-800 rounded-2xl flex items-center justify-between">
                    <div className="space-y-1 pr-4">
                      <div className="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white text-xs">
                        <SlidersHorizontal className="h-4 w-4 text-blue-500" />
                        <span>Global Auto Sync</span>
                      </div>
                      <p className="text-[10px] text-slate-400">Check connected suppliers automatically on your chosen schedule.</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0">
                      <input 
                        type="checkbox" 
                        checked={!!supplierSettings.autoSyncEnabled}
                        onChange={(e) => setSupplierSettings(prev => ({ ...prev, autoSyncEnabled: e.target.checked }))}
                        className="sr-only peer" 
                      />
                      <div className="w-10 h-5 bg-slate-200 dark:bg-slate-800 peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>

                  <label className="space-y-1 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/60">
                    <span className="block text-xs font-bold text-slate-900 dark:text-white">Default Auto Sync Behaviour</span>
                    <span className="block text-[10px] text-slate-400">Schedule used when Auto Sync is first enabled for a supplier.</span>
                    <select
                      value={supplierSettings.syncInterval || '1 Hour'}
                      onChange={(event) => setSupplierSettings((current: any) => ({ ...current, syncInterval: event.target.value }))}
                      className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-bold dark:border-slate-700 dark:bg-slate-900"
                    >
                      {!SUPPLIER_AUTO_SYNC_SCHEDULES.includes(String(supplierSettings.syncInterval || '1 Hour') as typeof SUPPLIER_AUTO_SYNC_SCHEDULES[number]) && (
                        <option value={String(supplierSettings.syncInterval)}>{String(supplierSettings.syncInterval)} (legacy schedule)</option>
                      )}
                      {SUPPLIER_AUTO_SYNC_SCHEDULES.map((interval) => <option key={interval} value={interval}>{interval === '1 Hour' ? 'Hourly' : interval === 'Daily' ? 'Daily' : `Every ${interval}`}</option>)}
                    </select>
                  </label>

                </div>
              </div>

              {/* Business: pricing defaults */}
              <div className="space-y-4">
                <h4 className="text-[10px] font-black uppercase text-blue-500 tracking-wider">Pricing</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111928] md:col-span-2">
                    <span className="block text-[10px] font-bold text-slate-400">Default Pricing Rule</span>
                    <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">Supplier cost + default markup + profit margin</strong>
                    <p className="mt-1 text-[10px] text-slate-400">Prices remain reviewable and do not reach the storefront until approval.</p>
                  </div>
                  
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111928] md:col-span-2">
                    <h5 className="font-bold text-slate-600 dark:text-slate-300">Product Limits</h5>
                    <div className="mt-4 grid gap-4">
                  {/* Scheduled Product Limit */}
                  <div className="space-y-1">
                    <label className="text-slate-400 font-bold block">Scheduled Max Products</label>
                    <input
                      type="number"
                      min="1"
                      max="250"
                      value={supplierSettings.maxProducts !== undefined ? supplierSettings.maxProducts : 5}
                      onChange={(e) => setSupplierSettings(prev => ({ ...prev, maxProducts: e.target.value === "" ? "" : Number(e.target.value) }))}
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-[#111928] border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500/50 transition-colors text-xs text-slate-900 dark:text-white font-mono font-bold text-left"
                    />
                  </div>

                    </div>
                  </div>

                  {/* Profit Margin */}
                  <div className="space-y-1">
                    <label className="text-slate-400 font-bold block">Default Profit Margin (%)</label>
                    <div className="relative">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        value={supplierSettings.defaultProfitMargin !== undefined ? supplierSettings.defaultProfitMargin : 15}
                        onChange={(e) => setSupplierSettings(prev => ({ ...prev, defaultProfitMargin: e.target.value === "" ? "" : Number(e.target.value) }))}
                        className="w-full px-3.5 py-2.5 bg-white dark:bg-[#111928] border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500/50 transition-colors text-xs text-slate-900 dark:text-white font-mono font-bold text-left"
                      />
                      <span className="absolute right-4 top-3 text-slate-400 font-bold">%</span>
                    </div>
                  </div>

                  {/* Default Markup */}
                  <div className="space-y-1">
                    <label className="text-slate-400 font-bold block">Default Markup Rate (%)</label>
                    <div className="relative">
                      <input
                        type="number"
                        min="0"
                        max="200"
                        step="0.1"
                        value={supplierSettings.defaultMarkup !== undefined ? supplierSettings.defaultMarkup : 10}
                        onChange={(e) => setSupplierSettings(prev => ({ ...prev, defaultMarkup: e.target.value === "" ? "" : Number(e.target.value) }))}
                        className="w-full px-3.5 py-2.5 bg-white dark:bg-[#111928] border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500/50 transition-colors text-xs text-slate-900 dark:text-white font-mono font-bold text-left"
                      />
                      <span className="absolute right-4 top-3 text-slate-400 font-bold">%</span>
                    </div>
                  </div>

                  {/* Max Image Limit */}
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111928] md:col-span-2">
                    <h5 className="font-bold text-slate-600 dark:text-slate-300">Image Limits</h5>
                  <div className="mt-4 space-y-1">
                    <label className="text-slate-400 font-bold block">Maximum Image Limit per Product</label>
                    <input
                      type="number"
                      min="1"
                      max="20"
                      value={supplierSettings.defaultImageLimit !== undefined ? supplierSettings.defaultImageLimit : 5}
                      onChange={(e) => setSupplierSettings(prev => ({ ...prev, defaultImageLimit: e.target.value === "" ? "" : Number(e.target.value) }))}
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-[#111928] border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500/50 transition-colors text-xs text-slate-900 dark:text-white font-mono font-bold text-left"
                    />
                  </div>
                  </div>

                </div>
              </div>

              {/* Business: catalogue preparation */}
              <div className="space-y-4">
                <div>
                  <h4 className="text-[10px] font-black uppercase text-blue-500 tracking-wider">Catalogue</h4>
                  <h5 className="mt-2 text-xs font-bold text-slate-800 dark:text-slate-100">Category Mapping</h5>
                  <p className="mt-1 text-[10px] text-slate-400">Map each supplier taxonomy to an active canonical Zyro category and, when required, its active subcategory.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-[#111928]">
                    <span className="block text-[10px] font-bold text-slate-400">Brand Mapping</span>
                    <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">Brand Registry with Product Review override</strong>
                    <p className="mt-1 text-[10px] text-slate-400">Unknown brands remain optional and never receive a fabricated canonical brand.</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-[#111928]">
                    <span className="block text-[10px] font-bold text-slate-400">Default Category</span>
                    <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">Manual review when no mapping is trusted</strong>
                    <p className="mt-1 text-[10px] text-slate-400">The system never publishes an uncertain category automatically.</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {supplierCategoryOptions.map((option) => {
                    const draft = supplierCategoryMappingDrafts[option.key] || { targetCategoryId: '', targetSubcategoryId: '' };
                    const selectedCategory = categories.find((category) => category.id === draft.targetCategoryId);
                    const activeSubcategories = (selectedCategory?.subcategories || []).filter((subcategory: any) => subcategory.isActive !== false);
                    const hasSupplierSubcategoryBinding = Boolean(option.supplierSubcategory || option.supplierSubcategoryId);
                    const requiresSubcategory = hasSupplierSubcategoryBinding && activeSubcategories.length > 0;
                    const mapping = supplierCategoryMappings.find((candidate) => supplierCategoryMappingUiKey(
                      candidate.sourceId,
                      candidate.normalizedCategory,
                      candidate.mappingScope === 'child' ? candidate.supplierSubcategory : undefined,
                      candidate.mappingScope === 'child' ? candidate.supplierSubcategoryId : undefined,
                    ) === option.key);
                    return <div key={option.key} className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-[#111928]">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-bold text-slate-700 dark:text-slate-200" title={option.label}>{option.label}</span>
                        {mapping ? <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-black text-emerald-600">Mapped</span> : null}
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <select aria-label={`Map supplier category ${option.label}`} value={draft.targetCategoryId} onChange={(event) => setSupplierCategoryMappingDrafts((current) => ({ ...current, [option.key]: { targetCategoryId: event.target.value, targetSubcategoryId: '' } }))} className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs dark:border-slate-700 dark:bg-slate-900">
                          <option value="">Select Zyro category</option>
                          {categories.filter((category) => category.isActive !== false).map((category) => <option key={category.id} value={category.id}>{category.name || category.id}</option>)}
                        </select>
                        <select aria-label={`Map supplier subcategory ${option.label}`} value={draft.targetSubcategoryId} onChange={(event) => setSupplierCategoryMappingDrafts((current) => ({ ...current, [option.key]: { ...draft, targetSubcategoryId: event.target.value } }))} disabled={!selectedCategory || !hasSupplierSubcategoryBinding || activeSubcategories.length === 0} className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900">
                          <option value="">{!hasSupplierSubcategoryBinding ? 'Category-only mapping' : requiresSubcategory ? 'Select subcategory' : 'No subcategory required'}</option>
                          {activeSubcategories.map((subcategory: any) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name || subcategory.id}</option>)}
                        </select>
                      </div>
                      <button type="button" onClick={() => void handleSaveSupplierCategoryMapping(option)} disabled={!draft.targetCategoryId || (requiresSubcategory && !draft.targetSubcategoryId) || savingSupplierCategoryMapping === option.key} className="mt-2 min-h-9 rounded-lg bg-blue-600 px-3 text-[10px] font-black text-white disabled:cursor-not-allowed disabled:opacity-40">
                        {savingSupplierCategoryMapping === option.key ? 'Saving…' : 'Save mapping'}
                      </button>
                      {mapping?.mappingScope === 'child' && mapping.id && <button type="button" onClick={() => void handleRemoveSupplierCategoryMapping(mapping, option.label)} disabled={savingSupplierCategoryMapping === option.key || removingSupplierCategoryMapping === mapping.id} className="mt-2 ml-2 min-h-9 rounded-lg border border-red-300 px-3 text-[10px] font-black text-red-600 disabled:cursor-not-allowed disabled:opacity-40">
                        {removingSupplierCategoryMapping === mapping.id ? 'Removing...' : 'Unmap'}
                      </button>}
                    </div>;
                  })}
                  {(supplierSources.length === 0 || supplierCategoryOptions.length === 0) && <div className="rounded-xl border border-dashed border-slate-200 p-4 text-[11px] text-slate-400 dark:border-slate-800 md:col-span-2">{supplierSources.length === 0 ? 'Connect a supplier to configure category mapping.' : 'Update a supplier to discover categories for mapping.'}</div>}
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <h4 className="text-[10px] font-black uppercase text-blue-500 tracking-wider">Supplier Restrictions & Limits</h4>
                  <p className="mt-1 text-[10px] text-slate-400">Optional catalog restrictions are retained for existing suppliers and kept out of the normal business workflow.</p>
                </div>
                <div className="space-y-3">
                  {supplierSources.map((source) => (
                    <div key={source.id} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111928]">
                      <button type="button" onClick={() => handleOpenSettings(source)} className="flex w-full items-center justify-between text-left text-xs font-black">
                        <span>{source.supplierName || source.name || source.id}</span>
                        <span className="text-blue-500">{editingSourceId === source.id ? 'Close' : 'Configure'}</span>
                      </button>
                      {editingSourceId === source.id && (
                        <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 dark:border-slate-800 md:grid-cols-2">
                          <label className="space-y-1"><span className="block text-[10px] font-bold text-slate-400">Catalog path</span><input value={editEndpoint} onChange={(event) => setEditEndpoint(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-transparent px-3 py-2 dark:border-slate-700" /></label>
                          <label className="space-y-1"><span className="block text-[10px] font-bold text-slate-400">Brand restrictions</span><input value={editBrandFilter} onChange={(event) => setEditBrandFilter(event.target.value)} placeholder="Comma-separated brands" className="w-full rounded-xl border border-slate-200 bg-transparent px-3 py-2 dark:border-slate-700" /></label>
                          <div className="space-y-2 md:col-span-2"><span className="block text-[10px] font-bold text-slate-400">Category restrictions</span><div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-xl border border-slate-100 p-2 dark:border-slate-800">{categories.map((category) => { const value = category.name || category.id; const selected = editCategoriesFilter.includes(value); return <button key={category.id} type="button" onClick={() => setEditCategoriesFilter((current) => selected ? current.filter((item) => item !== value) : [...current, value])} className={`rounded-lg border px-2.5 py-1 text-[10px] font-bold ${selected ? 'border-blue-500 bg-blue-500/10 text-blue-500' : 'border-slate-200 text-slate-500 dark:border-slate-700'}`}>{value}</button>; })}</div></div>
                          <div className="space-y-2 md:col-span-2">
                            <span className="block text-[10px] font-bold text-slate-400">Catalog fetch page size</span>
                            <p className="text-[10px] leading-relaxed text-slate-500">Controls how many products each connector page requests. It does not stop the sync after that many products — set Product count limit in Manual Sync for a controlled trial.</p>
                            <div className="flex flex-wrap gap-1">{['5', '20', '50', '100', '250', 'All'].map((limit) => <button key={limit} type="button" onClick={() => setEditProductLimit(limit)} className={`rounded-lg px-3 py-1 text-[10px] font-bold ${editProductLimit === limit ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>{limit}</button>)}</div>
                          </div>
                          <div className="flex justify-end md:col-span-2"><button type="button" onClick={() => void handleSaveAdvancedSourceSettings(source.id)} disabled={savingSettingsSourceId !== null} className="rounded-xl bg-blue-600 px-4 py-2 text-[10px] font-black text-white disabled:opacity-50">Save Supplier Limits</button></div>
                        </div>
                      )}
                    </div>
                  ))}
                  {supplierSources.length === 0 && (
                    <div className="rounded-xl border border-dashed border-slate-200 p-4 text-[11px] text-slate-400 dark:border-slate-800">
                      No supplier restrictions configured.
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                <h4 className="text-[10px] font-black uppercase tracking-wider text-blue-500">Review</h4>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111928]">
                    <span className="block text-[10px] font-bold text-slate-400">Review Behaviour</span>
                    <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">Every supported supplier change requires Product Review</strong>
                    <p className="mt-1 text-[10px] text-slate-400">New products, updates, removals, and conflicts stay private until reviewed.</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111928]">
                    <span className="block text-[10px] font-bold text-slate-400">Approval Behaviour</span>
                    <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">Storefront publication occurs only after approval</strong>
                    <p className="mt-1 text-[10px] text-slate-400">These safeguards are fixed production rules and cannot be disabled here.</p>
                  </div>
                </div>
              </div>

              {/* Actions Row */}
              <div className="pt-4 border-t border-slate-200/50 dark:border-slate-800/60 flex justify-end">
                <button
                  type="submit"
                  disabled={savingSupplierSettings}
                  className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white font-bold rounded-xl text-xs transition-colors shadow-lg shadow-blue-500/10 flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {savingSupplierSettings ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  <span>Save Settings Configuration</span>
                </button>
              </div>

            </form>
            </section>

            {canAccessAdvanced && <section aria-labelledby="supplier-advanced-settings-title" className="space-y-4">
              <div>
                <h3 id="supplier-advanced-settings-title" className="text-sm font-black text-slate-900 dark:text-white">Advanced Settings</h3>
                <p className="mt-1 text-[11px] text-slate-400">Permission-protected diagnostics, recovery, scheduling, media, and system status.</p>
              </div>
              <div className="flex flex-wrap gap-2" aria-label="Advanced settings areas">
                {['Diagnostics', 'Recovery', 'Queue Information', 'Scheduler Information', 'Media Diagnostics', 'System Status'].map((label) => (
                  <span key={label} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-bold text-slate-500 dark:border-slate-800 dark:bg-slate-900">{label}</span>
                ))}
              </div>
            <SupplierOperationsDashboard
              requestApi={requestSupplierApi}
              activeSyncJob={currentSyncJob}
              refreshKey={operationsRefreshKey}
              mode="advanced"
            />
            </section>}
          </div>
        )}

      </div>

      {/* --- ALL INLINE MODALS --- */}
      {manualSyncSource && (
        <SupplierManualSyncDialog
          source={manualSyncSource}
          isInitialSync={!supplierHasCompletedInitialSync(manualSyncSource)}
          busy={syncingSourceId === String(manualSyncSource.id)}
          onClose={() => setManualSyncSource(null)}
          onSubmit={runManualSupplierSync}
        />
      )}

      {showConnectModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4" role="presentation">
          <div
            ref={connectDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="connect-supplier-title"
            aria-describedby="connect-supplier-description"
            className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-xl w-full max-h-[min(90dvh,calc(100dvh-2rem))] p-6 text-left shadow-2xl flex flex-col space-y-4 overflow-y-auto"
          >
            
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-emerald-500/10 text-emerald-500 rounded-xl">
                  <Plus className="h-5 w-5" />
                </div>
                <div>
                  <h3 id="connect-supplier-title" className="text-sm font-extrabold font-display text-slate-900 dark:text-white">Connect External Supplier</h3>
                  <p id="connect-supplier-description" className="text-[10px] text-slate-400 font-medium">Connect an API or catalog integration such as A2Z. Manual Supplier Portal onboarding stays separate.</p>
                </div>
              </div>
              <button
                ref={connectCloseButtonRef}
                type="button"
                onClick={closeConnectModal}
                aria-label="Close Connect External Supplier"
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full cursor-pointer transition-colors"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* Connection Test Status Banner */}
            {modalTestStatus !== 'idle' && (
              <div className={`p-3.5 rounded-2xl border text-xs flex flex-col space-y-1.5 transition-all ${
                modalTestStatus === 'testing' ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20 animate-pulse' :
                modalTestStatus === 'Connected' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' :
                'bg-red-500/10 text-red-500 border-red-500/20'
              }`}>
                <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-[10px]">
                  {modalTestStatus === 'testing' && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                  {modalTestStatus === 'Connected' && <Check className="h-3.5 w-3.5" />}
                  {modalTestStatus === 'Failed' && <AlertCircle className="h-3.5 w-3.5 text-red-500" />}
                  <span>Connection: {modalTestStatus === 'testing' ? 'Verifying Link...' : modalTestStatus}</span>
                </div>
                
                {modalTestStatus === 'Connected' && newSupplierConfigurationVerified && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 font-normal">
                    Successfully verified! Discovered <strong className="font-extrabold text-emerald-500">{modalTestProductsCount} products</strong>. Save the supplier, then run Initial Sync from the supplier card.
                  </p>
                )}
                {modalTestStatus === 'Connected' && !newSupplierConfigurationVerified && (
                  <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">The configuration changed after testing. Test it again before saving.</p>
                )}
                {modalTestStatus === 'Failed' && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 font-normal">
                    {supplierBusinessErrorMessage(modalTestError, 'The supplier connection could not be verified.')}
                  </p>
                )}
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleConnectSupplierSubmit} className="space-y-4 text-xs">
              
              <div className="grid grid-cols-1 gap-4">
                {/* Supplier Name */}
                <div className="space-y-1">
                  <label htmlFor="connect-supplier-name" className="text-slate-400 font-bold block text-[10px] uppercase">Supplier Name</label>
                  <input 
                    id="connect-supplier-name"
                    type="text" 
                    required
                    placeholder="e.g., A2Z Traders"
                    value={newSupplierName}
                    onChange={(e) => {
                      setNewSupplierName(e.target.value);
                      setNewSupplierCode(generateSlug(e.target.value));
                    }}
                    className="w-full px-3 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-850 rounded-xl focus:outline-hidden focus:border-emerald-500 transition-colors text-xs dark:text-white font-medium"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="connect-supplier-account" className="text-slate-400 font-bold block text-[10px] uppercase">Fulfilment Supplier Account</label>
                  <select
                    id="connect-supplier-account"
                    required
                    value={newSupplierAccountId}
                    onChange={(event) => {
                      setNewSupplierAccountId(event.target.value);
                      setModalTestStatus('idle');
                      testedSupplierConfigurationRef.current = null;
                    }}
                    className="w-full px-3 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-850 rounded-xl focus:outline-hidden focus:border-emerald-500 transition-colors text-xs dark:text-white font-medium"
                  >
                    <option value="">Select an active supplier account</option>
                    {supplierAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.companyName || account.email || account.id}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-slate-400">This is the active Supplier Portal account that receives fulfilment groups for products imported from this external source.</p>
                </div>

              </div>

              {/* Supplier Type selection */}
              <div className="space-y-1">
                <label htmlFor="connect-supplier-type" className="text-slate-400 font-bold block text-[10px] uppercase">Supplier Type</label>
                <select 
                  id="connect-supplier-type"
                  value={newSupplierType}
                  onChange={(e) => {
                    setNewSupplierType(e.target.value as SupplierOnboardingType);
                    setNewSupplierUrl("");
                    setNewSupplierCredentialProfile('');
                    setApiEndpoint("");
                    setModalTestStatus('idle');
                    setModalTestError(null);
                    setModalTestProductsCount(null);
                    testedSupplierConfigurationRef.current = null;
                  }}
                  className="w-full px-3 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-850 rounded-xl focus:outline-hidden focus:border-emerald-500 transition-colors text-xs dark:text-white font-bold cursor-pointer"
                >
                  <option value="a2z">A2Z (Firebase Secret Manager)</option>
                  <option value="dropex">Dropex (Firebase Secret Manager)</option>
                  <option value="website">Generic HTTP JSON Feed</option>
                  <option value="api">REST / JSON Endpoint</option>
                </select>
              </div>

              {/* Dynamic Type Specific Fields */}
              {(newSupplierType === 'website' || newSupplierType === 'a2z' || newSupplierType === 'dropex') && (
                <div className="space-y-3.5 p-4 rounded-2xl bg-amber-500/5 border border-amber-500/10">
                  {(newSupplierType === 'website' || newSupplierType === 'a2z') && (
                  <div className="space-y-1">
                    <label htmlFor="connect-supplier-base-url" className="text-amber-600 dark:text-amber-500 font-black block text-[9px] uppercase tracking-wider">
                      {newSupplierType === 'a2z' ? 'A2Z Base URL' : 'JSON Feed Base URL'}
                    </label>
                    <input 
                      id="connect-supplier-base-url"
                      type="url" 
                      required
                      placeholder={newSupplierType === 'a2z' ? 'https://supplier.example.com' : 'https://supplier.example.com/catalog/'}
                      value={newSupplierUrl}
                      onChange={(e) => setNewSupplierUrl(e.target.value)}
                      className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white"
                    />
                  </div>
                  )}

                  {newSupplierType === 'dropex' && (
                    <div className="space-y-1">
                      <label htmlFor="connect-supplier-dropex-portal-url" className="text-amber-600 dark:text-amber-500 font-black block text-[9px] uppercase tracking-wider">
                        Dropex Portal URL (optional)
                      </label>
                      <input
                        id="connect-supplier-dropex-portal-url"
                        type="url"
                        placeholder="https://manager.dropex.lk"
                        value={newSupplierUrl}
                        onChange={(e) => setNewSupplierUrl(e.target.value)}
                        className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white"
                      />
                      <p className="text-[10px] font-semibold leading-relaxed text-amber-700/80 dark:text-amber-400/80">
                        Catalog sync uses Dropex Dreamworld APIs. This reference URL is optional and is not used for login.
                      </p>
                    </div>
                  )}

                  {newSupplierType === 'website' && <div className="space-y-1">
                    <label htmlFor="connect-supplier-product-endpoint" className="text-amber-600 dark:text-amber-500 font-black block text-[9px] uppercase tracking-wider">Product Endpoint</label>
                    <input 
                      id="connect-supplier-product-endpoint"
                      type="text" 
                      required
                      placeholder="/api/products"
                      value={apiEndpoint}
                      onChange={(e) => setApiEndpoint(e.target.value)}
                      className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white font-mono"
                    />
                  </div>}
                  {(newSupplierType === 'a2z' || newSupplierType === 'dropex') && (
                    <div className="space-y-1">
                      <label htmlFor="connect-supplier-credential-profile" className="text-amber-600 dark:text-amber-500 font-black block text-[9px] uppercase tracking-wider">
                        Credential profile ID (required)
                      </label>
                      <input
                        id="connect-supplier-credential-profile"
                        type="text"
                        required
                        maxLength={160}
                        pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,159}"
                        placeholder={newSupplierType === 'dropex' ? 'dropex-production' : 'supplier-profile-id'}
                        value={newSupplierCredentialProfile}
                        onChange={(event) => {
                          setNewSupplierCredentialProfile(event.target.value);
                          setModalTestStatus('idle');
                          testedSupplierConfigurationRef.current = null;
                        }}
                        className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white font-mono"
                        aria-describedby="supplier-credential-profile-help"
                      />
                      <p id="supplier-credential-profile-help" className="text-[10px] font-semibold leading-relaxed text-amber-700/80 dark:text-amber-400/80">
                        Enter only the server-configured profile ID. Credentials remain in Firebase Secret Manager and are never sent by this form.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {newSupplierType === 'api' && (
                <div className="space-y-3.5 p-4 rounded-2xl bg-blue-500/5 border border-blue-500/10">
                  <div className="space-y-1">
                    <label htmlFor="connect-supplier-rest-url" className="text-blue-500 font-black block text-[9px] uppercase tracking-wider">REST Endpoint URL</label>
                    <input 
                      id="connect-supplier-rest-url"
                      type="url" 
                      required
                      placeholder="https://api.distributor.com/v2/catalog"
                      value={apiEndpoint}
                      onChange={(e) => setApiEndpoint(e.target.value)}
                      className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs dark:text-white"
                    />
                  </div>

                  <div className="space-y-1">
                    <label htmlFor="connect-supplier-data-path" className="text-blue-500 font-black block text-[9px] uppercase tracking-wider">JSON Response Data Path</label>
                    <input 
                      id="connect-supplier-data-path"
                      type="text" 
                      required
                      placeholder="products"
                      value={apiDataPath}
                      onChange={(e) => setApiDataPath(e.target.value)}
                      className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs dark:text-white font-mono"
                    />
                  </div>
                </div>
              )}

              {/* Modal Actions Footer */}
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-between gap-2 items-center">
                <button 
                  type="button"
                  onClick={closeConnectModal}
                  className="px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold rounded-xl text-xs transition-colors cursor-pointer border border-slate-200/50 dark:border-slate-800/60"
                >
                  Cancel
                </button>
                
                <div className="flex items-center gap-2">
                  <button 
                    type="button"
                    onClick={handleModalTestConnection}
                    disabled={modalTestStatus === 'testing' || savingSupplier}
                    className="px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-extrabold rounded-xl text-xs transition-colors cursor-pointer flex items-center gap-1 border border-slate-200/50 dark:border-slate-750"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${modalTestStatus === 'testing' ? 'animate-spin' : ''}`} />
                    <span>{modalTestStatus === 'testing' ? 'Testing...' : 'Test Connection'}</span>
                  </button>

                  <button 
                    type="submit"
                    disabled={savingSupplier || !newSupplierConfigurationVerified}
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold rounded-xl text-xs transition-colors shadow-lg shadow-emerald-500/20 flex items-center gap-1.5 cursor-pointer"
                  >
                    {savingSupplier ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    <span>{savingSupplier ? 'Saving...' : 'Connect Source'}</span>
                  </button>
                </div>
              </div>

            </form>
          </div>
        </div>
      )}

      {editingReviewItem && (
        <SupplierReviewEditorModal
          item={editingReviewItem}
          initialDraft={createSupplierReviewDraft(editingReviewItem)}
          categories={categories}
          brands={brands}
          validCategoryIds={validCategoryIds}
          isPublishing={processingChangeId === editingReviewItem.id}
          isSaving={savingReviewDraftId === editingReviewItem.id}
          offers={supplierOffers}
          offerSelection={supplierOfferSelection}
          offersLoading={supplierOffersLoading}
          offerActionId={supplierOfferActionId}
          offerError={supplierOfferError ? supplierBusinessErrorMessage(supplierOfferError, 'Supplier offers could not be loaded.') : null}
          onRefreshOffers={() => loadSupplierOffers(editingReviewItem)}
          refreshEligible={supplierReviewRefreshEligible(editingReviewItem)}
          isRefreshing={refreshingReviewItemId === editingReviewItem.id}
          refreshFeedback={refreshFeedback}
          onRefreshSupplier={() => handleRefreshSupplierReviewItem(editingReviewItem)}
          onConfigureOffer={configureSupplierOffer}
          onSelectOffer={selectSupplierOffer}
          onClose={() => {
            if (processingChangeId !== editingReviewItem.id && savingReviewDraftId !== editingReviewItem.id) {
              setEditingReviewItem(null);
              setSupplierOffers([]);
              setSupplierOfferError(null);
            }
          }}
          onRemove={() => setRemovingReviewItem(editingReviewItem)}
          onSaveDraft={(draft) => handleSaveSupplierReviewDraft(editingReviewItem, draft)}
          onPublish={(draft) => handleApproveReviewItem(editingReviewItem, draft)}
        />
      )}

      {historyReviewItem && (
        <SupplierReviewHistoryModal
          item={historyReviewItem}
          events={reviewAuditEvents}
          loading={reviewAuditLoading}
          error={reviewAuditError ? supplierBusinessErrorMessage(reviewAuditError, 'Review history could not be loaded.') : null}
          nextCursor={reviewAuditCursor}
          currentAdmin={auth.currentUser}
          onLoadMore={() => loadSupplierReviewAudit(historyReviewItem, reviewAuditCursor || undefined, true)}
          onClose={() => {
            supplierAuditRequestIdRef.current += 1;
            setHistoryReviewItem(null);
            setReviewAuditEvents([]);
            setReviewAuditCursor(null);
            setReviewAuditError(null);
          }}
        />
      )}

      {rejectingReviewItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs" role="dialog" aria-modal="true" aria-labelledby="supplier-rejection-title">
          <form
            className="w-full max-w-md space-y-4 rounded-3xl border border-slate-200 bg-white p-6 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928]"
            onSubmit={(event) => {
              event.preventDefault();
              if (!rejectionReasonDraft.trim()) return;
              void handleRejectReviewItem(rejectingReviewItem, rejectionReasonDraft);
            }}
          >
            <div>
              <h3 id="supplier-rejection-title" className="text-sm font-extrabold text-slate-900 dark:text-white">Reject supplier product</h3>
              <p className="mt-1 text-xs text-slate-500">Give the supplier a clear reason they can act on.</p>
            </div>
            <label className="block text-xs font-bold text-slate-600 dark:text-slate-300">
              Rejection reason
              <textarea
                autoFocus
                required
                maxLength={500}
                value={rejectionReasonDraft}
                onChange={(event) => setRejectionReasonDraft(event.target.value)}
                className="mt-2 min-h-28 w-full rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setRejectingReviewItem(null); setRejectionReasonDraft(''); }} className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">Cancel</button>
              <button type="submit" disabled={!rejectionReasonDraft.trim() || processingChangeId === rejectingReviewItem.id} className="rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">Reject Product</button>
            </div>
          </form>
        </div>
      )}

      {removingReviewItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs" role="dialog" aria-modal="true" aria-labelledby="supplier-remove-review-title">
          <div className="w-full max-w-md space-y-4 rounded-3xl border border-slate-200 bg-white p-6 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928]">
            <div>
              <h3 id="supplier-remove-review-title" className="text-sm font-extrabold text-slate-900 dark:text-white">Remove from Product Review?</h3>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">Remove this item from Product Review? This does not delete the supplier product or a published Zyro product.</p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRemovingReviewItem(null)} disabled={processingChangeId === removingReviewItem.id} className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300">Cancel</button>
              <button type="button" onClick={() => void handleRemoveReviewItem(removingReviewItem)} disabled={processingChangeId === removingReviewItem.id} className="rounded-xl bg-amber-600 px-4 py-2 text-xs font-black text-white disabled:opacity-50">{processingChangeId === removingReviewItem.id ? 'Removing…' : 'Remove from Review'}</button>
            </div>
          </div>
        </div>
      )}

    </motion.div>
  );
}

export default React.memo(SupplierHubFiveStars);
