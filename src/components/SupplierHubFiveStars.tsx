import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion } from 'motion/react';
import {
  Activity, 
  RefreshCw, 
  UserCheck, 
  PlusCircle, 
  Tag, 
  Boxes, 
  Camera, 
  Info,
  ChevronRight,
  AlertCircle,
  Globe,
  Settings,
  SlidersHorizontal,
  Save,
  Plus,
  X,
  Check,
  TrendingUp,
  User,
  Clock,
  ArrowRight,
  ShieldCheck,
  AlertTriangle,
  Search,
  Sparkles,
  FileText,
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
import { buildSupplierOnboardingSource, SupplierOnboardingType } from '../services/supplierSourceOnboarding';
import { reportSupplierImageFailure } from '../services/supplierImageDiagnostics';
import SupplierReviewEditorModal from './SupplierReviewEditorModal';
import SupplierOperationsDashboard from './supplier-operations/SupplierOperationsDashboard';
import {
  calculateSupplierProfit,
  createSupplierReviewDraft,
  SupplierReviewDraft,
} from '../services/supplierReviewEditor';
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
  selectSupplierSyncJobForDisplay,
  supplierSyncJobStateLabel,
  SupplierSyncJobView,
} from '../services/supplierSyncJobs';
import {
  matchesProductChangeFilter,
  matchesProductReviewFilter,
  PRODUCT_REVIEW_FILTERS,
  ProductReviewFilter,
  supplierHealthLabel,
  SupplierHubSection,
  supplierReviewApiState,
} from '../services/supplierHubPresentation';

interface SupplierHubFiveStarsProps {
  isDarkMode?: boolean;
}

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
}

type SupplierQueueView = 'review' | 'import' | 'changes';

interface SupplierQueuePageResponse {
  success?: boolean;
  view?: SupplierQueueView;
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
  const [importQueue, setImportQueue] = useState<any[]>([]);
  const [supplierQueueCursors, setSupplierQueueCursors] = useState<Record<SupplierQueueView, string | null>>({
    review: null,
    import: null,
    changes: null,
  });
  const [supplierQueueLoading, setSupplierQueueLoading] = useState<Record<SupplierQueueView, boolean>>({
    review: false,
    import: false,
    changes: false,
  });
  const [supplierQueueError, setSupplierQueueError] = useState<string | null>(null);
  const supplierQueueRequestIdRef = useRef<Record<SupplierQueueView, number>>({ review: 0, import: 0, changes: 0 });
  
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
  const [reviewFilter, setReviewFilter] = useState<ProductReviewFilter>('new_products');
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [reviewSearch, setReviewSearch] = useState<string>('');
  const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<'approve' | 'reject' | 'delete' | null>(null);

  // 1. Supplier Sources & Connect states
  const [supplierSources, setSupplierSources] = useState<any[]>([]);
  const [showConnectModal, setShowConnectModal] = useState<boolean>(false);
  const [wizardStep, setWizardStep] = useState<number>(1);
  const [newSupplierName, setNewSupplierName] = useState<string>("");
  const [newSupplierType, setNewSupplierType] = useState<SupplierOnboardingType>("a2z");
  const [newSupplierCode, setNewSupplierCode] = useState<string>("");
  const [newSupplierDesc, setNewSupplierDesc] = useState<string>("");
  
  // Website specific
  const [newSupplierUrl, setNewSupplierUrl] = useState<string>("");
  const [cssPriceSelector, setCssPriceSelector] = useState<string>(".product-price");
  const [cssStockSelector, setCssStockSelector] = useState<string>(".instock-status");
  const [cssImageSelector, setCssImageSelector] = useState<string>(".product-image img");

  // API specific
  const [apiEndpoint, setApiEndpoint] = useState<string>("");
  const [apiMethod, setApiMethod] = useState<string>("GET");
  const [apiDataPath, setApiDataPath] = useState<string>("products");

  const [savingSupplier, setSavingSupplier] = useState<boolean>(false);
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null);
  
  // Connection Testing states
  const [testingSourceId, setTestingSourceId] = useState<string | null>(null);
  const [modalTestStatus, setModalTestStatus] = useState<'idle' | 'testing' | 'Connected' | 'Failed'>('idle');
  const [modalTestError, setModalTestError] = useState<string | null>(null);
  const [modalTestProductsCount, setModalTestProductsCount] = useState<number | null>(null);

  // Supplier source definitions are deliberately projected by Functions. This
  // keeps legacy credential fields out of every browser response.
  const loadSources = useCallback(async () => {
    const [response, jobsResponse] = await Promise.all([
      getSupplierApi('/api/supplier-sources'),
      getSupplierApi('/api/supplier-sync/jobs?limit=20'),
    ]);
    const result = await response.json().catch(() => ({})) as { success?: boolean; sources?: any[]; error?: string };
    const jobsResult = await jobsResponse.json().catch(() => ({})) as { success?: boolean; jobs?: SupplierSyncJobView[] };
    if (!response.ok || result.success !== true || !Array.isArray(result.sources)) {
      throw new Error(result.error || 'Supplier sources could not be loaded.');
    }
    setSupplierSources(result.sources.map(normalizeSupplierSourceForUi));
    if (jobsResponse.ok && jobsResult.success === true && Array.isArray(jobsResult.jobs)) {
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
      if (currentUser) void loadSources().catch((error) => {
        if (!cancelled) handleFirestoreError(error, OperationType.GET, 'supplierSources API');
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
    if (!['review', 'suppliers'].includes(activeSubTab)) return;
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
    if (!['review', 'suppliers'].includes(activeSubTab)) return;
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
    () => visibleReviewItems.filter((item) => item.status === 'Pending' && selectedReviewIds.includes(item.id)),
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
    importQueue.forEach((item) => addCategories(item.categoryHierarchy));
    supplierSources.forEach((source) => addCategories(source.settings?.discoveredCategories));
    return Array.from(values.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [importQueue, reviewQueue, supplierSources]);

  useEffect(() => {
    const pendingIds = new Set(reviewQueue.filter((item) => item.status === 'Pending').map((item) => item.id));
    setSelectedReviewIds((current) => current.filter((id) => pendingIds.has(id)));
  }, [reviewQueue]);

  // Supplier Settings Engine state
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editSupplierName, setEditSupplierName] = useState<string>('');
  const [editWebsiteUrl, setEditWebsiteUrl] = useState<string>('');
  const [editEndpoint, setEditEndpoint] = useState<string>('');
  const [editIsEnabled, setEditIsEnabled] = useState<boolean>(true);
  
  // Sync settings
  const [editCategoriesFilter, setEditCategoriesFilter] = useState<string[]>([]);
  const [editBrandFilter, setEditBrandFilter] = useState<string>('');
  const [editProductLimit, setEditProductLimit] = useState<string>('All');
  
  // Sync mode flags
  const [editSyncNewProducts, setEditSyncNewProducts] = useState<boolean>(true);
  const [editSyncPriceUpdates, setEditSyncPriceUpdates] = useState<boolean>(true);
  const [editSyncStockUpdates, setEditSyncStockUpdates] = useState<boolean>(true);
  const [editSyncDescriptionUpdates, setEditSyncDescriptionUpdates] = useState<boolean>(true);
  const [editSyncImageUpdates, setEditSyncImageUpdates] = useState<boolean>(true);
  
  // Auto sync and dry run
  const [editAutoSync, setEditAutoSync] = useState<string>('Off');
  const [editDryRunMode, setEditDryRunMode] = useState<boolean>(false);
  
  const [savingSettingsSourceId, setSavingSettingsSourceId] = useState<string | null>(null);

  // 2. Pending Changes states
  const [supplierPendingChanges, setSupplierPendingChanges] = useState<any[]>([]);
  const [processingChangeId, setProcessingChangeId] = useState<string | null>(null);
  const [comparingChange, setComparingChange] = useState<any | null>(null);
  const [editingReviewItem, setEditingReviewItem] = useState<ReviewQueueItem | null>(null);
  const [supplierOffers, setSupplierOffers] = useState<SupplierOfferView[]>([]);
  const [supplierOfferSelection, setSupplierOfferSelection] = useState<SupplierOfferSelectionView>({ activeOfferId: null, lockedOfferId: null, failoverEnabled: true });
  const [supplierOffersLoading, setSupplierOffersLoading] = useState(false);
  const [supplierOfferActionId, setSupplierOfferActionId] = useState<string | null>(null);
  const [supplierOfferError, setSupplierOfferError] = useState<string | null>(null);
  const [rejectingReviewItem, setRejectingReviewItem] = useState<ReviewQueueItem | null>(null);
  const [rejectionReasonDraft, setRejectionReasonDraft] = useState('');
  const visibleProductChanges = useMemo(() => supplierPendingChanges.filter((change) => (
    matchesProductChangeFilter(change, reviewFilter) && matchesSupplierSearch(change, reviewSearch)
  )), [reviewFilter, reviewSearch, supplierPendingChanges]);
  const productsBeingPrepared = useMemo(() => importQueue.filter((item) => matchesSupplierSearch(item, reviewSearch)), [importQueue, reviewSearch]);

  // 3. Settings states
  const [supplierSettings, setSupplierSettings] = useState<any>({
    websiteSyncEnabled: true,
    autoSyncEnabled: true,
    syncInterval: "1 Hour",
    maxProducts: 5,
    enabledSupplierIds: [],
    enabledSupplierIdsConfigured: false,
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
  const [showResetSettingsConfirm, setShowResetSettingsConfirm] = useState<boolean>(false);

  const generateSlug = (name: string): string => {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') 
      .replace(/[\s_]+/g, '-')   
      .replace(/-+/g, '-')      
      .replace(/^-+|-+$/g, '');  
  };

  const toDateTimeLocalValue = (value?: string): string => {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    const timezoneOffsetMs = parsed.getTimezoneOffset() * 60000;
    return new Date(parsed.getTime() - timezoneOffsetMs).toISOString().slice(0, 16);
  };

  const loadSupplierQueueView = async (
    view: SupplierQueueView,
    options: { append?: boolean; after?: string | null; reviewState?: 'active' | 'conflict' | 'approved' } = {},
  ): Promise<void> => {
    const append = options.append === true;
    const after = options.after === undefined ? (append ? supplierQueueCursors[view] : null) : options.after;
    if (append && !after) return;
    const requestId = ++supplierQueueRequestIdRef.current[view];
    setSupplierQueueLoading((current) => ({ ...current, [view]: true }));
    try {
      const parameters = new URLSearchParams({ view, limit: '50' });
      if (view === 'review') parameters.set('state', options.reviewState || supplierReviewApiState(reviewFilter));
      if (after) parameters.set('after', after);
      const response = await getSupplierApi(`/api/supplier-review-queue?${parameters.toString()}`);
      const result = await response.json().catch(() => ({})) as SupplierQueuePageResponse;
      if (!response.ok || result.success !== true || !Array.isArray(result.items)) {
        throw new Error(result.error || 'Supplier products could not be loaded.');
      }
      if (requestId !== supplierQueueRequestIdRef.current[view]) return;
      if (view === 'review') {
        const items = result.items as unknown as ReviewQueueItem[];
        setReviewQueue((current) => append ? mergeSupplierQueuePage(current, items) : items);
      } else if (view === 'import') {
        setImportQueue((current: any[]) => append ? mergeSupplierQueuePage(current, result.items as any[]) : result.items);
      } else {
        setSupplierPendingChanges((current: any[]) => append ? mergeSupplierQueuePage(current, result.items as any[]) : result.items);
      }
      setSupplierQueueCursors((current) => ({ ...current, [view]: result.nextCursor || null }));
      setSupplierQueueError(null);
    } catch (error) {
      if (requestId === supplierQueueRequestIdRef.current[view]) {
        setSupplierQueueError(error instanceof Error ? error.message : 'Supplier products could not be loaded.');
      }
    } finally {
      if (requestId === supplierQueueRequestIdRef.current[view]) {
        setSupplierQueueLoading((current) => ({ ...current, [view]: false }));
      }
    }
  };

  const refreshSupplierQueueViews = async (): Promise<void> => {
    const views: SupplierQueueView[] = ['review', 'changes'];
    if (reviewFilter === 'needs_attention') views.push('import');
    await Promise.all(views.map((view) => loadSupplierQueueView(view)));
  };

  useEffect(() => onIdTokenChanged(auth, (currentUser) => {
    if (currentUser) void Promise.all([loadSupplierQueueView('review'), loadSupplierQueueView('changes')]);
  }), []);

  useEffect(() => {
    if (activeSubTab !== 'review' || !auth.currentUser) return;
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
      setSyncStatusMsg(`${supplierSyncJobStateLabel(result.job.state)} · ${result.job.progress.percent}%`);
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

  const handleSyncSupplier = useCallback(async (sourceIds?: string[]): Promise<boolean> => {
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
      const response = await postSupplierApi('/api/supplier-sync', sourceIds?.length ? { sourceIds } : {});
      const result = await response.json().catch(() => ({})) as {
        success?: boolean;
        accepted?: boolean;
        job?: SupplierSyncJobView;
        jobId?: string;
        status?: string;
        error?: string;
      };
      if (!response.ok || result.success !== true || result.accepted !== true || !result.job) {
        throw new Error(result.error || 'Supplier synchronization could not be completed.');
      }
      applyActiveSyncJob(result.job);
      setSyncStatusMsg('Supplier product update started.');
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
      supplierType: newSupplierType,
      description: newSupplierDesc,
      websiteUrl: newSupplierUrl,
      endpoint: apiEndpoint,
      apiMethod,
      apiDataPath,
      cssPriceSelector,
      cssStockSelector,
      cssImageSelector,
      connectionStatus,
      lastError: modalTestError,
    });
  };

  const handleModalTestConnection = async () => {
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

    try {
      const response = await postSupplierApi('/api/test-supplier', {
        id: newSupplierCode.trim() || generateSlug(newSupplierName),
        source: buildNewSupplierSource('Not Synced'),
      });

      const result = await response.json();

      if (result.success) {
        setModalTestStatus('Connected');
        setModalTestProductsCount(result.productsCount);
      } else {
        setModalTestStatus('Failed');
        setModalTestError(result.error || "The endpoint did not respond successfully.");
      }
    } catch (err: any) {
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
    
    // Generate code if empty
    const code = newSupplierCode.trim() || generateSlug(newSupplierName);
    setSavingSupplier(true);

    const newSource = buildNewSupplierSource();

    try {
      const response = await postSupplierApi('/api/supplier-sources', {
        id: code,
        source: newSource,
        testConnection: modalTestStatus === 'Connected',
      });
      const result = await response.json().catch(() => ({})) as {
        success?: boolean;
        source?: Record<string, any> & { id: string };
        connectionTest?: { success?: boolean; error?: string };
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
      setWizardStep(1);
      setNewSupplierName("");
      setNewSupplierCode("");
      setNewSupplierDesc("");
      setNewSupplierType("a2z");
      setNewSupplierUrl("");
      setCssPriceSelector(".product-price");
      setCssStockSelector(".instock-status");
      setCssImageSelector(".product-image img");
      setApiEndpoint("");
      setApiMethod("GET");
      setApiDataPath("products");
      
      setModalTestStatus('idle');
      setModalTestError(null);
      setModalTestProductsCount(null);
      
      setShowConnectModal(false);
      if (result.connectionTest?.success === false) {
        setErrorMsg(`Supplier "${newSupplierName}" was saved, but the server connection test failed: ${result.connectionTest.error || 'Unknown error'}`);
        setTimeout(() => setErrorMsg(null), 5000);
      } else {
        setSuccessMsg(`Supplier "${newSupplierName}" successfully connected to "supplierSources"!`);
      }
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

  const handleTriggerSync = async (id: string) => {
    setSyncingSourceId(id);
    setSuccessMsg('Checking this supplier for catalog updates...');
    try {
      const succeeded = await handleSyncSupplier([id]);
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
  };

  const handleOpenSettings = (source: any) => {
    setEditingSourceId(source.id === editingSourceId ? null : source.id);
    
    // Initialize form fields from current source values
    setEditSupplierName(source.supplierName || source.name || '');
    setEditWebsiteUrl(source.websiteUrl || '');
    setEditEndpoint(source.endpoint || '');
    setEditIsEnabled(source.sourceStatus !== 'inactive');
    
    // Initialize sync settings (fall back to defaults if not set)
    const currentSettings = source.settings || {};
    setEditCategoriesFilter(currentSettings.categoriesFilter || []);
    setEditBrandFilter(currentSettings.brandFilter || '');
    setEditProductLimit(currentSettings.productLimit || 'All');
    
    setEditSyncNewProducts(currentSettings.syncNewProducts !== false); // default to true
    setEditSyncPriceUpdates(currentSettings.syncPriceUpdates !== false); // default to true
    setEditSyncStockUpdates(currentSettings.syncStockUpdates !== false); // default to true
    setEditSyncDescriptionUpdates(currentSettings.syncDescriptionUpdates !== false); // default to true
    setEditSyncImageUpdates(currentSettings.syncImageUpdates !== false); // default to true
    
    setEditAutoSync(currentSettings.autoSync || 'Off');
    setEditDryRunMode(currentSettings.dryRunMode === true); // default to false
  };

  const handleSaveSettings = async (sourceId: string) => {
    setSavingSettingsSourceId(sourceId);
    try {
      if (!editSupplierName.trim()) throw new Error('Supplier name is required.');
      let supplierUrl: URL;
      try {
        supplierUrl = new URL(editWebsiteUrl.trim());
      } catch {
        throw new Error('Enter a valid supplier website URL.');
      }
      if (!['http:', 'https:'].includes(supplierUrl.protocol)) {
        throw new Error('Supplier website URL must use HTTP or HTTPS.');
      }

      const updatedData = {
        supplierName: editSupplierName.trim(),
        name: editSupplierName.trim(), // for backwards compatibility
        websiteUrl: editWebsiteUrl.trim(),
        endpoint: editEndpoint.trim(),
        sourceStatus: editIsEnabled ? 'active' : 'inactive',
        
        settings: {
          categoriesFilter: editCategoriesFilter,
          brandFilter: editBrandFilter.trim(),
          productLimit: editProductLimit,
          syncNewProducts: editSyncNewProducts,
          syncPriceUpdates: editSyncPriceUpdates,
          syncStockUpdates: editSyncStockUpdates,
          syncDescriptionUpdates: editSyncDescriptionUpdates,
          syncImageUpdates: editSyncImageUpdates,
          autoSync: editAutoSync,
          dryRunMode: editDryRunMode
        }
      };
      
      const response = await patchSupplierApi(`/api/supplier-sources/${encodeURIComponent(sourceId)}`, { source: updatedData });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Supplier source could not be updated.');
      setSupplierSources((current) => current.map((source) => source.id === sourceId
        ? normalizeSupplierSourceForUi({
            ...source,
            ...updatedData,
            enabled: editIsEnabled,
            settings: { ...(source.settings || {}), ...updatedData.settings },
          })
        : source));
      setErrorMsg(null);

      setSuccessMsg("Supplier settings successfully saved and persisted!");
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

  // --- PENDING CHANGES HANDLERS ---
  const handleApprovePendingChange = async (change: any) => {
    setProcessingChangeId(change.id);
    try {
      const result = await decideSupplierReviewQueueItem(change.id, 'approve', {
        resolveConflict: change.queueState === 'conflict' || change.status === 'CONFLICT',
      });
      if (result.success !== true && result.status === 'conflict') {
        setProcessingChangeId(null);
        setErrorMsg(result.error || 'The live product changed. Review the conflict before publishing.');
        setTimeout(() => setErrorMsg(null), 6000);
        return;
      }

      setProcessingChangeId(null);
      void refreshSupplierQueueViews();
      setSuccessMsg(`Change for "${change.productName}" approved successfully.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      console.error("Approval error:", error);
      setErrorMsg(`Failed to approve: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 4000);
      setProcessingChangeId(null);
    }
  };

  const handleRejectPendingChange = async (change: any) => {
    setProcessingChangeId(change.id);
    try {
      await decideSupplierReviewQueueItem(change.id, 'reject', { rejectionReason: 'Change rejected by admin.' });
      setProcessingChangeId(null);
      void refreshSupplierQueueViews();
      setSuccessMsg(`Change for "${change.productName}" rejected.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      console.error("Reject pending change error:", error);
      setErrorMsg(`Failed to reject: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 4000);
      setProcessingChangeId(null);
    }
  };

  // --- REVIEW QUEUE APPROVAL HANDLERS ---
  const handleApproveReviewItem = async (item: ReviewQueueItem, draft: SupplierReviewDraft) => {
    setProcessingChangeId(item.id);
    try {
      const result = await decideSupplierReviewQueueItem(item.id, 'approve', {
        draft,
        resolveConflict: item.queueState === 'conflict' || item.status === 'CONFLICT',
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
      await decideSupplierReviewQueueItem(item.id, 'reject', { rejectionReason: rejectionReason.trim() });
      setProcessingChangeId(null);
      setRejectingReviewItem(null);
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
    const visiblePendingIds = visibleReviewItems.filter((item) => item.status === 'Pending').map((item) => item.id);
    const allSelected = visiblePendingIds.length > 0 && visiblePendingIds.every((id) => selectedReviewIds.includes(id));
    setSelectedReviewIds((current) => allSelected
      ? current.filter((id) => !visiblePendingIds.includes(id))
      : Array.from(new Set([...current, ...visiblePendingIds])));
  };

  const handleBulkApproveReviews = async () => {
    if (selectedReviewItems.length === 0) return;
    setBulkAction('approve');
    setErrorMsg(null);
    try {
      const approvals = selectedReviewItems.map((item) => ({
        queueItemId: item.id,
        draft: createSupplierReviewDraft(item),
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
    }
  };

  const handleBulkRejectReviews = async () => {
    if (selectedReviewItems.length === 0) return;
    setBulkAction('reject');
    setErrorMsg(null);
    try {
      const response = await postSupplierApi('/api/supplier-review-queue/bulk-reject', {
        queueItemIds: selectedReviewItems.map((item) => item.id),
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
    }
  };

  const handleBulkDeleteReviews = async () => {
    if (selectedReviewItems.length === 0) return;
    setBulkAction('delete');
    setErrorMsg(null);
    try {
      for (const item of selectedReviewItems) {
        await decideSupplierReviewQueueItem(item.id, 'delete', { deletionReason: 'Bulk deleted by admin.' });
      }
      setSelectedReviewIds([]);
      void refreshSupplierQueueViews();
      setSuccessMsg(`${selectedReviewItems.length} products removed from review.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      setErrorMsg(`Bulk delete stopped: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 5000);
    } finally {
      setBulkAction(null);
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
        ...supplierSettings,
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
        websiteSyncEnabled: payload.websiteSyncEnabled !== false,
        autoSyncEnabled: payload.autoSyncEnabled !== false,
        syncInterval: payload.syncInterval,
        maxProducts: payload.maxProducts,
        enabledSupplierIds: payload.enabledSupplierIds,
        enabledSupplierIdsConfigured: payload.enabledSupplierIdsConfigured === true,
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

  const handleResetSettings = async () => {
    const defaults = {
      websiteSyncEnabled: false,
      autoSyncEnabled: true,
      syncInterval: "1 Hour",
      maxProducts: 5,
      enabledSupplierIds: [],
      enabledSupplierIdsConfigured: false,
      lastSync: "",
      nextSync: "",
      defaultProfitMargin: 15,
      defaultMarkup: 10,
      defaultImageLimit: 5,
      categoryMappings: {},
      lastUpdated: new Date().toISOString(),
      updatedBy: "System Default"
    };

    try {
      pendingSupplierSettingsRef.current = {
        websiteSyncEnabled: defaults.websiteSyncEnabled,
        autoSyncEnabled: defaults.autoSyncEnabled,
        syncInterval: defaults.syncInterval,
        maxProducts: defaults.maxProducts,
        enabledSupplierIds: defaults.enabledSupplierIds,
        enabledSupplierIdsConfigured: defaults.enabledSupplierIdsConfigured,
        defaultProfitMargin: defaults.defaultProfitMargin,
        defaultMarkup: defaults.defaultMarkup,
        defaultImageLimit: defaults.defaultImageLimit,
        categoryMappings: defaults.categoryMappings,
      };
      const response = await postSupplierApi('/api/supplier-settings', { settings: defaults });
      const result = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) throw new Error(result.error || 'Supplier Hub settings could not be reset.');
      setSupplierSettings(defaults);
      setShowResetSettingsConfirm(false);
      setSuccessMsg("Supplier Hub control settings reset to system defaults.");
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      pendingSupplierSettingsRef.current = null;
      console.error("Reset supplier settings failed:", error);
      setErrorMsg(error.message || "Failed to reset supplier settings.");
      setTimeout(() => setErrorMsg(null), 4000);
    }
  };

  const handleSupplierPauseAction = async (source: any) => {
    const isPaused = String(source.sourceStatus || source.status || '').toLowerCase() === 'paused';
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

  const visibleErrorMsg = errorMsg || syncErrorMsg;

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
          {activeSubTab === 'review' ? (
            <button
              onClick={() => handleSyncSupplier()}
              disabled={isSyncing}
              className="w-full sm:w-auto px-5 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white font-extrabold rounded-xl text-xs transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center space-x-2 cursor-pointer"
            >
              <RefreshCw className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Updating...' : 'Update Products'}</span>
            </button>
          ) : activeSubTab === 'suppliers' ? (
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
                {isSupplierSyncJobActive(activeSyncJob) && activeSyncJob.progress.percent <= 0 && activeSyncJob.progress.pagesProcessed > 0
                  ? 'In progress · '
                  : activeSyncJob.progress.percent > 0 ? `${activeSyncJob.progress.percent}% · ` : ''}
                {activeSyncJob.progress.productsScanned} products checked · {activeSyncJob.progress.productsQueued} changes found
                {isSupplierSyncJobActive(activeSyncJob) ? ` · ${formatSupplierSyncEta(activeSyncJob.progress.etaMs)}` : ''}
              </p>
              {activeSyncJob.state === 'waiting' && activeSyncJob.waitingReason ? (
                <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                  Supplier update is waiting to continue.
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {['pending', 'running', 'waiting'].includes(activeSyncJob.state) && (
                <button
                  type="button"
                  onClick={() => handleSyncJobAction('cancel')}
                  disabled={syncJobAction !== null || activeSyncJob.cancellationRequestedAt != null}
                  className="min-h-10 rounded-xl border border-rose-200 px-3 text-[11px] font-bold text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-900/60 dark:hover:bg-rose-950/30"
                >
                  {activeSyncJob.cancellationRequestedAt ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
              {(activeSyncJob.state === 'waiting' || activeSyncJob.state === 'cancelled') && (
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
            aria-valuenow={activeSyncJob.progress.percent}
            aria-valuetext={formatSupplierSyncProgress(activeSyncJob)}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-600 to-cyan-500 transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${Math.max(0, Math.min(100, activeSyncJob.progress.percent))}%` }}
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
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-1.5 overflow-x-auto">
        {[
          { id: 'suppliers', label: 'Suppliers', badge: supplierSources.length, icon: Globe },
          { id: 'review', label: 'Product Review', badge: reviewQueue.length + supplierPendingChanges.filter(c => c.status === 'Pending').length, icon: UserCheck, badgeColor: 'bg-blue-500 text-white' },
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

        {activeSubTab === 'activity' && (
          <SupplierOperationsDashboard
            requestApi={requestSupplierApi}
            activeSyncJob={activeSyncJob}
            refreshKey={operationsRefreshKey}
          />
        )}

        {/* VIEW 1: REVIEW QUEUE & INGESTION (Existing view) */}
        {activeSubTab === 'review' && (
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
                    placeholder="Search products or supplier codes..."
                    aria-label="Search products awaiting review"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-xs focus:outline-none dark:border-slate-800 dark:bg-slate-900/50"
                  />
                </div>
              </div>
              <div className="mt-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Product review filters">
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
            {/* Review Queue Table card */}
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

              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/30">
                <span className="mr-auto text-[11px] font-bold text-slate-500">
                  {selectedReviewItems.length} selected
                </span>
                <button type="button" onClick={handleBulkApproveReviews} disabled={selectedReviewItems.length === 0 || bulkAction !== null} className="rounded-lg bg-emerald-600 px-3 py-2 text-[10px] font-black text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                  {bulkAction === 'approve' ? 'Approving...' : 'Bulk Approve'}
                </button>
                <button type="button" onClick={handleBulkRejectReviews} disabled={selectedReviewItems.length === 0 || bulkAction !== null} className="rounded-lg bg-amber-600 px-3 py-2 text-[10px] font-black text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                  {bulkAction === 'reject' ? 'Rejecting...' : 'Bulk Reject'}
                </button>
                <button type="button" onClick={handleBulkDeleteReviews} disabled={selectedReviewItems.length === 0 || bulkAction !== null} className="flex items-center gap-1 rounded-lg bg-red-600 px-3 py-2 text-[10px] font-black text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                  <Trash2 className="h-3 w-3" />{bulkAction === 'delete' ? 'Deleting...' : 'Bulk Delete'}
                </button>
              </div>

              {supplierQueueError && (
                <p role="alert" className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-600">
                  {supplierQueueError}
                </p>
              )}

              {supplierQueueLoading.review && reviewQueue.length === 0 ? (
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
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                        <th className="py-3 px-2">
                          <input
                            type="checkbox"
                            aria-label="Select all visible review items"
                            checked={visibleReviewItems.some((item) => item.status === 'Pending') && visibleReviewItems.filter((item) => item.status === 'Pending').every((item) => selectedReviewIds.includes(item.id))}
                            onChange={toggleAllVisibleReviews}
                            className="h-4 w-4 accent-blue-600"
                          />
                        </th>
                        <th className="py-3 px-3 w-16">Thumbnail</th>
                        <th className="py-3 px-4">Product Code</th>
                        <th className="py-3 px-4">Product Name</th>
                        <th className="py-3 px-3 text-right">Supplier Price</th>
                        <th className="py-3 px-3 text-right">Selling Price</th>
                        <th className="py-3 px-3 text-right">Profit</th>
                        <th className="py-3 px-3 text-right">Margin</th>
                        <th className="py-3 px-4 text-right">Stock</th>
                        <th className="py-3 px-4">Catalog readiness</th>
                        <th className="py-3 px-4 text-right">Changes</th>
                        <th className="py-3 px-4 text-right">Status</th>
                        <th className="py-3 px-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleReviewItems.map((item) => {
                        const sellingPrice = Number(item.productPayload?.price ?? item.marketPrice);
                        const safeSellingPrice = Number.isFinite(sellingPrice) ? sellingPrice : 0;
                        const metrics = calculateSupplierProfit(safeSellingPrice, item.costPrice);
                        return (
                        <tr key={item.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-900/30">
                          <td className="py-3 px-2">
                            <input
                              type="checkbox"
                              aria-label={`Select ${item.productName}`}
                              checked={selectedReviewIds.includes(item.id)}
                              disabled={item.status !== 'Pending' || bulkAction !== null}
                              onChange={() => toggleReviewSelection(item.id)}
                              className="h-4 w-4 accent-blue-600 disabled:opacity-40"
                            />
                          </td>
                          <td className="py-3 px-3">
                            <SupplierImagePreview src={item.imageUrl} alt={item.productName} />
                          </td>
                          <td className="py-3 px-4 font-mono font-medium">{item.supplierCode}</td>
                          <td className="py-3 px-4 font-semibold">{item.productName}</td>
                          <td className="py-3 px-3 text-right font-bold text-slate-900 dark:text-white">
                            LKR {item.costPrice.toLocaleString()}
                          </td>
                          <td className="py-3 px-3 text-right font-bold text-blue-600 dark:text-blue-400">
                            LKR {safeSellingPrice.toLocaleString()}
                          </td>
                          <td className={`py-3 px-3 text-right font-bold ${metrics.profit >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                            LKR {metrics.profit.toLocaleString()}
                          </td>
                          <td className={`py-3 px-3 text-right font-bold ${metrics.marginPercent >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                            {metrics.marginPercent.toFixed(2)}%
                          </td>
                          <td className="py-3 px-4 text-right font-semibold text-slate-600 dark:text-slate-400">
                            {item.stock} units
                          </td>
                          <td className="py-3 px-4">
                            <div className="min-w-44 space-y-1 text-[9px]">
                              <p><span className="font-black uppercase text-slate-400">Supplier category:</span> {item.categoryMapping?.supplierCategory || 'Not supplied'}</p>
                              <p><span className="font-black uppercase text-slate-400">Suggested:</span> {item.categoryMapping?.targetCategoryId || 'Manual selection'} ({Math.round(Number(item.categoryMapping?.confidence || 0))}%)</p>
                              <p><span className="font-black uppercase text-slate-400">Brand:</span> {item.brandMapping?.mappedBrandId || 'Manual selection'}</p>
                              <p className={item.productValidation?.readyToPublish ? 'font-black text-emerald-600' : 'font-black text-amber-600'}>
                                {item.productValidation?.readyToPublish ? 'Ready to publish' : `Missing: ${(item.productValidation?.missingFields || ['Review required']).join(', ')}`}
                              </p>
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right">
                            {item.comparison ? (
                              <div className="flex flex-col items-end gap-1.5">
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
                                  {item.comparison.comparisonStatus === 'NEW_PRODUCT' && 'NEW'}
                                  {item.comparison.comparisonStatus === 'PRICE_CHANGED' && 'PRICE CHANGED'}
                                  {item.comparison.comparisonStatus === 'STOCK_CHANGED' && 'STOCK CHANGED'}
                                  {item.comparison.comparisonStatus === 'IMAGE_CHANGED' && 'IMAGE CHANGED'}
                                  {item.comparison.comparisonStatus === 'DESCRIPTION_CHANGED' && 'DESC CHANGED'}
                                  {item.comparison.comparisonStatus === 'SUPPLIER_OFFER_REMOVED' && 'REMOVED'}
                                  {item.comparison.comparisonStatus === 'UNCHANGED' && 'UNCHANGED'}
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
                              </div>
                            ) : (
                              <span className="text-slate-400 font-bold text-[10px]">Preparing details</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <span className={`px-2.5 py-1 rounded-md text-[11px] font-bold ${item.status === 'CONFLICT' ? 'bg-red-500/10 text-red-500' : 'bg-amber-500/10 text-amber-500'}`}>
                              {item.status}
                            </span>
                            {item.status === 'CONFLICT' && item.approvalConflict?.changedFields?.length ? (
                              <p className="mt-1 max-w-48 text-[9px] font-semibold text-red-500" title={item.approvalConflict.reason}>
                                Changed: {item.approvalConflict.changedFields.join(', ')}
                              </p>
                            ) : null}
                          </td>
                          <td className="py-3 px-4 text-right">
                            {(item.status === 'Pending' || item.status === 'CONFLICT') && (
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => openSupplierReviewEditor(item)}
                                  disabled={processingChangeId === item.id}
                                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 text-white font-bold rounded-lg text-[10px] transition-colors flex items-center gap-1 cursor-pointer"
                                >
                                  <Check className="h-3 w-3" />
                                  {item.status === 'CONFLICT' ? 'Review Conflict' : 'Edit & Publish'}
                                </button>
                                <button
                                  onClick={() => {
                                    setRejectingReviewItem(item);
                                    setRejectionReasonDraft('');
                                  }}
                                  disabled={processingChangeId === item.id}
                                  className="px-3 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-slate-700 text-white font-bold rounded-lg text-[10px] transition-colors flex items-center gap-1 cursor-pointer"
                                >
                                  <X className="h-3 w-3" />
                                  Reject
                                </button>
                              </div>
                            )}
                            {item.status === 'Approved' && (
                              <span className="text-emerald-500 font-bold text-[10px]">Approved</span>
                            )}
                            {item.status === 'Rejected' && (
                              <span className="text-red-500 font-bold text-[10px]">Rejected</span>
                            )}
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {supplierQueueCursors.review && (
                <div className="mt-4 flex justify-center">
                  <button
                    type="button"
                    onClick={() => void loadSupplierQueueView('review', { append: true })}
                    disabled={supplierQueueLoading.review}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-black text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900"
                  >
                    {supplierQueueLoading.review ? 'Loading…' : 'Load more products'}
                  </button>
                </div>
              )}
            </div>

          </div>
        )}

        {/* Products not yet ready for an administrator decision */}
        {activeSubTab === 'review' && reviewFilter === 'needs_attention' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900/20 p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Products Being Prepared</h3>
                <p className="text-[11px] text-slate-400">These products were received from suppliers but are not ready for a review decision yet.</p>
              </div>
              <div className="shrink-0">
                <span className="text-[10px] text-slate-400 font-mono bg-slate-100 dark:bg-slate-800/50 px-2.5 py-1 rounded-lg border border-slate-200/50 dark:border-slate-800">
                  {importQueue.length} Products
                </span>
              </div>
            </div>

            {supplierQueueLoading.import && importQueue.length === 0 ? (
              <div className="p-12 text-center text-xs font-bold text-slate-400" role="status">Checking products…</div>
            ) : productsBeingPrepared.length === 0 ? (
              /* Empty State */
              <div className="p-16 text-center rounded-3xl border border-dashed border-slate-250 dark:border-slate-800 bg-slate-50/30 dark:bg-[#111928]/30 space-y-4 max-w-xl mx-auto my-6">
                <div className="w-14 h-14 bg-blue-500/10 text-blue-500 rounded-2xl flex items-center justify-center mx-auto shadow-inner">
                  <FileText className="h-6 w-6" />
                </div>
                <div className="space-y-1.5">
                  <h4 className="text-sm font-black text-slate-900 dark:text-white">No products need preparation</h4>
                  <p className="text-[11.5px] text-slate-400 max-w-sm mx-auto leading-relaxed">
                    All received supplier products have progressed to a review decision or need no action.
                  </p>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                      <th className="py-3 px-4 w-16">Image</th>
                      <th className="py-3 px-4">SKU / Code</th>
                      <th className="py-3 px-4">Title</th>
                      <th className="py-3 px-4 text-right">Wholesale Price</th>
                      <th className="py-3 px-4 text-right">Recommended Retail</th>
                      <th className="py-3 px-4 text-right">Inventory</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productsBeingPrepared.map((item) => (
                      <tr key={item.sku} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-900/30">
                        <td className="py-3 px-4">
                          <SupplierImagePreview src={item.mediaGallery?.[0]} alt={item.title} />
                        </td>
                        <td className="py-3 px-4 font-mono font-medium">{item.sku}</td>
                        <td className="py-3 px-4 font-semibold">{item.title}</td>
                        <td className="py-3 px-4 text-right font-bold text-slate-900 dark:text-white">
                          LKR {(item.wholesalePrice || 0).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right font-bold text-slate-900 dark:text-white">
                          LKR {(item.recommendedRetailPrice || 0).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right font-semibold text-slate-600 dark:text-slate-400">
                          {item.inventoryLevel || 0} units
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {supplierQueueCursors.import && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadSupplierQueueView('import', { append: true })}
                  disabled={supplierQueueLoading.import}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-black text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900"
                >
                    {supplierQueueLoading.import ? 'Loading…' : 'Load more products'}
                </button>
              </div>
            )}
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

            {/* Update all suppliers */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 rounded-3xl bg-slate-50 dark:bg-[#101827]/40 border border-slate-200/50 dark:border-slate-800/60">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-blue-500/10 text-blue-500 rounded-xl">
                  <Activity className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-white">Update All Suppliers</h4>
                  <p className="text-[10px] text-slate-400 font-medium">Check every active supplier for product and stock changes.</p>
                </div>
              </div>
              <button
                type="button"
                  onClick={() => handleSyncSupplier()}
                  disabled={isSyncing}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold rounded-xl text-xs flex items-center justify-center space-x-2 cursor-pointer transition-all shadow-md shadow-blue-500/10 hover:shadow-lg hover:shadow-blue-500/20"
              >
                <RefreshCw className="h-3.5 w-3.5 animate-pulse" />
                <span>Update All</span>
              </button>
            </div>

            {supplierSources.length === 0 ? (
              <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                <Globe className="h-10 w-10 text-slate-300 mx-auto" />
                <div className="space-y-1">
                  <p className="text-sm font-bold text-slate-900 dark:text-white">No data available.</p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {supplierSources.map((source) => (
                  <div 
                    key={source.id}
                    className={`p-5 rounded-3xl border ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-xl shadow-slate-950/20' : 'bg-white border-slate-200 shadow-xs'} transition-all relative overflow-hidden`}
                  >
                    <div className={`absolute top-0 bottom-0 left-0 w-1 ${
                      source.connectionStatus === 'connected' ? 'bg-emerald-500' : 
                      source.connectionStatus === 'Not Synced' ? 'bg-amber-500' : 'bg-rose-500'
                    }`} />
                    
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-extrabold text-sm text-slate-900 dark:text-white">{source.name}</span>
                        </div>
                        {source.websiteUrl && (
                          <p className="text-[10px] text-blue-500 hover:underline break-all mt-1 flex items-center gap-1 font-medium">
                            <a href={source.websiteUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1">
                              <Globe className="h-3 w-3 shrink-0" /> {source.websiteUrl}
                            </a>
                          </p>
                        )}
                      </div>

                      <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold border flex items-center gap-1 uppercase tracking-wider ${
                        source.connectionStatus === 'connected' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 
                        source.connectionStatus === 'Not Synced' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' : 
                        'bg-rose-500/10 text-rose-500 border-rose-500/20'
                      }`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${
                          source.connectionStatus === 'connected' ? 'bg-emerald-500 animate-pulse' : 
                          source.connectionStatus === 'Not Synced' ? 'bg-amber-500' : 
                          'bg-rose-500'
                        }`} />
                        {source.connectionStatus || 'Not Connected'}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mt-6 p-3 bg-slate-50 dark:bg-slate-900/40 rounded-2xl border border-slate-100/50 dark:border-slate-800/40 text-xs">
                      <div className="space-y-0.5">
                        <span className="text-slate-400 font-bold block text-[10px] uppercase">Last Update</span>
                        <span className="text-slate-700 dark:text-slate-200 font-medium font-mono">{source.lastSync || 'Never'}</span>
                      </div>
                      <div className="space-y-0.5">
                        <span className="text-slate-400 font-bold block text-[10px] uppercase">Health</span>
                        <span className="font-bold text-emerald-500">{supplierHealthLabel(source)}</span>
                      </div>
                      <div className="col-span-2 space-y-0.5 border-t border-slate-100 dark:border-slate-800/40 pt-2">
                        <span className="text-slate-400 font-bold block text-[10px] uppercase">Latest Notice</span>
                        <span className="text-slate-400 font-medium block truncate">
                          {source.lastError || 'None'}
                        </span>
                      </div>
                    </div>

                    <details className="mt-4 rounded-xl border border-slate-200/70 px-3 py-2 text-[10px] text-slate-500 dark:border-slate-800">
                      <summary className="cursor-pointer font-bold">Advanced supplier details</summary>
                      <dl className="mt-2 space-y-1 font-mono">
                        <div><dt className="inline font-bold">Supplier ID: </dt><dd className="inline">{source.id}</dd></div>
                        <div><dt className="inline font-bold">Connection type: </dt><dd className="inline">{source.type || source.connectorType || 'website'}</dd></div>
                        {source.endpoint && <div><dt className="inline font-bold">Endpoint: </dt><dd className="inline break-all">{source.endpoint}</dd></div>}
                      </dl>
                    </details>

                    <div className="mt-5 flex items-center justify-end gap-3 flex-wrap">
                      <div className="flex items-center gap-2 shrink-0 ml-auto">
                        <button
                          onClick={() => handleOpenSettings(source)}
                          className={`px-3.5 py-1.5 font-bold rounded-lg text-[10px] flex items-center gap-1.5 cursor-pointer transition-all border ${
                            editingSourceId === source.id 
                              ? 'bg-amber-500 text-slate-900 border-amber-500 hover:bg-amber-600' 
                              : 'bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 border-slate-200/50 dark:border-slate-700/50'
                          }`}
                        >
                          <Settings className={`h-3.5 w-3.5 ${editingSourceId === source.id ? 'animate-spin' : ''}`} />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSupplierPauseAction(source)}
                          disabled={savingSettingsSourceId !== null}
                          className="px-3.5 py-1.5 bg-amber-100 hover:bg-amber-200 disabled:opacity-50 text-amber-700 font-bold rounded-lg text-[10px] flex items-center gap-1.5 cursor-pointer transition-colors"
                        >
                          {String(source.sourceStatus || source.status || '').toLowerCase() === 'paused' ? 'Resume' : 'Pause'}
                        </button>
                        <button
                          onClick={() => handleTestExistingConnection(source)}
                          disabled={testingSourceId !== null || syncingSourceId !== null}
                          className="px-3.5 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50 text-slate-700 dark:text-slate-300 font-bold rounded-lg text-[10px] flex items-center gap-1.5 cursor-pointer transition-colors border border-slate-200/50 dark:border-slate-700/50"
                        >
                          <RefreshCw className={`h-3 w-3 ${testingSourceId === source.id ? 'animate-spin' : ''}`} />
                          <span>{testingSourceId === source.id ? 'Testing...' : 'Test Connection'}</span>
                        </button>
                        <button
                          onClick={() => handleTriggerSync(source.id)}
                          disabled={isSyncing || syncingSourceId !== null || testingSourceId !== null}
                          className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:opacity-50 text-white font-bold rounded-lg text-[10px] flex items-center gap-1.5 cursor-pointer transition-colors"
                        >
                          <RefreshCw className={`h-3 w-3 ${syncingSourceId === source.id ? 'animate-spin' : ''}`} />
                          <span>{syncingSourceId === source.id ? 'Updating...' : 'Update Now'}</span>
                        </button>
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
                              General Settings
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
                                Enable Supplier
                              </label>
                              <div className="flex items-center h-9">
                                <label className="relative inline-flex items-center cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={editIsEnabled}
                                    onChange={(e) => setEditIsEnabled(e.target.checked)}
                                    className="sr-only peer"
                                  />
                                  <div className="w-9 h-5 bg-slate-200 dark:bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-slate-600 peer-checked:bg-emerald-500"></div>
                                  <span className="ml-3 text-xs font-bold text-slate-600 dark:text-slate-400">
                                    {editIsEnabled ? 'Active' : 'Inactive'}
                                  </span>
                                </label>
                              </div>
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

                            <details className="col-span-1 rounded-xl border border-slate-200 p-3 dark:border-slate-800 sm:col-span-2">
                              <summary className="cursor-pointer text-[10px] font-bold text-slate-500">Advanced connection settings</summary>
                              <div className="mt-3 space-y-1">
                                <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500">Catalog path</label>
                                <input
                                  type="text"
                                  value={editEndpoint}
                                  onChange={(e) => setEditEndpoint(e.target.value)}
                                  className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white font-mono"
                                  placeholder="/api/products"
                                />
                              </div>
                            </details>
                          </div>
                        </div>

                        {/* SYNC SETTINGS */}
                        <div className="space-y-4">
                          <div className="border-b border-slate-100 dark:border-slate-800 pb-1.5">
                            <span className="text-[10px] font-extrabold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                              Products to Update
                            </span>
                          </div>

                          {/* Category Filter Multi-select */}
                          <div className="space-y-2">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500 block">
                              Category Filter (Multi Select)
                            </label>
                            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1.5 bg-slate-50 dark:bg-slate-900/30 border border-slate-100 dark:border-slate-800 rounded-xl">
                              {categories.map((cat: any) => {
                                const catValue = cat.name || cat.id;
                                const isSelected = editCategoriesFilter.includes(catValue);
                                return (
                                  <button
                                    key={cat.id}
                                    type="button"
                                    onClick={() => {
                                      if (isSelected) {
                                        setEditCategoriesFilter(editCategoriesFilter.filter(c => c !== catValue));
                                      } else {
                                        setEditCategoriesFilter([...editCategoriesFilter, catValue]);
                                      }
                                    }}
                                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all cursor-pointer flex items-center gap-1 ${
                                      isSelected
                                        ? 'bg-blue-500/10 text-blue-500 border-blue-500/30'
                                        : 'bg-white dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                                    }`}
                                  >
                                    {isSelected && <Check className="h-2.5 w-2.5" />}
                                    <span>{catValue}</span>
                                  </button>
                                );
                              })}
                              {categories.length === 0 && (
                                <span className="px-2 py-1 text-[10px] font-medium text-slate-400">
                                  No Zyro categories are available for filtering.
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Brand Filter */}
                          <div className="space-y-1">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500">
                              Brand Filter (Optional)
                            </label>
                            <input
                              type="text"
                              value={editBrandFilter}
                              onChange={(e) => setEditBrandFilter(e.target.value)}
                              className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white"
                              placeholder="e.g. Sony, Apple, Samsung (comma-separated)"
                            />
                          </div>

                          {/* Advanced product limit */}
                          <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                            <summary className="cursor-pointer text-[10px] font-bold text-slate-500">Advanced product limit</summary>
                            <div className="mt-3 space-y-2">
                            <div className="flex flex-wrap gap-1 bg-slate-100 dark:bg-slate-900/50 p-1 rounded-xl border border-slate-200/50 dark:border-slate-800/40 w-fit">
                              {['5', '20', '50', '100', '250', 'All'].map((limit) => (
                                <button
                                  key={limit}
                                  type="button"
                                  onClick={() => setEditProductLimit(limit)}
                                  className={`px-3 py-1 text-[10px] font-bold rounded-lg transition-all cursor-pointer ${
                                    editProductLimit === limit
                                      ? 'bg-blue-600 text-white shadow-xs'
                                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                                  }`}
                                >
                                  {limit}
                                </button>
                              ))}
                            </div>
                            </div>
                          </details>

                          {/* Sync Mode */}
                          <div className="space-y-2">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500 block">
                              Products to update
                            </label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-slate-50 dark:bg-slate-900/20 border border-slate-100 dark:border-slate-800/60 rounded-xl">
                              {[
                                { label: 'New Products', value: editSyncNewProducts, setter: setEditSyncNewProducts },
                                { label: 'Price Updates', value: editSyncPriceUpdates, setter: setEditSyncPriceUpdates },
                                { label: 'Stock Updates', value: editSyncStockUpdates, setter: setEditSyncStockUpdates },
                                { label: 'Description Updates', value: editSyncDescriptionUpdates, setter: setEditSyncDescriptionUpdates },
                                { label: 'Image Updates', value: editSyncImageUpdates, setter: setEditSyncImageUpdates }
                              ].map((mode, i) => (
                                <label key={i} className="flex items-center gap-2.5 cursor-pointer select-none">
                                  <input
                                    type="checkbox"
                                    checked={mode.value}
                                    onChange={(e) => mode.setter(e.target.checked)}
                                    className="rounded border-slate-300 dark:border-slate-800 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5 bg-white dark:bg-slate-950"
                                  />
                                  <span className="text-xs text-slate-700 dark:text-slate-300 font-semibold">{mode.label}</span>
                                </label>
                              ))}
                            </div>
                          </div>

                          {/* Auto Sync */}
                          <div className="space-y-2">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500 block">
                              Automatic updates
                            </label>
                            <div className="flex flex-wrap gap-1 bg-slate-100 dark:bg-slate-900/50 p-1 rounded-xl border border-slate-200/50 dark:border-slate-800/40 w-fit">
                              {['Off', '15 Minutes', '30 Minutes', '1 Hour', '6 Hours', 'Daily'].map((interval) => (
                                <button
                                  key={interval}
                                  type="button"
                                  onClick={() => setEditAutoSync(interval)}
                                  className={`px-3 py-1 text-[10px] font-bold rounded-lg transition-all cursor-pointer ${
                                    editAutoSync === interval
                                      ? 'bg-blue-600 text-white shadow-xs'
                                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                                  }`}
                                >
                                  {interval}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Advanced preview mode */}
                          <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                            <summary className="cursor-pointer text-[10px] font-bold text-slate-500">Advanced preview mode</summary>
                          <div className="mt-3 flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900/20 border border-slate-100 dark:border-slate-800/60 rounded-xl">
                            <div className="space-y-0.5">
                              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block">Preview changes only</span>
                              <span className="text-[10px] text-slate-400 font-medium">Check supplier changes without saving them for review.</span>
                            </div>
                            <div className="flex items-center">
                              <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={editDryRunMode}
                                  onChange={(e) => setEditDryRunMode(e.target.checked)}
                                  className="sr-only peer"
                                />
                                <div className="w-9 h-5 bg-slate-200 dark:bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-slate-600 peer-checked:bg-amber-500"></div>
                                <span className="ml-3 text-xs font-bold text-slate-600 dark:text-slate-400 w-10">
                                  {editDryRunMode ? 'ON' : 'OFF'}
                                </span>
                              </label>
                            </div>
                          </div>
                          </details>
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
                            onClick={() => handleSaveSettings(source.id)}
                            disabled={savingSettingsSourceId !== null}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold rounded-xl text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors shadow-md shadow-emerald-500/10 hover:shadow-lg hover:shadow-emerald-500/20 disabled:opacity-50"
                          >
                            {savingSettingsSourceId === source.id ? (
                              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Save className="h-3.5 w-3.5" />
                            )}
                            <span>{savingSettingsSourceId === source.id ? 'Saving...' : 'Save Settings'}</span>
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

        {/* Product updates from already published products */}
        {activeSubTab === 'review' && reviewFilter !== 'new_products' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900/20 p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Published Product Changes</h3>
                <p className="text-[11px] text-slate-400">Supplier changes affecting products that already exist in your store.</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] text-blue-500 font-bold bg-blue-500/10 px-2.5 py-1 rounded-lg border border-blue-500/20 font-mono">
                  {supplierPendingChanges.length} Changes
                </span>
                <span className="text-[10px] text-amber-500 font-bold bg-amber-500/10 px-2.5 py-1 rounded-lg border border-amber-500/20 font-mono">
                  {visibleProductChanges.length} Shown
                </span>
              </div>
            </div>

            {/* Pending Changes List */}
            {(() => {
              const filteredChanges = visibleProductChanges;

              if (filteredChanges.length === 0) {
                return (
                  <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                    <SlidersHorizontal className="h-10 w-10 text-slate-300 mx-auto" />
                    <div className="space-y-1">
                      <p className="text-sm font-bold text-slate-900 dark:text-white">No matches found</p>
                      <p className="text-xs text-slate-400">No published product changes match this filter.</p>
                    </div>
                  </div>
                );
              }

              return (
                <div className="space-y-4">
                  {filteredChanges.map((change) => (
                    <div 
                      key={change.id}
                      className={`p-5 rounded-3xl border ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-xl shadow-slate-950/20' : 'bg-white border-slate-200 shadow-xs'} transition-all flex flex-col md:flex-row items-start md:items-center justify-between gap-6`}
                    >
                      <div className="space-y-2.5 flex-1 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-extrabold text-sm text-slate-900 dark:text-white leading-tight">{change.productName}</span>
                          
                          {change.changeType === 'PRICE_CHANGED' && (
                            <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-500 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-emerald-500/20">
                              <TrendingUp className="h-3 w-3" /> Price Changed
                            </span>
                          )}
                          {change.changeType === 'STOCK_CHANGED' && (
                            <span className="px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-500 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-blue-500/20">
                              <Boxes className="h-3 w-3" /> Stock Changed
                            </span>
                          )}
                          {change.changeType === 'IMAGE_CHANGED' && (
                            <span className="px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-500 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-indigo-500/20">
                              <Camera className="h-3 w-3" /> Image Changed
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-400 text-[10px] font-medium font-mono">
                          <span className="flex items-center gap-1">
                            <User className="h-3.5 w-3.5" /> Supplier: {change.supplierName} ({change.supplierCode || 'N/A'})
                          </span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            <Globe className="h-3 w-3 text-sky-500" />
                            Source: {change.source}
                          </span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" /> Detected: {change.detectedAt ? new Date(change.detectedAt).toLocaleString() : 'N/A'}
                          </span>
                        </div>

                        {/* Live changes compare block */}
                        <div className="flex items-center space-x-2 text-[11px] bg-slate-50 dark:bg-slate-900/40 p-2 rounded-xl border border-slate-100/50 dark:border-slate-800/40 w-fit">
                          <span className="text-slate-400 font-bold font-mono">Current:</span>
                          <span className="text-slate-600 dark:text-slate-300 font-bold line-through font-mono max-w-[120px] truncate">{change.oldValue || '(None)'}</span>
                          <ArrowRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                          <span className="text-slate-400 font-bold font-mono">New:</span>
                          <span className="text-emerald-500 font-extrabold font-mono max-w-[120px] truncate">{change.newValue}</span>
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-center gap-2 justify-end shrink-0 w-full md:w-auto border-t md:border-t-0 border-slate-100 dark:border-slate-800 pt-4 md:pt-0">
                        <button
                          onClick={() => setComparingChange(change)}
                          className="px-3.5 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold rounded-xl text-xs transition-colors cursor-pointer border border-slate-200/50 dark:border-slate-800/60"
                        >
                          Compare
                        </button>

                        {(change.status === 'Pending' || change.status === 'CONFLICT') ? (
                          <>
                            <button
                              onClick={() => handleRejectPendingChange(change)}
                              disabled={processingChangeId === change.id}
                              className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer flex items-center justify-center gap-1"
                            >
                              Reject
                            </button>
                            <button
                              onClick={() => handleApprovePendingChange(change)}
                              disabled={processingChangeId === change.id}
                              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white font-bold rounded-xl text-xs transition-colors shadow-lg shadow-blue-500/20 flex items-center justify-center gap-1 cursor-pointer"
                            >
                              {processingChangeId === change.id ? (
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Check className="h-3.5 w-3.5" />
                              )}
                              <span>Approve</span>
                            </button>
                          </>
                        ) : (
                          <span className={`px-3 py-1.5 rounded-xl text-xs font-bold border font-mono ${
                            change.status === 'Approved'
                              ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                              : 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                          }`}>
                            {change.status}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
            {supplierQueueCursors.changes && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadSupplierQueueView('changes', { append: true })}
                  disabled={supplierQueueLoading.changes}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-black text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900"
                >
                  {supplierQueueLoading.changes ? 'Loading…' : 'Load more product changes'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* VIEW 4: CONFIGURATION SETTINGS */}
        {activeSubTab === 'settings' && (
          <div className="space-y-6 text-left">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900/20 p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Supplier Settings</h3>
                <p className="text-[11px] text-slate-400">Choose how supplier products are updated, priced, and organized.</p>
              </div>
              {supplierSettings && (supplierSettings.lastUpdated || supplierSettings.updatedBy) && (
                <div className="text-left sm:text-right text-[10px] text-slate-400 font-mono">
                  {supplierSettings.lastUpdated && (
                    <div>Last updated: {new Date(supplierSettings.lastUpdated).toLocaleString()}</div>
                  )}
                  {supplierSettings.updatedBy && (
                    <div>Updated by: {supplierSettings.updatedBy}</div>
                  )}
                </div>
              )}
            </div>

            <form onSubmit={handleSaveSupplierSettings} className="p-6 rounded-3xl border border-slate-200/50 dark:border-slate-800/60 bg-slate-50/50 dark:bg-[#101827]/30 text-xs space-y-6">
              
              {/* Section 1: Ingestion Channels */}
              <div className="space-y-4">
                <h4 className="text-[10px] font-black uppercase text-blue-500 tracking-wider">Catalog Updates</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  
                  {/* Website Sync Channel */}
                  <div className="p-4 bg-white dark:bg-slate-900/60 border border-slate-150 dark:border-slate-800 rounded-2xl flex items-center justify-between">
                    <div className="space-y-1 pr-4">
                      <div className="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white text-xs">
                        <Globe className="h-4 w-4 text-sky-500" />
                        <span>Supplier updates enabled</span>
                      </div>
                      <p className="text-[10px] text-slate-400">Allow product updates from connected suppliers.</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0">
                      <input 
                        type="checkbox" 
                        checked={!!supplierSettings.websiteSyncEnabled}
                        onChange={(e) => setSupplierSettings(prev => ({ ...prev, websiteSyncEnabled: e.target.checked }))}
                        className="sr-only peer" 
                      />
                      <div className="w-10 h-5 bg-slate-200 dark:bg-slate-800 peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>

                  {/* Automated Sync Jobs */}
                  <div className="p-4 bg-white dark:bg-slate-900/60 border border-slate-150 dark:border-slate-800 rounded-2xl flex items-center justify-between">
                    <div className="space-y-1 pr-4">
                      <div className="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white text-xs">
                        <SlidersHorizontal className="h-4 w-4 text-blue-500" />
                        <span>Automatic updates</span>
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

                </div>
              </div>

              {/* Section 2: Financial Margins */}
              <div className="space-y-4">
                <h4 className="text-[10px] font-black uppercase text-blue-500 tracking-wider">Update Schedule & Pricing</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  
                  {/* Sync Interval */}
                  <div className="space-y-1 text-slate-900 dark:text-white">
                    <label className="text-slate-400 font-bold block">Automatic update schedule</label>
                    <select
                      value={supplierSettings.syncInterval || "1 Hour"}
                      onChange={(e) => setSupplierSettings(prev => ({ ...prev, syncInterval: e.target.value }))}
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-[#111928] border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500/50 transition-colors text-xs text-slate-900 dark:text-white cursor-pointer"
                    >
                      <option value="Manual">Manual</option>
                      <option value="15 Minutes">15 Minutes</option>
                      <option value="30 Minutes">30 Minutes</option>
                      <option value="1 Hour">1 Hour</option>
                      <option value="6 Hours">6 Hours</option>
                      <option value="Daily">Daily</option>
                    </select>
                  </div>

                  <details className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111928] md:col-span-2">
                    <summary className="cursor-pointer font-bold text-slate-600 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-300">Advanced scheduling details</summary>
                    <div className="mt-4 grid gap-4 md:grid-cols-3">
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

                  {/* Next Scheduled Sync */}
                  <div className="space-y-1">
                    <label className="text-slate-400 font-bold block">Next Scheduled Sync</label>
                    <input
                      type="datetime-local"
                      value={toDateTimeLocalValue(supplierSettings.nextSync)}
                      readOnly
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-[#111928] border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500/50 transition-colors text-xs text-slate-900 dark:text-white font-mono font-bold text-left"
                    />
                  </div>

                  {/* Last Sync */}
                  <div className="space-y-1">
                    <label className="text-slate-400 font-bold block">Last Scheduled Sync</label>
                    <input
                      type="datetime-local"
                      value={toDateTimeLocalValue(supplierSettings.lastSync)}
                      readOnly
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-[#111928] border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500/50 transition-colors text-xs text-slate-900 dark:text-white font-mono font-bold text-left"
                    />
                  </div>
                    </div>
                  </details>

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
                  <details className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111928] md:col-span-2">
                    <summary className="cursor-pointer font-bold text-slate-600 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-slate-300">Advanced image settings</summary>
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
                  </details>

                </div>
              </div>

              {/* Section 3: Supplier Category Mapping */}
              <div className="space-y-4">
                <div>
                  <h4 className="text-[10px] font-black uppercase text-blue-500 tracking-wider">Supplier Category → Store Category</h4>
                  <p className="mt-1 text-[10px] text-slate-400">Choose where supplier categories appear in the Zyro catalog.</p>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {supplierCategoryOptions.map(({ key, label }) => (
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
                  {supplierCategoryOptions.length === 0 && (
                    <div className="rounded-xl border border-dashed border-slate-200 p-4 text-[11px] text-slate-400 dark:border-slate-800 md:col-span-2">
                      Update a supplier to discover categories for mapping.
                    </div>
                  )}
                </div>
              </div>

              {/* Advanced supplier scope */}
              <details className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#111928]">
                <summary className="cursor-pointer text-[10px] font-black uppercase tracking-wider text-blue-500 outline-none focus-visible:ring-2 focus-visible:ring-blue-500">Advanced supplier scope</summary>
              <div className="mt-4 space-y-4">
                <h4 className="text-[10px] font-black uppercase text-slate-500 tracking-wider">Suppliers included in automatic updates</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {supplierSources.filter(source => (source.supplierType || source.type) === 'website').map((source) => {
                    const enabledIds = supplierSettings.enabledSupplierIds || [];
                    const usesExplicitScope = supplierSettings.enabledSupplierIdsConfigured === true;
                    const isChecked = (!usesExplicitScope && enabledIds.length === 0) || enabledIds.includes(source.id);
                    return (
                      <label
                        key={source.id}
                        className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-white dark:bg-[#111928] border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-200"
                      >
                        <span className="font-bold truncate">{source.supplierName || source.name || source.id}</span>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            setSupplierSettings(prev => {
                              const currentIds = prev.enabledSupplierIds || [];
                              const allWebsiteIds = supplierSources
                                .filter(item => (item.supplierType || item.type) === 'website')
                                .map(item => item.id);
                              const normalizedIds = currentIds.length === 0 ? allWebsiteIds : currentIds;
                              return {
                                ...prev,
                                enabledSupplierIdsConfigured: true,
                                enabledSupplierIds: e.target.checked
                                  ? Array.from(new Set([...normalizedIds, source.id]))
                                  : normalizedIds.filter((id: string) => id !== source.id)
                              };
                            });
                          }}
                          className="h-4 w-4 accent-blue-600"
                        />
                      </label>
                    );
                  })}
                  {supplierSources.filter(source => (source.supplierType || source.type) === 'website').length === 0 && (
                    <div className="text-[11px] text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl p-4">
                      No website suppliers are connected yet.
                    </div>
                  )}
                </div>
              </div>
              </details>

              {/* Actions Row */}
              <div className="pt-4 border-t border-slate-200/50 dark:border-slate-800/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setShowResetSettingsConfirm(true)}
                  className="px-4.5 py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer border border-transparent dark:border-slate-700/50"
                >
                  <RefreshCw className="h-4 w-4" />
                  <span>Reset to Defaults</span>
                </button>

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
          </div>
        )}

      </div>

      {/* --- ALL INLINE MODALS --- */}
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
                
                {modalTestStatus === 'Connected' && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 font-normal">
                    Successfully verified! Discovered <strong className="font-extrabold text-emerald-500">{modalTestProductsCount} products</strong> in the remote feed payload. You can now save this configuration.
                  </p>
                )}
                {modalTestStatus === 'Failed' && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 font-normal">
                    Response Error: <code className="bg-red-500/5 px-1 py-0.5 rounded font-mono font-bold text-red-500">{modalTestError}</code>
                  </p>
                )}
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleConnectSupplierSubmit} className="space-y-4 text-xs">
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

                {/* Unique Code */}
                <div className="space-y-1">
                  <label className="text-slate-400 font-bold block text-[10px] uppercase">Supplier Code / ID</label>
                  <input 
                    type="text" 
                    required
                    placeholder="e.g., a2z-traders"
                    value={newSupplierCode}
                    onChange={(e) => setNewSupplierCode(generateSlug(e.target.value))}
                    className="w-full px-3 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-850 rounded-xl focus:outline-hidden focus:border-emerald-500 transition-colors text-xs dark:text-white font-mono font-bold"
                  />
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
                    setApiEndpoint("");
                    setModalTestStatus('idle');
                    setModalTestError(null);
                    setModalTestProductsCount(null);
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
                    <p className="text-[10px] font-semibold leading-relaxed text-amber-700/80 dark:text-amber-400/80">
                      Credentials are resolved only from the Firebase Functions A2Z Secret Manager profile; no credential values are sent by this form.
                    </p>
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

              {/* Internal Notes */}
              <div className="space-y-1">
                <label className="text-slate-400 font-bold block text-[10px] uppercase">Internal Notes</label>
                <textarea 
                  rows={2}
                  placeholder="Enter logs, distributor contacts, key notes..."
                  value={newSupplierDesc}
                  onChange={(e) => setNewSupplierDesc(e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-850 rounded-xl focus:outline-hidden focus:border-emerald-500 transition-colors text-xs dark:text-white resize-none"
                />
              </div>

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
                    disabled={savingSupplier}
                    className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold rounded-xl text-xs transition-colors shadow-lg shadow-emerald-500/20 flex items-center gap-1.5 cursor-pointer"
                  >
                    {savingSupplier ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    <span>{savingSupplier ? 'Connecting...' : 'Save Supplier'}</span>
                  </button>
                </div>
              </div>

            </form>
          </div>
        </div>
      )}

      {comparingChange && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-lg w-full p-6 text-left shadow-2xl flex flex-col space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-blue-500/10 text-blue-500 rounded-xl">
                  <SlidersHorizontal className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold font-display text-slate-900 dark:text-white">Compare Live Fluctuation</h3>
                  <p className="text-[10px] text-slate-400 font-medium">Verify update parameters before applying changes</p>
                </div>
              </div>
              <button 
                onClick={() => setComparingChange(null)}
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full cursor-pointer transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 text-xs">
              <div className="p-4 bg-slate-50 dark:bg-slate-900/40 rounded-2xl border border-slate-100 dark:border-slate-800/40 space-y-2">
                <p className="font-extrabold text-sm text-slate-900 dark:text-white">{comparingChange.productName}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-400 font-mono">
                  <span>Code: {comparingChange.supplierCode}</span>
                  <span>•</span>
                  <span>Supplier: {comparingChange.supplierName}</span>
                  <span>•</span>
                  <span>Type: {comparingChange.changeType}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-2xl bg-slate-50/50 dark:bg-slate-900/20 border border-slate-150/40 dark:border-slate-800/40 space-y-1 text-center">
                  <span className="text-[10px] uppercase font-black tracking-widest text-slate-400">Current Catalog Value</span>
                  <p className="text-base font-bold text-slate-700 dark:text-slate-300 font-mono line-through">{comparingChange.oldValue || '(None)'}</p>
                </div>
                <div className="p-4 rounded-2xl bg-emerald-50/10 dark:bg-emerald-500/5 border border-emerald-500/20 space-y-1 text-center">
                  <span className="text-[10px] uppercase font-black tracking-widest text-emerald-500">Incoming Supplier Value</span>
                  <p className="text-base font-black text-emerald-500 font-mono">{comparingChange.newValue}</p>
                </div>
              </div>

              <div className="p-3 bg-blue-500/10 text-blue-500 text-[11px] rounded-xl border border-blue-500/20 flex items-start gap-2">
                <Info className="h-4 w-4 shrink-0 mt-0.5" />
                <span>Approving this item will publish it to the Zyro catalog. This action requires administrator authorization.</span>
              </div>

              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
                <button 
                  type="button"
                  onClick={() => setComparingChange(null)}
                  className="px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold rounded-xl text-xs transition-colors cursor-pointer border border-slate-200/50 dark:border-slate-800/60"
                >
                  Close
                </button>
                {(comparingChange.status === 'Pending' || comparingChange.status === 'CONFLICT') && (
                  <>
                    <button 
                      type="button"
                      onClick={() => {
                        handleRejectPendingChange(comparingChange);
                        setComparingChange(null);
                      }}
                      className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 font-bold rounded-xl text-xs transition-colors cursor-pointer"
                    >
                      Reject Change
                    </button>
                    <button 
                      type="button"
                      onClick={() => {
                        handleApprovePendingChange(comparingChange);
                        setComparingChange(null);
                      }}
                      className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs transition-colors shadow-lg shadow-blue-500/20 flex items-center gap-1.5 cursor-pointer"
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>Approve & Apply</span>
                    </button>
                  </>
                )}
              </div>
            </div>
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
          offerError={supplierOfferError}
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

      {rejectingReviewItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs" role="dialog" aria-modal="true" aria-labelledby="supplier-rejection-title">
          <form
            className="w-full max-w-md space-y-4 rounded-3xl border border-slate-200 bg-white p-6 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928]"
            onSubmit={(event) => {
              event.preventDefault();
              if (rejectionReasonDraft.trim()) void handleRejectReviewItem(rejectingReviewItem, rejectionReasonDraft);
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

      {showResetSettingsConfirm && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-md w-full p-6 text-left shadow-2xl flex flex-col space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-amber-500/10 text-amber-500 rounded-xl">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold font-display text-slate-900 dark:text-white">Reset Settings</h3>
                  <p className="text-[10px] text-slate-400 font-medium">Are you sure you want to restore defaults?</p>
                </div>
              </div>
              <button 
                onClick={() => setShowResetSettingsConfirm(false)}
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full cursor-pointer transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 text-xs">
              <p className="text-slate-500 dark:text-slate-400">
                This will reset all Supplier Hub configuration values to system defaults. Standard margins, markup, limits, and synchronizations will be restored.
              </p>
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
                <button 
                  type="button"
                  onClick={() => setShowResetSettingsConfirm(false)}
                  className="px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold rounded-xl text-xs transition-colors cursor-pointer border border-slate-200/50 dark:border-slate-800/60"
                >
                  Cancel
                </button>
                <button 
                  type="button"
                  onClick={handleResetSettings}
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-xl text-xs transition-colors shadow-lg shadow-amber-500/20 cursor-pointer"
                >
                  Reset Defaults
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </motion.div>
  );
}

export default React.memo(SupplierHubFiveStars);
