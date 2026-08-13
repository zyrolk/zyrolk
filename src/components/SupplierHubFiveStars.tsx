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
import { isValidSupplierImageUrl } from '../services/connectors/a2z-website/productImages';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import { onIdTokenChanged } from 'firebase/auth';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import { Product } from '../types';
import { getSupplierApi, patchSupplierApi, postSupplierApi, requestSupplierApi } from '../services/supplierHubApi';
import { matchesSupplierSearch } from '../services/supplierSearch';
import { normalizeSupplierSourceForUi } from '../services/supplierSourceUtils';
import { A2Z_GLOBAL_SECRET_PROFILE, buildSupplierOnboardingSource, SupplierOnboardingType } from '../services/supplierSourceOnboarding';
import { reportSupplierImageFailure } from '../services/supplierImageDiagnostics';
import { reportClientIssue } from '../services/observability/clientDiagnostics';
import SupplierReviewEditorModal from './SupplierReviewEditorModal';
import SupplierReviewHistoryModal, { SupplierReviewAuditEvent } from './SupplierReviewHistoryModal';
import SupplierOperationsDashboard from './supplier-operations/SupplierOperationsDashboard';
import SupplierManagementDashboard from './supplier-management/SupplierManagementDashboard';
import SupplierManualSyncDialog from './supplier-management/SupplierManualSyncDialog';
import SupplierConnectionBadge from './supplier-ui/SupplierConnectionBadge';
import { createSupplierReviewDraft, SupplierReviewDraft } from '../services/supplierReviewEditor';
import { normalizeSupplierCategory } from '../services/supplierCategoryMapping';
import {
  sortSupplierOffers,
  SupplierOfferSelectionView,
  SupplierOffersResponse,
  SupplierOfferView,
} from '../services/supplierOffers';
import {
  formatSupplierSyncEta,
  formatSupplierSyncProgress,
  isSupplierSyncJobActive,
  isSupplierSyncProgressDeterminate,
  selectSupplierSyncJobForDisplay,
  supplierSyncJobStateLabel,
  SupplierSyncJobView,
} from '../services/supplierSyncJobs';
import { SupplierManualSyncRequest } from '../services/supplierManualSync';
import {
  matchesProductReviewFilter,
  PRODUCT_REVIEW_FILTERS,
  ProductReviewFilter,
  hasSupplierHubAdvancedAccess,
  supplierHealthLabel,
  supplierConnectionPresentation,
  SupplierHubSection,
  supplierReviewDecisionReady,
  supplierReviewChangeLabel,
  supplierReviewApiState,
  supplierReviewStatusLabel,
  supplierBusinessErrorMessage,
  formatSupplierTimestamp,
  formatSupplierDuration,
  supplierAdministratorLabel,
} from '../services/supplierHubPresentation';

interface SupplierHubFiveStarsProps {
  isDarkMode?: boolean;
}

const SUPPLIER_AUTO_SYNC_SCHEDULES = ['1 Hour', '3 Hours', '6 Hours', 'Daily'] as const;

function SupplierImagePreview({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!isValidSupplierImageUrl(src) || failed) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-center text-[8px] font-bold uppercase leading-tight text-slate-400 dark:bg-slate-800">
        No image
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className="h-10 w-10 rounded-lg border border-slate-200 object-cover dark:border-slate-800"
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={(event) => {
        reportSupplierImageFailure(event.currentTarget);
        setFailed(true);
      }}
    />
  );
}

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
  portalRequestId?: string;
  supplierId?: string;
  supplierSkuClaimId?: string;
  productFingerprintClaimId?: string;
  sourceId?: string;
  batchId?: string;
  createdAt?: string;
  updatedAt?: string;
  supplierSnapshot?: Record<string, unknown>;
  supplierOfferPendingRevision?: string;
  managedMedia?: Array<Record<string, unknown>>;
  mediaFailures?: Array<{ originalSupplierUrl?: string; reason?: string; retryable?: boolean; failedAt?: string }>;
  mediaStatus?: string;
  categoryMapping?: {
    supplierCategory?: string;
    targetCategoryId?: string;
    targetSubcategoryId?: string;
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
  };
  approvalConflict?: {
    reason?: string;
    changedFields?: string[];
    previousVersion?: string;
    currentVersion?: string;
  };
  supplierOfferId?: string;
  decisionAction?: 'approved' | 'rejected' | 'deleted';
  decisionCompletedAt?: unknown;
  decisionCompletedBy?: unknown;
}

interface SupplierQueuePageResponse {
  success?: boolean;
  items?: Array<Record<string, unknown> & { id: string }>;
  nextCursor?: string | null;
  error?: string;
}

const mergeSupplierQueuePage = <T extends { id: string }>(current: T[], page: T[]): T[] => {
  const items = new Map(current.map((item) => [item.id, item]));
  page.forEach((item) => items.set(item.id, item));
  return Array.from(items.values());
};

function SupplierHubFiveStars({ isDarkMode = true }: SupplierHubFiveStarsProps) {
  // Product review workspace state
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [supplierReviewCursor, setSupplierReviewCursor] = useState<string | null>(null);
  const [supplierReviewLoading, setSupplierReviewLoading] = useState(false);
  const [supplierQueueError, setSupplierQueueError] = useState<string | null>(null);
  const supplierQueueRequestIdRef = useRef(0);
  const supplierAuditRequestIdRef = useRef(0);
  const supplierReviewLoadedPagesRef = useRef(1);
  
  // Syncing state
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncStatusMsg, setSyncStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [syncErrorMsg, setSyncErrorMsg] = useState<string | null>(null);
  const [activeSyncJob, setActiveSyncJob] = useState<SupplierSyncJobView | null>(null);
  const [operationsRefreshKey, setOperationsRefreshKey] = useState(0);
  const [syncJobAction, setSyncJobAction] = useState<'cancel' | 'retry' | 'resume' | null>(null);
  const syncStartInFlightRef = useRef(false);
  const activeSyncJobRef = useRef<SupplierSyncJobView | null>(null);
  const pendingSupplierSettingsRef = useRef<Record<string, unknown> | null>(null);
  const applyActiveSyncJob = useCallback((job: SupplierSyncJobView | null) => {
    const active = isSupplierSyncJobActive(job);
    activeSyncJobRef.current = job;
    syncStartInFlightRef.current = active;
    setActiveSyncJob(job);
    setIsSyncing(active);
  }, []);

  // Supplier Hub navigation and interaction state
  const [activeSubTab, setActiveSubTab] = useState<SupplierHubSection>('suppliers');
  const [canAccessAdvanced, setCanAccessAdvanced] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<ProductReviewFilter>('new_products');
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [reviewSearch, setReviewSearch] = useState<string>('');
  const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<'approve' | 'reject' | null>(null);
  const [bulkProgressTotal, setBulkProgressTotal] = useState(0);

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

  // Supplier source definitions are deliberately projected by Functions. This
  // keeps legacy credential fields out of every browser response.
  const loadSources = useCallback(async () => {
    const [response, jobsResponse, accountsResponse] = await Promise.all([
      getSupplierApi('/api/supplier-sources'),
      getSupplierApi('/api/supplier-sync/jobs?limit=20'),
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
      const selectedJob = selectSupplierSyncJobForDisplay(jobsResult.jobs);
      if (selectedJob && isSupplierSyncJobActive(selectedJob)) {
        applyActiveSyncJob(selectedJob);
        setSyncStatusMsg(formatSupplierSyncProgress(selectedJob));
      } else applyActiveSyncJob(null);
    }
  }, [applyActiveSyncJob]);

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

  useEffect(() => {
    if (!['review', 'suppliers', 'settings'].includes(activeSubTab)) return;
    const unsubscribe = onSnapshot(
      collection(db, "categories"),
      (snapshot) => {
        const catList: any[] = [];
        snapshot.forEach((d) => catList.push({ id: d.id, ...d.data() }));
        setCategories(catList);
      },
      (error) => {
        console.error("Categories fetch error:", error);
      }
    );
    return () => unsubscribe();
  }, [activeSubTab]);

  useEffect(() => {
    if (!['review', 'suppliers', 'settings'].includes(activeSubTab)) return;
    const unsubscribe = onSnapshot(
      collection(db, "brands"),
      (snapshot) => setBrands(snapshot.docs.map((brand) => ({ id: brand.id, ...brand.data() }))),
      (error) => handleFirestoreError(error, OperationType.GET, "brands"),
    );
    return () => unsubscribe();
  }, [activeSubTab]);

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

  const visibleReviewItems = useMemo(
    () => reviewQueue.filter((item) => (
      matchesProductReviewFilter(item, reviewFilter) && matchesSupplierSearch(item, reviewSearch)
    )),
    [reviewFilter, reviewQueue, reviewSearch],
  );
  const selectedReviewItems = useMemo(
    () => visibleReviewItems.filter((item) => item.status === 'Pending' && supplierReviewDecisionReady(item) && selectedReviewIds.includes(item.id)),
    [selectedReviewIds, visibleReviewItems],
  );
  const validCategoryIds = useMemo(() => categories.map((category) => String(category.id)), [categories]);
  const supplierCategoryOptions = useMemo(() => {
    const values = new Map<string, string>();
    const addCategories = (source: unknown) => {
      if (!Array.isArray(source)) return;
      source.forEach((value) => {
        const label = String(value || '').trim();
        const normalized = normalizeSupplierCategory(label);
        if (normalized && !values.has(normalized)) values.set(normalized, label);
      });
    };

    reviewQueue.forEach((item) => addCategories(item.supplierSnapshot?.categoryHierarchy));
    supplierSources.forEach((source) => addCategories(source.settings?.discoveredCategories));
    return Array.from(values.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [reviewQueue, supplierSources]);
  const supplierSourceById = useMemo(
    () => new Map(supplierSources.map((source) => [String(source.id), source])),
    [supplierSources],
  );
  const sourceIsSyncing = useCallback((sourceId: string): boolean => Boolean(
    activeSyncJob
    && isSupplierSyncJobActive(activeSyncJob)
    && (activeSyncJob.sourceIds.includes(sourceId) || activeSyncJob.progress.currentSourceId === sourceId)
  ), [activeSyncJob]);

  useEffect(() => {
    const pendingIds = new Set(reviewQueue.filter((item) => item.status === 'Pending' && supplierReviewDecisionReady(item)).map((item) => item.id));
    setSelectedReviewIds((current) => current.filter((id) => pendingIds.has(id)));
  }, [reviewQueue]);

  // Supplier Settings Engine state
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editSupplierName, setEditSupplierName] = useState<string>('');
  const [editWebsiteUrl, setEditWebsiteUrl] = useState<string>('');
  const [editEndpoint, setEditEndpoint] = useState<string>('');
  const [editCredentialProfile, setEditCredentialProfile] = useState<string>(A2Z_GLOBAL_SECRET_PROFILE);
  const [editSupplierAccountId, setEditSupplierAccountId] = useState<string>('');
  const [editSyncMode, setEditSyncMode] = useState<'manual' | 'auto'>('manual');
  const [editAutoSyncSchedule, setEditAutoSyncSchedule] = useState<string>('1 Hour');
  
  // Sync settings
  const [editCategoriesFilter, setEditCategoriesFilter] = useState<string[]>([]);
  const [editBrandFilter, setEditBrandFilter] = useState<string>('');
  const [editProductLimit, setEditProductLimit] = useState<string>('All');
  
  const [savingSettingsSourceId, setSavingSettingsSourceId] = useState<string | null>(null);

  const [processingChangeId, setProcessingChangeId] = useState<string | null>(null);
  const [editingReviewItem, setEditingReviewItem] = useState<ReviewQueueItem | null>(null);
  const [supplierOffers, setSupplierOffers] = useState<SupplierOfferView[]>([]);
  const [supplierOfferSelection, setSupplierOfferSelection] = useState<SupplierOfferSelectionView>({ activeOfferId: null, lockedOfferId: null, failoverEnabled: true });
  const [supplierOffersLoading, setSupplierOffersLoading] = useState(false);
  const [supplierOfferActionId, setSupplierOfferActionId] = useState<string | null>(null);
  const [supplierOfferError, setSupplierOfferError] = useState<string | null>(null);
  const [rejectingReviewItem, setRejectingReviewItem] = useState<ReviewQueueItem | null>(null);
  const [reviewDecisionAction, setReviewDecisionAction] = useState<'reject' | 'delete'>('reject');
  const [rejectionReasonDraft, setRejectionReasonDraft] = useState('');
  const [historyReviewItem, setHistoryReviewItem] = useState<ReviewQueueItem | null>(null);
  const [reviewAuditEvents, setReviewAuditEvents] = useState<SupplierReviewAuditEvent[]>([]);
  const [reviewAuditCursor, setReviewAuditCursor] = useState<string | null>(null);
  const [reviewAuditLoading, setReviewAuditLoading] = useState(false);
  const [reviewAuditError, setReviewAuditError] = useState<string | null>(null);
  // 3. Settings states
  const [supplierSettings, setSupplierSettings] = useState<any>({
    autoSyncEnabled: true,
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
      append?: boolean;
      after?: string | null;
      reviewState?: 'active' | 'conflict' | 'history';
      pageCount?: number;
    } = {},
  ): Promise<void> => {
    const append = options.append === true;
    const after = options.after === undefined ? (append ? supplierReviewCursor : null) : options.after;
    if (append && !after) return;
    const requestedPageCount = append ? 1 : Math.max(1, options.pageCount || 1);
    const requestId = ++supplierQueueRequestIdRef.current;
    setSupplierReviewLoading(true);
    try {
      let scanCursor = after;
      let nextCursor: string | null = null;
      let pagesLoaded = 0;
      let items: ReviewQueueItem[] = [];
      for (let page = 0; page < requestedPageCount; page += 1) {
        const parameters = new URLSearchParams({ view: 'review', limit: '50', filter: reviewFilter });
        parameters.set('state', options.reviewState || supplierReviewApiState(reviewFilter));
        if (scanCursor) parameters.set('after', scanCursor);
        const response = await getSupplierApi(`/api/supplier-review-queue?${parameters.toString()}`);
        const result = await response.json().catch(() => ({})) as SupplierQueuePageResponse;
        if (!response.ok || result.success !== true || !Array.isArray(result.items)) {
          throw new Error(result.error || 'Supplier products could not be loaded.');
        }
        if (requestId !== supplierQueueRequestIdRef.current) return;
        items = mergeSupplierQueuePage(items, result.items as unknown as ReviewQueueItem[]);
        pagesLoaded += 1;
        nextCursor = result.nextCursor || null;
        if (!nextCursor) break;
        scanCursor = nextCursor;
      }
      setReviewQueue((current) => append ? mergeSupplierQueuePage(current, items) : items);
      setSupplierReviewCursor(nextCursor);
      supplierReviewLoadedPagesRef.current = append
        ? supplierReviewLoadedPagesRef.current + pagesLoaded
        : pagesLoaded;
      setSupplierQueueError(null);
    } catch (error) {
      if (requestId === supplierQueueRequestIdRef.current) {
        setSupplierQueueError(error instanceof Error ? error.message : 'Supplier products could not be loaded.');
      }
    } finally {
      if (requestId === supplierQueueRequestIdRef.current) {
        setSupplierReviewLoading(false);
      }
    }
  };

  const refreshSupplierQueueViews = async (): Promise<void> => {
    await loadSupplierQueueView({ pageCount: supplierReviewLoadedPagesRef.current });
  };

  useEffect(() => {
    if (activeSubTab !== 'review' || !auth.currentUser) return;
    supplierReviewLoadedPagesRef.current = 1;
    let cancelled = false;
    let refreshTimer: number | null = null;
    const poll = async () => {
      await refreshSupplierQueueViews();
      if (!cancelled) refreshTimer = window.setTimeout(() => {
        if (auth.currentUser) void poll();
      }, 30_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [activeSubTab, reviewFilter]);

  useEffect(() => {
    const jobId = activeSyncJob?.id;
    if (!jobId || !isSupplierSyncJobActive(activeSyncJob)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const response = await getSupplierApi(`/api/supplier-sync/jobs/${encodeURIComponent(jobId)}`);
        const result = await response.json().catch(() => ({})) as { success?: boolean; job?: SupplierSyncJobView; error?: string };
        if (!response.ok || result.success !== true || !result.job) throw new Error(result.error || 'Synchronization status could not be loaded.');
        if (cancelled) return;
        const active = isSupplierSyncJobActive(result.job);
        if (active) applyActiveSyncJob(result.job);
        setSyncErrorMsg(null);
        setSyncStatusMsg(formatSupplierSyncProgress(result.job));
        if (!active) {
          setOperationsRefreshKey((current) => current + 1);
          void refreshSupplierQueueViews();
          const jobsResponse = await getSupplierApi('/api/supplier-sync/jobs?limit=20');
          const jobsResult = await jobsResponse.json().catch(() => ({})) as {
            success?: boolean;
            jobs?: SupplierSyncJobView[];
          };
          if (!cancelled && jobsResponse.ok && jobsResult.success === true && Array.isArray(jobsResult.jobs)) {
            const nextJob = selectSupplierSyncJobForDisplay(jobsResult.jobs);
            if (nextJob && nextJob.id !== result.job.id && isSupplierSyncJobActive(nextJob)) {
              applyActiveSyncJob(nextJob);
              setSyncStatusMsg(formatSupplierSyncProgress(nextJob));
            } else if (activeSyncJobRef.current?.id === jobId) applyActiveSyncJob(null);
          } else if (activeSyncJobRef.current?.id === jobId) applyActiveSyncJob(null);
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
  }, [activeSyncJob?.id, activeSyncJob?.state]);

  const handleSyncJobAction = async (action: 'cancel' | 'retry' | 'resume') => {
    if (!activeSyncJob) return;
    setSyncJobAction(action);
    setSyncErrorMsg(null);
    try {
      const response = await postSupplierApi(`/api/supplier-sync/jobs/${encodeURIComponent(activeSyncJob.id)}/${action}`, {});
      const result = await response.json().catch(() => ({})) as { success?: boolean; job?: SupplierSyncJobView; error?: string };
      if (!response.ok || result.success !== true || !result.job) throw new Error(result.error || `Synchronization could not ${action}.`);
      applyActiveSyncJob(result.job);
      setSyncStatusMsg(formatSupplierSyncProgress(result.job));
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
    };
    if (response.status === 409 && result.status === 'conflict' && result.conflict) return result;
    if (!response.ok || result.success !== true) {
      throw new Error(result.error || 'Supplier review action could not be completed.');
    }
    return result;
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
        throw new Error(result.error || 'Approval history could not be loaded.');
      }
      if (requestId !== supplierAuditRequestIdRef.current) return;
      setReviewAuditEvents((current) => append ? mergeSupplierQueuePage(current, result.events || []) : result.events || []);
      setReviewAuditCursor(result.nextCursor || null);
      setReviewAuditError(null);
    } catch (error) {
      if (requestId === supplierAuditRequestIdRef.current) {
        setReviewAuditError(error instanceof Error ? error.message : 'Approval history could not be loaded.');
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
    const currentJob = activeSyncJobRef.current;
    if (syncStartInFlightRef.current || isSupplierSyncJobActive(currentJob)) {
      if (currentJob) setSyncStatusMsg(formatSupplierSyncProgress(currentJob));
      return false;
    }
    let accepted = false;
    syncStartInFlightRef.current = true;
    setIsSyncing(true);
    setSyncErrorMsg(null);
      setSyncStatusMsg('Starting the supplier product update...');
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
      applyActiveSyncJob(result.job);
      setSyncStatusMsg(followsExistingActiveJob || result.created === false
        ? 'This supplier update is already in progress.'
        : 'Supplier product update started.');
      accepted = true;
      return true;
    } catch (error: any) {
      setSyncErrorMsg(error.message || 'Supplier synchronization failed.');
      setSyncStatusMsg(null);
      return false;
    } finally {
      if (!accepted) {
        syncStartInFlightRef.current = false;
        setIsSyncing(false);
      }
    }
  }, [applyActiveSyncJob, postSupplierApi]);

  // --- CONNECT SUPPLIER HANDLERS ---
  const buildNewSupplierSource = (connectionStatus = modalTestStatus === 'Connected' ? 'connected' : 'Not Synced') => {
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
      lastError: modalTestError,
    });
  };

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
    if (newSupplierType === 'api' && !apiEndpoint.trim()) {
      setModalTestStatus('Failed');
      setModalTestError("REST endpoint URL is required to test connection.");
      return;
    }

    setModalTestStatus('testing');
    setModalTestError(null);
    setModalTestProductsCount(null);
    const testedConfiguration = JSON.stringify(buildNewSupplierSource('Not Synced'));

    try {
      const response = await postSupplierApi('/api/test-supplier', {
        id: newSupplierCode.trim() || generateSlug(newSupplierName),
        source: buildNewSupplierSource('Not Synced'),
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
    if (newSupplierType === 'a2z' && !newSupplierCredentialProfile.trim()) {
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
    if (supplierHasCompletedInitialSync(source)) {
      setManualSyncSource(source);
      return;
    }
    await runManualSupplierSync({ sourceIds: [id], mode: 'full' });
  };

  const handleOpenSettings = (source: any) => {
    setEditingSourceId(source.id === editingSourceId ? null : source.id);
    
    // Initialize form fields from current source values
    setEditSupplierName(source.supplierName || source.name || '');
    setEditWebsiteUrl(source.websiteUrl || '');
    setEditEndpoint(source.endpoint || '');
    setEditCredentialProfile(String(source.authentication?.secretRef || source.authentication?.credentialProfile || A2Z_GLOBAL_SECRET_PROFILE));
    setEditSupplierAccountId(String(source.supplierAccountId || ''));
    // Initialize advanced source settings without changing the supplier workflow.
    const currentSettings = source.settings || {};
    setEditCategoriesFilter(currentSettings.categoriesFilter || []);
    setEditBrandFilter(currentSettings.brandFilter || '');
    setEditProductLimit(currentSettings.productLimit || 'All');
    const configuredSchedule = String(currentSettings.autoSync || source.syncSchedule || 'Off').trim();
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
      let supplierUrl: URL;
      try {
        supplierUrl = new URL(editWebsiteUrl.trim());
      } catch {
        throw new Error('Enter a valid supplier website URL.');
      }
      if (!['http:', 'https:'].includes(supplierUrl.protocol)) {
        throw new Error('Supplier website URL must use HTTP or HTTPS.');
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
        ...(String(currentSource.connectorType || '').toLowerCase() === 'a2z' ? {
          authentication: {
            mode: 'secret_manager',
            credentialProfile: editCredentialProfile.trim() || A2Z_GLOBAL_SECRET_PROFILE,
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
  const handleApproveReviewItem = async (item: ReviewQueueItem, draft: SupplierReviewDraft) => {
    setProcessingChangeId(item.id);
    try {
      const result = await decideSupplierReviewQueueItem(item.id, 'approve', {
        draft,
        resolveConflict: item.queueState === 'conflict' || item.status === 'CONFLICT',
        expectedPendingRevision: item.supplierOfferPendingRevision,
      });
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
      void refreshSupplierQueueViews();
      setSuccessMsg(`Product "${draft.productName.trim()}" approved and published successfully.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      console.error("Review approval error:", error);
      setErrorMsg(`Failed to approve: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 4000);
    } finally {
      setProcessingChangeId(null);
    }
  };

  const handleRejectReviewItem = async (item: ReviewQueueItem, rejectionReason: string) => {
    setProcessingChangeId(item.id);
    try {
      await decideSupplierReviewQueueItem(item.id, 'reject', {
        rejectionReason: rejectionReason.trim(),
        expectedPendingRevision: item.supplierOfferPendingRevision,
      });
      setProcessingChangeId(null);
      setRejectingReviewItem(null);
      setReviewDecisionAction('reject');
      setRejectionReasonDraft('');
      void refreshSupplierQueueViews();
      setSuccessMsg(`Product "${item.productName}" rejected.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      console.error("Review rejection error:", error);
      setErrorMsg(`Failed to reject: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 4000);
      setProcessingChangeId(null);
    }
  };

  const toggleReviewSelection = (itemId: string) => {
    setSelectedReviewIds((current) => current.includes(itemId)
      ? current.filter((id) => id !== itemId)
      : [...current, itemId]);
  };

  const toggleAllVisibleReviews = () => {
    const visiblePendingIds = visibleReviewItems.filter((item) => item.status === 'Pending' && supplierReviewDecisionReady(item)).map((item) => item.id);
    const allSelected = visiblePendingIds.length > 0 && visiblePendingIds.every((id) => selectedReviewIds.includes(id));
    setSelectedReviewIds((current) => allSelected
      ? current.filter((id) => !visiblePendingIds.includes(id))
      : Array.from(new Set([...current, ...visiblePendingIds])));
  };

  const handleBulkApproveReviews = async () => {
    if (selectedReviewItems.length === 0) return;
    setBulkProgressTotal(selectedReviewItems.length);
    setBulkAction('approve');
    setErrorMsg(null);
    try {
      const approvals = selectedReviewItems.map((item) => ({
        queueItemId: item.id,
        draft: createSupplierReviewDraft(item),
        expectedPendingRevision: item.supplierOfferPendingRevision,
      }));
      const response = await postSupplierApi('/api/supplier-review-queue/bulk-approve', { items: approvals });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Bulk supplier approval could not be completed.');

      setSelectedReviewIds([]);
      void refreshSupplierQueueViews();
      setSuccessMsg(`${approvals.length} products approved and published successfully.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      setErrorMsg(`Bulk approve stopped: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 5000);
    } finally {
      setBulkAction(null);
      setBulkProgressTotal(0);
    }
  };

  const handleBulkRejectReviews = async () => {
    if (selectedReviewItems.length === 0) return;
    setBulkProgressTotal(selectedReviewItems.length);
    setBulkAction('reject');
    setErrorMsg(null);
    try {
      const response = await postSupplierApi('/api/supplier-review-queue/bulk-reject', {
        items: selectedReviewItems.map((item) => ({
          queueItemId: item.id,
          expectedPendingRevision: item.supplierOfferPendingRevision,
        })),
        rejectionReason: 'Bulk rejected by admin.',
      });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Bulk supplier rejection could not be completed.');
      setSelectedReviewIds([]);
      void refreshSupplierQueueViews();
      setSuccessMsg(`${selectedReviewItems.length} products rejected with audit records.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      setErrorMsg(`Bulk reject stopped: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 5000);
    } finally {
      setBulkAction(null);
      setBulkProgressTotal(0);
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
        autoSyncEnabled: supplierSettings.autoSyncEnabled !== false,
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
        autoSyncEnabled: payload.autoSyncEnabled !== false,
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
        ? normalizeSupplierSourceForUi({ ...item, endpoint: editEndpoint.trim(), settings })
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

  const handleDismissReviewItem = async (item: ReviewQueueItem, deletionReason: string) => {
    setProcessingChangeId(item.id);
    try {
      await decideSupplierReviewQueueItem(item.id, 'delete', {
        deletionReason: deletionReason.trim(),
        expectedPendingRevision: item.supplierOfferPendingRevision,
      });
      setRejectingReviewItem(null);
      setReviewDecisionAction('reject');
      setRejectionReasonDraft('');
      void refreshSupplierQueueViews();
      setSuccessMsg(`Product "${item.productName}" dismissed from the current review.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      console.error('Review dismissal error:', error);
      setErrorMsg(`Failed to dismiss: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 4000);
    } finally {
      setProcessingChangeId(null);
    }
  };

  const handleToggleSupplierAutoSync = async (source: any) => {
    const currentSchedule = String(source.settings?.autoSync || source.syncSchedule || 'Off').trim();
    const enabled = currentSchedule.toLowerCase() !== 'off';
    const defaultSchedule = String(supplierSettings.syncInterval || '1 Hour');
    const nextSchedule = enabled ? 'Off' : (currentSchedule && currentSchedule.toLowerCase() !== 'off' ? currentSchedule : defaultSchedule);
    setSavingSettingsSourceId(source.id);
    try {
      const settings = { ...(source.settings || {}), autoSync: nextSchedule };
      const response = await patchSupplierApi(`/api/supplier-sources/${encodeURIComponent(source.id)}`, { source: { settings } });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Automatic synchronization could not be updated.');
      setSupplierSources((current) => current.map((item) => item.id === source.id
        ? normalizeSupplierSourceForUi({ ...item, settings })
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
    && testedSupplierConfigurationRef.current === JSON.stringify(buildNewSupplierSource('Not Synced'));
  const supplierHasCompletedInitialSync = (source: any): boolean => Boolean(
    source.lastSuccessfulSync
    || source.lastSuccess
    || source.lastSync
    || source.catalogSync?.status === 'completed',
  );
  const visibleErrorMsg = errorMsg || syncErrorMsg
    ? supplierBusinessErrorMessage(errorMsg || syncErrorMsg)
    : null;

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
        <div>
          {activeSubTab === 'suppliers' ? (
            <button
              onClick={() => setShowConnectModal(true)}
              className="w-full sm:w-auto px-5 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold rounded-xl text-xs transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center space-x-2 cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              <span>Add Supplier</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* Notifications and messages */}
      {syncStatusMsg && (
        <motion.div 
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-3.5 bg-blue-500/10 text-blue-500 text-xs font-semibold rounded-2xl border border-blue-500/20 flex items-center gap-2"
        >
          <Info className="h-4 w-4 shrink-0 animate-pulse" />
          <span>{syncStatusMsg}</span>
        </motion.div>
      )}

      {activeSyncJob && (
        <section
          aria-label="Supplier catalog update progress"
          className="rounded-2xl border border-slate-200/70 bg-white/80 p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-blue-500" aria-hidden="true" />
                <p className="text-xs font-extrabold text-slate-900 dark:text-white">
                  Catalog update · {supplierSyncJobStateLabel(activeSyncJob.state)}
                </p>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400" aria-live="polite">
                {isSupplierSyncJobActive(activeSyncJob) && !isSupplierSyncProgressDeterminate(activeSyncJob) && activeSyncJob.progress.pagesProcessed > 0
                  ? 'In progress · '
                  : isSupplierSyncProgressDeterminate(activeSyncJob) ? `${activeSyncJob.progress.percent}% · ` : ''}
                {activeSyncJob.progress.productsScanned} products checked · {activeSyncJob.progress.productsQueued} changes found
                {isSupplierSyncJobActive(activeSyncJob)
                  && isSupplierSyncProgressDeterminate(activeSyncJob)
                  && activeSyncJob.progress.etaMs !== null
                  ? ` · ${formatSupplierSyncEta(activeSyncJob.progress.etaMs)}`
                  : ''}
              </p>
              {activeSyncJob.state === 'waiting' && activeSyncJob.waitingReason ? (
                <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                  Supplier update is waiting to continue.
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {activeSubTab === 'settings' && canAccessAdvanced && ['pending', 'running', 'waiting'].includes(activeSyncJob.state) && (
                <button
                  type="button"
                  onClick={() => handleSyncJobAction('cancel')}
                  disabled={syncJobAction !== null || activeSyncJob.cancellationRequestedAt != null}
                  className="min-h-10 rounded-xl border border-rose-200 px-3 text-[11px] font-bold text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-900/60 dark:hover:bg-rose-950/30"
                >
                  {activeSyncJob.cancellationRequestedAt ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
              {activeSubTab === 'settings' && canAccessAdvanced && (activeSyncJob.state === 'waiting' || activeSyncJob.state === 'cancelled') && (
                <button
                  type="button"
                  onClick={() => handleSyncJobAction('resume')}
                  disabled={syncJobAction !== null}
                  className="min-h-10 rounded-xl bg-blue-600 px-3 text-[11px] font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Resume
                </button>
              )}
              {activeSyncJob.state === 'failed' && (
                <button
                  type="button"
                  onClick={() => handleSyncJobAction('retry')}
                  disabled={syncJobAction !== null}
                  className="min-h-10 rounded-xl bg-blue-600 px-3 text-[11px] font-bold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Retry
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
            aria-valuenow={isSupplierSyncProgressDeterminate(activeSyncJob) ? activeSyncJob.progress.percent : undefined}
            aria-valuetext={formatSupplierSyncProgress(activeSyncJob)}
          >
            <div
              className={`h-full rounded-full bg-gradient-to-r from-blue-600 to-cyan-500 transition-[width] duration-500 motion-reduce:transition-none ${isSupplierSyncProgressDeterminate(activeSyncJob) ? '' : 'w-1/3 animate-pulse motion-reduce:animate-none'}`}
              style={isSupplierSyncProgressDeterminate(activeSyncJob)
                ? { width: `${Math.max(0, Math.min(100, activeSyncJob.progress.percent))}%` }
                : undefined}
            />
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

      {/* Business navigation */}
      <div className="flex w-full flex-wrap items-center gap-1.5 border-b border-slate-100 pb-1.5 dark:border-slate-800">
        {[
          { id: 'suppliers', label: 'Suppliers', badge: supplierSources.length, icon: Globe },
          { id: 'review', label: 'Product Review', badge: reviewQueue.length, icon: UserCheck, badgeColor: 'bg-blue-500 text-white' },
          { id: 'activity', label: 'Activity', badge: null, icon: Activity },
          { id: 'settings', label: 'Settings', badge: null, icon: Settings },
        ].map((tab) => {
          const TabIcon = tab.icon;
          const isSubActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id as SupplierHubSection)}
              className={`px-4 py-2.5 rounded-xl font-bold text-xs transition-all flex items-center space-x-2 border cursor-pointer whitespace-nowrap ${
                isSubActive 
                  ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-500/10' 
                  : 'bg-slate-50 dark:bg-slate-900/40 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200/50 dark:border-slate-800/60'
              }`}
            >
              <TabIcon className="h-4 w-4" />
              <span>{tab.label}</span>
              {tab.badge !== null && tab.badge > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-mono font-black ${tab.badgeColor || 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'}`}>
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* SUB-TAB CONTENTS */}
      <div className="min-h-[400px]">

        {activeSubTab === 'activity' && supplierSourcesLoaded && supplierSources.length === 0 && (
          <div className="w-full rounded-3xl border border-dashed border-slate-200 bg-slate-50/50 p-8 text-center dark:border-slate-800 dark:bg-slate-900/10 sm:p-12">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500"><Activity className="h-8 w-8" aria-hidden="true" /></span>
            <h3 className="mt-3 text-sm font-bold text-slate-900 dark:text-white">No supplier activity yet.</h3>
            <p className="mt-1 text-xs text-slate-400">Activity will appear after your first synchronization.</p>
          </div>
        )}

        {activeSubTab === 'activity' && (!supplierSourcesLoaded || supplierSources.length > 0) && (
          <SupplierOperationsDashboard
            requestApi={requestSupplierApi}
            activeSyncJob={activeSyncJob}
            refreshKey={operationsRefreshKey}
            mode="activity"
            supplierSources={supplierSources}
          />
        )}

        {/* Product Review is the only business approval workspace. */}
        {activeSubTab === 'review' && supplierSourcesLoaded && supplierSources.length === 0 && (
          <div className="w-full rounded-3xl border border-dashed border-slate-200 bg-slate-50/50 p-8 text-center dark:border-slate-800 dark:bg-slate-900/10 sm:p-12">
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500"><UserCheck className="h-8 w-8" aria-hidden="true" /></span>
            <h3 className="mt-3 text-sm font-bold text-slate-900 dark:text-white">No supplier connected</h3>
            <p className="mt-1 text-xs text-slate-400">Connect a supplier and run the initial synchronization.</p>
            <button type="button" onClick={() => { setActiveSubTab('suppliers'); setShowConnectModal(true); }} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-xs font-extrabold text-white transition-colors hover:bg-emerald-700 sm:w-auto">
              <Plus className="h-4 w-4" aria-hidden="true" /> Add Supplier
            </button>
          </div>
        )}

        {activeSubTab === 'review' && (!supplierSourcesLoaded || supplierSources.length > 0) && (
          <div className="space-y-8">
            <section aria-labelledby="product-review-filters-title" className="rounded-3xl border border-slate-200/70 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h3 id="product-review-filters-title" className="text-sm font-black text-slate-900 dark:text-white">Product Review</h3>
                  <p className="mt-1 text-[11px] text-slate-400">Review supplier products and changes before they appear in your store.</p>
                </div>
                <div className="relative w-full max-w-sm">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={reviewSearch}
                    onChange={(event) => setReviewSearch(event.target.value)}
                    placeholder="Search loaded products or supplier codes..."
                    aria-label="Search currently loaded Product Review records"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs focus:outline-none dark:border-slate-800 dark:bg-slate-900/50"
                  />
                </div>
              </div>
              <p className="mt-2 text-[10px] text-slate-400">Search is intentionally limited to the products loaded on this page. Use Load more products to extend the bounded search.</p>
              <div className="mt-4 flex flex-wrap gap-2 pb-1" role="tablist" aria-label="Product review filters">
                {PRODUCT_REVIEW_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    role="tab"
                    aria-selected={reviewFilter === filter.id}
                    onClick={() => {
                      setReviewFilter(filter.id);
                      setSelectedReviewIds([]);
                    }}
                    className={`min-h-10 shrink-0 rounded-xl px-3 text-[11px] font-black transition-colors ${reviewFilter === filter.id ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </section>
            {/* Product review table */}
            <div className={`rounded-3xl border p-6 ${
              isDarkMode ? 'bg-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
            }`}>
              <div className="flex items-center justify-between mb-5">
                <div className="text-left">
                  <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-1.5">
                    <UserCheck className="h-4 w-4 text-blue-500" />
                    <span>{PRODUCT_REVIEW_FILTERS.find((filter) => filter.id === reviewFilter)?.label}</span>
                  </h3>
                  <p className="text-[11px] text-slate-400">Only products matching this business filter are shown.</p>
                </div>
              </div>

              {selectedReviewItems.length > 0 && <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/30">
                <span className="mr-auto text-[11px] font-bold text-slate-500">
                  {selectedReviewItems.length} selected
                </span>
                <button type="button" onClick={handleBulkApproveReviews} disabled={selectedReviewItems.length === 0 || bulkAction !== null} className="rounded-lg bg-emerald-600 px-3 py-2 text-[10px] font-black text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                  {bulkAction === 'approve' ? 'Approving...' : 'Bulk Approve'}
                </button>
                <button type="button" onClick={handleBulkRejectReviews} disabled={selectedReviewItems.length === 0 || bulkAction !== null} className="rounded-lg bg-amber-600 px-3 py-2 text-[10px] font-black text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                  {bulkAction === 'reject' ? 'Rejecting...' : 'Bulk Reject'}
                </button>
              </div>}

              {bulkAction && (
                <div className="mb-4 rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4" role="status" aria-live="polite">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-black text-blue-700 dark:text-blue-300">
                    <span>{bulkAction === 'approve' ? 'Approving products...' : 'Rejecting products...'}</span>
                    <span>{bulkProgressTotal} products</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-950/10" role="progressbar" aria-label="Bulk review request in progress" aria-valuetext={`Waiting for confirmation for ${bulkProgressTotal} products`}>
                    <div className="h-full w-2/3 animate-pulse rounded-full bg-blue-600 motion-reduce:animate-none" />
                  </div>
                  <p className="mt-2 text-[10px] text-blue-600/80 dark:text-blue-300/80">Actions remain disabled until the server confirms the complete review request.</p>
                </div>
              )}

              {supplierQueueError && (
                <p role="alert" className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600">
                  {supplierBusinessErrorMessage(supplierQueueError, 'Supplier products could not be loaded.')}
                </p>
              )}

              {supplierReviewLoading && reviewQueue.length === 0 ? (
                <div className="p-12 text-center text-xs font-bold text-slate-400" role="status">Loading products…</div>
              ) : visibleReviewItems.length === 0 ? (
                <div className="p-12 text-center rounded-2xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                  <UserCheck className="h-10 w-10 text-slate-300 mx-auto" />
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-slate-900 dark:text-white">No supplier updates found.</p>
                    <p className="text-xs text-slate-400">Check back later or update products to look for supplier changes.</p>
                  </div>
                </div>
              ) : (
                <>
                <div className="grid gap-3 md:hidden" aria-label="Products awaiting review">
                  {visibleReviewItems.map((item) => {
                    const product = item.productPayload || {};
                    const sellingPrice = Number(product.price ?? item.marketPrice);
                    const safeSellingPrice = Number.isFinite(sellingPrice) ? sellingPrice : 0;
                    const specifications = product.specifications && typeof product.specifications === 'object'
                      ? Object.keys(product.specifications as Record<string, unknown>)
                      : [];
                    const reviewSourceId = String(item.sourceId || item.supplierId || '');
                    const reviewSource = supplierSourceById.get(reviewSourceId);
                    return (
                      <article key={item.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
                        <div className="flex items-start gap-3 p-4">
                          <SupplierImagePreview src={item.imageUrl} alt={item.productName} />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <h4 className="break-words text-sm font-black text-slate-900 dark:text-white">{item.productName}</h4>
                                <p className="mt-1 font-mono text-[9px] text-slate-400">{item.supplierCode}</p>
                              </div>
                              <span className="rounded-lg bg-slate-100 px-2 py-1 text-[9px] font-black text-slate-600 dark:bg-slate-800 dark:text-slate-300">{supplierReviewStatusLabel(item)}</span>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <SupplierConnectionBadge source={reviewSource} isSyncing={sourceIsSyncing(reviewSourceId)} compact />
                              <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[9px] font-black text-blue-600">{supplierReviewChangeLabel(item.comparison)}</span>
                            </div>
                          </div>
                        </div>
                        <dl className="grid grid-cols-2 gap-3 border-y border-slate-100 bg-slate-50/70 p-4 text-[10px] dark:border-slate-800 dark:bg-slate-900/40">
                          <div><dt className="text-slate-400">Price</dt><dd className="font-black text-blue-600">LKR {safeSellingPrice.toLocaleString()}</dd></div>
                          <div><dt className="text-slate-400">Stock</dt><dd className="font-black">{item.stock}</dd></div>
                          <div><dt className="text-slate-400">Brand</dt><dd className="font-bold">{String(product.brand || item.brandMapping?.mappedBrandId || 'Brand needed')}</dd></div>
                          <div><dt className="text-slate-400">Category</dt><dd className="font-bold">{String(product.category || item.categoryMapping?.targetCategoryId || 'Category needed')}</dd></div>
                          <div className="col-span-2"><dt className="text-slate-400">Description</dt><dd className="mt-1 line-clamp-2 text-slate-600 dark:text-slate-300">{String(product.shortDescription || product.description || 'Description needed')}</dd></div>
                          <div><dt className="text-slate-400">Specifications</dt><dd className="font-bold">{specifications.length}</dd></div>
                          <div><dt className="text-slate-400">Detected</dt><dd className="font-bold">{formatSupplierTimestamp(item.createdAt, 'Recently')}</dd></div>
                        </dl>
                        {!item.productValidation?.readyToPublish && <p className="mx-4 mt-3 rounded-xl bg-amber-500/10 p-2 text-[10px] font-bold text-amber-700 dark:text-amber-300">{(item.productValidation?.missingFields || ['Review required']).join(', ')}</p>}
                        {supplierReviewDecisionReady(item) && (
                           <div className="sticky bottom-0 z-10 mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 bg-white/95 p-3 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95 sm:grid-cols-4">
                             <button type="button" onClick={() => openSupplierReviewEditor(item)} disabled={processingChangeId === item.id || bulkAction !== null} className="min-h-11 rounded-xl bg-emerald-600 text-[10px] font-black text-white disabled:opacity-50">{item.queueState === 'conflict' || item.status === 'CONFLICT' ? 'Review & Resolve' : 'Edit'}</button>
                             <button type="button" onClick={() => void handleApproveReviewItem(item, createSupplierReviewDraft(item))} disabled={processingChangeId === item.id || bulkAction !== null || item.productValidation?.readyToPublish === false} className="min-h-11 rounded-xl bg-blue-600 text-[10px] font-black text-white disabled:opacity-50">Approve</button>
                             <button type="button" onClick={() => { setRejectingReviewItem(item); setReviewDecisionAction('reject'); setRejectionReasonDraft(''); }} disabled={processingChangeId === item.id || bulkAction !== null} className="min-h-11 rounded-xl bg-red-600 text-[10px] font-black text-white disabled:opacity-50">Reject</button>
                             {(reviewFilter === 'conflicts' || reviewFilter === 'needs_attention') && <button type="button" onClick={() => { setRejectingReviewItem(item); setReviewDecisionAction('delete'); setRejectionReasonDraft(''); }} disabled={processingChangeId === item.id || bulkAction !== null} className="min-h-11 rounded-xl border border-slate-300 text-[10px] font-black text-slate-600 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300">Dismiss</button>}
                           </div>
                         )}
                        {!supplierReviewDecisionReady(item) && ['Approved', 'Rejected'].includes(item.status) && <div className="p-3"><button type="button" onClick={() => openSupplierReviewHistory(item)} className="min-h-11 w-full rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 text-[10px] font-black text-blue-700 dark:text-blue-300">View decision history</button></div>}
                      </article>
                    );
                  })}
                </div>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead className="sticky top-0 z-10 bg-white dark:bg-[#0d1424]">
                      <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                        <th className="py-3 px-2">
                          <input
                            type="checkbox"
                            aria-label="Select all visible review items"
                            checked={visibleReviewItems.some((item) => item.status === 'Pending' && supplierReviewDecisionReady(item)) && visibleReviewItems.filter((item) => item.status === 'Pending' && supplierReviewDecisionReady(item)).every((item) => selectedReviewIds.includes(item.id))}
                            onChange={toggleAllVisibleReviews}
                            className="h-4 w-4 accent-blue-600"
                          />
                        </th>
                        <th className="py-3 px-3 w-16">Images</th>
                        <th className="py-3 px-4">Product</th>
                        <th className="py-3 px-4">Brand & Category</th>
                        <th className="py-3 px-4">Price & Stock</th>
                        <th className="py-3 px-4">Description & Specifications</th>
                        <th className="py-3 px-4">Supplier & Detection Time</th>
                        <th className="py-3 px-4">Validation Problems</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="sticky right-0 bg-white py-3 px-4 text-right dark:bg-[#0d1424]">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleReviewItems.map((item) => {
                        const sellingPrice = Number(item.productPayload?.price ?? item.marketPrice);
                        const safeSellingPrice = Number.isFinite(sellingPrice) ? sellingPrice : 0;
                        const product = item.productPayload || {};
                        const specifications = product.specifications && typeof product.specifications === 'object'
                          ? Object.entries(product.specifications as Record<string, unknown>)
                          : [];
                        return (
                        <tr key={item.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-900/30">
                          <td className="py-3 px-2">
                            <input
                              type="checkbox"
                              aria-label={`Select ${item.productName}`}
                              checked={selectedReviewIds.includes(item.id)}
                              disabled={item.status !== 'Pending' || !supplierReviewDecisionReady(item) || bulkAction !== null}
                              onChange={() => toggleReviewSelection(item.id)}
                              className="h-4 w-4 accent-blue-600 disabled:opacity-40"
                            />
                          </td>
                          <td className="py-3 px-3">
                            <SupplierImagePreview src={item.imageUrl} alt={item.productName} />
                          </td>
                          <td className="py-3 px-4 font-semibold">
                            {item.productName}
                            <span className="mt-1 block font-mono text-[9px] font-medium text-slate-400">{item.supplierCode}</span>
                          </td>
                          <td className="py-3 px-4 text-[10px]"><strong className="block text-slate-700 dark:text-slate-200">{String(product.brand || item.brandMapping?.mappedBrandId || 'Brand needed')}</strong><span className="mt-1 block text-slate-400">{String(product.category || item.categoryMapping?.targetCategoryId || 'Category needed')}</span></td>
                          <td className="py-3 px-4 text-[10px]"><strong className="block text-blue-600">LKR {safeSellingPrice.toLocaleString()}</strong><span className="mt-1 block text-slate-400">{item.stock} in stock</span></td>
                          <td className="max-w-64 py-3 px-4 text-[10px]"><p className="line-clamp-2 text-slate-600 dark:text-slate-300">{String(product.shortDescription || product.description || 'Description needed')}</p><p className="mt-1 font-bold text-slate-400">{specifications.length} specifications</p></td>
                          <td className="py-3 px-4 text-[10px]"><strong className="block">{item.supplierName || item.sourceId || 'Supplier'}</strong><span className="mt-1 block text-slate-400">{formatSupplierTimestamp(item.createdAt, 'Recently')}</span><span className="mt-2 block"><SupplierConnectionBadge source={supplierSourceById.get(String(item.sourceId || item.supplierId || ''))} isSyncing={sourceIsSyncing(String(item.sourceId || item.supplierId || ''))} compact /></span></td>
                          <td className="py-3 px-4">
                            <p className={item.productValidation?.readyToPublish ? 'text-[10px] font-black text-emerald-600' : 'text-[10px] font-black text-amber-600'}>
                              {item.productValidation?.readyToPublish ? 'No validation problems' : (item.productValidation?.missingFields || ['Review required']).join(', ')}
                            </p>
                          </td>
                          <td className="py-3 px-4">
                            {item.comparison ? <div className="mb-2 flex flex-col items-start gap-1.5">
                                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-extrabold border ${
                                  item.comparison.comparisonStatus === 'NEW_PRODUCT'
                                    ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                                    : item.comparison.comparisonStatus === 'PRICE_CHANGED'
                                    ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                                    : item.comparison.comparisonStatus === 'STOCK_CHANGED'
                                    ? 'bg-orange-500/10 text-orange-500 border-orange-500/20'
                                    : item.comparison.comparisonStatus === 'IMAGE_CHANGED'
                                    ? 'bg-blue-500/10 text-blue-500 border-blue-500/20'
                                    : item.comparison.comparisonStatus === 'DESCRIPTION_CHANGED'
                                    ? 'bg-purple-500/10 text-purple-500 border-purple-500/20'
                                    : item.comparison.comparisonStatus === 'SUPPLIER_OFFER_REMOVED'
                                    ? 'bg-red-500/10 text-red-500 border-red-500/20'
                                    : 'bg-slate-500/10 text-slate-500 border-slate-500/20'
                                }`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${
                                    item.comparison.comparisonStatus === 'NEW_PRODUCT'
                                      ? 'bg-emerald-500'
                                      : item.comparison.comparisonStatus === 'PRICE_CHANGED'
                                      ? 'bg-amber-500'
                                      : item.comparison.comparisonStatus === 'STOCK_CHANGED'
                                      ? 'bg-orange-500'
                                      : item.comparison.comparisonStatus === 'IMAGE_CHANGED'
                                      ? 'bg-blue-500'
                                      : item.comparison.comparisonStatus === 'DESCRIPTION_CHANGED'
                                      ? 'bg-purple-500'
                                      : item.comparison.comparisonStatus === 'SUPPLIER_OFFER_REMOVED'
                                      ? 'bg-red-500'
                                      : 'bg-slate-500'
                                  }`} />
                                  {supplierReviewChangeLabel(item.comparison)}
                                </span>
                                
                                {item.comparison.changedFields.length > 0 && (
                                  <div className="flex flex-wrap gap-1 justify-end max-w-[160px]">
                                    {item.comparison.changedFields.map((field) => (
                                      <span 
                                        key={field} 
                                        className="text-[8px] px-1 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 rounded font-semibold uppercase tracking-wider"
                                      >
                                        {field}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div> : (
                              <span className="text-slate-400 font-bold text-[10px]">Preparing details</span>
                            )}
                            <span className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${item.status === 'CONFLICT' ? 'bg-red-500/10 text-red-500' : 'bg-amber-500/10 text-amber-500'}`}>
                              {supplierReviewStatusLabel(item)}
                            </span>
                            {item.status === 'CONFLICT' && item.approvalConflict?.changedFields?.length ? (
                              <p className="mt-1 max-w-48 text-[9px] font-semibold text-red-500" title={item.approvalConflict.reason}>
                                Changed: {item.approvalConflict.changedFields.join(', ')}
                              </p>
                            ) : null}
                          </td>
                          <td className="sticky right-0 bg-white py-3 px-4 text-right dark:bg-[#0d1424]">
                            {supplierReviewDecisionReady(item) && (
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => openSupplierReviewEditor(item)}
                                  disabled={processingChangeId === item.id || bulkAction !== null}
                                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 text-white font-bold rounded-lg text-[10px] transition-colors flex items-center gap-1 cursor-pointer"
                                >
                                  <Check className="h-3 w-3" />
                                  {item.queueState === 'conflict' || item.status === 'CONFLICT' ? 'Review & Resolve' : 'Edit'}
                                </button>
                                <button
                                  onClick={() => void handleApproveReviewItem(item, createSupplierReviewDraft(item))}
                                  disabled={processingChangeId === item.id || bulkAction !== null || item.productValidation?.readyToPublish === false}
                                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white font-bold rounded-lg text-[10px] transition-colors flex items-center gap-1"
                                >
                                  <Check className="h-3 w-3" /> Approve
                                </button>
                                <button
                                   onClick={() => {
                                     setRejectingReviewItem(item);
                                     setReviewDecisionAction('reject');
                                     setRejectionReasonDraft('');
                                  }}
                                  disabled={processingChangeId === item.id || bulkAction !== null}
                                  className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-slate-700 text-white font-bold rounded-lg text-[10px] transition-colors flex items-center gap-1 cursor-pointer"
                                >
                                   <X className="h-3 w-3" />
                                   Reject
                                 </button>
                                 {(reviewFilter === 'conflicts' || reviewFilter === 'needs_attention') && <button
                                   type="button"
                                   onClick={() => {
                                     setRejectingReviewItem(item);
                                     setReviewDecisionAction('delete');
                                     setRejectionReasonDraft('');
                                   }}
                                   disabled={processingChangeId === item.id || bulkAction !== null}
                                   className="px-3 py-1.5 rounded-lg border border-slate-300 text-[10px] font-bold text-slate-600 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300"
                                 >
                                   Dismiss
                                 </button>}
                               </div>
                             )}
                            {!supplierReviewDecisionReady(item) && ['Approved', 'Rejected'].includes(item.status) && (
                              <button type="button" onClick={() => openSupplierReviewHistory(item)} className="min-h-9 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 text-[10px] font-black text-blue-700 dark:text-blue-300">View history</button>
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                </>
              )}
              {supplierReviewCursor && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={() => void loadSupplierQueueView({ append: true })}
                    disabled={supplierReviewLoading}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-black text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900"
                  >
                    {supplierReviewLoading ? 'Loading…' : 'Load more products'}
                  </button>
                </div>
              )}
            </div>

          </div>
        )}

        {/* Suppliers */}
        {activeSubTab === 'suppliers' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Connected Suppliers</h3>
                <p className="text-[11px] text-slate-400">Manage supplier connections and catalog update schedules.</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-slate-400 font-mono bg-slate-100 dark:bg-slate-800/50 px-2.5 py-1 rounded-lg border border-slate-200/50 dark:border-slate-800">
                  {supplierSources.length || 0} Supplier(s)
                </span>
              </div>
            </div>

            <SupplierManagementDashboard requestApi={requestSupplierApi} refreshKey={operationsRefreshKey} />

            {supplierSources.length === 0 ? (
              <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500"><Globe className="h-8 w-8" aria-hidden="true" /></span>
                <div className="space-y-1">
                  <p className="text-sm font-bold text-slate-900 dark:text-white">No suppliers connected</p>
                  <p className="text-xs text-slate-400">Add your first supplier, test the connection and run the initial sync to begin importing products.</p>
                </div>
                <button type="button" onClick={() => setShowConnectModal(true)} className="mx-auto mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-xs font-extrabold text-white transition-colors hover:bg-emerald-700 sm:w-auto">
                  <Plus className="h-4 w-4" aria-hidden="true" /> Add Supplier
                </button>
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
                        <button type="button" onClick={() => void handleToggleSupplierAutoSync(source)} disabled={savingSettingsSourceId !== null || !supplierHasCompletedInitialSync(source)} title={supplierHasCompletedInitialSync(source) ? 'Enable or disable automatic synchronization' : 'Run Initial Sync before enabling Auto Sync'} className={`font-bold disabled:cursor-not-allowed disabled:opacity-50 ${String(source.settings?.autoSync || source.syncSchedule || 'Off').toLowerCase() === 'off' ? 'text-slate-500' : 'text-emerald-500'}`}>
                          {String(source.settings?.autoSync || source.syncSchedule || 'Off').toLowerCase() === 'off'
                            ? 'Manual Mode'
                            : `Auto · ${String(source.settings?.autoSync || source.syncSchedule)}`}
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
                        <span className="text-slate-700 dark:text-slate-200 font-medium">{formatSupplierTimestamp(source.lastSuccessfulSyncAt || source.lastSuccessfulSync || source.lastSuccess, 'Not updated yet')}</span>
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
                          <button type="button" onClick={() => setActiveSubTab('review')} className="px-3.5 py-1.5 bg-emerald-100 text-emerald-700 font-bold rounded-lg text-[10px]">
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
                                Supplier Portal Account
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
                                Credential profile ID
                              </label>
                              {String(source.connectorType || '').toLowerCase() === 'a2z' ? (
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
                            <span>{savingSettingsSourceId === source.id ? 'Saving...' : 'Save Supplier'}</span>
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Settings keeps business controls available while protecting technical operations. */}
        {activeSubTab === 'settings' && (
          <div className="space-y-6 text-left">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900/20 p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Settings</h3>
                <p className="text-[11px] text-slate-400">Configure business defaults for supplier updates, pricing, catalogue preparation, and review.</p>
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
                <h3 id="supplier-business-settings-title" className="text-sm font-black text-slate-900 dark:text-white">Business Settings</h3>
                <p className="mt-1 text-[11px] text-slate-400">Defaults used by the existing synchronization and review workflow.</p>
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
                  <p className="mt-1 text-[10px] text-slate-400">Choose where supplier categories appear in the Zyro catalog.</p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-[#111928]">
                    <span className="block text-[10px] font-bold text-slate-400">Brand Mapping</span>
                    <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">Brand Registry with Product Review override</strong>
                    <p className="mt-1 text-[10px] text-slate-400">Unknown brands require an administrator decision before approval.</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-[#111928]">
                    <span className="block text-[10px] font-bold text-slate-400">Default Category</span>
                    <strong className="mt-1 block text-xs text-slate-800 dark:text-slate-100">Manual review when no mapping is trusted</strong>
                    <p className="mt-1 text-[10px] text-slate-400">The system never publishes an uncertain category automatically.</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {supplierSources.length > 0 && supplierCategoryOptions.map(({ key, label }) => (
                    <label key={key} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-[#111928]">
                      <span className="truncate font-bold text-slate-700 dark:text-slate-200" title={label}>{label}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                      <select
                        aria-label={`Map supplier category ${label}`}
                        value={supplierSettings.categoryMappings?.[key] || ''}
                        onChange={(event) => setSupplierSettings((current: any) => ({
                          ...current,
                          categoryMappings: {
                            ...(current.categoryMappings || {}),
                            [key]: event.target.value,
                          },
                        }))}
                        className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-xs dark:border-slate-700 dark:bg-slate-900"
                      >
                        <option value="">Select Zyro category</option>
                        {categories.map((category) => (
                          <option key={category.id} value={category.id}>{category.name || category.id}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                  {(supplierSources.length === 0 || supplierCategoryOptions.length === 0) && (
                    <div className="rounded-xl border border-dashed border-slate-200 p-4 text-[11px] text-slate-400 dark:border-slate-800 md:col-span-2">
                      {supplierSources.length === 0
                        ? 'Connect a supplier to configure category mapping.'
                        : 'Update a supplier to discover categories for mapping.'}
                    </div>
                  )}
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
                          <div className="space-y-2 md:col-span-2"><span className="block text-[10px] font-bold text-slate-400">Product page size</span><div className="flex flex-wrap gap-1">{['5', '20', '50', '100', '250', 'All'].map((limit) => <button key={limit} type="button" onClick={() => setEditProductLimit(limit)} className={`rounded-lg px-3 py-1 text-[10px] font-bold ${editProductLimit === limit ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>{limit}</button>)}</div></div>
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
              activeSyncJob={activeSyncJob}
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
          busy={syncingSourceId === String(manualSyncSource.id)}
          onClose={() => setManualSyncSource(null)}
          onSubmit={runManualSupplierSync}
        />
      )}

      {showConnectModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-xl w-full p-6 text-left shadow-2xl flex flex-col space-y-4">
            
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-emerald-500/10 text-emerald-500 rounded-xl">
                  <Plus className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold font-display text-slate-900 dark:text-white">Connect Supplier</h3>
                  <p className="text-[10px] text-slate-400 font-medium">Configure and verify connections to external supplier catalogs</p>
                </div>
              </div>
              <button 
                onClick={() => {
                  setShowConnectModal(false);
                  setModalTestStatus('idle');
                  setModalTestError(null);
                  setModalTestProductsCount(null);
                  testedSupplierConfigurationRef.current = null;
                }}
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full cursor-pointer transition-colors"
              >
                <X className="h-4 w-4" />
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
                  <label className="text-slate-400 font-bold block text-[10px] uppercase">Supplier Name</label>
                  <input 
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
                  <label className="text-slate-400 font-bold block text-[10px] uppercase">Supplier Portal Account</label>
                  <select
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
                  <p className="text-[10px] text-slate-400">This verified account receives fulfilment groups for products from this source.</p>
                </div>

              </div>

              {/* Supplier Type selection */}
              <div className="space-y-1">
                <label className="text-slate-400 font-bold block text-[10px] uppercase">Supplier Type</label>
                <select 
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
                  <option value="website">Generic HTTP JSON Feed</option>
                  <option value="api">REST / JSON Endpoint</option>
                </select>
              </div>

              {/* Dynamic Type Specific Fields */}
              {(newSupplierType === 'website' || newSupplierType === 'a2z') && (
                <div className="space-y-3.5 p-4 rounded-2xl bg-amber-500/5 border border-amber-500/10">
                  <div className="space-y-1">
                    <label className="text-amber-600 dark:text-amber-500 font-black block text-[9px] uppercase tracking-wider">
                      {newSupplierType === 'a2z' ? 'A2Z Base URL' : 'JSON Feed Base URL'}
                    </label>
                    <input 
                      type="url" 
                      required
                      placeholder={newSupplierType === 'a2z' ? 'https://supplier.example.com' : 'https://supplier.example.com/catalog/'}
                      value={newSupplierUrl}
                      onChange={(e) => setNewSupplierUrl(e.target.value)}
                      className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white"
                    />
                  </div>

                  {newSupplierType === 'website' && <div className="space-y-1">
                    <label className="text-amber-600 dark:text-amber-500 font-black block text-[9px] uppercase tracking-wider">Product Endpoint</label>
                    <input 
                      type="text" 
                      required
                      placeholder="/api/products"
                      value={apiEndpoint}
                      onChange={(e) => setApiEndpoint(e.target.value)}
                      className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white font-mono"
                    />
                  </div>}
                  {newSupplierType === 'a2z' && (
                    <div className="space-y-1">
                      <label className="text-amber-600 dark:text-amber-500 font-black block text-[9px] uppercase tracking-wider">
                        Credential profile ID
                      </label>
                      <input
                        type="text"
                        required
                        maxLength={160}
                        pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,159}"
                        placeholder="supplier-profile-id"
                        value={newSupplierCredentialProfile}
                        onChange={(event) => {
                          setNewSupplierCredentialProfile(event.target.value);
                          setModalTestStatus('idle');
                          testedSupplierConfigurationRef.current = null;
                        }}
                        className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white font-mono"
                        aria-describedby="a2z-credential-profile-help"
                      />
                      <p id="a2z-credential-profile-help" className="text-[10px] font-semibold leading-relaxed text-amber-700/80 dark:text-amber-400/80">
                        Enter only the server-configured profile ID. Credentials remain in Firebase Secret Manager and are never sent by this form.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {newSupplierType === 'api' && (
                <div className="space-y-3.5 p-4 rounded-2xl bg-blue-500/5 border border-blue-500/10">
                  <div className="space-y-1">
                    <label className="text-blue-500 font-black block text-[9px] uppercase tracking-wider">REST Endpoint URL</label>
                    <input 
                      type="url" 
                      required
                      placeholder="https://api.distributor.com/v2/catalog"
                      value={apiEndpoint}
                      onChange={(e) => setApiEndpoint(e.target.value)}
                      className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs dark:text-white"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-blue-500 font-black block text-[9px] uppercase tracking-wider">JSON Response Data Path</label>
                    <input 
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
                  onClick={() => {
                    setShowConnectModal(false);
                    setModalTestStatus('idle');
                    setModalTestError(null);
                    setModalTestProductsCount(null);
                  }}
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
                    <span>{savingSupplier ? 'Saving...' : 'Save Supplier'}</span>
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
          offers={supplierOffers}
          offerSelection={supplierOfferSelection}
          offersLoading={supplierOffersLoading}
          offerActionId={supplierOfferActionId}
          offerError={supplierOfferError ? supplierBusinessErrorMessage(supplierOfferError, 'Supplier offers could not be loaded.') : null}
          onRefreshOffers={() => loadSupplierOffers(editingReviewItem)}
          onConfigureOffer={configureSupplierOffer}
          onSelectOffer={selectSupplierOffer}
          onClose={() => {
            if (processingChangeId !== editingReviewItem.id) {
              setEditingReviewItem(null);
              setSupplierOffers([]);
              setSupplierOfferError(null);
            }
          }}
          onPublish={(draft) => handleApproveReviewItem(editingReviewItem, draft)}
        />
      )}

      {historyReviewItem && (
        <SupplierReviewHistoryModal
          item={historyReviewItem}
          events={reviewAuditEvents}
          loading={reviewAuditLoading}
          error={reviewAuditError ? supplierBusinessErrorMessage(reviewAuditError, 'Approval history could not be loaded.') : null}
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
              if (reviewDecisionAction === 'delete') void handleDismissReviewItem(rejectingReviewItem, rejectionReasonDraft);
              else void handleRejectReviewItem(rejectingReviewItem, rejectionReasonDraft);
            }}
          >
            <div>
              <h3 id="supplier-rejection-title" className="text-sm font-extrabold text-slate-900 dark:text-white">{reviewDecisionAction === 'delete' ? 'Dismiss this review' : 'Reject supplier product'}</h3>
              <p className="mt-1 text-xs text-slate-500">{reviewDecisionAction === 'delete' ? 'Dismissal preserves the immutable audit record and does not delete the product or supplier evidence. A later supplier observation may require review again.' : 'Give the supplier a clear reason they can act on.'}</p>
            </div>
            <label className="block text-xs font-bold text-slate-600 dark:text-slate-300">
              {reviewDecisionAction === 'delete' ? 'Dismissal reason' : 'Rejection reason'}
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
              <button type="button" onClick={() => { setRejectingReviewItem(null); setReviewDecisionAction('reject'); setRejectionReasonDraft(''); }} className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">Cancel</button>
              <button type="submit" disabled={!rejectionReasonDraft.trim() || processingChangeId === rejectingReviewItem.id} className="rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">{reviewDecisionAction === 'delete' ? 'Dismiss Review' : 'Reject Product'}</button>
            </div>
          </form>
        </div>
      )}

    </motion.div>
  );
}

export default React.memo(SupplierHubFiveStars);
