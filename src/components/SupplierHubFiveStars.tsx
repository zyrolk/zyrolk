import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  Activity, 
  RefreshCw, 
  UserCheck, 
  History, 
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
  Phone,
  ShieldCheck,
  AlertTriangle,
  Search,
  Sparkles,
  FileText
} from 'lucide-react';
import { RawA2ZProduct } from '../services/connectors/a2z-website/types';
import { collection, doc, getDocs, onSnapshot, setDoc, writeBatch } from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../firebase';
import { Product } from '../types';
import { approveSupplierQueueItem, rejectSupplierQueueItem } from '../services/supplierQueueService';
import { matchesSupplierSearch } from '../services/supplierSearch';
import { isActiveWebsiteSupplier } from '../services/supplierSourceUtils';

interface SupplierHubFiveStarsProps {
  isDarkMode?: boolean;
}

export interface ComparisonResult {
  matchFound: boolean;
  matchedProductId: string | null;
  comparisonStatus: 'NEW_PRODUCT' | 'PRICE_CHANGED' | 'STOCK_CHANGED' | 'DESCRIPTION_CHANGED' | 'IMAGE_CHANGED' | 'UNCHANGED';
  changedFields: string[];
}

export interface ReviewQueueItem {
  id: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  supplierCode: string;
  productName: string;
  costPrice: number;
  marketPrice: number;
  stock: number;
  imageUrl?: string;
  currentValue?: string | number;
  supplierValue?: string | number;
  comparisonStatus?: 'NEW_PRODUCT' | 'PRICE_CHANGED' | 'STOCK_CHANGED' | 'DESCRIPTION_CHANGED' | 'IMAGE_CHANGED' | 'UNCHANGED';
  comparison?: ComparisonResult;
  productPayload?: Product & Record<string, unknown>; // Full product data to be written on approval
  matchedProductId?: string | null; // ID of existing product if match found
  supplierName?: string;
  source?: 'Website' | 'WhatsApp';
  sourceId?: string;
  batchId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SyncHistoryItem {
  id: string;
  timestamp: string;
  createdAt?: string;
  batchId?: string;
  supplierCode: string;
  productsSynced: number;
  status: 'Success' | 'Failed';
  details: string;
}

export default function SupplierHubFiveStars({ isDarkMode = true }: SupplierHubFiveStarsProps) {
  // Stat states
  const [newProducts, setNewProducts] = useState<number>(0);
  const [priceChanges, setPriceChanges] = useState<number>(0);
  const [stockChanges, setStockChanges] = useState<number>(0);
  const [imageChanges, setImageChanges] = useState<number>(0);

  // Core review queue and sync history states
  const [reviewQueue, setReviewQueue] = useState<ReviewQueueItem[]>([]);
  const [syncHistory, setSyncHistory] = useState<SyncHistoryItem[]>([]);
  
  // Syncing state
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncStatusMsg, setSyncStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // --- MERGED SECTIONS STATES (PLACEHOLDER/LOCAL STATE) ---
  const [activeSubTab, setActiveSubTab] = useState<'review' | 'import_queue' | 'sources' | 'changes' | 'settings'>('review');
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [reviewSearch, setReviewSearch] = useState<string>('');
  const [importSearch, setImportSearch] = useState<string>('');

  // 1. Supplier Sources & Connect states
  const [supplierSources, setSupplierSources] = useState<any[]>([]);
  const [showConnectModal, setShowConnectModal] = useState<boolean>(false);
  const [wizardStep, setWizardStep] = useState<number>(1);
  const [newSupplierName, setNewSupplierName] = useState<string>("");
  const [newSupplierType, setNewSupplierType] = useState<string>("website");
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
  const [apiHeaders, setApiHeaders] = useState<string>('{\n  "Content-Type": "application/json"\n}');
  const [apiDataPath, setApiDataPath] = useState<string>("products");

  // WhatsApp specific
  const [whatsappNumber, setWhatsappNumber] = useState<string>("");
  const [whatsappSender, setWhatsappSender] = useState<string>("");
  const [whatsappKeywords, setWhatsappKeywords] = useState<string>("STOCK_UPDATE, PRICE_CHANGE");
  const [whatsappFormat, setWhatsappFormat] = useState<string>("Code: {code}, Qty: {qty}");

  const [savingSupplier, setSavingSupplier] = useState<boolean>(false);
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null);
  
  // Connection Testing states
  const [testingSourceId, setTestingSourceId] = useState<string | null>(null);
  const [modalTestStatus, setModalTestStatus] = useState<'idle' | 'testing' | 'Connected' | 'Failed'>('idle');
  const [modalTestError, setModalTestError] = useState<string | null>(null);
  const [modalTestProductsCount, setModalTestProductsCount] = useState<number | null>(null);

  // Sync supplier sources from Firestore on mount
  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "supplierSources"),
      (snapshot) => {
        const sources: any[] = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          sources.push({
            id: doc.id,
            ...data,
            // Map the new structured schema fields to the existing layout keys for full visual compatibility
            name: data.supplierName || data.name || "Unnamed Supplier",
            type: data.supplierType || data.type || "website",
            supplierType: data.supplierType || data.type || "website",
            websiteUrl: data.websiteUrl || data.config?.targetUrl || "",
            endpoint: data.endpoint || data.config?.apiEndpoint || "",
            connectionStatus: data.connectionStatus || "Not Synced",
            sourceStatus: data.sourceStatus || "active",
            lastSync: data.lastSync || null,
            lastError: data.lastError || "None"
          });
        });

        setSupplierSources(sources);
      },
      (error) => {
        console.error("onSnapshot error:", error);
        handleFirestoreError(error, OperationType.GET, "supplierSources");
      }
    );
    return () => unsubscribe();
  }, []);

  const [categories, setCategories] = useState<any[]>([]);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, "supplier_settings", "config"),
      (snapshot) => {
        if (snapshot.exists()) {
          setSupplierSettings(prev => ({ ...prev, ...snapshot.data() }));
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, "supplier_settings/config");
      }
    );

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const sortByCreatedAtDesc = <T extends { createdAt?: string; detectedAt?: string; timestamp?: string }>(items: T[]): T[] => {
      return items.sort((a, b) => {
        const aTime = new Date(a.createdAt || a.detectedAt || a.timestamp || 0).getTime();
        const bTime = new Date(b.createdAt || b.detectedAt || b.timestamp || 0).getTime();
        return bTime - aTime;
      });
    };

    const unsubscribeReviewQueue = onSnapshot(
      collection(db, "supplier_review_queue"),
      (snapshot) => {
        const items: ReviewQueueItem[] = [];
        snapshot.forEach((queueDoc) => {
          items.push({ id: queueDoc.id, ...queueDoc.data() } as ReviewQueueItem);
        });
        setReviewQueue(sortByCreatedAtDesc(items));
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, "supplier_review_queue");
      }
    );

    const unsubscribeImportQueue = onSnapshot(
      collection(db, "supplier_import_queue"),
      (snapshot) => {
        const items: any[] = [];
        snapshot.forEach((queueDoc) => {
          items.push({ id: queueDoc.id, ...queueDoc.data() });
        });
        setImportQueue(sortByCreatedAtDesc(items));
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, "supplier_import_queue");
      }
    );

    const unsubscribePendingChanges = onSnapshot(
      collection(db, "supplier_pending_changes"),
      (snapshot) => {
        const items: any[] = [];
        snapshot.forEach((queueDoc) => {
          items.push({ id: queueDoc.id, ...queueDoc.data() });
        });
        setSupplierPendingChanges(sortByCreatedAtDesc(items));
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, "supplier_pending_changes");
      }
    );

    const unsubscribeSyncHistory = onSnapshot(
      collection(db, "supplier_sync_history"),
      (snapshot) => {
        const items: SyncHistoryItem[] = [];
        snapshot.forEach((queueDoc) => {
          items.push({ id: queueDoc.id, ...queueDoc.data() } as SyncHistoryItem);
        });
        setSyncHistory(sortByCreatedAtDesc(items));
      },
      (error) => {
        handleFirestoreError(error, OperationType.GET, "supplier_sync_history");
      }
    );

    return () => {
      unsubscribeReviewQueue();
      unsubscribeImportQueue();
      unsubscribePendingChanges();
      unsubscribeSyncHistory();
    };
  }, []);

  useEffect(() => {
    setNewProducts(reviewQueue.filter(item => item.comparison?.comparisonStatus === 'NEW_PRODUCT').length);
    setPriceChanges(reviewQueue.filter(item => item.comparison?.comparisonStatus === 'PRICE_CHANGED').length);
    setStockChanges(reviewQueue.filter(item => item.comparison?.comparisonStatus === 'STOCK_CHANGED').length);
    setImageChanges(reviewQueue.filter(item => (
      item.comparison?.comparisonStatus === 'IMAGE_CHANGED' ||
      item.comparison?.comparisonStatus === 'DESCRIPTION_CHANGED'
    )).length);
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

  const [importQueue, setImportQueue] = useState<any[]>([]);

  // 2. Pending Changes states
  const [supplierPendingChanges, setSupplierPendingChanges] = useState<any[]>([]);
  const [pendingChangesFilter, setPendingChangesFilter] = useState<'All' | 'Pending' | 'Approved' | 'Rejected'>('All');
  const [pendingChangesSearch, setPendingChangesSearch] = useState<string>('');
  const [processingChangeId, setProcessingChangeId] = useState<string | null>(null);
  const [comparingChange, setComparingChange] = useState<any | null>(null);

  // 3. Settings states
  const [supplierSettings, setSupplierSettings] = useState<any>({
    websiteSyncEnabled: true,
    whatsappSyncEnabled: false,
    autoSyncEnabled: true,
    autoImageDownload: true,
    notificationEnabled: true,
    syncInterval: "1 Hour",
    maxProducts: 5,
    enabledSupplierIds: [],
    lastSync: "",
    nextSync: "",
    defaultProfitMargin: 15,
    defaultMarkup: 10,
    defaultImageLimit: 5,
    lastUpdated: new Date().toISOString(),
    updatedBy: "Admin User"
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

  const generateQueueDocId = (sourceId: string, supplierCode: string, productName: string): string => {
    const sourcePart = generateSlug(sourceId) || 'supplier';
    const productPart = generateSlug(supplierCode || productName) || `${Date.now()}`;
    return `${sourcePart}-${productPart}`;
  };

  const toDateTimeLocalValue = (value?: string): string => {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    const timezoneOffsetMs = parsed.getTimezoneOffset() * 60000;
    return new Date(parsed.getTime() - timezoneOffsetMs).toISOString().slice(0, 16);
  };

  const fromDateTimeLocalValue = (value: string): string => {
    return value ? new Date(value).toISOString() : "";
  };

  const getSupplierApiHeaders = async () => {
    const user = auth.currentUser;
    if (!user) {
      throw new Error("Admin authentication is required. Please sign in again.");
    }

    const token = await user.getIdToken();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    };
  };

  const handleSyncSupplier = async (sourceIds?: string[]): Promise<boolean> => {
    setIsSyncing(true);
    setErrorMsg(null);
    setSyncStatusMsg("Initiating supplier synchronization checks...");
    
    try {
      const syncBatchId = `batch-${Date.now()}`;
      // 1. Fetch existing products from Firestore
      const querySnapshot = await getDocs(collection(db, "products"));
      const existingProducts: Product[] = [];
      querySnapshot.forEach((docSnap) => {
        existingProducts.push({ id: docSnap.id, ...docSnap.data() } as Product);
      });

      // 2. Fetch raw products from active website suppliers
      const activeSources = supplierSources.filter(src => 
        isActiveWebsiteSupplier(src) &&
        (!sourceIds || sourceIds.includes(src.id))
      );
      
      if (activeSources.length === 0) {
        throw new Error("No active Website supplier was found. Please enable a website supplier source in its Settings panel.");
      }

      const allFetchedProducts: any[] = [];
      const aggregatedMappedQueue: ReviewQueueItem[] = [];
      const aggregatedPendingChanges: any[] = [];
      let successCount = 0;
      let errorMsgs: string[] = [];

      for (const source of activeSources) {
        const urlToFetch = source.websiteUrl || source.config?.targetUrl || '';
        const endpointToFetch = source.endpoint || source.config?.apiEndpoint || '';
        
        if (!urlToFetch) continue;

        try {
          const res = await fetch('/api/fetch-supplier', {
            method: 'POST',
            headers: await getSupplierApiHeaders(),
            body: JSON.stringify({ websiteUrl: urlToFetch, endpoint: endpointToFetch })
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP error ${res.status}`);
          }

          const result = await res.json();
          if (result.success && Array.isArray(result.products)) {
            let fetched = result.products;

            // Apply Category Filter
            const catFilter = source.settings?.categoriesFilter || [];
            if (catFilter.length > 0) {
              fetched = fetched.filter((prod: RawA2ZProduct) => {
                const prodCats = prod.categoryHierarchy || [];
                return prodCats.some(c => 
                  catFilter.some(fc => fc.trim().toLowerCase() === c.trim().toLowerCase())
                ) || catFilter.some(fc => prod.title.toLowerCase().includes(fc.trim().toLowerCase()));
              });
            }

            // Apply Brand Filter
            const brandFilter = source.settings?.brandFilter || '';
            if (brandFilter) {
              const brands = brandFilter.split(',').map(b => b.trim().toLowerCase()).filter(Boolean);
              if (brands.length > 0) {
                fetched = fetched.filter((prod: RawA2ZProduct) => {
                  const prodBrand = prod.specifications?.brand || prod.specifications?.Brand || '';
                  return brands.some(b => 
                    prod.title.toLowerCase().includes(b) || 
                    prodBrand.toLowerCase().includes(b)
                  );
                });
              }
            }

            // Product Limit & "Download ONLY the first 5 products" constraint
            let limitNum = 5;
            if (source.settings?.productLimit && source.settings.productLimit !== 'All') {
              const savedLimit = parseInt(source.settings.productLimit, 10);
              if (!isNaN(savedLimit)) {
                limitNum = Math.min(5, savedLimit);
              }
            }
            
            const slicedProducts = fetched.slice(0, limitNum);

            // Map and compare each product
            const sourceMappedQueue: ReviewQueueItem[] = [];
            for (const prod of slicedProducts) {
              const supplierName = source.supplierName || source.name || 'A2Z Supplier';
              const queueItemId = generateQueueDocId(source.id, prod.sku, prod.title);
              const match = existingProducts.find(p => {
                if (p.supplierItemCode && p.supplierItemCode.trim().toLowerCase() === prod.sku.trim().toLowerCase()) {
                  return true;
                }
                if (p.sku && p.sku.trim().toLowerCase() === prod.sku.trim().toLowerCase()) {
                  return true;
                }
                if (p.id && p.id.trim().toLowerCase() === prod.sku.trim().toLowerCase()) {
                  return true;
                }
                const rawSlug = generateSlug(prod.title);
                if (p.id && p.id.trim().toLowerCase() === rawSlug.toLowerCase()) {
                  return true;
                }
                return false;
              });

              const changedFields: string[] = [];
              let comparisonStatus: 'NEW_PRODUCT' | 'PRICE_CHANGED' | 'STOCK_CHANGED' | 'DESCRIPTION_CHANGED' | 'IMAGE_CHANGED' | 'UNCHANGED' = 'NEW_PRODUCT';
              const matchFound = !!match;
              const matchedProductId = match ? match.id : null;

              if (match) {
                if (prod.title !== match.name) {
                  changedFields.push('Product Name');
                }
                if (prod.wholesalePrice !== match.costPrice) {
                  changedFields.push('Cost Price');
                }
                if (prod.recommendedRetailPrice !== match.marketPrice) {
                  changedFields.push('Market Price');
                }
                if (prod.inventoryLevel !== match.stock) {
                  changedFields.push('Stock');
                }
                if (prod.longDescription !== match.description) {
                  changedFields.push('Description');
                }
                const rawImage = prod.mediaGallery && prod.mediaGallery.length > 0 ? prod.mediaGallery[0] : '';
                const matchImage = match.imageUrl || '';
                if (rawImage !== matchImage) {
                  changedFields.push('Primary Image');
                }

                if (changedFields.length === 0) {
                  comparisonStatus = 'UNCHANGED';
                } else if (changedFields.includes('Cost Price') || changedFields.includes('Market Price')) {
                  comparisonStatus = 'PRICE_CHANGED';
                } else if (changedFields.includes('Stock')) {
                  comparisonStatus = 'STOCK_CHANGED';
                } else if (changedFields.includes('Primary Image')) {
                  comparisonStatus = 'IMAGE_CHANGED';
                } else {
                  comparisonStatus = 'DESCRIPTION_CHANGED';
                }
              }

              const comparisonResult: ComparisonResult = {
                matchFound,
                matchedProductId,
                comparisonStatus,
                changedFields
              };

              // Prepare product payload for approval (NOT written to Firestore yet)
              const docId = match ? match.id : (generateSlug(prod.title) || prod.sku);
              
              const wholesale = prod.wholesalePrice || 0;
              const retail = prod.recommendedRetailPrice || wholesale * 1.15;
              const price = Math.round(retail);
              const originalPrice = Math.round(retail * 1.1);
              const discount = 10;
              
              const imageUrl = prod.mediaGallery && prod.mediaGallery.length > 0 
                ? prod.mediaGallery[0] 
                : 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&q=80&w=600';
              const categoryName = prod.categoryHierarchy && prod.categoryHierarchy.length > 0 ? prod.categoryHierarchy[0] : 'electronics';
              const categorySlug = generateSlug(categoryName);

              const productPayload: Product & Record<string, unknown> = {
                id: docId,
                name: prod.title,
                description: prod.longDescription || '',
                price: price,
                originalPrice: originalPrice,
                discount: discount,
                stock: prod.inventoryLevel,
                imageUrl: imageUrl,
                imageUrls: prod.mediaGallery || [imageUrl],
                category: categorySlug,
                specs: prod.specifications || {},
                isNew: true,
                isFeatured: false,
                isBestSeller: false,
                isActive: true,
                active: true,
                published: true,
                approved: true,
                visible: true,
                sku: prod.sku,
                supplierItemCode: prod.sku,
                costPrice: wholesale,
                marketPrice: prod.recommendedRetailPrice || 0,
                rating: match ? (match.rating || 5) : 5,
                reviewsCount: match ? (match.reviewsCount || 0) : 0,
                createdAt: match ? (match.createdAt || new Date().toISOString()) : new Date().toISOString()
              };

              const queueItem: ReviewQueueItem = {
                id: queueItemId,
                status: 'Pending' as const,
                supplierCode: prod.sku,
                supplierName,
                source: 'Website',
                sourceId: source.id,
                batchId: syncBatchId,
                productName: prod.title,
                costPrice: prod.wholesalePrice,
                marketPrice: prod.recommendedRetailPrice,
                stock: prod.inventoryLevel,
                imageUrl: prod.mediaGallery && prod.mediaGallery.length > 0 ? prod.mediaGallery[0] : undefined,
                comparisonStatus,
                comparison: comparisonResult,
                productPayload: productPayload, // Store payload for approval
                matchedProductId: matchedProductId, // Store match info for approval
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              };

              sourceMappedQueue.push(queueItem);

              allFetchedProducts.push({
                ...prod,
                id: queueItemId,
                supplierCode: prod.sku,
                supplierName,
                source: 'Website',
                sourceId: source.id,
                batchId: syncBatchId,
                importStatus: 'Pending',
                progress: 0,
                createdAt: queueItem.createdAt,
                updatedAt: queueItem.updatedAt
              });
            }

            aggregatedMappedQueue.push(...sourceMappedQueue);

            // Generate pending changes for this source
            const sourcePendingChanges = sourceMappedQueue
              .filter(item => item.comparisonStatus !== 'UNCHANGED' && item.comparisonStatus !== 'NEW_PRODUCT')
              .map(item => {
                let oldValue = '';
                let newValue = '';
                const matchedProduct = existingProducts.find(p => {
                  if (p.supplierItemCode && p.supplierItemCode.trim().toLowerCase() === item.supplierCode.trim().toLowerCase()) {
                    return true;
                  }
                  if (p.sku && p.sku.trim().toLowerCase() === item.supplierCode.trim().toLowerCase()) {
                    return true;
                  }
                  if (p.id && p.id.trim().toLowerCase() === item.supplierCode.trim().toLowerCase()) {
                    return true;
                  }
                  return false;
                });

                if (item.comparisonStatus === 'PRICE_CHANGED') {
                  oldValue = matchedProduct ? `LKR ${(matchedProduct.costPrice || 0).toLocaleString()}` : 'Unknown';
                  newValue = `LKR ${(item.costPrice || 0).toLocaleString()}`;
                } else if (item.comparisonStatus === 'STOCK_CHANGED') {
                  oldValue = matchedProduct ? `${matchedProduct.stock || 0} units` : 'Unknown';
                  newValue = `${item.stock || 0} units`;
                } else if (item.comparisonStatus === 'IMAGE_CHANGED') {
                  oldValue = matchedProduct?.imageUrl || '';
                  newValue = item.imageUrl || '';
                } else {
                  oldValue = 'Previous description';
                  newValue = 'Updated description';
                }

                return {
                  id: `change-${item.id}`,
                  reviewQueueItemId: item.id,
                  productName: item.productName,
                  supplierCode: item.supplierCode,
                  supplierName: item.supplierName || source.supplierName || source.name || 'A2Z Supplier',
                  changeType: item.comparisonStatus,
                  source: 'Website',
                  sourceId: source.id,
                  batchId: syncBatchId,
                  detectedAt: new Date().toISOString(),
                  createdAt: new Date().toISOString(),
                  oldValue,
                  newValue,
                  status: 'Pending',
                  productPayload: item.productPayload,
                  matchedProductId: item.matchedProductId
                };
              });

            aggregatedPendingChanges.push(...sourcePendingChanges);
            successCount++;

            // Update source status in firestore to 'connected' and lastSync timestamp
            await setDoc(doc(db, "supplierSources", source.id), {
              lastSync: new Date().toLocaleString(),
              connectionStatus: 'connected',
              lastError: 'None'
            }, { merge: true });
          } else {
            throw new Error(result.error || "Invalid response format from server");
          }
        } catch (err: any) {
          console.error(`Error syncing source ${source.id}:`, err);
          errorMsgs.push(`${source.supplierName || source.name || source.id}: ${err.message}`);

          // Update source status in firestore to 'Failed'
          await setDoc(doc(db, "supplierSources", source.id), {
            connectionStatus: 'Failed',
            lastError: err.message || "Failed to fetch from supplier endpoint"
          }, { merge: true });
        }
      }

      if (successCount === 0) {
        throw new Error(`Failed to sync from configured suppliers. Errors: ${errorMsgs.join("; ")}`);
      }

      const data: any[] = allFetchedProducts;
      const mappedQueue = aggregatedMappedQueue;
      
      const newCount = mappedQueue.filter(item => item.comparison?.comparisonStatus === 'NEW_PRODUCT').length;
      const priceCount = mappedQueue.filter(item => item.comparison?.comparisonStatus === 'PRICE_CHANGED').length;
      const stockCount = mappedQueue.filter(item => item.comparison?.comparisonStatus === 'STOCK_CHANGED').length;
      const imageCount = mappedQueue.filter(item => item.comparison?.comparisonStatus === 'IMAGE_CHANGED' || item.comparison?.comparisonStatus === 'DESCRIPTION_CHANGED').length;

      const newLog: SyncHistoryItem = {
        id: syncBatchId,
        timestamp: new Date().toLocaleTimeString(),
        createdAt: new Date().toISOString(),
        batchId: syncBatchId,
        supplierCode: 'A2Z',
        productsSynced: data.length,
        status: 'Success',
        details: `Successfully fetched and compared ${data.length} products. Found ${newCount} new, ${priceCount} price changes, ${stockCount} stock changes.`
      };

      const batch = writeBatch(db);
      mappedQueue.forEach((item) => {
        batch.set(doc(db, "supplier_review_queue", item.id), item, { merge: true });
      });
      data.forEach((item) => {
        batch.set(doc(db, "supplier_import_queue", item.id), item, { merge: true });
      });
      aggregatedPendingChanges.forEach((change) => {
        batch.set(doc(db, "supplier_pending_changes", change.id), change, { merge: true });
      });
      batch.set(doc(db, "supplier_sync_history", newLog.id), newLog, { merge: true });
      await batch.commit();
      
      setSyncStatusMsg("Synchronization complete!");
      setTimeout(() => {
        setSyncStatusMsg(null);
      }, 3000);
      return true;

    } catch (err: any) {
      console.error("Error syncing supplier products:", err);
      setErrorMsg(err.message || "Failed to fetch from supplier endpoint");
      
      const failedLog: SyncHistoryItem = {
        id: `log-${Date.now()}`,
        timestamp: new Date().toLocaleTimeString(),
        createdAt: new Date().toISOString(),
        supplierCode: 'A2Z',
        productsSynced: 0,
        status: 'Failed',
        details: err.message || "Network request failed."
      };
      await setDoc(doc(db, "supplier_sync_history", failedLog.id), failedLog, { merge: true }).catch((historyErr) => {
        handleFirestoreError(historyErr, OperationType.WRITE, `supplier_sync_history/${failedLog.id}`);
      });
      setSyncStatusMsg(null);
      return false;
    } finally {
      setIsSyncing(false);
    }
  };

  // --- CONNECT SUPPLIER HANDLERS ---
  const handleModalTestConnection = async () => {
    if (newSupplierType === 'website' && !newSupplierUrl.trim()) {
      setModalTestStatus('Failed');
      setModalTestError("Website URL is required to test connection.");
      return;
    }

    setModalTestStatus('testing');
    setModalTestError(null);
    setModalTestProductsCount(null);

    const targetUrl = newSupplierType === 'website' ? newSupplierUrl.trim() : apiEndpoint.trim();
    const endpointPath = newSupplierType === 'website' ? apiEndpoint.trim() : '';

    try {
      const response = await fetch('/api/test-supplier', {
        method: 'POST',
        headers: await getSupplierApiHeaders(),
        body: JSON.stringify({
          websiteUrl: targetUrl,
          endpoint: endpointPath
        })
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
    const endpointToTest = source.endpoint || source.config?.apiEndpoint || '';

    if (!urlToTest) {
      setErrorMsg(`Missing Website URL for supplier: ${source.name}`);
      setTimeout(() => setErrorMsg(null), 4000);
      return;
    }

    setTestingSourceId(source.id);
    setSuccessMsg(`Testing connection to ${source.name}...`);
    
    try {
      const response = await fetch('/api/test-supplier', {
        method: 'POST',
        headers: await getSupplierApiHeaders(),
        body: JSON.stringify({
          websiteUrl: urlToTest,
          endpoint: endpointToTest
        })
      });

      const result = await response.json();

      if (result.success) {
        setSuccessMsg(`Connection successful! Discovered ${result.productsCount} products for ${source.name}.`);
        setTimeout(() => setSuccessMsg(null), 4000);
        
        // Save connectionStatus = 'connected' in Firestore
        await setDoc(doc(db, "supplierSources", source.id), {
          connectionStatus: 'connected',
          lastError: 'None',
          lastSync: new Date().toLocaleString()
        }, { merge: true });
      } else {
        setErrorMsg(`Connection failed for ${source.name}: ${result.error || 'Endpoint returned error response.'}`);
        setTimeout(() => setErrorMsg(null), 5000);

        // Save connectionStatus = 'Failed' in Firestore
        await setDoc(doc(db, "supplierSources", source.id), {
          connectionStatus: 'Failed',
          lastError: result.error || 'Endpoint returned error response.'
        }, { merge: true });
      }
    } catch (err: any) {
      console.error("Test connection error:", err);
      setErrorMsg(`Network error during connection test: ${err.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 5000);

      await setDoc(doc(db, "supplierSources", source.id), {
        connectionStatus: 'Failed',
        lastError: err.message || 'Network request failed.'
      }, { merge: true });
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

    const configData: any = {
      description: newSupplierDesc.trim()
    };

    if (newSupplierType === 'website') {
      configData.targetUrl = newSupplierUrl.trim();
      configData.cssPriceSelector = cssPriceSelector.trim();
      configData.cssStockSelector = cssStockSelector.trim();
      configData.cssImageSelector = cssImageSelector.trim();
    } else if (newSupplierType === 'api') {
      configData.apiEndpoint = apiEndpoint.trim();
      configData.apiMethod = apiMethod;
      configData.apiHeaders = apiHeaders.trim();
      configData.apiDataPath = apiDataPath.trim();
    } else if (newSupplierType === 'whatsapp') {
      configData.whatsappNumber = whatsappNumber.trim();
      configData.whatsappSender = whatsappSender.trim();
      configData.whatsappKeywords = whatsappKeywords.trim();
      configData.whatsappFormat = whatsappFormat.trim();
    }

    const newSource = {
      id: code,
      supplierName: newSupplierName.trim(),
      websiteUrl: newSupplierType === 'website' ? newSupplierUrl.trim() : (newSupplierType === 'api' ? apiEndpoint.trim() : ''),
      endpoint: newSupplierType === 'website' ? apiEndpoint.trim() : '',
      supplierType: newSupplierType,
      connectionStatus: modalTestStatus === 'Connected' ? 'connected' : 'Not Synced',
      sourceStatus: 'active',
      lastSync: null,
      lastError: modalTestError || 'None',
      config: configData,
      createdAt: new Date().toISOString()
    };

    try {
      await setDoc(doc(db, "supplierSources", code), newSource);
      
      // Reset form fields, test states, and modal
      setWizardStep(1);
      setNewSupplierName("");
      setNewSupplierCode("");
      setNewSupplierDesc("");
      setNewSupplierUrl("");
      setCssPriceSelector(".product-price");
      setCssStockSelector(".instock-status");
      setCssImageSelector(".product-image img");
      setApiEndpoint("");
      setApiMethod("GET");
      setApiHeaders('{\n  "Content-Type": "application/json"\n}');
      setApiDataPath("products");
      setWhatsappNumber("");
      setWhatsappSender("");
      setWhatsappKeywords("STOCK_UPDATE, PRICE_CHANGE");
      setWhatsappFormat("Code: {code}, Qty: {qty}");
      
      setModalTestStatus('idle');
      setModalTestError(null);
      setModalTestProductsCount(null);
      
      setShowConnectModal(false);
      setSuccessMsg(`Supplier "${newSupplierName}" successfully connected to "supplierSources"!`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err) {
      console.error("Firestore save error:", err);
      setErrorMsg("Failed to save supplier configuration to Firestore. Please check security rules.");
      setTimeout(() => setErrorMsg(null), 5000);
      handleFirestoreError(err, OperationType.WRITE, `supplierSources/${code}`);
    } finally {
      setSavingSupplier(false);
    }
  };

  const handleTriggerSync = async (id: string) => {
    setSyncingSourceId(id);
    setSuccessMsg(`Supplier synchronization started for feed ID: ${id}...`);
    try {
      const succeeded = await handleSyncSupplier([id]);
      if (succeeded) {
        setSuccessMsg(`Supplier synchronization completed for feed ID: ${id}. Review the queued results before publishing.`);
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
      
      await setDoc(doc(db, "supplierSources", sourceId), updatedData, { merge: true });
      
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
      const linkedReviewItem = reviewQueue.find(item => item.id === change.reviewQueueItemId);
      const queueDecisionItem = {
        ...linkedReviewItem,
        ...change,
        id: change.id,
        productPayload: change.productPayload || linkedReviewItem?.productPayload,
        reviewQueueItemId: change.reviewQueueItemId || linkedReviewItem?.id
      };

      await approveSupplierQueueItem(queueDecisionItem);
      console.log(`[Approval Pipeline] Successfully approved and wrote product for queue item: ${change.id}`);

      setProcessingChangeId(null);
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
      // Only update local state - do NOT write to Firestore
      await rejectSupplierQueueItem(change);
      setProcessingChangeId(null);
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
  const handleApproveReviewItem = async (item: ReviewQueueItem) => {
    setProcessingChangeId(item.id);
    try {
      await approveSupplierQueueItem(item);
      console.log(`[Approval Pipeline] Successfully approved and wrote product for queue item: ${item.id}`);

      setProcessingChangeId(null);
      setSuccessMsg(`Product "${item.productName}" approved successfully.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      console.error("Review approval error:", error);
      setErrorMsg(`Failed to approve: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 4000);
      setProcessingChangeId(null);
    }
  };

  const handleRejectReviewItem = async (item: ReviewQueueItem) => {
    setProcessingChangeId(item.id);
    try {
      // Only update local state - do NOT write to Firestore
      await rejectSupplierQueueItem(item);
      setProcessingChangeId(null);
      setSuccessMsg(`Product "${item.productName}" rejected.`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      console.error("Review rejection error:", error);
      setErrorMsg(`Failed to reject: ${error.message || 'Unknown error'}`);
      setTimeout(() => setErrorMsg(null), 4000);
      setProcessingChangeId(null);
    }
  };

  // --- SETTINGS CONFIGURATION HANDLERS ---
  const handleSaveSupplierSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSupplierSettings(true);
    try {
      const email = auth.currentUser?.email || "Admin";
      const payload = {
        ...supplierSettings,
        lastUpdated: new Date().toISOString(),
        updatedBy: email
      };
      await setDoc(doc(db, "supplier_settings", "config"), payload, { merge: true });
      setSavingSupplierSettings(false);
      setSuccessMsg("Supplier Hub control settings saved successfully.");
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      console.error("Save supplier settings failed:", error);
      setErrorMsg(error.message || "Failed to save supplier settings.");
      setTimeout(() => setErrorMsg(null), 4000);
      setSavingSupplierSettings(false);
    }
  };

  const handleResetSettings = async () => {
    const defaults = {
      websiteSyncEnabled: false,
      whatsappSyncEnabled: false,
      autoSyncEnabled: true,
      autoImageDownload: true,
      notificationEnabled: true,
      syncInterval: "1 Hour",
      maxProducts: 5,
      enabledSupplierIds: [],
      lastSync: "",
      nextSync: "",
      defaultProfitMargin: 15,
      defaultMarkup: 10,
      defaultImageLimit: 5,
      lastUpdated: new Date().toISOString(),
      updatedBy: "System Default"
    };

    try {
      await setDoc(doc(db, "supplier_settings", "config"), defaults, { merge: true });
      setSupplierSettings(defaults);
      setShowResetSettingsConfirm(false);
      setSuccessMsg("Supplier Hub control settings reset to system defaults.");
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (error: any) {
      console.error("Reset supplier settings failed:", error);
      setErrorMsg(error.message || "Failed to reset supplier settings.");
      setTimeout(() => setErrorMsg(null), 4000);
    }
  };

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
            Supplier Hub ⭐⭐⭐⭐⭐
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Pragmatic distributor workflow panel for automated catalog feed synchronization.
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
              <span>{isSyncing ? 'Syncing...' : 'Sync Supplier'}</span>
            </button>
          ) : activeSubTab === 'sources' ? (
            <button
              onClick={() => setShowConnectModal(true)}
              className="w-full sm:w-auto px-5 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold rounded-xl text-xs transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center space-x-2 cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              <span>Connect Supplier</span>
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

      {errorMsg && (
        <motion.div 
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-3.5 bg-red-500/10 text-red-500 text-xs font-semibold rounded-2xl border border-red-500/20 flex items-center gap-2"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
          <span>{errorMsg}</span>
        </motion.div>
      )}

      {/* WORKFLOW SUB-TABS NAVIGATION BAR */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-1.5 overflow-x-auto">
        {[
          { id: 'review', label: 'Review Queue & Ingestion', badge: reviewQueue.length, icon: UserCheck, badgeColor: 'bg-blue-500 text-white animate-pulse' },
          { id: 'import_queue', label: 'Import Queue', badge: importQueue.length, icon: FileText, badgeColor: 'bg-slate-500 text-white' },
          { id: 'sources', label: 'Supplier Sources', badge: supplierSources.length, icon: Globe },
          { id: 'changes', label: 'Pending Changes', badge: supplierPendingChanges.filter(c => c.status === 'Pending').length, icon: SlidersHorizontal, badgeColor: 'bg-amber-500 text-slate-900' },
          { id: 'settings', label: 'Settings', badge: null, icon: Settings },
        ].map((tab) => {
          const TabIcon = tab.icon;
          const isSubActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id as any)}
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

        {/* VIEW 1: REVIEW QUEUE & INGESTION (Existing view) */}
        {activeSubTab === 'review' && (
          <div className="space-y-8">
            {/* statistics cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
              {/* Card 1: New Products */}
              <div className={`rounded-3xl p-5 border flex flex-col justify-between transition-all hover:shadow-xl relative overflow-hidden group ${
                isDarkMode ? 'bg-gradient-to-b from-[#111c30] to-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
              }`}>
                <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-full blur-xl group-hover:bg-blue-500/10 transition-all duration-500" />
                <div className="flex items-center justify-between relative z-10">
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">New Products</span>
                  <div className="w-9 h-9 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center font-black">
                    <PlusCircle className="h-4.5 w-4.5" />
                  </div>
                </div>
                <div className="mt-4 text-left relative z-10">
                  <p className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                    {newProducts}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-1">Pending approval to import</p>
                </div>
              </div>

              {/* Card 2: Price Changes */}
              <div className={`rounded-3xl p-5 border flex flex-col justify-between transition-all hover:shadow-xl relative overflow-hidden group ${
                isDarkMode ? 'bg-gradient-to-b from-[#111c30] to-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
              }`}>
                <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/5 rounded-full blur-xl group-hover:bg-purple-500/10 transition-all duration-500" />
                <div className="flex items-center justify-between relative z-10">
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">Price Changes</span>
                  <div className="w-9 h-9 rounded-xl bg-purple-500/10 text-purple-500 flex items-center justify-center font-black">
                    <Tag className="h-4.5 w-4.5" />
                  </div>
                </div>
                <div className="mt-4 text-left relative z-10">
                  <p className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                    {priceChanges}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-1">Updates to catalog pricing</p>
                </div>
              </div>

              {/* Card 3: Stock Changes */}
              <div className={`rounded-3xl p-5 border flex flex-col justify-between transition-all hover:shadow-xl relative overflow-hidden group ${
                isDarkMode ? 'bg-gradient-to-b from-[#111c30] to-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
              }`}>
                <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-full blur-xl group-hover:bg-amber-500/10 transition-all duration-500" />
                <div className="flex items-center justify-between relative z-10">
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">Stock Changes</span>
                  <div className="w-9 h-9 rounded-xl bg-amber-500/10 text-amber-500 flex items-center justify-center font-black">
                    <Boxes className="h-4.5 w-4.5" />
                  </div>
                </div>
                <div className="mt-4 text-left relative z-10">
                  <p className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                    {stockChanges}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-1">Inventory level fluctuations</p>
                </div>
              </div>

              {/* Card 4: Image Changes */}
              <div className={`rounded-3xl p-5 border flex flex-col justify-between transition-all hover:shadow-xl relative overflow-hidden group ${
                isDarkMode ? 'bg-gradient-to-b from-[#111c30] to-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
              }`}>
                <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-xl group-hover:bg-emerald-500/10 transition-all duration-500" />
                <div className="flex items-center justify-between relative z-10">
                  <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">Image Changes</span>
                  <div className="w-9 h-9 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center font-black">
                    <Camera className="h-4.5 w-4.5" />
                  </div>
                </div>
                <div className="mt-4 text-left relative z-10">
                  <p className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                    {imageChanges}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-1">New media files identified</p>
                </div>
              </div>
            </div>

            {/* Review Queue Table card */}
            <div className={`rounded-3xl border p-6 ${
              isDarkMode ? 'bg-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
            }`}>
              <div className="flex items-center justify-between mb-5">
                <div className="text-left">
                  <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-1.5">
                    <UserCheck className="h-4 w-4 text-blue-500" />
                    <span>Review Queue</span>
                  </h3>
                  <p className="text-[11px] text-slate-400">Incoming products or changes awaiting admin action.</p>
                </div>
                <div className="relative w-full max-w-xs">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={reviewSearch}
                    onChange={(event) => setReviewSearch(event.target.value)}
                    placeholder="Search product or supplier code..."
                    aria-label="Search Review Queue"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs focus:outline-none dark:border-slate-800 dark:bg-slate-900/50"
                  />
                </div>
              </div>

              {reviewQueue.filter((item) => matchesSupplierSearch(item, reviewSearch)).length === 0 ? (
                <div className="p-12 text-center rounded-2xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                  <UserCheck className="h-10 w-10 text-slate-300 mx-auto" />
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-slate-900 dark:text-white">No supplier updates found.</p>
                    <p className="text-xs text-slate-400">Check back later or run a new sync to search for updates.</p>
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                        <th className="py-3 px-4 w-16">Image</th>
                        <th className="py-3 px-4">Product Code</th>
                        <th className="py-3 px-4">Product Name</th>
                        <th className="py-3 px-4 text-right">Cost Price</th>
                        <th className="py-3 px-4 text-right">Market Price</th>
                        <th className="py-3 px-4 text-right">Stock</th>
                        <th className="py-3 px-4 text-right">Comparison</th>
                        <th className="py-3 px-4 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reviewQueue.filter((item) => matchesSupplierSearch(item, reviewSearch)).map((item) => (
                        <tr key={item.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-900/30">
                          <td className="py-3 px-4">
                            {item.imageUrl ? (
                              <img 
                                src={item.imageUrl} 
                                alt={item.productName} 
                                className="w-10 h-10 object-cover rounded-lg border border-slate-200 dark:border-slate-800"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <div className="w-10 h-10 bg-slate-100 dark:bg-slate-800 rounded-lg flex items-center justify-center text-slate-400 font-bold text-[9px] uppercase">
                                No Img
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 font-mono font-medium">{item.supplierCode}</td>
                          <td className="py-3 px-4 font-semibold">{item.productName}</td>
                          <td className="py-3 px-4 text-right font-bold text-slate-900 dark:text-white">
                            LKR {item.costPrice.toLocaleString()}
                          </td>
                          <td className="py-3 px-4 text-right font-bold text-slate-900 dark:text-white">
                            LKR {item.marketPrice.toLocaleString()}
                          </td>
                          <td className="py-3 px-4 text-right font-semibold text-slate-600 dark:text-slate-400">
                            {item.stock} units
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
                                      : 'bg-slate-500'
                                  }`} />
                                  {item.comparison.comparisonStatus === 'NEW_PRODUCT' && 'NEW'}
                                  {item.comparison.comparisonStatus === 'PRICE_CHANGED' && 'PRICE CHANGED'}
                                  {item.comparison.comparisonStatus === 'STOCK_CHANGED' && 'STOCK CHANGED'}
                                  {item.comparison.comparisonStatus === 'IMAGE_CHANGED' && 'IMAGE CHANGED'}
                                  {item.comparison.comparisonStatus === 'DESCRIPTION_CHANGED' && 'DESC CHANGED'}
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
                              <span className="text-slate-400 font-bold text-[10px]">Pending Compare</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <span className="px-2.5 py-1 bg-amber-500/10 text-amber-500 rounded-md text-[11px] font-bold">
                              {item.status}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            {item.status === 'Pending' && (
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => handleApproveReviewItem(item)}
                                  disabled={processingChangeId === item.id}
                                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 text-white font-bold rounded-lg text-[10px] transition-colors flex items-center gap-1 cursor-pointer"
                                >
                                  <Check className="h-3 w-3" />
                                  Approve
                                </button>
                                <button
                                  onClick={() => handleRejectReviewItem(item)}
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
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Sync History Table card */}
            <div className={`rounded-3xl border p-6 ${
              isDarkMode ? 'bg-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
            }`}>
              <div className="flex items-center justify-between mb-5">
                <div className="text-left">
                  <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-1.5">
                    <History className="h-4 w-4 text-blue-500" />
                    <span>Sync History</span>
                  </h3>
                  <p className="text-[11px] text-slate-400">History log of automated execution runs and manual sync sessions.</p>
                </div>
              </div>

              {syncHistory.length === 0 ? (
                <div className="p-12 text-center rounded-2xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                  <History className="h-10 w-10 text-slate-300 mx-auto" />
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-slate-900 dark:text-white">No data available.</p>
                    <p className="text-xs text-slate-400">There are no records in the synchronization logs yet.</p>
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 dark:border-slate-800 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                        <th className="py-3 px-4">Timestamp</th>
                        <th className="py-3 px-4">Supplier Code</th>
                        <th className="py-3 px-4">Products Synced</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {syncHistory.map((log) => (
                        <tr key={log.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-900/30">
                          <td className="py-3 px-4 text-slate-500">{log.timestamp}</td>
                          <td className="py-3 px-4 font-mono font-bold">{log.supplierCode}</td>
                          <td className="py-3 px-4 font-medium">{log.productsSynced}</td>
                          <td className="py-3 px-4 font-bold">{log.status}</td>
                          <td className="py-3 px-4 text-slate-400">{log.details}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* VIEW: IMPORT QUEUE */}
        {activeSubTab === 'import_queue' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900/20 p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Import Ingestion Queue</h3>
                <p className="text-[11px] text-slate-400">Temporary workspace for staging, validating, and pre-comparing downloaded supplier items before commit.</p>
              </div>
              <div className="shrink-0">
                <span className="text-[10px] text-slate-400 font-mono bg-slate-100 dark:bg-slate-800/50 px-2.5 py-1 rounded-lg border border-slate-200/50 dark:border-slate-800">
                  {importQueue.length} Items in Queue
                </span>
              </div>
              <div className="relative w-full max-w-xs">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={importSearch}
                  onChange={(event) => setImportSearch(event.target.value)}
                  placeholder="Search product or supplier code..."
                  aria-label="Search Import Queue"
                  className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-xs focus:outline-none dark:border-slate-800 dark:bg-slate-900/50"
                />
              </div>
            </div>

            {importQueue.filter((item) => matchesSupplierSearch(item, importSearch)).length === 0 ? (
              /* Empty State */
              <div className="p-16 text-center rounded-3xl border border-dashed border-slate-250 dark:border-slate-800 bg-slate-50/30 dark:bg-[#111928]/30 space-y-4 max-w-xl mx-auto my-6">
                <div className="w-14 h-14 bg-blue-500/10 text-blue-500 rounded-2xl flex items-center justify-center mx-auto shadow-inner">
                  <FileText className="h-6 w-6" />
                </div>
                <div className="space-y-1.5">
                  <h4 className="text-sm font-black text-slate-900 dark:text-white">Import Queue is Empty</h4>
                  <p className="text-[11.5px] text-slate-400 max-w-sm mx-auto leading-relaxed">
                    No supplier feed products are currently staged in the queue. Trigger a synchronization task from the <strong>Supplier Sources</strong> tab to pull items into this view before comparison.
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
                    {importQueue.filter((item) => matchesSupplierSearch(item, importSearch)).map((item) => (
                      <tr key={item.sku} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-900/30">
                        <td className="py-3 px-4">
                          {item.mediaGallery && item.mediaGallery.length > 0 ? (
                            <img 
                              src={item.mediaGallery[0]} 
                              alt={item.title} 
                              className="w-10 h-10 object-cover rounded-lg border border-slate-200 dark:border-slate-800"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-10 h-10 bg-slate-100 dark:bg-slate-800 rounded-lg flex items-center justify-center text-slate-400 font-bold text-[9px] uppercase">
                              No Img
                            </div>
                          )}
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
          </div>
        )}

        {/* VIEW 2: SUPPLIER SOURCES & CONNECT */}
        {activeSubTab === 'sources' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Connected Feeds</h3>
                <p className="text-[11px] text-slate-400">Direct endpoints parsed for catalog updates, inventory streams, and pricing matrices.</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-slate-400 font-mono bg-slate-100 dark:bg-slate-800/50 px-2.5 py-1 rounded-lg border border-slate-200/50 dark:border-slate-800">
                  {supplierSources.length || 0} Connected Feed(s)
                </span>
              </div>
            </div>

            {/* Sync All Feeds Action Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 rounded-3xl bg-slate-50 dark:bg-[#101827]/40 border border-slate-200/50 dark:border-slate-800/60">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-blue-500/10 text-blue-500 rounded-xl">
                  <Activity className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-white">Batch Synchronization Controls</h4>
                  <p className="text-[10px] text-slate-400 font-medium">Trigger sync tasks for all active distributor feeds simultaneously.</p>
                </div>
              </div>
              <button
                type="button"
                  onClick={() => handleSyncSupplier()}
                  disabled={isSyncing}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold rounded-xl text-xs flex items-center justify-center space-x-2 cursor-pointer transition-all shadow-md shadow-blue-500/10 hover:shadow-lg hover:shadow-blue-500/20"
              >
                <RefreshCw className="h-3.5 w-3.5 animate-pulse" />
                <span>Sync All Feeds</span>
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
                          {source.type === 'whatsapp' ? (
                            <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-500 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-emerald-500/20">
                              <Phone className="h-2.5 w-2.5" /> WhatsApp
                            </span>
                          ) : source.type === 'api' ? (
                            <span className="px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-500 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-blue-500/20">
                              <Activity className="h-2.5 w-2.5" /> API Feed
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-500 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-amber-500/20">
                              <Globe className="h-2.5 w-2.5" /> Website
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-400 font-mono">ID: {source.id}</p>
                        {source.websiteUrl && (
                          <p className="text-[10px] text-blue-500 hover:underline break-all mt-1 flex items-center gap-1 font-medium">
                            <a href={source.websiteUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1">
                              <Globe className="h-3 w-3 shrink-0" /> {source.websiteUrl}
                            </a>
                          </p>
                        )}
                        {source.endpoint && (
                          <p className="text-[9px] text-slate-400/80 font-mono mt-0.5 break-all">
                            Endpoint: {source.endpoint}
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
                        <span className="text-slate-400 font-bold block text-[10px] uppercase">Last Synchronization</span>
                        <span className="text-slate-700 dark:text-slate-200 font-medium font-mono">{source.lastSync || 'Never'}</span>
                      </div>
                      <div className="space-y-0.5">
                        <span className="text-slate-400 font-bold block text-[10px] uppercase">Operational Status</span>
                        <span className="font-bold text-emerald-500 capitalize">{source.sourceStatus || 'active'}</span>
                      </div>
                      <div className="col-span-2 space-y-0.5 border-t border-slate-100 dark:border-slate-800/40 pt-2">
                        <span className="text-slate-400 font-bold block text-[10px] uppercase">Last Recorded Error</span>
                        <span className="text-slate-400 font-medium block truncate">
                          {source.lastError || 'None'}
                        </span>
                      </div>
                    </div>

                    <div className="mt-5 flex items-center justify-between gap-3 flex-wrap sm:flex-nowrap">
                      <div className="flex items-center gap-1 text-[10px] text-slate-400">
                        <Info className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                        <span>Connected via server proxy link</span>
                      </div>
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
                          <span>Settings</span>
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
                          disabled={syncingSourceId !== null || testingSourceId !== null}
                          className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:opacity-50 text-white font-bold rounded-lg text-[10px] flex items-center gap-1.5 cursor-pointer transition-colors"
                        >
                          <RefreshCw className={`h-3 w-3 ${syncingSourceId === source.id ? 'animate-spin' : ''}`} />
                          <span>{syncingSourceId === source.id ? 'Syncing...' : 'Sync Now'}</span>
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
                            Supplier Settings Engine
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

                            <div className="space-y-1 col-span-1 sm:col-span-2">
                              <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500">
                                Endpoint
                              </label>
                              <input
                                type="text"
                                value={editEndpoint}
                                onChange={(e) => setEditEndpoint(e.target.value)}
                                className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white font-mono"
                                placeholder="/api/products"
                              />
                            </div>
                          </div>
                        </div>

                        {/* SYNC SETTINGS */}
                        <div className="space-y-4">
                          <div className="border-b border-slate-100 dark:border-slate-800 pb-1.5">
                            <span className="text-[10px] font-extrabold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                              Sync Settings
                            </span>
                          </div>

                          {/* Category Filter Multi-select */}
                          <div className="space-y-2">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500 block">
                              Category Filter (Multi Select)
                            </label>
                            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1.5 bg-slate-50 dark:bg-slate-900/30 border border-slate-100 dark:border-slate-800 rounded-xl">
                              {(categories.length > 0 ? categories : [
                                { id: 'electronics', name: 'Electronics' },
                                { id: 'accessories', name: 'Accessories' },
                                { id: 'wearables', name: 'Wearables' },
                                { id: 'audio', name: 'Audio' },
                                { id: 'covers', name: 'Covers' },
                                { id: 'peripherals', name: 'Peripherals' }
                              ]).map((cat: any) => {
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

                          {/* Product Limit */}
                          <div className="space-y-2">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500 block">
                              Product Limit
                            </label>
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

                          {/* Sync Mode */}
                          <div className="space-y-2">
                            <label className="text-[10px] font-bold text-slate-400 dark:text-slate-500 block">
                              Sync Mode
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
                              Auto Sync
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

                          {/* Dry Run Mode */}
                          <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900/20 border border-slate-100 dark:border-slate-800/60 rounded-xl">
                            <div className="space-y-0.5">
                              <span className="text-xs font-bold text-slate-800 dark:text-slate-200 block">Dry Run Mode</span>
                              <span className="text-[10px] text-slate-400 font-medium">Staged comparison only, do not write database logs.</span>
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

        {/* VIEW 3: PENDING CHANGES */}
        {activeSubTab === 'changes' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900/20 p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Pending Changes</h3>
                <p className="text-[11px] text-slate-400">Streamed fluctuations detected in supplier feeds comparing real-time feed elements against live catalog listings.</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] text-blue-500 font-bold bg-blue-500/10 px-2.5 py-1 rounded-lg border border-blue-500/20 font-mono">
                  {supplierPendingChanges.length} Total Logs
                </span>
                <span className="text-[10px] text-amber-500 font-bold bg-amber-500/10 px-2.5 py-1 rounded-lg border border-amber-500/20 font-mono">
                  {supplierPendingChanges.filter(x => x.status === 'Pending').length} Pending
                </span>
              </div>
            </div>

            {/* Filter and Search Bar */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 dark:bg-[#111928] p-1.5 rounded-2xl border border-slate-200/50 dark:border-slate-800/60 w-fit">
                {(['All', 'Pending', 'Approved', 'Rejected'] as const).map((tab) => {
                  const count = tab === 'All' 
                    ? supplierPendingChanges.length 
                    : supplierPendingChanges.filter(x => x.status === tab).length;
                  return (
                    <button
                      key={tab}
                      onClick={() => setPendingChangesFilter(tab)}
                      className={`px-4 py-1.5 text-xs font-bold rounded-xl transition-all flex items-center gap-2 cursor-pointer ${
                        pendingChangesFilter === tab
                          ? 'bg-blue-600 text-white shadow-md shadow-blue-500/10'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      <span>{tab}</span>
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md ${
                        pendingChangesFilter === tab
                          ? 'bg-white/20 text-white'
                          : 'bg-slate-200 dark:bg-slate-800 text-slate-500'
                      }`}>{count}</span>
                    </button>
                  );
                })}
              </div>

              <div className="relative flex-1 max-w-md w-full">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by Product Name or Supplier Code..."
                  value={pendingChangesSearch}
                  onChange={(e) => setPendingChangesSearch(e.target.value)}
                  className="w-full pl-10 pr-10 py-2.5 text-xs bg-slate-100 dark:bg-[#111928] text-slate-900 dark:text-white border border-slate-200/50 dark:border-slate-800/60 rounded-2xl focus:outline-hidden focus:border-blue-500/50"
                />
                {pendingChangesSearch && (
                  <button
                    onClick={() => setPendingChangesSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Pending Changes List */}
            {(() => {
              const filteredChanges = supplierPendingChanges.filter((change) => {
                const matchesSearch = 
                  matchesSupplierSearch(change, pendingChangesSearch);

                if (!matchesSearch) return false;

                if (pendingChangesFilter !== 'All') {
                  return change.status === pendingChangesFilter;
                }
                return true;
              });

              if (filteredChanges.length === 0) {
                return (
                  <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                    <SlidersHorizontal className="h-10 w-10 text-slate-300 mx-auto" />
                    <div className="space-y-1">
                      <p className="text-sm font-bold text-slate-900 dark:text-white">No matches found</p>
                      <p className="text-xs text-slate-400">All processed updates match live configurations perfectly.</p>
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

                        {change.status === 'Pending' ? (
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
          </div>
        )}

        {/* VIEW 4: CONFIGURATION SETTINGS */}
        {activeSubTab === 'settings' && (
          <div className="space-y-6 text-left">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900/20 p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40">
              <div>
                <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Hub Control Settings</h3>
                <p className="text-[11px] text-slate-400">Configure synchronizations, markup parameters, image ingestion thresholds, and notifications.</p>
              </div>
              {supplierSettings && (supplierSettings.lastUpdated || supplierSettings.updatedBy) && (
                <div className="text-left sm:text-right text-[10px] text-slate-400 font-mono">
                  {supplierSettings.lastUpdated && (
                    <div>Last Config Update: {new Date(supplierSettings.lastUpdated).toLocaleString()}</div>
                  )}
                  {supplierSettings.updatedBy && (
                    <div>Updated By: {supplierSettings.updatedBy}</div>
                  )}
                </div>
              )}
            </div>

            <form onSubmit={handleSaveSupplierSettings} className="p-6 rounded-3xl border border-slate-200/50 dark:border-slate-800/60 bg-slate-50/50 dark:bg-[#101827]/30 text-xs space-y-6">
              
              {/* Section 1: Ingestion Channels */}
              <div className="space-y-4">
                <h4 className="text-[10px] font-black uppercase text-blue-500 tracking-wider">Sync Channels & Automation</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  
                  {/* Website Sync Channel */}
                  <div className="p-4 bg-white dark:bg-slate-900/60 border border-slate-150 dark:border-slate-800 rounded-2xl flex items-center justify-between">
                    <div className="space-y-1 pr-4">
                      <div className="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white text-xs">
                        <Globe className="h-4 w-4 text-sky-500" />
                        <span>Website Sync Channel</span>
                      </div>
                      <p className="text-[10px] text-slate-400">Enable automatic product synchronizations through the Zyro.lk Web Feed.</p>
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

                  {/* WhatsApp Sync Channel */}
                  <div className="p-4 bg-white dark:bg-slate-900/60 border border-slate-150 dark:border-slate-800 rounded-2xl flex items-center justify-between">
                    <div className="space-y-1 pr-4">
                      <div className="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white text-xs">
                        <Phone className="h-4 w-4 text-emerald-500" />
                        <span>WhatsApp Sync Channel</span>
                      </div>
                      <p className="text-[10px] text-slate-400">Process supplier stock and price updates automatically via the WhatsApp channel.</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0">
                      <input 
                        type="checkbox" 
                        checked={!!supplierSettings.whatsappSyncEnabled}
                        onChange={(e) => setSupplierSettings(prev => ({ ...prev, whatsappSyncEnabled: e.target.checked }))}
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
                        <span>Automated Sync Engine</span>
                      </div>
                      <p className="text-[10px] text-slate-400">Run background crawler and ingest pipelines on the scheduled interval.</p>
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

                  {/* Automated Image Download */}
                  <div className="p-4 bg-white dark:bg-slate-900/60 border border-slate-150 dark:border-slate-800 rounded-2xl flex items-center justify-between">
                    <div className="space-y-1 pr-4">
                      <div className="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white text-xs">
                        <Camera className="h-4 w-4 text-purple-500" />
                        <span>Automated Image Downloader</span>
                      </div>
                      <p className="text-[10px] text-slate-400">Fetch, optimize and upload new product images directly into Zyro.lk storage.</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0">
                      <input 
                        type="checkbox" 
                        checked={!!supplierSettings.autoImageDownload}
                        onChange={(e) => setSupplierSettings(prev => ({ ...prev, autoImageDownload: e.target.checked }))}
                        className="sr-only peer" 
                      />
                      <div className="w-10 h-5 bg-slate-200 dark:bg-slate-800 peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                </div>
              </div>

              {/* Section 2: Financial Margins */}
              <div className="space-y-4">
                <h4 className="text-[10px] font-black uppercase text-blue-500 tracking-wider">Sync Schedule & Financial Margins</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  
                  {/* Sync Interval */}
                  <div className="space-y-1 text-slate-900 dark:text-white">
                    <label className="text-slate-400 font-bold block">Synchronize Job Interval</label>
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
                      onChange={(e) => setSupplierSettings(prev => ({ ...prev, nextSync: fromDateTimeLocalValue(e.target.value) }))}
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-[#111928] border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500/50 transition-colors text-xs text-slate-900 dark:text-white font-mono font-bold text-left"
                    />
                  </div>

                  {/* Last Sync */}
                  <div className="space-y-1">
                    <label className="text-slate-400 font-bold block">Last Scheduled Sync</label>
                    <input
                      type="datetime-local"
                      value={toDateTimeLocalValue(supplierSettings.lastSync)}
                      onChange={(e) => setSupplierSettings(prev => ({ ...prev, lastSync: fromDateTimeLocalValue(e.target.value) }))}
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-[#111928] border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500/50 transition-colors text-xs text-slate-900 dark:text-white font-mono font-bold text-left"
                    />
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
                  <div className="space-y-1">
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

              {/* Section 3: Scheduled Supplier Scope */}
              <div className="space-y-4">
                <h4 className="text-[10px] font-black uppercase text-blue-500 tracking-wider">Enabled Suppliers for Scheduled Sync</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {supplierSources.filter(source => (source.supplierType || source.type) === 'website').map((source) => {
                    const enabledIds = supplierSettings.enabledSupplierIds || [];
                    const isChecked = enabledIds.length === 0 || enabledIds.includes(source.id);
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
                    setNewSupplierType(e.target.value);
                    setNewSupplierUrl("");
                    setApiEndpoint("");
                  }}
                  className="w-full px-3 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-850 rounded-xl focus:outline-hidden focus:border-emerald-500 transition-colors text-xs dark:text-white font-bold cursor-pointer"
                >
                  <option value="website">Website (HTML / Scraper Target)</option>
                  <option value="api">API Feed (REST / JSON Endpoint)</option>
                  <option value="whatsapp">WhatsApp (Automated Messaging Feed)</option>
                </select>
              </div>

              {/* Dynamic Type Specific Fields */}
              {newSupplierType === 'website' && (
                <div className="space-y-3.5 p-4 rounded-2xl bg-amber-500/5 border border-amber-500/10">
                  <div className="space-y-1">
                    <label className="text-amber-600 dark:text-amber-500 font-black block text-[9px] uppercase tracking-wider">Website URL</label>
                    <input 
                      type="url" 
                      required
                      placeholder="https://example-supplier.com"
                      value={newSupplierUrl}
                      onChange={(e) => setNewSupplierUrl(e.target.value)}
                      className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-amber-600 dark:text-amber-500 font-black block text-[9px] uppercase tracking-wider">Product Endpoint</label>
                    <input 
                      type="text" 
                      required
                      placeholder="/api/products"
                      value={apiEndpoint}
                      onChange={(e) => setApiEndpoint(e.target.value)}
                      className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-amber-500 transition-colors text-xs dark:text-white font-mono"
                    />
                  </div>
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

              {newSupplierType === 'whatsapp' && (
                <div className="space-y-3.5 p-4 rounded-2xl bg-emerald-500/5 border border-emerald-500/10">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-emerald-500 font-black block text-[9px] uppercase tracking-wider">WhatsApp Phone Number</label>
                      <input 
                        type="text" 
                        required
                        placeholder="+94 77 123 4567"
                        value={whatsappNumber}
                        onChange={(e) => setWhatsappNumber(e.target.value)}
                        className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-emerald-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-emerald-500 font-black block text-[9px] uppercase tracking-wider">Trusted Sender Name</label>
                      <input 
                        type="text" 
                        required
                        placeholder="Admin Bot"
                        value={whatsappSender}
                        onChange={(e) => setWhatsappSender(e.target.value)}
                        className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-emerald-500"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-emerald-500 font-black block text-[9px] uppercase tracking-wider">Message Parsing Template</label>
                    <input 
                      type="text" 
                      required
                      value={whatsappFormat}
                      onChange={(e) => setWhatsappFormat(e.target.value)}
                      className="w-full px-3 py-2.5 bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-emerald-500 font-mono"
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
                <span>Approving this item will queue it for direct catalog ingestion and auto-publish. This operation requires admin authorization.</span>
              </div>

              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
                <button 
                  type="button"
                  onClick={() => setComparingChange(null)}
                  className="px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold rounded-xl text-xs transition-colors cursor-pointer border border-slate-200/50 dark:border-slate-800/60"
                >
                  Close
                </button>
                {comparingChange.status === 'Pending' && (
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
