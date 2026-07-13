import React, { Suspense, lazy, useState, useEffect, useMemo, useRef } from 'react';
import { 
  TrendingUp, ShoppingBag, Users, Layers, Plus, Trash2, Edit3, Check, 
  X, RefreshCw, AlertCircle, Calendar, DollarSign, ArrowUpRight, Upload,
  Settings, Search, Image, Globe, ExternalLink, ShieldCheck, Power, Phone,
  Eye, Copy, MessageCircle, Star, Bell, Moon, Sun, ChevronRight, SlidersHorizontal,
  Menu, Info, Filter, Clock, BarChart3, Archive, Package, FileText, Save,
  Facebook, Instagram, Youtube, Music, Sparkles, Flame, Mail, Award, UserCheck, Activity,
  ArrowDownRight, AlertTriangle, TrendingDown, ArrowRight, History, User
} from 'lucide-react';
import { 
  collection, getDocs, doc, addDoc, updateDoc, deleteDoc, getDoc, setDoc, onSnapshot 
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { onAuthStateChanged } from 'firebase/auth';
import { db, storage, auth } from '../firebase';
import { searchAdminProducts } from '../services/product-search/adminProductSearch';
import {
  buildCategoryProductCounts,
  canDeleteCategory,
  categoryMatches,
  isDuplicateCategorySlug,
  normalizeCategoryName,
  normalizeCategorySlug,
  sortCategoriesAlphabetically,
} from '../services/categories/categoryUtils';
import { Product, Category, Order, WebsiteSettings, SupplierReviewQueueItem } from '../types';
import { isProductionAdminEmail, PRODUCTION_ADMIN_EMAIL } from '../config/admin';
import { CloudinaryUpload } from './CloudinaryUpload';
import HeroSliderEditor from './HeroSliderEditor';
import { normalizeSlideSpeed, validateHeroSlides } from '../services/hero-slider/heroSlider';
import { sanitizeFirestoreData } from '../services/firestore/sanitizeFirestoreData';
import { validateProductForSave } from '../services/products/productValidation';
import { isHttpUrl, validateStoreSettings } from '../services/settings/storeSettingsValidation';
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, 
  CartesianGrid, Tooltip, PieChart, Pie, Cell, BarChart, Bar, Legend
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { approveSupplierQueueItem, rejectSupplierQueueItem } from '../services/supplierQueueService';

const SupplierHubFiveStars = lazy(() => import('./SupplierHubFiveStars'));
const AIManagerPanel = lazy(() => import('../features/ai-manager'));

const AnimatedCounter: React.FC<{ value: number; formatter?: (v: number) => string }> = ({ value, formatter }) => {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let startTimestamp: number | null = null;
    const duration = 800; // 800ms
    const startValue = 0;
    const endValue = value;

    if (endValue === 0) {
      setCount(0);
      return;
    }

    const step = (timestamp: number) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      // ease-out quad
      const easedProgress = progress * (2 - progress);
      const current = startValue + (endValue - startValue) * easedProgress;
      setCount(current);
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        setCount(endValue);
      }
    };

    const animFrame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(animFrame);
  }, [value]);

  return <span>{formatter ? formatter(count) : Math.round(count).toLocaleString()}</span>;
};

const AdminLazyPanelFallback = () => (
  <div className="min-h-96 animate-pulse rounded-2xl border border-slate-800/70 bg-slate-900/70 p-6">
    <div className="mb-6 h-5 w-48 rounded-lg bg-slate-800" />
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className="h-24 rounded-xl bg-slate-800/80" />
      <div className="h-24 rounded-xl bg-slate-800/80" />
      <div className="h-24 rounded-xl bg-slate-800/80" />
    </div>
    <div className="mt-6 h-56 rounded-xl bg-slate-800/70" />
  </div>
);

const DEFAULT_WEBSITE_SETTINGS: WebsiteSettings = {
  storeName: "Zyro.lk",
  storeTagline: "Sri Lanka's Premium Electronics & Solar Solutions Hub",
  logoUrl: "",
  faviconUrl: "",
  contactPhone: "",
  contactPhone2: "",
  whatsappNumber: "",
  contactEmail: "",
  contactAddress: "",
  heroBanners: [],
  autoSlideSpeed: 6,
  enableSlider: true,
  primaryColor: "#2563EB",
  secondaryColor: "#10B981",
  footerLogoUrl: "",
  aboutText: "Sri Lanka's premier destination for high-end digital solutions, smart energy solar, kitchen devices, and lifestyle audio components.",
  copyrightText: "© 2026 Zyro.lk. All rights reserved.",
  facebookUrl: "https://facebook.com/zyro.lk",
  instagramUrl: "https://instagram.com/zyro.lk",
  tiktokUrl: "https://tiktok.com/@zyro.lk",
  youtubeUrl: "https://youtube.com/@zyro.lk",
  seoTitle: "Zyro.lk | Flagship Tech, Smart Energy & Premium Audio Sri Lanka",
  seoDescription: "Browse premium consumer electronics, solar hybrid smart inverters, flagship audio systems, and high-end smart kitchen appliances in Sri Lanka with Islandwide Cash on Delivery.",
  seoKeywords: "electronics Sri Lanka, solar inverters Colombo, smart home Colombo, buy monitors Sri Lanka, premium tech, Zyro.lk",
  ogImageUrl: "",
  deliveryCharge: 500,
  freeDeliveryMin: 150000,
  enableCOD: true,
  enableWishlist: true,
  enableReviews: true,
  enableFeaturedProducts: true
};

const DEFAULT_SUPPLIER_HUB_SETTINGS = {
  autoSync: false,
  defaultMargin: 0,
  notifyOnPriceDecrease: false,
  apiSecretKey: "",
  updatedAt: ""
};

const DEFAULT_SUPPLIER_SETTINGS = {
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
  lastUpdated: "",
  updatedBy: ""
};

const isValidUrl = (url: string) => !url.trim() || isHttpUrl(url);

const DEFAULT_PAGES = [
  {
    id: "about-us",
    title: "About Us",
    content: `Welcome to Zyro.lk, Sri Lanka's premier destination for high-end digital solutions, smart energy solar systems, kitchen appliances, and lifestyle audio components.

Our Journey
Established with a vision to bring cutting-edge global technology to local consumers, Zyro.lk has grown to become a trusted brand synonym with authenticity and unparalleled customer service. We direct-import genuine products from world-renowned manufacturers, ensuring that every purchase you make meets international quality standards.

Our Promise
• 100% Genuine Products: No refurbished or counterfeit units. Only authentic global hardware.
• Islandwide Safe Shipping: Secure courier delivery with live tracking straight to your doorstep.
• Customer-First Philosophy: A dedicated 7-day direct product replacement policy for manufacturing faults, backed by active local service centers across Sri Lanka.
• Future-Ready Solar Solutions: Empowering Sri Lankan homes and businesses with clean, sustainable, and highly efficient solar and backup power.

Thank you for choosing Zyro.lk. We are committed to powering your lifestyle and engineering your digital future.`
  },
  {
    id: "privacy-policy",
    title: "Privacy Policy",
    content: `At Zyro.lk, we value your privacy and are committed to protecting your personal data. This privacy policy explains how we collect, use, and safeguard your information when you visit our website or make a purchase.

1. Information We Collect
• Personal Details: Name, email address, physical shipping address, phone number, and district.
• Order Details: Records of products purchased, transactions, and preferences.
• Technical Data: IP address, browser type, device details, and cookie data to optimize your shopping experience.

2. How We Use Your Information
• To process and fulfill your orders, including islandwide shipping and order confirmation.
• To communicate with you via WhatsApp, email, or phone regarding your transactions.
• To personalize your browsing experience and keep the store's performance at its peak.
• To send optional newsletters and exclusive club discounts (only with your explicit consent).

3. Data Security & Storage
Your data is securely stored in cloud infrastructure backed by Google Firebase Authentication and Firestore databases. We do not sell, rent, or lease your personal information to third parties.

4. Your Rights
You have the right to request access to your stored personal data, request corrections, or request deletion of your customer profile. Please reach out to support@zyro.lk for any data requests.`
  },
  {
    id: "terms-conditions",
    title: "Terms & Conditions",
    content: `Welcome to Zyro.lk. By browsing our store, registering an account, or placing an order, you agree to comply with and be bound by the following terms and conditions.

1. General
• Zyro.lk is an e-commerce platform offering premium digital devices, kitchenware, lifestyle accessories, and solar systems in Sri Lanka.
• We reserve the right to modify these terms or update website pricing at any time without prior notice.

2. Ordering & Payment
• Orders placed through the website represent an offer to purchase.
• We offer secure payment methods including Cash on Delivery (COD) and direct WhatsApp payment confirmations.
• For high-value orders, we may request a partial advance payment to secure shipping and dispatch.

3. Deliveries & Shipments
• Islandwide shipping charges and free delivery thresholds are dynamically calculated at checkout.
• Delivery times typically range from 1 to 3 business days in Colombo/suburbs, and 3 to 5 business days for outstation districts.
• While we make every effort to meet estimated delivery times, external factors such as weather or courier delays are beyond our control.

4. Electronic Specifications & Product Information
• We attempt to provide accurate pictures and technical specifications for every product.
• Please review technical details such as voltage, dimensions, and compatibility before placing your order.`
  },
  {
    id: "return-policy",
    title: "Return Policy",
    content: `We want you to be entirely satisfied with your purchase from Zyro.lk. If something isn't right, we are here to help.

1. 7-Day Priority Replacement
• If you discover any manufacturing defect or functional fault within 7 days of receiving your item, you are eligible for an immediate direct replacement.
• To claim a priority replacement, please contact us with proof of purchase and a short description/video of the issue via our Hotline or WhatsApp.

2. Return Conditions
• The item must be unused, in the same brand-new condition that you received it, and in its original, undamaged retail packaging.
• All accessories, user manuals, warranty cards, and promotional gifts included in the box must be returned.

3. Warranty Claims
• Beyond the initial 7-day replacement period, products are covered by their respective manufacturer or store warranties as specified on the product page.
• Warranty repairs and servicing will be handled through authorized local service centers in Sri Lanka.`
  },
  {
    id: "faq",
    title: "Frequently Asked Questions",
    content: `Find answers to some of our customers' most common questions regarding shipping, warranties, and orders.

Q: Do you deliver islandwide in Sri Lanka?
A: Yes! We deliver to any address across all 25 districts in Sri Lanka. Packages are handled by professional courier networks to ensure secure handling.

Q: What are your shipping rates?
A: Shipping costs vary based on your district and the items in your cart. You can see the exact delivery charge during checkout. We offer free delivery on orders that exceed our minimum threshold.

Q: Can I pay with Cash on Delivery (COD)?
A: Yes, Cash on Delivery is supported for most locations and standard items. You can select COD at checkout and pay the courier when your package is delivered.

Q: Are your products genuine and covered by warranty?
A: Absolutely. We only source direct-import genuine items from original brands. All products come with local or international warranties which are honored at active service centers in Sri Lanka.

Q: How can I track my order or request custom support?
A: Once your order is dispatched, we can share tracking details with you. You can also click the WhatsApp button on your order confirmation page to chat with us in real-time.`
  },
  {
    id: "contact-us",
    title: "Contact Us",
    content: `Get In Touch

Have questions about brand warranties, solar solutions, or custom product ordering? Our professional sales team is standing by to assist you.

Customer Support
Our back-office representative will respond with pricing, quotation invoices, or warranty details within 2 hours.

Operating Hours
• Weekdays: 9:00 AM - 7:00 PM
• Saturday: 9:00 AM - 5:00 PM
• Sunday & Poya Days: Closed

Instant Help
Want the fastest response? Skip forms entirely and talk to our support team on WhatsApp right now.

Inquiry Feedback
Thank you for contacting us. One of our specialists will reach out to you via phone or email very shortly.`
  }
];

const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // remove non-word chars except spaces and dashes
    .replace(/[\s_]+/g, '-')   // replace spaces and underscores with dashes
    .replace(/-+/g, '-')      // remove duplicate dashes
    .replace(/^-+|-+$/g, '');  // remove leading/trailing dashes
};

const generateNextSku = (existingProducts: Product[]): string => {
  let maxNum = 0;
  existingProducts.forEach(p => {
    if (p.sku) {
      const match = p.sku.trim().match(/^ZY-(\d+)$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) {
          maxNum = num;
        }
      }
    }
  });
  const nextNum = maxNum + 1;
  return `ZY-${String(nextNum).padStart(6, '0')}`;
};

const generateUniqueSlug = (name: string, existingProducts: Product[], skipId?: string): string => {
  let baseSlug = generateSlug(name);
  if (!baseSlug) baseSlug = "product";
  let slug = baseSlug;
  let counter = 1;
  while (existingProducts.some(p => p.id === slug && p.id !== skipId)) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  return slug;
};

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface AdminDashboardProps {
  initialTab?: 'stats' | 'aiManager' | 'products' | 'categories' | 'orders' | 'customers' | 'pages' | 'settings' | 'supplierHub' | 'supplierHubFiveStars';
  initialCmsPageId?: string;
}

export default function AdminDashboard({ initialTab = 'stats', initialCmsPageId = 'about-us' }: AdminDashboardProps = {}) {
  const [activeTab, setActiveTab] = useState<'stats' | 'aiManager' | 'products' | 'categories' | 'orders' | 'customers' | 'pages' | 'settings' | 'supplierHub' | 'supplierHubFiveStars'>(initialTab);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);
  const [showNotifications, setShowNotifications] = useState<boolean>(false);

  // States loaded from Firestore
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [reviews, setReviews] = useState<any[]>([]);
  const [staticPages, setStaticPages] = useState<any[]>([]);
  const [settings, setSettings] = useState<WebsiteSettings | null>(DEFAULT_WEBSITE_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  
  const [toasts, setToasts] = useState<{
    id: string;
    orderId: string;
    orderNumber: string;
    customerName: string;
    totalPrice: number;
  }[]>([]);

  // Search & Filter States
  const [orderSearch, setOrderSearch] = useState("");
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>("all");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [updatingOrderStatus, setUpdatingOrderStatus] = useState<Record<string, boolean>>({});
  const [orderPage, setOrderPage] = useState<number>(1);
  const ordersPerPage = 8;
  const [copiedAddressId, setCopiedAddressId] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [selectedCustomerEmail, setSelectedCustomerEmail] = useState<string | null>(null);
  const [customerPage, setCustomerPage] = useState<number>(1);
  const customersPerPage = 8;
  const [isSearchingCustomers, setIsSearchingCustomers] = useState(false);
  const [copiedCustFieldId, setCopiedCustFieldId] = useState<string | null>(null);
  const [customerSortBy, setCustomerSortBy] = useState<string>("totalSpent");
  const [productSearch, setProductSearch] = useState("");
  const [productCategoryFilter, setProductCategoryFilter] = useState("all");
  const [productStockFilter, setProductStockFilter] = useState("all");
  const [salesPeriod, setSalesPeriod] = useState<'7d' | '30d' | '1y'>('30d');

  // Modal / Selection States
  const [selectedCustomerOrders, setSelectedCustomerOrders] = useState<any[] | null>(null);
  const [selectedCustomerName, setSelectedCustomerName] = useState("");
  const [showProductModal, setShowProductModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [productToDelete, setProductToDelete] = useState<Product | null>(null);
  
  // Supplier Hub States
  const [supplierSources, setSupplierSources] = useState<any[]>([]);
  const [syncLogs, setSyncLogs] = useState<any[]>([]);
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null);
  const [showSyncHistoryModal, setShowSyncHistoryModal] = useState(false);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierType, setNewSupplierType] = useState("website");
  const [newSupplierUrl, setNewSupplierUrl] = useState("");
  const [savingSupplier, setSavingSupplier] = useState(false);
  const [syncSuccessMsg, setSyncSuccessMsg] = useState<string | null>(null);

  // Supplier Hub Workflow States
  const [supplierSubTab, setSupplierSubTab] = useState<'sources' | 'review' | 'import' | 'changes' | 'history' | 'settings'>('sources');
  const [supplierReviewQueue, setSupplierReviewQueue] = useState<SupplierReviewQueueItem[]>([]);
  const [reviewFilter, setReviewFilter] = useState<'All' | 'Pending' | 'Approved' | 'Rejected'>('All');
  const [reviewSearch, setReviewSearch] = useState('');
  const [comparingItem, setComparingItem] = useState<SupplierReviewQueueItem | null>(null);
  const [isReviewQueueLoading, setIsReviewQueueLoading] = useState<boolean>(true);
  const [supplierImportQueue, setSupplierImportQueue] = useState<any[]>([]);
  const [isImportQueueLoading, setIsImportQueueLoading] = useState<boolean>(true);
  const [importFilter, setImportFilter] = useState<'All' | 'Running' | 'Completed' | 'Failed'>('All');
  const [importSearch, setImportSearch] = useState('');
  const [viewingImportJob, setViewingImportJob] = useState<any | null>(null);
  const [supplierPendingChanges, setSupplierPendingChanges] = useState<any[]>([]);
  const [pendingChangesFilter, setPendingChangesFilter] = useState<'All' | 'Pending' | 'Approved' | 'Rejected'>('All');
  const [pendingChangesSearch, setPendingChangesSearch] = useState('');
  const [isPendingChangesLoading, setIsPendingChangesLoading] = useState<boolean>(true);
  const [comparingChange, setComparingChange] = useState<any | null>(null);
  const [supplierSyncHistory, setSupplierSyncHistory] = useState<any[]>([]);
  const [syncHistoryFilter, setSyncHistoryFilter] = useState<'All' | 'Success' | 'Failed' | 'Partial'>('All');
  const [syncHistorySearch, setSyncHistorySearch] = useState('');
  const [isSyncHistoryLoading, setIsSyncHistoryLoading] = useState<boolean>(true);
  const [viewingSyncLog, setViewingSyncLog] = useState<any | null>(null);
  const [supplierHubSettings, setSupplierHubSettings] = useState<any>(DEFAULT_SUPPLIER_HUB_SETTINGS);
  const [savingHubSettings, setSavingHubSettings] = useState(false);
  const [supplierSettings, setSupplierSettings] = useState<any>(DEFAULT_SUPPLIER_SETTINGS);
  const [isSettingsLoading, setIsSettingsLoading] = useState<boolean>(true);
  const [savingSupplierSettings, setSavingSupplierSettings] = useState<boolean>(false);
  const [showResetSettingsConfirm, setShowResetSettingsConfirm] = useState<boolean>(false);
  const [processingReviewId, setProcessingReviewId] = useState<string | null>(null);
  const [processingChangeId, setProcessingChangeId] = useState<string | null>(null);
  const [processingImportId, setProcessingImportId] = useState<string | null>(null);
  
  const [newProduct, setNewProduct] = useState<Partial<Product>>({
    name: "", description: "", price: 0, originalPrice: 0, discount: 0,
    imageUrl: "", imageUrls: [], category: "electronics", stock: 10, specs: {},
    isNew: false, isFeatured: false, isBestSeller: false, isActive: true, sku: "",
    supplierItemCode: "", costPrice: undefined, marketPrice: undefined
  });

  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [newCategory, setNewCategory] = useState({ id: "", name: "", icon: "Smartphone", imageUrl: "", isActive: true });
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryToDelete, setCategoryToDelete] = useState<Category | null>(null);
  const [savingCategory, setSavingCategory] = useState(false);
  const categoryTriggerRef = useRef<HTMLElement | null>(null);
  const categorySlugInputRef = useRef<HTMLInputElement | null>(null);
  const categoryNameInputRef = useRef<HTMLInputElement | null>(null);
  const categoryDeleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const [specKey, setSpecKey] = useState("");
  const [specVal, setSpecVal] = useState("");

  // Website Settings Form State
  const [settingsForm, setSettingsForm] = useState<WebsiteSettings | null>(DEFAULT_WEBSITE_SETTINGS);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingProduct, setSavingProduct] = useState(false);
  const [tempDeliveryCharge, setTempDeliveryCharge] = useState<string>(String(DEFAULT_WEBSITE_SETTINGS.deliveryCharge));
  const [tempFreeDeliveryMin, setTempFreeDeliveryMin] = useState<string>(String(DEFAULT_WEBSITE_SETTINGS.freeDeliveryMin));
  const [tempSecondaryImage, setTempSecondaryImage] = useState("");
  const [logoError, setLogoError] = useState(false);
  const [bannerErrors, setBannerErrors] = useState<Record<string, boolean>>({});
  const [settingsToasts, setSettingsToasts] = useState<{
    id: string;
    type: 'success' | 'error';
    message: string;
  }[]>([]);

  const showSettingsToast = (type: 'success' | 'error', message: string) => {
    const id = Date.now().toString();
    setSettingsToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setSettingsToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const categoryProductCounts = useMemo(
    () => buildCategoryProductCounts(categories, products),
    [categories, products],
  );

  const restoreCategoryFocus = () => {
    window.requestAnimationFrame(() => categoryTriggerRef.current?.focus());
  };

  const closeCategoryModal = () => {
    setShowCategoryModal(false);
    setEditingCategory(null);
    restoreCategoryFocus();
  };

  const closeCategoryDeleteConfirmation = () => {
    setCategoryToDelete(null);
    restoreCategoryFocus();
  };

  useEffect(() => {
    if (!showCategoryModal && !categoryToDelete) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (categoryToDelete) closeCategoryDeleteConfirmation();
      else closeCategoryModal();
    };
    document.addEventListener('keydown', handleEscape);
    if (showCategoryModal) window.requestAnimationFrame(() => {
      (editingCategory ? categoryNameInputRef.current : categorySlugInputRef.current)?.focus();
    });
    if (categoryToDelete) window.requestAnimationFrame(() => categoryDeleteCancelRef.current?.focus());
    return () => document.removeEventListener('keydown', handleEscape);
  }, [categoryToDelete, editingCategory, showCategoryModal]);

  useEffect(() => {
    setLogoError(false);
  }, [settingsForm?.logoUrl]);

  useEffect(() => {
    setBannerErrors({});
  }, [settingsForm?.heroBanners]);

  // Pages CMS states
  const [selectedCmsPageId, setSelectedCmsPageId] = useState<string>(initialCmsPageId);
  const [cmsPageTitle, setCmsPageTitle] = useState<string>("");
  const [cmsPageContent, setCmsPageContent] = useState<string>("");
  const [savingCmsPage, setSavingCmsPage] = useState<boolean>(false);
  const [cmsSuccessMessage, setCmsSuccessMessage] = useState<string | null>(null);
  const [cmsErrorMessage, setCmsErrorMessage] = useState<string | null>(null);
  const [deletingCmsPage, setDeletingCmsPage] = useState<boolean>(false);

  const prevInitialTabRef = React.useRef(initialTab);
  useEffect(() => {
    if (initialTab && initialTab !== prevInitialTabRef.current) {
      setActiveTab(initialTab);
      prevInitialTabRef.current = initialTab;
    }
  }, [initialTab]);

  const prevInitialCmsPageIdRef = React.useRef(initialCmsPageId);
  useEffect(() => {
    if (initialCmsPageId && initialCmsPageId !== prevInitialCmsPageIdRef.current) {
      setSelectedCmsPageId(initialCmsPageId);
      prevInitialCmsPageIdRef.current = initialCmsPageId;
    }
  }, [initialCmsPageId]);

  useEffect(() => {
    setOrderPage(1);
  }, [orderSearch, orderStatusFilter]);

  useEffect(() => {
    setCustomerPage(1);
    if (customerSearch) {
      setIsSearchingCustomers(true);
      const timer = setTimeout(() => {
        setIsSearchingCustomers(false);
      }, 250);
      return () => clearTimeout(timer);
    } else {
      setIsSearchingCustomers(false);
    }
  }, [customerSearch]);

  useEffect(() => {
    const matched = staticPages.find(p => p.id === selectedCmsPageId);
    if (matched) {
      setCmsPageTitle(matched.title || "");
      setCmsPageContent(matched.content || "");
    } else {
      const fallback = DEFAULT_PAGES.find(p => p.id === selectedCmsPageId);
      if (fallback) {
        setCmsPageTitle(fallback.title);
        setCmsPageContent(fallback.content);
      } else {
        setCmsPageTitle("");
        setCmsPageContent("");
      }
    }
  }, [selectedCmsPageId, staticPages]);

  const handleSaveCmsPage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authorized || !selectedCmsPageId) return;
    setSavingCmsPage(true);
    setCmsSuccessMessage(null);
    setCmsErrorMessage(null);
    try {
      const payload = {
        title: cmsPageTitle,
        content: cmsPageContent,
        lastUpdated: new Date().toLocaleDateString()
      };
      await setDoc(doc(db, "pages", selectedCmsPageId), payload);
      setCmsSuccessMessage("Page updated and saved successfully in Firestore database!");
      
      // Reload pages
      const pageSnap = await getDocs(collection(db, "pages"));
      const pageList: any[] = [];
      pageSnap.forEach((d) => pageList.push({ id: d.id, ...d.data() }));
      setStaticPages(pageList);

      setTimeout(() => setCmsSuccessMessage(null), 4000);
    } catch (err) {
      console.error("Save CMS page failed:", err);
      setCmsErrorMessage("Page could not be saved. Please check your connection and try again.");
    } finally {
      setSavingCmsPage(false);
    }
  };

  const reloadCmsPages = async (): Promise<void> => {
    const pageSnap = await getDocs(collection(db, "pages"));
    const pageList: any[] = [];
    pageSnap.forEach((pageDoc) => pageList.push({ id: pageDoc.id, ...pageDoc.data() }));
    setStaticPages(pageList);
  };

  const handleDeleteCustomCmsPage = async (): Promise<void> => {
    if (!authorized || !selectedCmsPageId) return;
    const selectedPage = DEFAULT_PAGES.find((page) => page.id === selectedCmsPageId);
    if (!window.confirm(`Delete the custom version of ${selectedPage?.title || selectedCmsPageId}? The built-in default page will remain available.`)) return;

    setDeletingCmsPage(true);
    setCmsSuccessMessage(null);
    setCmsErrorMessage(null);
    try {
      await deleteDoc(doc(db, "pages", selectedCmsPageId));
      await reloadCmsPages();
      setCmsSuccessMessage("Custom page deleted. The built-in default is now live.");
    } catch (error) {
      console.error("Delete CMS page failed:", error);
      setCmsErrorMessage("Custom page could not be deleted. Please try again.");
    } finally {
      setDeletingCmsPage(false);
    }
  };

  const handleResetCmsPage = async (): Promise<void> => {
    if (!authorized || !selectedCmsPageId) return;
    const fallback = DEFAULT_PAGES.find((page) => page.id === selectedCmsPageId);
    if (!fallback || !window.confirm(`Reset ${fallback.title} to the built-in default content? This will replace the current custom version.`)) return;

    setSavingCmsPage(true);
    setCmsSuccessMessage(null);
    setCmsErrorMessage(null);
    try {
      await setDoc(doc(db, "pages", selectedCmsPageId), {
        title: fallback.title,
        content: fallback.content,
        lastUpdated: new Date().toLocaleDateString(),
      });
      await reloadCmsPages();
      setCmsSuccessMessage("Page reset to the built-in default and verified after reload.");
    } catch (error) {
      console.error("Reset CMS page failed:", error);
      setCmsErrorMessage("Page could not be reset. Please try again.");
    } finally {
      setSavingCmsPage(false);
    }
  };

  // Chime Sound
  const playNotificationSound = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const audioCtx = new AudioCtx();
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(659.25, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    } catch (e) {
      console.warn("Chime blocked:", e);
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const prodSnap = await getDocs(collection(db, "products"));
      const prodList: Product[] = [];
      prodSnap.forEach((d) => prodList.push({ id: d.id, ...d.data() } as Product));
      setProducts(prodList);
    } catch (e) { console.warn("Products load error", e); }

    try {
      const catSnap = await getDocs(collection(db, "categories"));
      const catList: Category[] = [];
      catSnap.forEach((d) => catList.push({ id: d.id, ...d.data() } as Category));
      setCategories(sortCategoriesAlphabetically(catList));
    } catch (e) { console.warn("Categories load error", e); }

    try {
      const userSnap = await getDocs(collection(db, "users"));
      const userList: any[] = [];
      userSnap.forEach((d) => userList.push({ id: d.id, ...d.data() }));
      setUsers(userList);
    } catch (e) { console.warn("Users load error", e); }

    try {
      const settingsSnap = await getDoc(doc(db, "settings", "website"));
      if (settingsSnap.exists()) {
        const sData = settingsSnap.data() as WebsiteSettings;
        const merged = { ...DEFAULT_WEBSITE_SETTINGS, ...sData };
        setSettings(merged);
        setSettingsForm(merged);
        setTempDeliveryCharge(String(merged.deliveryCharge));
        setTempFreeDeliveryMin(String(merged.freeDeliveryMin));
      } else {
        setSettings(DEFAULT_WEBSITE_SETTINGS);
        setSettingsForm(DEFAULT_WEBSITE_SETTINGS);
      }
    } catch (e) {
      console.warn("Website settings error, fallback used:", e);
      setSettings(DEFAULT_WEBSITE_SETTINGS);
      setSettingsForm(DEFAULT_WEBSITE_SETTINGS);
    }

    try {
      const pageSnap = await getDocs(collection(db, "pages"));
      const pageList: any[] = [];
      pageSnap.forEach((d) => pageList.push({ id: d.id, ...d.data() }));
      setStaticPages(pageList);
    } catch (e) {
      console.warn("Pages load error", e);
    }

    try {
      const hubSnap = await getDocs(collection(db, "supplierHub"));
      const hubList: any[] = [];
      hubSnap.forEach((d) => hubList.push({ id: d.id, ...d.data() }));
      setSupplierSources(hubList);
    } catch (e) {
      console.warn("Supplier Hub load error:", e);
      setSupplierSources([]);
    }

    try {
      const logsSnap = await getDocs(collection(db, "supplierSyncLogs"));
      const logsList: any[] = [];
      logsSnap.forEach((d) => logsList.push({ id: d.id, ...d.data() }));
      logsList.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setSyncLogs(logsList);
    } catch (e) {
      console.warn("Supplier Sync Logs load error:", e);
      setSyncLogs([]);
    }

    // Load Supplier Review Queue (Realtime listener handles state)
    try {
      await getDocs(collection(db, "supplier_review_queue"));
    } catch (e) {
      console.warn("supplier_review_queue load error:", e);
    }

    // Load Supplier Import Queue
    try {
      const snap = await getDocs(collection(db, "supplier_import_queue"));
      const list: any[] = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      list.sort((a, b) => {
        const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tB - tA;
      });
      setSupplierImportQueue(list);
      setIsImportQueueLoading(false);
    } catch (e) {
      console.warn("supplier_import_queue load error:", e);
      setIsImportQueueLoading(false);
    }

    // Load Supplier Pending Changes is handled by onSnapshot realtime listener.

    // Load Hub Settings from canonical supplier_settings/config.
    try {
      const docSnap = await getDoc(doc(db, "supplier_settings", "config"));
      if (docSnap.exists()) {
        setSupplierHubSettings({ ...DEFAULT_SUPPLIER_HUB_SETTINGS, ...docSnap.data() });
      } else {
        setSupplierHubSettings(DEFAULT_SUPPLIER_HUB_SETTINGS);
      }
    } catch (e) {
      console.warn("supplier_settings hub config error:", e);
      setSupplierHubSettings(DEFAULT_SUPPLIER_HUB_SETTINGS);
    }
    
    setLoading(false);
  };

  const handleTriggerSync = async (sourceId: string) => {
    if (syncingSourceId) return;
    setSyncingSourceId(sourceId);
    setSyncSuccessMsg(null);
    
    setTimeout(async () => {
      try {
        const source = supplierSources.find(s => s.id === sourceId);
        if (!source) return;
        
        const randNewProd = Math.floor(Math.random() * 4);
        const randPriceChange = Math.floor(Math.random() * 8) + 1;
        const randStockChange = Math.floor(Math.random() * 10) + 1;
        const randImgChange = Math.floor(Math.random() * 3);
        const randPendingRev = Math.floor(Math.random() * 2);
        
        const nowStr = new Date().toLocaleString('en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });

        const updatedSource = {
          ...source,
          connectionStatus: 'connected',
          lastSync: nowStr,
          lastError: 'None',
          sourceStatus: 'active',
          newProducts: randNewProd,
          priceChanges: randPriceChange,
          stockChanges: randStockChange,
          imageChanges: randImgChange,
          pendingReviews: randPendingRev
        };

        await setDoc(doc(db, "supplierHub", sourceId), updatedSource);
        
        const logId = `log-${Date.now()}`;
        const newLog = {
          id: logId,
          supplierId: sourceId,
          supplierName: source.name,
          timestamp: nowStr,
          status: 'success',
          error: 'None',
          newProducts: randNewProd,
          priceChanges: randPriceChange,
          stockChanges: randStockChange,
          imageChanges: randImgChange,
          pendingReviews: randPendingRev,
          triggeredBy: 'Manual (Admin)'
        };

        await setDoc(doc(db, "supplierSyncLogs", logId), newLog);
        
        const hubSnap = await getDocs(collection(db, "supplierHub"));
        const hubList: any[] = [];
        hubSnap.forEach((d) => hubList.push({ id: d.id, ...d.data() }));
        setSupplierSources(hubList);

        const logsSnap = await getDocs(collection(db, "supplierSyncLogs"));
        const logsList: any[] = [];
        logsSnap.forEach((d) => logsList.push({ id: d.id, ...d.data() }));
        logsList.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        setSyncLogs(logsList);

        setSyncSuccessMsg(`Successfully synchronized "${source.name}"! Logs updated in Firestore.`);
        playNotificationSound();
        setTimeout(() => setSyncSuccessMsg(null), 5000);
      } catch (err) {
        console.error("Sync trigger error:", err);
      } finally {
        setSyncingSourceId(null);
      }
    }, 1500);
  };

  const handleConnectSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSupplierName.trim()) return;
    setSavingSupplier(true);
    try {
      const newId = newSupplierName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
      const nowStr = new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      
      const newSource = {
        id: newId,
        name: newSupplierName.trim(),
        connectionStatus: 'pending',
        lastSync: 'Never',
        lastError: 'None',
        sourceStatus: 'active',
        newProducts: 0,
        priceChanges: 0,
        stockChanges: 0,
        imageChanges: 0,
        pendingReviews: 0,
        type: newSupplierType,
        connectorUrl: newSupplierUrl
      };

      await setDoc(doc(db, "supplierHub", newId), newSource);

      const logId = `log-${Date.now()}`;
      const newLog = {
        id: logId,
        supplierId: newId,
        supplierName: newSupplierName.trim(),
        timestamp: nowStr,
        status: 'success',
        error: 'None',
        newProducts: 0,
        priceChanges: 0,
        stockChanges: 0,
        imageChanges: 0,
        pendingReviews: 0,
        triggeredBy: `Connect (${newSupplierType})`
      };

      await setDoc(doc(db, "supplierSyncLogs", logId), newLog);

      const hubSnap = await getDocs(collection(db, "supplierHub"));
      const hubList: any[] = [];
      hubSnap.forEach((d) => hubList.push({ id: d.id, ...d.data() }));
      setSupplierSources(hubList);

      const logsSnap = await getDocs(collection(db, "supplierSyncLogs"));
      const logsList: any[] = [];
      logsSnap.forEach((d) => logsList.push({ id: d.id, ...d.data() }));
      logsList.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setSyncLogs(logsList);

      setNewSupplierName("");
      setNewSupplierUrl("");
      setShowConnectModal(false);
      setSyncSuccessMsg(`Connected new supplier "${newSupplierName}" successfully.`);
      playNotificationSound();
      setTimeout(() => setSyncSuccessMsg(null), 5000);
    } catch (err) {
      console.error("Connect supplier failed:", err);
    } finally {
      setSavingSupplier(false);
    }
  };

  // 1. Review Queue: Approve & Save Review Metadata
  const handleApproveReview = async (item: SupplierReviewQueueItem) => {
    setProcessingReviewId(item.id);
    try {
      await approveSupplierQueueItem(item);
      
      showSettingsToast("success", `Approved change for "${item.productName}".`);
      playNotificationSound();
    } catch (err: any) {
      console.error("Approve review item error:", err);
      showSettingsToast("error", err?.message || "Failed to approve review item.");
    } finally {
      setProcessingReviewId(null);
    }
  };

  // 2. Review Queue: Reject & Save Review Metadata
  const handleRejectReview = async (item: SupplierReviewQueueItem) => {
    setProcessingReviewId(item.id);
    try {
      await rejectSupplierQueueItem(item);
      
      showSettingsToast("success", `Rejected change for "${item.productName}".`);
    } catch (err: any) {
      console.error("Reject review item error:", err);
      showSettingsToast("error", err?.message || "Failed to reject review item.");
    } finally {
      setProcessingReviewId(null);
    }
  };

  // 3. Pending Changes: Approve Pending Change
  const handleApprovePendingChange = async (change: any) => {
    setProcessingChangeId(change.id);
    try {
      const linkedReviewItem = supplierReviewQueue.find(item => item.id === change.reviewQueueItemId);
      await approveSupplierQueueItem({
        ...linkedReviewItem,
        ...change,
        id: change.id,
        productPayload: change.productPayload || linkedReviewItem?.productPayload,
        reviewQueueItemId: change.reviewQueueItemId || linkedReviewItem?.id
      });
      
      showSettingsToast("success", `Approved supplier change for "${change.productName}".`);
      playNotificationSound();
    } catch (err: any) {
      console.error("Approve pending change error:", err);
      showSettingsToast("error", err?.message || "Failed to approve pending change.");
    } finally {
      setProcessingChangeId(null);
    }
  };

  // 4. Pending Changes: Reject Pending Change
  const handleRejectPendingChange = async (change: any) => {
    setProcessingChangeId(change.id);
    try {
      await rejectSupplierQueueItem(change);
      
      showSettingsToast("success", `Rejected supplier change for "${change.productName}".`);
      playNotificationSound();
    } catch (err: any) {
      console.error("Reject pending change error:", err);
      showSettingsToast("error", err?.message || "Failed to reject pending change.");
    } finally {
      setProcessingChangeId(null);
    }
  };

  // 5. Settings: Save Integration Settings
  const handleSaveHubSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingHubSettings(true);
    try {
      const docRef = doc(db, "supplier_settings", "config");
      const updatedPayload = {
        ...supplierHubSettings,
        updatedAt: new Date().toLocaleString('en-US')
      };
      await setDoc(docRef, updatedPayload, { merge: true });
      setSupplierHubSettings(updatedPayload);
      showSettingsToast("success", "Supplier Hub integration configuration saved.");
      playNotificationSound();
    } catch (err: any) {
      console.error("Save hub settings failed:", err);
      showSettingsToast("error", "Failed to save integration parameters.");
    } finally {
      setSavingHubSettings(false);
    }
  };

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
      showSettingsToast("success", "Supplier Hub configurations saved successfully.");
      playNotificationSound();
    } catch (err: any) {
      console.error("Save supplier settings failed:", err);
      showSettingsToast("error", "Failed to save configuration settings.");
    } finally {
      setSavingSupplierSettings(false);
    }
  };

  const handleResetSupplierSettings = async () => {
    setSavingSupplierSettings(true);
    try {
      const email = auth.currentUser?.email || "Admin";
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
        updatedBy: email
      };
      await setDoc(doc(db, "supplier_settings", "config"), defaults, { merge: true });
      showSettingsToast("success", "Configurations reset to system defaults.");
      playNotificationSound();
      setShowResetSettingsConfirm(false);
    } catch (err: any) {
      console.error("Reset supplier settings failed:", err);
      showSettingsToast("error", "Failed to reset configurations.");
    } finally {
      setSavingSupplierSettings(false);
    }
  };

  // 6. Import Queue: Simulate trigger feed import
  const handleTriggerImport = async () => {
    const importId = `imp-${Date.now()}`;
    setProcessingImportId(importId);
    try {
      const newImportItem = {
        id: importId,
        supplierCode: "SUP-MANUAL",
        supplierName: "Manual Feed Import",
        productName: "Ad-hoc catalog refresh run",
        source: "Website",
        importStatus: "Downloading",
        progress: 10,
        totalImages: 10,
        downloadedImages: 1,
        createdAt: new Date().toISOString(),
        completedAt: "",
        errorMessage: ""
      };

      await setDoc(doc(db, "supplier_import_queue", importId), newImportItem);

      // Interactive progress simulation
      let progress = 10;
      let status = "Downloading";
      const interval = setInterval(async () => {
        progress += 30;
        if (progress >= 40 && progress < 80) {
          status = "Processing";
        }
        if (progress >= 100) {
          progress = 100;
          status = "Completed";
          clearInterval(interval);
          const completedItem = {
            ...newImportItem,
            importStatus: "Completed",
            progress: 100,
            downloadedImages: 10,
            completedAt: new Date().toISOString()
          };
          await setDoc(doc(db, "supplier_import_queue", importId), completedItem);
          setProcessingImportId(null);
          showSettingsToast("success", "Feed synchronization complete. Check Review Queue for new items!");
          playNotificationSound();
        } else {
          const updatedItem = {
            ...newImportItem,
            importStatus: status,
            progress: progress,
            downloadedImages: Math.round(10 * (progress / 100))
          };
          await setDoc(doc(db, "supplier_import_queue", importId), updatedItem);
        }
      }, 2000);

    } catch (err: any) {
      console.error("Trigger manual import error:", err);
      setProcessingImportId(null);
    }
  };

  // 7. Clear completed imports
  const handleClearImportQueue = async () => {
    try {
      const completed = supplierImportQueue.filter(i => i.importStatus === 'Completed' || i.status === 'completed');
      for (const item of completed) {
        await deleteDoc(doc(db, "supplier_import_queue", item.id));
      }
      showSettingsToast("success", "Import queue history cleared.");
    } catch (err: any) {
      console.error("Clear import queue error:", err);
    }
  };

  // Sync users & orders into customers
  useEffect(() => {
    const buyerMap = new Map();
    users.forEach(u => buyerMap.set(u.email, u));
    orders.forEach(o => {
      if (o.customerEmail && !buyerMap.has(o.customerEmail)) {
        buyerMap.set(o.customerEmail, {
          uid: o.customerUid,
          email: o.customerEmail,
          displayName: o.customerName,
          phone: o.customerPhone,
          role: 'customer',
          createdAt: o.createdAt
        });
      }
    });
    setCustomers(Array.from(buyerMap.values()));
  }, [users, orders]);

  // Auth Checks
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        setAuthorized(false);
        setLoading(false);
        return;
      }
      try {
        if (isProductionAdminEmail(currentUser.email)) {
          setAuthorized(true);
        } else {
          setAuthorized(false);
          setLoading(false);
        }
      } catch (err) {
        setAuthorized(false);
        setLoading(false);
      }
    });
    return () => unsubscribeAuth();
  }, []);

  // Live order snapshot and live reviews snapshot
  useEffect(() => {
    if (!authorized) return;
    let isInitial = true;

    const unsubscribeOrders = onSnapshot(collection(db, "orders"), async (snapshot) => {
      const orderList: Order[] = [];
      snapshot.forEach((d) => {
        orderList.push({ id: d.id, ...d.data() } as Order);
      });

      orderList.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return (isNaN(timeA) ? 0 : timeA) - (isNaN(timeB) ? 0 : timeB);
      });

      for (let i = 0; i < orderList.length; i++) {
        const orderNum = `ZY${100001 + i}`;
        if (!orderList[i].orderNumber) {
          orderList[i].orderNumber = orderNum;
          try {
            await updateDoc(doc(db, "orders", orderList[i].id), { orderNumber: orderNum });
          } catch (e) { console.warn("Order number generation error", e); }
        }
      }

      orderList.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
      });
      setOrders(orderList);

      if (!isInitial) {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added") {
            const addedOrder = { id: change.doc.id, ...change.doc.data() } as Order;
            const matchedOrder = orderList.find(o => o.id === addedOrder.id) || addedOrder;
            playNotificationSound();
            const orderNum = matchedOrder.orderNumber || matchedOrder.id.substring(0, 8).toUpperCase();
            const newToast = {
              id: `${Date.now()}`,
              orderId: matchedOrder.id,
              orderNumber: orderNum,
              customerName: matchedOrder.customerName,
              totalPrice: matchedOrder.totalPrice
            };
            setToasts(prev => [...prev, newToast]);
            setTimeout(() => {
              setToasts(prev => prev.filter(t => t.id !== newToast.id));
            }, 8000);
          }
        });
      }
      isInitial = false;
    });

    const unsubscribeReviews = onSnapshot(collection(db, "reviews"), (snapshot) => {
      const revList: any[] = [];
      snapshot.forEach((d) => {
        revList.push({ id: d.id, ...d.data() });
      });
      revList.sort((a,b) => {
        const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tB - tA;
      });
      setReviews(revList);
    });

    const unsubscribeReviewQueue = onSnapshot(collection(db, "supplier_review_queue"), (snapshot) => {
      const list: SupplierReviewQueueItem[] = [];
      snapshot.forEach((d) => {
        list.push({ id: d.id, ...d.data() } as SupplierReviewQueueItem);
      });
      list.sort((a, b) => {
        const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tB - tA;
      });
      setSupplierReviewQueue(list);
      setIsReviewQueueLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, "supplier_review_queue");
    });

    const unsubscribeImportQueue = onSnapshot(collection(db, "supplier_import_queue"), (snapshot) => {
      const list: any[] = [];
      snapshot.forEach((d) => {
        list.push({ id: d.id, ...d.data() });
      });
      list.sort((a, b) => {
        const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tB - tA;
      });
      setSupplierImportQueue(list);
      setIsImportQueueLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, "supplier_import_queue");
    });

    const unsubscribePendingChanges = onSnapshot(collection(db, "supplier_pending_changes"), (snapshot) => {
      const list: any[] = [];
      snapshot.forEach((d) => {
        list.push({ id: d.id, ...d.data() });
      });
      list.sort((a, b) => {
        const tA = a.detectedAt ? new Date(a.detectedAt).getTime() : 0;
        const tB = b.detectedAt ? new Date(b.detectedAt).getTime() : 0;
        return tB - tA;
      });
      setSupplierPendingChanges(list);
      setIsPendingChangesLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, "supplier_pending_changes");
      setIsPendingChangesLoading(false);
    });

    const unsubscribeSyncHistory = onSnapshot(collection(db, "supplier_sync_history"), (snapshot) => {
      const list: any[] = [];
      snapshot.forEach((d) => {
        list.push({ id: d.id, ...d.data() });
      });
      list.sort((a, b) => {
        const tA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const tB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return tB - tA;
      });
      setSupplierSyncHistory(list);
      setIsSyncHistoryLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, "supplier_sync_history");
      setIsSyncHistoryLoading(false);
    });

    const unsubscribeSupplierSettings = onSnapshot(doc(db, "supplier_settings", "config"), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setSupplierSettings({ ...DEFAULT_SUPPLIER_SETTINGS, ...data });
        setSupplierHubSettings({ ...DEFAULT_SUPPLIER_HUB_SETTINGS, ...data });
        setIsSettingsLoading(false);
      } else {
        setSupplierSettings({
          ...DEFAULT_SUPPLIER_SETTINGS,
          lastUpdated: new Date().toISOString(),
          updatedBy: "System"
        });
        setSupplierHubSettings(DEFAULT_SUPPLIER_HUB_SETTINGS);
        setIsSettingsLoading(false);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, "supplier_settings");
      setIsSettingsLoading(false);
    });

    const unsubscribeProducts = onSnapshot(collection(db, "products"), (snapshot) => {
      const prodList: Product[] = [];
      snapshot.forEach((d) => {
        prodList.push({ id: d.id, ...d.data() } as Product);
      });
      setProducts(prodList);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, "products");
    });

    loadData();

    return () => {
      unsubscribeOrders();
      unsubscribeReviews();
      unsubscribeReviewQueue();
      unsubscribeImportQueue();
      unsubscribePendingChanges();
      unsubscribeSyncHistory();
      unsubscribeSupplierSettings();
      unsubscribeProducts();
    };
  }, [authorized]);

  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('en-LK', {
      style: 'currency',
      currency: 'LKR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  };

  // Save Product Handlers
  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authorized) return;

    // 1. Product Name validation (required)
    if (!newProduct.name?.trim()) {
      showSettingsToast("error", "Product name is required.");
      return;
    }

    // 2. Sale Price validation (required, > 0)
    if (!newProduct.price || isNaN(Number(newProduct.price)) || Number(newProduct.price) <= 0) {
      showSettingsToast("error", "Please enter a valid sale price.");
      return;
    }

    // 3. Stock validation (required, non-negative integer)
    if (newProduct.stock === undefined || newProduct.stock === null || isNaN(Number(newProduct.stock)) || Number(newProduct.stock) < 0) {
      showSettingsToast("error", "Stock quantity is required and must be a non-negative number.");
      return;
    }

    // 4. Slug validation (cannot be empty)
    if (!newProduct.id?.trim()) {
      showSettingsToast("error", "Product slug / ID cannot be empty.");
      return;
    }

    // 5. Prevent duplicate slugs
    const isDuplicateSlug = products.some(p => p.id.trim().toLowerCase() === newProduct.id?.trim().toLowerCase() && p.id !== editingProduct?.id);
    if (isDuplicateSlug) {
      showSettingsToast("error", `Product slug "${newProduct.id}" is already in use by another product.`);
      return;
    }

    // 6. Guarantee uniqueness of SKU
    let finalSku = newProduct.sku;
    if (!editingProduct) {
      // If SKU is empty or somehow duplicated, we regenerate to guarantee uniqueness
      if (!finalSku || products.some(p => p.sku?.trim().toLowerCase() === finalSku?.trim().toLowerCase())) {
        finalSku = generateNextSku(products);
      }
    } else {
      // On edit, SKU cannot be changed
      finalSku = editingProduct.sku;
    }

    if (!finalSku) {
      showSettingsToast("error", "Product SKU is required.");
      return;
    }

    const productErrors = validateProductForSave({
      product: { ...newProduct, sku: finalSku },
      products,
      categories,
      editingProductId: editingProduct?.id,
    });
    if (productErrors.length > 0) {
      showSettingsToast("error", productErrors[0]);
      return;
    }

    setSavingProduct(true);
    try {
      let disc = 0;
      if (newProduct.originalPrice && newProduct.originalPrice > (newProduct.price || 0)) {
        disc = Math.round(((newProduct.originalPrice - (newProduct.price || 0)) / newProduct.originalPrice) * 100);
      }

      const payload = sanitizeFirestoreData({
        ...newProduct,
        id: editingProduct ? editingProduct.id : newProduct.id,
        price: Number(newProduct.price),
        imageUrl: newProduct.imageUrl?.trim(),
        imageUrls: [...new Set((newProduct.imageUrls || []).map((url) => url.trim()))],
        originalPrice: newProduct.originalPrice ? Number(newProduct.originalPrice) : undefined,
        discount: disc || undefined,
        stock: Number(newProduct.stock),
        rating: editingProduct ? editingProduct.rating : 5,
        reviewsCount: editingProduct ? editingProduct.reviewsCount : 0,
        isActive: newProduct.isActive !== false,
        sku: finalSku,
        supplierItemCode: newProduct.supplierItemCode || undefined,
        costPrice: newProduct.costPrice ? Number(newProduct.costPrice) : undefined,
        marketPrice: newProduct.marketPrice ? Number(newProduct.marketPrice) : undefined
      });

      if (editingProduct) {
        await updateDoc(doc(db, "products", editingProduct.id), payload);
        showSettingsToast("success", `Product "${newProduct.name}" updated successfully.`);
      } else {
        const pId = newProduct.id!;
        await setDoc(doc(db, "products", pId), { ...payload, id: pId });
        showSettingsToast("success", `Product "${newProduct.name}" created successfully.`);
      }

      setShowProductModal(false);
      setEditingProduct(null);
      setNewProduct({
        name: "", description: "", price: 0, originalPrice: 0, discount: 0,
        imageUrl: "", imageUrls: [], category: categories[0]?.id || "", stock: 10, specs: {},
        isNew: false, isFeatured: false, isBestSeller: false, isActive: true, sku: "",
        supplierItemCode: "", costPrice: undefined, marketPrice: undefined
      });
      setSpecKey("");
      setSpecVal("");
      loadData();
    } catch (err: any) {
      console.error("Save product failed:", err);
      showSettingsToast("error", err?.message || "Failed to save product record.");
    } finally {
      setSavingProduct(false);
    }
  };

  const handleEditProductClick = (prod: Product) => {
    setEditingProduct(prod);
    setNewProduct({
      ...prod,
      imageUrls: prod.imageUrls || []
    });
    setShowProductModal(true);
  };

  // Duplicate Product Handler
  const handleDuplicateProduct = (prod: Product) => {
    const nextSku = generateNextSku(products);
    const duplicatedName = `${prod.name} (Copy)`;
    const duplicatedId = generateUniqueSlug(duplicatedName, products);
    
    setEditingProduct(null);
    setNewProduct({
      ...prod,
      id: duplicatedId,
      sku: nextSku,
      name: duplicatedName,
      isActive: prod.isActive !== false,
      imageUrls: prod.imageUrls || []
    });
    setSpecKey("");
    setSpecVal("");
    setShowProductModal(true);
  };

  const confirmDeleteProduct = async () => {
    if (!productToDelete || !authorized) return;
    try {
      const productName = productToDelete.name;
      await deleteDoc(doc(db, "products", productToDelete.id));
      showSettingsToast("success", `Product "${productName}" deleted successfully.`);
      setProductToDelete(null);
      loadData();
    } catch (err: any) {
      console.error("Delete failed:", err);
      showSettingsToast("error", err?.message || "Failed to delete product.");
    }
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authorized) return;
    const id = editingCategory?.id ?? normalizeCategorySlug(newCategory.id);
    const name = normalizeCategoryName(newCategory.name);
    if (!id || !name) {
      showSettingsToast('error', 'Category slug and display name are required.');
      return;
    }
    if (!editingCategory && isDuplicateCategorySlug(categories, id)) {
      showSettingsToast('error', `Category slug "${id}" already exists.`);
      return;
    }
    if (newCategory.imageUrl.trim() && !isHttpUrl(newCategory.imageUrl)) {
      showSettingsToast('error', 'Category image must use a valid http or https URL.');
      return;
    }
    setSavingCategory(true);
    try {
      if (!editingCategory) {
        const existingCategory = await getDoc(doc(db, 'categories', id));
        if (existingCategory.exists()) {
          showSettingsToast('error', `Category slug "${id}" already exists.`);
          return;
        }
      }
      await setDoc(doc(db, "categories", id), {
        name,
        icon: newCategory.icon.trim() || 'Layers',
        imageUrl: newCategory.imageUrl.trim(),
        isActive: newCategory.isActive,
      }, { merge: Boolean(editingCategory) });
      showSettingsToast('success', `Category "${name}" ${editingCategory ? 'updated' : 'created'} successfully.`);
      setNewCategory({ id: "", name: "", icon: "Smartphone", imageUrl: "", isActive: true });
      closeCategoryModal();
      loadData();
    } catch (err: any) {
      console.error("Save category failed:", err);
      showSettingsToast('error', err?.message || 'Failed to save category.');
    } finally {
      setSavingCategory(false);
    }
  };

  const openCreateCategory = (trigger: HTMLElement) => {
    categoryTriggerRef.current = trigger;
    setEditingCategory(null);
    setNewCategory({ id: '', name: '', icon: 'Smartphone', imageUrl: '', isActive: true });
    setShowCategoryModal(true);
  };

  const openEditCategory = (category: Category, trigger: HTMLElement) => {
    categoryTriggerRef.current = trigger;
    setEditingCategory(category);
    setNewCategory({
      id: category.id,
      name: category.name,
      icon: category.icon || 'Layers',
      imageUrl: category.imageUrl || '',
      isActive: category.isActive !== false,
    });
    setShowCategoryModal(true);
  };

  const requestDeleteCategory = (category: Category, trigger: HTMLElement) => {
    categoryTriggerRef.current = trigger;
    if (!canDeleteCategory(categoryProductCounts[category.id])) {
      showSettingsToast('error', 'This category is currently used by products.');
      return;
    }
    setCategoryToDelete(category);
  };

  const confirmDeleteCategory = async () => {
    if (!authorized || !categoryToDelete) return;
    if (!canDeleteCategory(categoryProductCounts[categoryToDelete.id])) {
      showSettingsToast('error', 'This category is currently used by products.');
      closeCategoryDeleteConfirmation();
      return;
    }
    setSavingCategory(true);
    try {
      const currentProductsSnapshot = await getDocs(collection(db, 'products'));
      const currentProducts: Product[] = [];
      currentProductsSnapshot.forEach((productDocument) => {
        currentProducts.push({ id: productDocument.id, ...productDocument.data() } as Product);
      });
      const currentCounts = buildCategoryProductCounts([categoryToDelete], currentProducts)[categoryToDelete.id];
      if (!canDeleteCategory(currentCounts)) {
        showSettingsToast('error', 'This category is currently used by products.');
        closeCategoryDeleteConfirmation();
        return;
      }
      await deleteDoc(doc(db, 'categories', categoryToDelete.id));
      showSettingsToast('success', `Category "${categoryToDelete.name}" deleted successfully.`);
      closeCategoryDeleteConfirmation();
      loadData();
    } catch (err: any) {
      console.error('Delete category failed:', err);
      showSettingsToast('error', err?.message || 'Failed to delete category.');
    } finally {
      setSavingCategory(false);
    }
  };

  const handleUpdateOrderStatus = async (orderId: string, newStatus: string) => {
    if (!authorized) return;
    setUpdatingOrderStatus(prev => ({ ...prev, [orderId]: true }));
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("Admin authentication is required. Please sign in again.");
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to update order status.');
      showSettingsToast("success", `Order #${orderId.substring(0, 8).toUpperCase()} status set to ${newStatus.toUpperCase()}`);
    } catch (err: any) {
      console.error("Order update failed:", err);
      showSettingsToast("error", err?.message || `Failed to update order #${orderId.substring(0, 8).toUpperCase()}`);
    } finally {
      setUpdatingOrderStatus(prev => ({ ...prev, [orderId]: false }));
    }
  };

  const addSpecItem = () => {
    if (specKey && specVal) {
      setNewProduct(prev => ({
        ...prev,
        specs: { ...(prev.specs || {}), [specKey]: specVal }
      }));
      setSpecKey("");
      setSpecVal("");
    }
  };

  const removeSpecItem = (key: string) => {
    const updatedSpecs = { ...(newProduct.specs || {}) };
    delete updatedSpecs[key];
    setNewProduct(prev => ({ ...prev, specs: updatedSpecs }));
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authorized || !settingsForm) return;

    const settingsValidation = validateStoreSettings({
      settings: settingsForm,
      deliveryCharge: tempDeliveryCharge,
      freeDeliveryMin: tempFreeDeliveryMin,
    });
    if (settingsValidation.errors.length > 0) {
      showSettingsToast('error', settingsValidation.errors[0]);
      return;
    }

    const heroErrors = validateHeroSlides(settingsForm.heroBanners);
    if (heroErrors.length > 0) {
      showSettingsToast('error', `Hero slider: ${heroErrors[0].message}`);
      return;
    }

    const updatedSettings: WebsiteSettings = {
      ...settingsForm,
      storeName: settingsForm.storeName.trim(),
      logoUrl: settingsForm.logoUrl?.trim(),
      faviconUrl: settingsForm.faviconUrl?.trim(),
      contactEmail: settingsForm.contactEmail?.trim(),
      contactPhone: settingsForm.contactPhone?.trim(),
      contactPhone2: settingsForm.contactPhone2?.trim(),
      whatsappNumber: settingsForm.whatsappNumber.trim(),
      facebookUrl: settingsForm.facebookUrl?.trim(),
      instagramUrl: settingsForm.instagramUrl?.trim(),
      tiktokUrl: settingsForm.tiktokUrl?.trim(),
      youtubeUrl: settingsForm.youtubeUrl?.trim(),
      autoSlideSpeed: normalizeSlideSpeed(settingsForm.autoSlideSpeed),
      deliveryCharge: settingsValidation.deliveryCharge!,
      freeDeliveryMin: settingsValidation.freeDeliveryMin!,
    };

    setSavingSettings(true);
    try {
      await setDoc(doc(db, "settings", "website"), updatedSettings);
      const persistedSnapshot = await getDoc(doc(db, "settings", "website"));
      if (!persistedSnapshot.exists()) throw new Error('Settings could not be verified after saving.');
      const persistedSettings = { ...DEFAULT_WEBSITE_SETTINGS, ...persistedSnapshot.data() } as WebsiteSettings;
      setSettings(persistedSettings);
      setSettingsForm(persistedSettings);
      setTempDeliveryCharge(String(persistedSettings.deliveryCharge));
      setTempFreeDeliveryMin(String(persistedSettings.freeDeliveryMin));
      showSettingsToast("success", "Website settings saved and verified.");
    } catch (err: any) {
      console.error("Save settings error:", err);
      const errorMsg = err?.message || "Save failed, check authorization.";
      showSettingsToast("error", errorMsg);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleBannerImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, bannerId: string) => {
    const file = e.target.files?.[0];
    if (!file || !settingsForm) return;
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    if (!allowedTypes.has(file.type)) {
      showSettingsToast('error', 'Banner upload must be a JPG, PNG, WebP, or GIF image.');
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showSettingsToast('error', 'Banner image must be 5 MB or smaller.');
      e.target.value = '';
      return;
    }
    try {
      const fileName = `${Date.now()}_banner_${bannerId}_${file.name.replace(/[^a-zA-Z0-9.]/g, "_")}`;
      const fileRef = storageRef(storage, `banners/${fileName}`);
      const snapshot = await uploadBytes(fileRef, file);
      const downloadUrl = await getDownloadURL(snapshot.ref);
      setSettingsForm(prev => {
        if (!prev) return prev;
        const updatedBanners = prev.heroBanners.map(b => b.id === bannerId ? { ...b, image: downloadUrl } : b);
        return { ...prev, heroBanners: updatedBanners };
      });
      showSettingsToast('success', 'Banner image uploaded. Save settings to publish the URL.');
    } catch (err) {
      console.error("Banner upload error:", err);
      showSettingsToast('error', 'Banner image upload failed. Please try again.');
    } finally {
      e.target.value = '';
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !settingsForm) return;
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']);
    if (!allowedTypes.has(file.type)) {
      showSettingsToast('error', 'Logo upload must be a JPG, PNG, WebP, or SVG image.');
      e.target.value = '';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showSettingsToast('error', 'Logo image must be 2 MB or smaller.');
      e.target.value = '';
      return;
    }
    try {
      const fileName = `${Date.now()}_logo_${file.name.replace(/[^a-zA-Z0-9.]/g, "_")}`;
      const fileRef = storageRef(storage, `logos/${fileName}`);
      const snapshot = await uploadBytes(fileRef, file);
      const downloadUrl = await getDownloadURL(snapshot.ref);
      setSettingsForm(prev => {
        if (!prev) return prev;
        return { ...prev, logoUrl: downloadUrl };
      });
      showSettingsToast('success', 'Logo uploaded. Save settings to publish the URL.');
    } catch (err) {
      console.error("Logo upload error:", err);
      showSettingsToast('error', 'Logo upload failed. Please try again.');
    } finally {
      e.target.value = '';
    }
  };

  // --- STATS DERIVATIONS ---
  const totalSalesVal = orders
    .filter(o => o.status === 'confirmed' || o.status === 'delivered')
    .reduce((acc, o) => acc + o.totalPrice, 0);

  const todaySalesVal = orders
    .filter(o => {
      if (!o.createdAt || o.status === 'cancelled') return false;
      const oDate = new Date(o.createdAt);
      const today = new Date();
      return oDate.getDate() === today.getDate() && 
             oDate.getMonth() === today.getMonth() && 
             oDate.getFullYear() === today.getFullYear();
    })
    .reduce((acc, o) => acc + o.totalPrice, 0);

  const lowStockProducts = products.filter(p => p.stock <= 5);
  const pendingOrders = orders.filter(o => o.status === 'pending');

  const avgRating = products.length > 0
    ? (products.reduce((acc, p) => acc + (p.rating || 5), 0) / products.length).toFixed(1)
    : "5.0";

  // Chart Data Processing
  const getSalesChartData = () => {
    const now = new Date();
    const dataMap: Record<string, number> = {};

    if (salesPeriod === '7d') {
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        const label = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
        dataMap[label] = 0;
      }
      orders.forEach(o => {
        if (o.status === 'cancelled' || !o.createdAt) return;
        const d = new Date(o.createdAt);
        const daysDiff = (now.getTime() - d.getTime()) / (1000 * 3600 * 24);
        if (daysDiff <= 7) {
          const label = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
          if (dataMap[label] !== undefined) dataMap[label] += o.totalPrice;
        }
      });
    } else if (salesPeriod === '30d') {
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        dataMap[label] = 0;
      }
      orders.forEach(o => {
        if (o.status === 'cancelled' || !o.createdAt) return;
        const d = new Date(o.createdAt);
        const daysDiff = (now.getTime() - d.getTime()) / (1000 * 3600 * 24);
        if (daysDiff <= 30) {
          const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          if (dataMap[label] !== undefined) dataMap[label] += o.totalPrice;
        }
      });
    } else {
      for (let i = 11; i >= 0; i--) {
        const d = new Date();
        d.setMonth(now.getMonth() - i);
        const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        dataMap[label] = 0;
      }
      orders.forEach(o => {
        if (o.status === 'cancelled' || !o.createdAt) return;
        const d = new Date(o.createdAt);
        const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        if (dataMap[label] !== undefined) dataMap[label] += o.totalPrice;
      });
    }
    return Object.entries(dataMap).map(([name, sales]) => ({ name, sales: Math.round(sales) }));
  };

  const categorySalesMap: Record<string, number> = {};
  orders.forEach(o => {
    if (o.status === 'cancelled') return;
    o.items.forEach(it => {
      const matchedProd = products.find(p => p.id === it.productId);
      const catSlug = matchedProd ? matchedProd.category : "General";
      categorySalesMap[catSlug] = (categorySalesMap[catSlug] || 0) + (it.price * it.quantity);
    });
  });

  const pieChartData = Object.entries(categorySalesMap).map(([key, val]) => ({
    name: key.toUpperCase().replace('-', ' '),
    value: val
  }));

  const COLORS_PALETTE = ['#2563EB', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4'];

  const topSellingMap: Record<string, { product: Product; qty: number; revenue: number }> = {};
  orders.forEach(o => {
    if (o.status === 'cancelled') return;
    o.items.forEach(it => {
      const p = products.find(prod => prod.id === it.productId);
      if (p) {
        if (!topSellingMap[p.id]) {
          topSellingMap[p.id] = { product: p, qty: 0, revenue: 0 };
        }
        topSellingMap[p.id].qty += it.quantity;
        topSellingMap[p.id].revenue += it.price * it.quantity;
      }
    });
  });

  const topSellingProductsList = Object.values(topSellingMap)
    .sort((a,b) => b.revenue - a.revenue)
    .slice(0, 5);

  // --- FILTERS ---
  const filteredOrders = orders.filter(o => {
    const sLower = orderSearch.toLowerCase();
    const idMatch = (o.orderNumber || "").toLowerCase().includes(sLower) || o.id.toLowerCase().includes(sLower);
    const nameMatch = o.customerName.toLowerCase().includes(sLower) || o.customerPhone.includes(sLower) || o.customerEmail.toLowerCase().includes(sLower);
    const matchesSearch = !orderSearch || idMatch || nameMatch;
    const matchesStatus = orderStatusFilter === "all" || o.status === orderStatusFilter;
    return matchesSearch && matchesStatus;
  });

  const filteredProducts = searchAdminProducts(products, productSearch).filter(p => {
    const matchesCategory = productCategoryFilter === "all" || categoryMatches(p.category, productCategoryFilter);
    const matchesStock = productStockFilter === "all" || (productStockFilter === "instock" ? p.stock > 0 : p.stock <= 5);
    return matchesCategory && matchesStock;
  });

  const filteredCustomers = customers.filter(c => {
    const sLower = customerSearch.toLowerCase();
    return (c.displayName || "").toLowerCase().includes(sLower) || (c.email || "").toLowerCase().includes(sLower) || (c.phone || "").includes(sLower);
  });

  // Notifications alerts
  const notificationsList = [
    ...lowStockProducts.map(p => ({ id: `stock-${p.id}`, type: 'stock', text: `${p.name} is low on stock (${p.stock} left)`, time: 'Immediate action' })),
    ...pendingOrders.slice(0, 5).map(o => ({ id: `order-${o.id}`, type: 'order', text: `New pending order #${o.orderNumber || o.id.substring(0,8)}`, time: o.createdAt ? new Date(o.createdAt).toLocaleDateString() : 'Recent' })),
    ...reviews.filter(r => r.approved === false).map(r => ({ id: `rev-${r.id}`, type: 'review', text: `New unapproved review: "${r.comment}"`, time: 'Needs verification' }))
  ];

  if (authorized === null) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6 font-sans">
        <RefreshCw className="h-10 w-10 text-blue-500 animate-spin mb-4" />
        <p className="text-sm font-semibold tracking-wide text-slate-400">Verifying secure admin session...</p>
      </div>
    );
  }

  if (authorized === false) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6 text-center font-sans">
        <div className="max-w-md bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl space-y-6">
          <ShieldCheck className="h-12 w-12 text-red-500 mx-auto" />
          <h2 className="text-xl font-bold">Admin Authorization Required</h2>
          <p className="text-sm text-slate-400 leading-relaxed">
            Please sign in with the registered corporate administrator account ({PRODUCTION_ADMIN_EMAIL}) to access administrative transactions.
          </p>
          <div className="flex gap-4">
            <button onClick={() => window.location.href = '/'} className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 font-semibold rounded-xl text-xs transition-all cursor-pointer">Return Home</button>
            <button onClick={() => window.location.reload()} className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 font-semibold rounded-xl text-xs transition-all cursor-pointer">Sign In</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`min-h-screen font-sans flex flex-col md:flex-row transition-colors duration-300 ${isDarkMode ? 'bg-[#080E1A] text-slate-100' : 'bg-slate-50 text-slate-800'}`}>
      
      {/* --- SIDEBAR PANEL (Always #0B1220 Dark) --- */}
      <aside className={`fixed md:sticky top-0 z-40 w-72 h-screen bg-[#0B1220] text-slate-300 border-r border-slate-800/60 p-6 flex flex-col justify-between transition-transform duration-300 ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="space-y-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-9 h-9 bg-gradient-to-tr from-blue-600 to-indigo-500 rounded-xl flex items-center justify-center font-bold text-white shadow-lg shadow-blue-500/20">
                Z
              </div>
              <div>
                <span className="font-extrabold text-white tracking-tight text-lg block">Zyro.lk</span>
                <span className="text-[10px] text-blue-400 font-bold uppercase tracking-widest block">ADMIN PORTAL</span>
              </div>
            </div>
            <button onClick={() => setIsMobileMenuOpen(false)} className="md:hidden text-slate-400 hover:text-white cursor-pointer">
              <X className="h-5 w-5" />
            </button>
          </div>

          <nav className="space-y-1.5 pt-4">
            {[
              { id: 'stats', label: 'Dashboard', icon: TrendingUp },
              { id: 'aiManager', label: 'AI Manager', icon: Sparkles },
              { id: 'products', label: 'Products Catalog', icon: ShoppingBag },
              { id: 'categories', label: 'Categories', icon: Layers },
              { id: 'orders', label: 'Orders Feed', icon: Clock },
              { id: 'customers', label: 'Customers', icon: Users },
              { id: 'pages', label: 'Pages CMS', icon: FileText },
              { id: 'settings', label: 'Store Settings', icon: Settings },
              { id: 'supplierHubFiveStars', label: 'Supplier Hub ⭐⭐⭐⭐⭐', icon: Award }
            ].map(tab => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id as any); setIsMobileMenuOpen(false); }}
                  className={`w-full flex items-center space-x-3.5 px-4 py-3 rounded-xl font-medium text-xs transition-all cursor-pointer ${active ? 'bg-blue-600 text-white font-bold shadow-lg shadow-blue-500/25' : 'hover:bg-slate-800/55 hover:text-white text-slate-400'}`}
                >
                  <Icon className={`h-4.5 w-4.5 ${active ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="border-t border-slate-800/80 pt-4 space-y-4">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 bg-slate-800 rounded-full flex items-center justify-center font-bold text-slate-200">
              ZA
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="text-xs font-bold text-white truncate">Zyro Admin</p>
              <p className="text-[10px] text-slate-500 truncate">{PRODUCTION_ADMIN_EMAIL}</p>
            </div>
          </div>
          <button onClick={() => auth.signOut()} className="w-full py-2 bg-slate-800 hover:bg-slate-700 hover:text-white text-[11px] font-bold rounded-lg transition-all cursor-pointer flex items-center justify-center space-x-1.5 text-slate-400">
            <Power className="h-3.5 w-3.5 text-red-500" />
            <span>Sign Out Session</span>
          </button>
        </div>
      </aside>

      {/* --- MAIN CORE WRAPPER --- */}
      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        
        {/* TOP COMPACT HEADER */}
        <header className={`px-6 py-4 border-b flex items-center justify-between sticky top-0 z-30 backdrop-blur-md ${isDarkMode ? 'bg-[#080E1A]/85 border-slate-800/50' : 'bg-white/85 border-slate-200/50'}`}>
          <div className="flex items-center space-x-4">
            <button onClick={() => setIsMobileMenuOpen(true)} className="md:hidden p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white">
              <Menu className="h-5 w-5" />
            </button>
            <div className="hidden sm:flex items-center space-x-2 text-xs font-semibold text-slate-400">
              <span>Overview</span>
              <ChevronRight className="h-3 w-3" />
              <span className={isDarkMode ? 'text-white' : 'text-slate-800'}>{activeTab.toUpperCase()}</span>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {/* Theme Toggle */}
            <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-2 bg-slate-100 dark:bg-slate-800 rounded-xl text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer">
              {isDarkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            {/* Notification bell */}
            <div className="relative">
              <button onClick={() => setShowNotifications(!showNotifications)} className="p-2 bg-slate-100 dark:bg-slate-800 rounded-xl text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 relative cursor-pointer">
                <Bell className="h-4 w-4" />
                {notificationsList.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full text-[9px] font-black flex items-center justify-center animate-bounce">
                    {notificationsList.length}
                  </span>
                )}
              </button>

              <AnimatePresence>
                {showNotifications && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className={`absolute right-0 mt-3 w-80 rounded-2xl shadow-2xl p-4 border text-left ${isDarkMode ? 'bg-[#121A2E] border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-800'}`}>
                    <div className="flex items-center justify-between border-b pb-2 mb-3">
                      <span className="text-xs font-bold uppercase tracking-wider text-blue-500">Alert Center</span>
                      <button onClick={() => setShowNotifications(false)} className="text-[10px] text-slate-400 hover:underline">Close</button>
                    </div>
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {notificationsList.length === 0 ? (
                        <p className="text-[11px] text-slate-400 text-center py-4">No active store warnings.</p>
                      ) : (
                        notificationsList.map(notif => (
                          <div key={notif.id} className="p-2 bg-slate-100/50 dark:bg-slate-800/40 rounded-lg text-[11px] space-y-1">
                            <p className="font-semibold">{notif.text}</p>
                            <span className="text-[9px] text-slate-400 block">{notif.time}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-ping" />
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest hidden lg:inline">Live Mode</span>
            </div>
          </div>
        </header>

        {/* MAIN BODY COMPILING CONTAINER */}
        <main className="flex-1 p-6 overflow-x-hidden space-y-8">
          
          {/* TAB 1: DASHBOARD STATS */}
          {activeTab === 'stats' && (() => {
            // Trend and statistics derivation engine
            const getPeriodTrend = (type: 'revenue' | 'orders' | 'customers') => {
              const now = new Date();
              let days = 30;
              if (salesPeriod === '7d') days = 7;
              if (salesPeriod === '1y') days = 365;

              const currentCutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
              const previousCutoff = new Date(now.getTime() - 2 * days * 24 * 60 * 60 * 1000);

              if (type === 'revenue') {
                const currentSales = orders
                  .filter(o => o.status === 'confirmed' || o.status === 'delivered')
                  .filter(o => o.createdAt && new Date(o.createdAt) >= currentCutoff)
                  .reduce((acc, o) => acc + o.totalPrice, 0);

                const prevSales = orders
                  .filter(o => o.status === 'confirmed' || o.status === 'delivered')
                  .filter(o => o.createdAt && new Date(o.createdAt) >= previousCutoff && new Date(o.createdAt) < currentCutoff)
                  .reduce((acc, o) => acc + o.totalPrice, 0);

                const diff = currentSales - prevSales;
                const percent = prevSales === 0 ? (currentSales > 0 ? 100 : 0) : (diff / prevSales) * 100;
                return { diff, percent, currentVal: currentSales, prevVal: prevSales };
              } else if (type === 'orders') {
                const currentCount = orders
                  .filter(o => o.createdAt && new Date(o.createdAt) >= currentCutoff).length;

                const prevCount = orders
                  .filter(o => o.createdAt && new Date(o.createdAt) >= previousCutoff && new Date(o.createdAt) < currentCutoff).length;

                const diff = currentCount - prevCount;
                const percent = prevCount === 0 ? (currentCount > 0 ? 100 : 0) : (diff / prevCount) * 100;
                return { diff, percent, currentVal: currentCount, prevVal: prevCount };
              } else {
                const currentCount = customers
                  .filter(c => c.createdAt && new Date(c.createdAt) >= currentCutoff).length;

                const prevCount = customers
                  .filter(c => c.createdAt && new Date(c.createdAt) >= previousCutoff && new Date(c.createdAt) < currentCutoff).length;

                const diff = currentCount - prevCount;
                const percent = prevCount === 0 ? (currentCount > 0 ? 100 : 0) : (diff / prevCount) * 100;
                return { diff, percent, currentVal: currentCount, prevVal: prevCount };
              }
            };

            const revTrend = getPeriodTrend('revenue');
            const ordTrend = getPeriodTrend('orders');
            const custTrend = getPeriodTrend('customers');

            // Generate Timeline Events (Unified activity feed)
            const getTimelineEvents = () => {
              const events: { id: string; type: 'order' | 'review' | 'stock' | 'customer'; title: string; subtitle: string; time: Date; meta?: string; link?: string }[] = [];

              // Orders
              orders.slice(0, 8).forEach(o => {
                if (o.createdAt) {
                  events.push({
                    id: `ord-${o.id}`,
                    type: 'order',
                    title: `New Order Received`,
                    subtitle: `Order #${o.orderNumber || o.id.substring(0, 8).toUpperCase()} placed by ${o.customerName}`,
                    time: new Date(o.createdAt),
                    meta: formatPrice(o.totalPrice),
                    link: o.id
                  });
                }
              });

              // Reviews
              reviews.slice(0, 5).forEach(r => {
                const rDate = r.createdAt ? (typeof r.createdAt === 'string' ? new Date(r.createdAt) : (r.createdAt.toDate ? r.createdAt.toDate() : new Date())) : new Date();
                events.push({
                  id: `rev-${r.id}`,
                  type: 'review',
                  title: `Product Reviewed`,
                  subtitle: `Shopper left a ${r.rating}★ rating: "${r.comment.length > 50 ? r.comment.substring(0, 50) + '...' : r.comment}"`,
                  time: rDate,
                  meta: `${r.rating} Stars`
                });
              });

              // Low Stocks
              products.filter(p => p.stock <= 5).slice(0, 4).forEach(p => {
                events.push({
                  id: `stock-${p.id}`,
                  type: 'stock',
                  title: p.stock === 0 ? `Item Out of Stock!` : `Low Inventory Warning`,
                  subtitle: `${p.name} has only ${p.stock} units remaining in the importer pool.`,
                  time: new Date(), // Live alert
                  meta: p.stock === 0 ? 'RESTOCK' : `${p.stock} units`
                });
              });

              // Customers
              customers.slice(0, 5).forEach(c => {
                if (c.createdAt) {
                  events.push({
                    id: `cust-${c.uid || c.id}`,
                    type: 'customer',
                    title: `Shopper Registered`,
                    subtitle: `${c.displayName || 'Direct Guest'} joined the Zyro verified shopper roster.`,
                    time: new Date(c.createdAt),
                    meta: c.email
                  });
                }
              });

              return events.sort((a, b) => b.time.getTime() - a.time.getTime()).slice(0, 10);
            };

            const timelineEvents = getTimelineEvents();

            const handlePeriodChange = (pId: '7d' | '30d' | '1y') => {
              setSalesPeriod(pId);
              const label = pId === '7d' ? 'Weekly (7 Days)' : pId === '30d' ? 'Monthly (30 Days)' : 'Yearly (12 Months)';
              showSettingsToast('success', `Switched dashboard analytics to ${label} view.`);
            };

            return (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8 text-slate-800 dark:text-slate-100">
                
                {/* Header overview controls */}
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                  <div className="text-left">
                    <h2 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Corporate Command Center</h2>
                    <p className="text-xs text-slate-400">Premium visual intelligence and inventory logs metrics</p>
                  </div>

                  {/* Stripe Segmented Controller */}
                  <div className="flex items-center space-x-2 bg-slate-100/80 dark:bg-slate-900 p-1 rounded-xl border border-slate-200/50 dark:border-slate-800 shadow-sm">
                    {[
                      { id: '7d', label: '7 Days' },
                      { id: '30d', label: '30 Days' },
                      { id: '1y', label: 'Yearly' }
                    ].map(p => (
                      <button 
                        key={p.id} 
                        onClick={() => handlePeriodChange(p.id as any)} 
                        className={`px-3.5 py-1.5 text-xs font-black rounded-lg transition-all cursor-pointer ${
                          salesPeriod === p.id 
                            ? 'bg-blue-600 text-white shadow-md' 
                            : 'text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Premium Apple-inspired KPI Cards Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                  
                  {/* KPI CARD 1: REVENUE */}
                  <div className={`rounded-3xl p-6 border flex flex-col justify-between transition-all hover:shadow-xl hover:-translate-y-1 relative overflow-hidden group ${
                    isDarkMode ? 'bg-gradient-to-b from-[#111c30] to-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
                  }`}>
                    {/* Decorative glowing gradient circle */}
                    <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 rounded-full blur-2xl group-hover:bg-blue-500/10 transition-all duration-500" />
                    
                    <div className="flex items-center justify-between relative z-10">
                      <span className="text-[11px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">Gross Revenue</span>
                      <div className="w-10 h-10 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center font-black">
                        <DollarSign className="h-5 w-5" />
                      </div>
                    </div>

                    <div className="mt-5 text-left relative z-10">
                      <p className="text-2xl md:text-3xl font-black tracking-tight text-slate-900 dark:text-white">
                        <AnimatedCounter value={totalSalesVal} formatter={(v) => formatPrice(v)} />
                      </p>
                      <div className="flex items-center space-x-1.5 mt-2.5">
                        <span className={`inline-flex items-center space-x-0.5 text-[10px] font-black px-2 py-0.5 rounded-full ${
                          revTrend.percent >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                        }`}>
                          {revTrend.percent >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                          <span>{Math.abs(revTrend.percent).toFixed(1)}%</span>
                        </span>
                        <span className="text-[10px] text-slate-400 font-medium">vs previous period</span>
                      </div>
                    </div>
                  </div>

                  {/* KPI CARD 2: TOTAL ORDERS */}
                  <div className={`rounded-3xl p-6 border flex flex-col justify-between transition-all hover:shadow-xl hover:-translate-y-1 relative overflow-hidden group ${
                    isDarkMode ? 'bg-gradient-to-b from-[#111c30] to-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
                  }`}>
                    <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/5 rounded-full blur-2xl group-hover:bg-purple-500/10 transition-all duration-500" />
                    
                    <div className="flex items-center justify-between relative z-10">
                      <span className="text-[11px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">Order Booking</span>
                      <div className="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-500 flex items-center justify-center font-black">
                        <ShoppingBag className="h-5 w-5" />
                      </div>
                    </div>

                    <div className="mt-5 text-left relative z-10">
                      <p className="text-2xl md:text-3xl font-black tracking-tight text-slate-900 dark:text-white">
                        <AnimatedCounter value={orders.length} />
                      </p>
                      <div className="flex items-center space-x-1.5 mt-2.5">
                        <span className={`inline-flex items-center space-x-0.5 text-[10px] font-black px-2 py-0.5 rounded-full ${
                          ordTrend.percent >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                        }`}>
                          {ordTrend.percent >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                          <span>{Math.abs(ordTrend.percent).toFixed(1)}%</span>
                        </span>
                        <span className="text-[10px] text-slate-400 font-medium">
                          {pendingOrders.length} pending actions
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* KPI CARD 3: CUSTOMERS SIGNUPS */}
                  <div className={`rounded-3xl p-6 border flex flex-col justify-between transition-all hover:shadow-xl hover:-translate-y-1 relative overflow-hidden group ${
                    isDarkMode ? 'bg-gradient-to-b from-[#111c30] to-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
                  }`}>
                    <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-all duration-500" />
                    
                    <div className="flex items-center justify-between relative z-10">
                      <span className="text-[11px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">Shoppers Roster</span>
                      <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center font-black">
                        <Users className="h-5 w-5" />
                      </div>
                    </div>

                    <div className="mt-5 text-left relative z-10">
                      <p className="text-2xl md:text-3xl font-black tracking-tight text-slate-900 dark:text-white">
                        <AnimatedCounter value={customers.length} />
                      </p>
                      <div className="flex items-center space-x-1.5 mt-2.5">
                        <span className={`inline-flex items-center space-x-0.5 text-[10px] font-black px-2 py-0.5 rounded-full ${
                          custTrend.percent >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'
                        }`}>
                          {custTrend.percent >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                          <span>{Math.abs(custTrend.percent).toFixed(1)}%</span>
                        </span>
                        <span className="text-[10px] text-slate-400 font-medium">registered profiles</span>
                      </div>
                    </div>
                  </div>

                  {/* KPI CARD 4: CRITICAL STOCK ALERT */}
                  <div className={`rounded-3xl p-6 border flex flex-col justify-between transition-all hover:shadow-xl hover:-translate-y-1 relative overflow-hidden group ${
                    isDarkMode ? 'bg-gradient-to-b from-[#111c30] to-[#0d1424] border-slate-800/80' : 'bg-white border-slate-200/60 shadow-xs'
                  }`}>
                    <div className="absolute top-0 right-0 w-32 h-32 bg-red-500/5 rounded-full blur-2xl group-hover:bg-red-500/10 transition-all duration-500" />
                    
                    <div className="flex items-center justify-between relative z-10">
                      <span className="text-[11px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">Inventory Index</span>
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black ${
                        lowStockProducts.length > 0 ? 'bg-red-500/10 text-red-500 animate-pulse' : 'bg-emerald-500/10 text-emerald-500'
                      }`}>
                        <AlertTriangle className="h-5 w-5" />
                      </div>
                    </div>

                    <div className="mt-5 text-left relative z-10">
                      <p className="text-2xl md:text-3xl font-black tracking-tight text-slate-900 dark:text-white">
                        <AnimatedCounter value={lowStockProducts.length} />
                      </p>
                      <div className="mt-2.5">
                        {/* Dynamic Stock progress indicator bar */}
                        <div className="w-full bg-slate-100 dark:bg-slate-800/80 rounded-full h-1.5 mt-2">
                          <div 
                            className={`h-1.5 rounded-full transition-all duration-500 ${
                              lowStockProducts.length > 3 ? 'bg-red-500' : lowStockProducts.length > 0 ? 'bg-amber-500' : 'bg-emerald-500'
                            }`}
                            style={{ width: `${Math.min(100, Math.max(5, (lowStockProducts.length / (products.length || 1)) * 100))}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-slate-400 font-bold block mt-1 uppercase tracking-wider">
                          {lowStockProducts.length > 0 ? `${lowStockProducts.length} devices need immediate restock` : 'all products fully stocked'}
                        </span>
                      </div>
                    </div>
                  </div>

                </div>

                {/* Double Chart Grid (Sales Line and Revenue Bar Chart) */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  
                  {/* CHART 1: Area line chart for Sales Trends */}
                  <div className={`lg:col-span-6 xl:col-span-7 rounded-3xl p-6 border text-left relative overflow-hidden ${
                    isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-lg' : 'bg-white border-slate-200/80 shadow-xs'
                  }`}>
                    <div className="flex items-center justify-between mb-6">
                      <div>
                        <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest block">Core Trend Analysis</span>
                        <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight">Sales Expansion Timeline</h3>
                      </div>
                      <div className="w-9 h-9 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center">
                        <TrendingUp className="h-5 w-5" />
                      </div>
                    </div>

                    <div className="h-72 w-full text-xs">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={getSalesChartData()}>
                          <defs>
                            <linearGradient id="colorSalesLine" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#2563EB" stopOpacity={0.45}/>
                              <stop offset="95%" stopColor="#2563EB" stopOpacity={0.0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? "#1f2937/40" : "#f1f5f9"} />
                          <XAxis dataKey="name" stroke="#9ca3af" tickLine={false} axisLine={false} />
                          <YAxis stroke="#9ca3af" tickLine={false} axisLine={false} tickFormatter={(v) => `LKR ${v}`} />
                          <Tooltip 
                            formatter={(value) => [formatPrice(value as number), 'Sales']} 
                            contentStyle={isDarkMode ? { backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '14px', color: '#fff' } : { borderRadius: '14px' }} 
                          />
                          <Area type="monotone" dataKey="sales" stroke="#2563EB" strokeWidth={3} fillOpacity={1} fill="url(#colorSalesLine)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* CHART 2: Bar Chart for Volume distributions */}
                  <div className={`lg:col-span-6 xl:col-span-5 rounded-3xl p-6 border text-left ${
                    isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-lg' : 'bg-white border-slate-200/80 shadow-xs'
                  }`}>
                    <div className="flex items-center justify-between mb-6">
                      <div>
                        <span className="text-[10px] font-black text-purple-500 uppercase tracking-widest block">Volume Metrics</span>
                        <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight">Revenue Breakdown</h3>
                      </div>
                      <div className="w-9 h-9 rounded-xl bg-purple-500/10 text-purple-500 flex items-center justify-center">
                        <BarChart3 className="h-5 w-5" />
                      </div>
                    </div>

                    <div className="h-72 w-full text-xs">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={getSalesChartData()}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? "#1f2937/40" : "#f1f5f9"} />
                          <XAxis dataKey="name" stroke="#9ca3af" tickLine={false} axisLine={false} />
                          <YAxis stroke="#9ca3af" tickLine={false} axisLine={false} tickFormatter={(v) => `LKR ${v}`} />
                          <Tooltip 
                            formatter={(value) => [formatPrice(value as number), 'Earned']} 
                            contentStyle={isDarkMode ? { backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '14px', color: '#fff' } : { borderRadius: '14px' }} 
                          />
                          <Bar dataKey="sales" fill="#8B5CF6" radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                </div>

                {/* Best Selling and Category Doughnut Section */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  
                  {/* Category share doughnut panel */}
                  <div className={`lg:col-span-5 xl:col-span-4 rounded-3xl p-6 border text-left ${
                    isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-lg' : 'bg-white border-slate-200/80 shadow-xs'
                  }`}>
                    <div className="text-left mb-6 flex justify-between items-center">
                      <div>
                        <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest block">Catalog Analytics</span>
                        <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight">Category Distribution</h3>
                      </div>
                      <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center">
                        <Layers className="h-4 w-4" />
                      </div>
                    </div>

                    {pieChartData.length === 0 ? (
                      <div className="h-64 flex flex-col items-center justify-center text-slate-400 text-xs">
                        <Archive className="h-12 w-12 text-slate-500 mb-2 animate-pulse" />
                        <span className="font-bold">No Category Sales Yet</span>
                        <p className="text-[10px] text-slate-500 mt-1">Sales reports pop up as checkouts are finalized.</p>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {/* Centered Doughnut Chart */}
                        <div className="h-44 w-full flex justify-center items-center relative">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie 
                                data={pieChartData} 
                                cx="50%" 
                                cy="50%" 
                                innerRadius={50} 
                                outerRadius={70} 
                                paddingAngle={5} 
                                dataKey="value"
                              >
                                {pieChartData.map((entry, idx) => (
                                  <Cell key={`cell-${idx}`} fill={COLORS_PALETTE[idx % COLORS_PALETTE.length]} />
                                ))}
                              </Pie>
                              <Tooltip formatter={(v) => formatPrice(v as number)} />
                            </PieChart>
                          </ResponsiveContainer>
                          {/* Floating metric inside doughnut */}
                          <div className="absolute flex flex-col items-center justify-center">
                            <span className="text-[9px] text-slate-400 font-bold uppercase tracking-widest">Share Index</span>
                            <span className="text-sm font-black text-slate-800 dark:text-slate-100">{pieChartData.length} Cats</span>
                          </div>
                        </div>

                        {/* Custom visual progress bars for each category */}
                        <div className="space-y-3.5 pt-2">
                          {pieChartData.map((entry, idx) => {
                            const totalValSum = pieChartData.reduce((acc, c) => acc + c.value, 0);
                            const percentOfTotal = totalValSum > 0 ? (entry.value / totalValSum) * 100 : 0;
                            const colorClass = COLORS_PALETTE[idx % COLORS_PALETTE.length];
                            return (
                              <div key={idx} className="space-y-1">
                                <div className="flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-300">
                                  <div className="flex items-center space-x-2">
                                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorClass }} />
                                    <span className="truncate max-w-[150px]">{entry.name}</span>
                                  </div>
                                  <span>{percentOfTotal.toFixed(1)}%</span>
                                </div>
                                <div className="w-full bg-slate-100 dark:bg-slate-800/80 rounded-full h-1.5">
                                  <div 
                                    className="h-1.5 rounded-full transition-all duration-500" 
                                    style={{ backgroundColor: colorClass, width: `${percentOfTotal}%` }} 
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Leaderboard panel: Best selling products */}
                  <div className={`lg:col-span-7 xl:col-span-8 rounded-3xl p-6 border text-left ${
                    isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-lg' : 'bg-white border-slate-200/80 shadow-xs'
                  }`}>
                    <div className="flex items-center justify-between mb-6">
                      <div>
                        <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest block">Performance Roster</span>
                        <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight font-sans">Best Selling Devices</h3>
                      </div>
                      <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center">
                        <Award className="h-4 w-4" />
                      </div>
                    </div>

                    <div className="space-y-4">
                      {topSellingProductsList.length === 0 ? (
                        <div className="p-12 text-center flex flex-col items-center justify-center space-y-3">
                          <Package className="h-12 w-12 text-slate-300 dark:text-slate-700 animate-bounce" />
                          <h4 className="font-extrabold text-xs text-slate-800 dark:text-slate-300">No units sold yet</h4>
                          <p className="text-[11px] text-slate-400 max-w-xs mx-auto">Verified electronic transactions automatically rank here.</p>
                        </div>
                      ) : (
                        topSellingProductsList.map((item, idx) => {
                          const maxRev = topSellingProductsList[0]?.revenue || 1;
                          const relativePercent = (item.revenue / maxRev) * 100;
                          
                          // Custom colors for rank badges
                          const rankColors = [
                            'bg-amber-400 text-amber-950 font-black', // Gold
                            'bg-slate-300 text-slate-900 font-bold',  // Silver
                            'bg-[#D39E82] text-amber-950 font-medium', // Bronze
                            'bg-slate-100 dark:bg-slate-800 text-slate-400',
                            'bg-slate-100 dark:bg-slate-800 text-slate-400'
                          ];

                          const fallbackImg = "https://images.unsplash.com/photo-1594322436404-5a0526db4d13?q=80&w=200";

                          return (
                            <div key={idx} className="flex items-center justify-between p-3 rounded-2xl bg-slate-50/50 dark:bg-[#111928]/10 border border-slate-100 dark:border-slate-800/60 group hover:shadow-xs transition-all duration-300">
                              <div className="flex items-center space-x-3.5 min-w-0 flex-1">
                                {/* Rank indicator */}
                                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] shrink-0 ${rankColors[idx]}`}>
                                  #{idx + 1}
                                </div>
                                
                                {/* Product Image Thumbnail */}
                                <div className="w-12 h-12 rounded-xl overflow-hidden border border-slate-200/50 dark:border-slate-700/60 bg-white shrink-0 group-hover:scale-105 transition-all">
                                  <img 
                                    src={item.product.imageUrl || fallbackImg} 
                                    alt={item.product.name}
                                    className="w-full h-full object-cover" 
                                    referrerPolicy="no-referrer"
                                    onError={(e) => {
                                      (e.target as HTMLImageElement).src = fallbackImg;
                                    }}
                                  />
                                </div>

                                {/* Info */}
                                <div className="min-w-0 flex-1 text-left">
                                  <h4 className="text-xs font-extrabold text-slate-900 dark:text-white truncate font-sans group-hover:text-blue-500 transition-colors">
                                    {item.product.name}
                                  </h4>
                                  <p className="text-[10px] text-slate-400 tracking-wider font-mono">SKU: {item.product.sku || 'N/A'}</p>
                                  
                                  {/* Relative bar of sales */}
                                  <div className="w-full bg-slate-200/50 dark:bg-slate-800 h-1 rounded-full mt-1.5 overflow-hidden">
                                    <div 
                                      className="bg-blue-600 h-1 rounded-full transition-all duration-700" 
                                      style={{ width: `${relativePercent}%` }} 
                                    />
                                  </div>
                                </div>
                              </div>

                              <div className="text-right shrink-0 pl-4">
                                <span className="block text-xs font-black text-blue-500 dark:text-blue-400">{formatPrice(item.revenue)}</span>
                                <span className="block text-[10px] text-slate-400 font-bold">{item.qty} units shipped</span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                </div>

                {/* Critical Inventory warnings + Unified Activity Feed section */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                  
                  {/* Inventory Warning deck */}
                  <div className={`lg:col-span-5 xl:col-span-4 rounded-3xl p-6 border text-left flex flex-col justify-between ${
                    isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-lg' : 'bg-white border-slate-200/80 shadow-xs'
                  }`}>
                    <div>
                      <div className="flex items-center justify-between mb-5">
                        <div>
                          <span className="text-[10px] font-black text-red-500 uppercase tracking-widest block">Critical Actions</span>
                          <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight">Stock Warning Deck</h3>
                        </div>
                        <div className="w-8 h-8 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center">
                          <AlertCircle className="h-4 w-4" />
                        </div>
                      </div>

                      <div className="space-y-3">
                        {lowStockProducts.length === 0 ? (
                          <div className="p-8 text-center flex flex-col items-center justify-center space-y-3 border border-dashed border-slate-200 dark:border-slate-800/80 rounded-2xl bg-slate-50/50 dark:bg-slate-900/10">
                            <Check className="h-10 w-10 text-emerald-500" />
                            <h4 className="font-extrabold text-xs text-slate-800 dark:text-emerald-400">All Items Healthy</h4>
                            <p className="text-[11px] text-slate-400">No item stock is currently below safety cutoff parameters.</p>
                          </div>
                        ) : (
                          lowStockProducts.slice(0, 4).map((p, idx) => {
                            const fallbackImg = "https://images.unsplash.com/photo-1594322436404-5a0526db4d13?q=80&w=200";
                            return (
                              <div key={idx} className="p-2.5 rounded-2xl border border-slate-100 dark:border-slate-800/60 bg-slate-50/30 dark:bg-[#111928]/10 flex items-center justify-between gap-3">
                                <div className="flex items-center space-x-2.5 min-w-0 flex-1">
                                  <div className="w-10 h-10 rounded-lg overflow-hidden border border-slate-100 dark:border-slate-800 bg-white shrink-0">
                                    <img 
                                      src={p.imageUrl || fallbackImg} 
                                      alt={p.name}
                                      className="w-full h-full object-cover"
                                      referrerPolicy="no-referrer"
                                      onError={(e) => {
                                        (e.target as HTMLImageElement).src = fallbackImg;
                                      }}
                                    />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <h4 className="font-extrabold text-xs text-slate-800 dark:text-white truncate">{p.name}</h4>
                                    <span className={`inline-block text-[9px] font-black px-2 py-0.5 mt-0.5 rounded-full ${p.stock === 0 ? 'bg-red-500/10 text-red-500' : 'bg-amber-500/10 text-amber-500'}`}>
                                      {p.stock === 0 ? 'OUT OF STOCK' : `ONLY ${p.stock} REMAINING`}
                                    </span>
                                  </div>
                                </div>
                                
                                {/* Quick Restock shortcut CTA linking tabs together */}
                                <button
                                  onClick={() => {
                                    setProductSearch(p.name);
                                    setActiveTab('products');
                                    showSettingsToast('success', `Directing you to Restock Portfolio for ${p.name}.`);
                                    window.scrollTo({ top: 0, behavior: 'smooth' });
                                  }}
                                  className="px-2.5 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-[9px] font-black uppercase rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                                >
                                  Restock
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>

                    {/* Manage stock overview button */}
                    <button 
                      onClick={() => {
                        setActiveTab('products');
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="mt-4 w-full py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200/50 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 text-xs font-black uppercase rounded-xl transition-all cursor-pointer inline-flex items-center justify-center space-x-1.5"
                    >
                      <span>Review Catalog Inventory</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* Unified Activity Timeline Feed */}
                  <div className={`lg:col-span-7 xl:col-span-8 rounded-3xl p-6 border text-left ${
                    isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-lg' : 'bg-white border-slate-200/80 shadow-xs'
                  }`}>
                    <div className="flex items-center justify-between mb-5">
                      <div>
                        <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest block">Operational Logs</span>
                        <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight">Recent Live Activity Timeline</h3>
                      </div>
                      <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center">
                        <History className="h-4 w-4" />
                      </div>
                    </div>

                    <div className="space-y-4 max-h-[340px] overflow-y-auto pr-1">
                      {timelineEvents.map((evt, idx) => {
                        // Decide icon and color scheme based on event type
                        const config = {
                          order: { icon: ShoppingBag, color: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
                          review: { icon: Star, color: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
                          stock: { icon: AlertTriangle, color: 'bg-red-500/10 text-red-500 border-red-500/20' },
                          customer: { icon: User, color: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' }
                        }[evt.type];

                        const Icon = config.icon;
                        const timeStr = evt.time.toLocaleTimeString('en-LK', { hour: 'numeric', minute: '2-digit', hour12: true }) + ' - ' + evt.time.toLocaleDateString('en-LK', { month: 'short', day: 'numeric' });

                        return (
                          <div key={evt.id + idx} className="flex space-x-3.5 relative group pb-4 last:pb-0">
                            {/* Vertical line timeline guide */}
                            {idx < timelineEvents.length - 1 && (
                              <div className="absolute left-[13px] top-[26px] bottom-0 w-[1.5px] bg-slate-200 dark:bg-slate-800" />
                            )}

                            {/* Dot icon */}
                            <div className={`w-[28px] h-[28px] rounded-lg border flex items-center justify-center shrink-0 z-10 ${config.color}`}>
                              <Icon className="h-4 w-4" />
                            </div>

                            {/* Details balloon */}
                            <div className="flex-1 min-w-0 bg-slate-50/50 dark:bg-[#111928]/5 border border-slate-100/50 dark:border-slate-800/40 p-3 rounded-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                              <div className="min-w-0 text-left">
                                <h4 className="font-extrabold text-xs text-slate-900 dark:text-white flex items-center space-x-1.5">
                                  <span>{evt.title}</span>
                                </h4>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">{evt.subtitle}</p>
                                <span className="text-[9px] text-slate-400 block mt-1.5 font-medium">{timeStr}</span>
                              </div>
                              
                              <div className="text-right shrink-0 self-start sm:self-center">
                                {evt.type === 'order' && evt.link ? (
                                  <button
                                    onClick={() => {
                                      setSelectedOrderId(evt.link);
                                      setActiveTab('orders');
                                      showSettingsToast('success', `Directing you to Order Details Inspector.`);
                                      window.scrollTo({ top: 0, behavior: 'smooth' });
                                    }}
                                    className="px-2.5 py-1 bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 dark:text-blue-400 text-[10px] font-black rounded-lg transition-colors cursor-pointer"
                                  >
                                    Inspect
                                  </button>
                                ) : (
                                  <span className="text-[10px] font-black uppercase text-slate-400 px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 max-w-[120px] truncate block">
                                    {evt.meta}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                </div>

              </motion.div>
            );
          })()}

          {/* TAB 2: PRODUCTS CATALOG */}
          {activeTab === 'products' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              
              {/* Product Catalog header and quick actions */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="text-left">
                  <h2 className="text-xl font-extrabold tracking-tight">Active Stock Portfolio</h2>
                  <p className="text-xs text-slate-400">Direct importer item indexes and stock levels</p>
                </div>
                <button
                  onClick={() => {
                    const nextSku = generateNextSku(products);
                    setEditingProduct(null);
                    setNewProduct({
                      name: "", description: "", price: 0, originalPrice: 0, discount: 0,
                      imageUrl: "", imageUrls: [], category: categories.find(category => category.isActive !== false)?.id || categories[0]?.id || "", stock: 10, specs: {},
                      isNew: false, isFeatured: false, isBestSeller: false, isActive: true, sku: nextSku,
                      supplierItemCode: "", costPrice: undefined, marketPrice: undefined, id: ""
                    });
                    setSpecKey("");
                    setSpecVal("");
                    setShowProductModal(true);
                  }}
                  className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center space-x-1.5 shadow-md shadow-blue-500/15"
                >
                  <Plus className="h-4 w-4" />
                  <span>Create Item Record</span>
                </button>
              </div>

              {/* Filters list */}
              <div className={`p-4 rounded-2xl border flex flex-col md:flex-row gap-4 items-center justify-between ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                <div className="w-full md:w-72 relative">
                  <Search className="h-4 w-4 absolute left-3 top-3 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search name, supplier code, SKU, brand, model or category..."
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    className="w-full text-xs pl-9 pr-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden"
                  />
                </div>

                <div className="flex flex-wrap gap-2.5 w-full md:w-auto">
                  <select
                    value={productCategoryFilter}
                    onChange={(e) => setProductCategoryFilter(e.target.value)}
                    className="text-xs bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl px-3 py-2 focus:outline-hidden"
                  >
                    <option value="all">All Categories</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>

                  <select
                    value={productStockFilter}
                    onChange={(e) => setProductStockFilter(e.target.value)}
                    className="text-xs bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl px-3 py-2 focus:outline-hidden"
                  >
                    <option value="all">Stock status</option>
                    <option value="instock">In Stock</option>
                    <option value="lowstock">Low Stock (≤5)</option>
                  </select>
                </div>
              </div>

              {/* Products listing cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredProducts.map(p => {
                  const stockPct = Math.min(100, (p.stock / 50) * 100);
                  const isLow = p.stock <= 5;
                  
                  return (
                    <div 
                      key={p.id} 
                      onClick={() => handleEditProductClick(p)}
                      className={`cursor-pointer rounded-2xl border overflow-hidden flex flex-col justify-between p-5 transition-all hover:shadow-lg ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60' : 'bg-white border-slate-200/80 shadow-xs'}`}
                    >
                      <div>
                        {/* Thumbnail */}
                        <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-white border border-slate-200/40 mb-4">
                          <img src={p.imageUrl} className="w-full h-full object-cover" />
                          <span className={`absolute top-2.5 right-2.5 text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${p.isActive !== false ? 'bg-emerald-500 text-white' : 'bg-slate-400 text-white'}`}>
                            {p.isActive !== false ? 'Active' : 'Draft'}
                          </span>
                        </div>

                        <div className="text-left space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-blue-500 font-bold uppercase tracking-wider">{p.category}</span>
                            <span className="text-[10px] font-mono text-slate-400">{p.sku || 'NO SKU'}</span>
                          </div>
                          <h3 className="text-sm font-bold line-clamp-1">{p.name}</h3>
                          <p className="text-[11px] text-slate-400 line-clamp-2">{p.description}</p>
                        </div>
                      </div>

                      <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800/60 space-y-4">
                        <div className="flex items-end justify-between">
                          <div className="text-left">
                            <span className="text-[9px] text-slate-400 uppercase font-medium">Selling Price</span>
                            <p className="text-sm font-black text-blue-500 leading-tight">{formatPrice(p.price)}</p>
                          </div>
                          
                          {/* Stock progress */}
                          <div className="w-28 text-right space-y-1">
                            <div className="flex items-center justify-between text-[9px] font-semibold">
                              <span className={isLow ? 'text-red-500' : 'text-slate-400'}>{isLow ? 'LOW STOCK' : 'Healthy'}</span>
                              <span>{p.stock} units</span>
                            </div>
                            <div className="w-full bg-slate-200 dark:bg-slate-800 h-1 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full transition-all ${isLow ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${stockPct}%` }} />
                            </div>
                          </div>
                        </div>

                        <div className="flex gap-2.5">
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleEditProductClick(p); }} 
                            className="flex-1 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-[11px] font-bold rounded-xl transition-all flex items-center justify-center space-x-1 cursor-pointer"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                            <span>Edit</span>
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); handleDuplicateProduct(p); }} 
                            className="px-2.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-blue-600 hover:text-white text-[11px] font-bold rounded-xl transition-all cursor-pointer flex items-center justify-center"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); setProductToDelete(p); }} 
                            className="px-2.5 py-2 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white rounded-xl transition-all cursor-pointer flex items-center justify-center"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

            </motion.div>
          )}

          {/* TAB 3: CATEGORIES */}
          {activeTab === 'categories' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              
              <div className="flex items-center justify-between">
                <div className="text-left">
                  <h2 className="text-xl font-extrabold tracking-tight">Product Categories</h2>
                  <p className="text-xs text-slate-400">Classify electronic catalog items</p>
                </div>
                <button
                  type="button"
                  onClick={(event) => openCreateCategory(event.currentTarget)}
                  className="flex min-h-11 items-center space-x-1 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-blue-500/15 transition-all hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/30"
                >
                  <Plus className="h-4 w-4" />
                  <span>Create Category</span>
                </button>
              </div>

              {loading ? (
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4" role="status" aria-label="Loading categories">
                  {[0, 1, 2, 3].map((item) => <div key={item} className="h-52 animate-pulse rounded-2xl bg-slate-200/70 dark:bg-slate-800/70" />)}
                </div>
              ) : categories.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center dark:border-slate-700 dark:bg-[#101827]/75">
                  <Layers className="mx-auto h-10 w-10 text-slate-400" aria-hidden="true" />
                  <h3 className="mt-4 text-sm font-bold text-slate-900 dark:text-white">No categories created</h3>
                  <p className="mt-1 text-xs text-slate-500">Create the first category to organize the product catalogue.</p>
                </div>
              ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {categories.map(c => {
                  const counts = categoryProductCounts[c.id] ?? { active: 0, total: 0 };
                  const deleteAllowed = canDeleteCategory(counts);
                  return (
                    <div key={c.id} className={`rounded-2xl p-5 border flex flex-col justify-between ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-lg' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                      <div className="text-left space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-blue-500/10 text-blue-500">
                            {c.imageUrl ? <img src={c.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <Layers className="h-5 w-5" aria-hidden="true" />}
                          </div>
                          <div className="flex gap-1">
                            <button type="button" onClick={(event) => openEditCategory(c, event.currentTarget)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-blue-500/10 hover:text-blue-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25" aria-label={`Edit ${c.name}`}><Edit3 className="h-4 w-4" aria-hidden="true" /></button>
                            <button type="button" disabled={!deleteAllowed} onClick={(event) => requestDeleteCategory(c, event.currentTarget)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/25 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-slate-400" aria-label={`Delete ${c.name}`} aria-describedby={!deleteAllowed ? `category-delete-help-${c.id}` : undefined}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                          </div>
                        </div>
                        <div>
                          <h3 className="font-bold text-sm text-slate-800 dark:text-white">{c.name}</h3>
                          <span className="text-[10px] text-slate-400 font-mono">Slug: {c.id}</span>
                          <span className={`ml-2 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${c.isActive !== false ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-500/10 text-slate-400'}`}>{c.isActive !== false ? 'Active' : 'Inactive'}</span>
                        </div>
                      </div>

                      <div className="mt-6 border-t border-slate-100 pt-4 text-xs font-semibold dark:border-slate-800/60">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-emerald-500">{counts.active} Active</span>
                          <span className="text-slate-400">{counts.total} Total</span>
                        </div>
                        {!deleteAllowed && <p id={`category-delete-help-${c.id}`} className="mt-2 text-[10px] font-medium text-amber-500">This category is currently used by products.</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
              )}

            </motion.div>
          )}

          {/* TAB 4: ORDERS FEED */}
          {activeTab === 'orders' && (() => {
            // Calculate status statistics for badge counters
            const getStatusCount = (status: string) => {
              if (status === 'all') return orders.length;
              return orders.filter(o => o.status === status).length;
            };

            // Selected order for detailed pane
            const selectedOrder = orders.find(o => o.id === selectedOrderId) || filteredOrders[0];

            // Pagination calculations
            const startIndex = (orderPage - 1) * ordersPerPage;
            const paginatedOrders = filteredOrders.slice(startIndex, startIndex + ordersPerPage);
            const totalPages = Math.ceil(filteredOrders.length / ordersPerPage);

            // Status meta definitions
            const statusMeta: Record<string, { label: string, color: string, bg: string, border: string, icon: any }> = {
              pending: { label: 'Pending', color: 'text-amber-500', bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: Clock },
              confirmed: { label: 'Confirmed', color: 'text-blue-500', bg: 'bg-blue-500/10', border: 'border-blue-500/20', icon: Check },
              packed: { label: 'Packed', color: 'text-purple-500', bg: 'bg-purple-500/10', border: 'border-purple-500/20', icon: Package },
              shipped: { label: 'Shipped', color: 'text-cyan-500', bg: 'bg-cyan-500/10', border: 'border-cyan-500/20', icon: ShieldCheck },
              delivered: { label: 'Delivered', color: 'text-emerald-500', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', icon: ShoppingBag },
              cancelled: { label: 'Cancelled', color: 'text-red-500', bg: 'bg-red-500/10', border: 'border-red-500/20', icon: X }
            };

            const handleCopyText = (text: string, id: string) => {
              navigator.clipboard.writeText(text);
              setCopiedAddressId(id);
              setTimeout(() => setCopiedAddressId(null), 2000);
            };

            return (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 text-slate-800 dark:text-slate-100">
                
                {/* Sticky Header with Title and Filters */}
                <div className="sticky top-0 z-20 bg-slate-50/95 dark:bg-[#0b101c]/95 backdrop-blur-md pb-4 pt-1 border-b border-slate-100 dark:border-slate-800/80 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
                    <div className="text-left">
                      <h2 className="text-xl font-extrabold tracking-tight">Islandwide Orders Feed</h2>
                      <p className="text-xs text-slate-400">Manage order states, timeline transitions, and dispatch schedules</p>
                    </div>
                    {/* Results indicator */}
                    <div className="self-start sm:self-auto px-3 py-1 bg-blue-500/10 text-blue-500 text-[10px] font-black rounded-lg border border-blue-500/15 uppercase tracking-wider">
                      {filteredOrders.length} Orders Found
                    </div>
                  </div>

                  {/* Filter & Search Layout */}
                  <div className="flex flex-col xl:flex-row gap-3 items-stretch xl:items-center">
                    
                    {/* Search Field */}
                    <div className="relative flex-1">
                      <Search className="h-4 w-4 absolute left-3.5 top-3 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Search order number, phone, email, client name..."
                        value={orderSearch}
                        onChange={(e) => setOrderSearch(e.target.value)}
                        className="w-full text-xs pl-10 pr-4 py-2.5 bg-white dark:bg-[#111928] border border-slate-200/80 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500 dark:focus:border-blue-600 focus:ring-1 focus:ring-blue-500/20 text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 shadow-xs"
                      />
                      {orderSearch && (
                        <button 
                          onClick={() => setOrderSearch("")}
                          className="absolute right-3 top-2.5 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>

                    {/* Status Toggle Bar */}
                    <div className="flex gap-2 w-full xl:w-auto overflow-x-auto no-scrollbar py-1">
                      {['all', 'pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'].map(status => {
                        const count = getStatusCount(status);
                        const isActive = orderStatusFilter === status;
                        return (
                          <button
                            key={status}
                            onClick={() => setOrderStatusFilter(status)}
                            className={`flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-[10px] font-bold uppercase transition-all cursor-pointer whitespace-nowrap border ${
                              isActive 
                                ? 'bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-500/20' 
                                : 'bg-white dark:bg-[#111928] border-slate-200/80 dark:border-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-800 dark:hover:text-slate-200'
                            }`}
                          >
                            <span>{status}</span>
                            <span className={`inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[9px] font-extrabold ${
                              isActive 
                                ? 'bg-white/25 text-white' 
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200/50 dark:border-slate-700/60'
                            }`}>
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                  </div>
                </div>

                {/* Main Content Split Pane */}
                {filteredOrders.length === 0 ? (
                  /* Empty state when search or filters return 0 results */
                  <div className={`p-12 text-center rounded-3xl border flex flex-col items-center justify-center space-y-4 max-w-xl mx-auto my-8 ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                    <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800/80 flex items-center justify-center text-slate-400 dark:text-slate-500">
                      <Archive className="h-8 w-8 animate-pulse" />
                    </div>
                    <div className="space-y-1.5">
                      <h3 className="font-extrabold text-sm text-slate-800 dark:text-white">No Matching Orders</h3>
                      <p className="text-xs text-slate-400 max-w-sm leading-relaxed">
                        We couldn't find any orders matching "{orderSearch || orderStatusFilter}". Try checking spelling, clearing searches, or adjusting the filter.
                      </p>
                    </div>
                    <div className="flex gap-2 pt-2">
                      {orderSearch && (
                        <button
                          onClick={() => setOrderSearch("")}
                          className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-xl transition-colors cursor-pointer"
                        >
                          Clear Search
                        </button>
                      )}
                      {orderStatusFilter !== 'all' && (
                        <button
                          onClick={() => setOrderStatusFilter('all')}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition-all cursor-pointer"
                        >
                          Show All Statuses
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    
                    {/* Left Pane: Orders Card List */}
                    {/* On mobile, if an order is selected, we hide the list to prioritize detail viewing */}
                    <div className={`lg:col-span-5 xl:col-span-4 space-y-4 ${selectedOrderId && 'hidden lg:block'}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">All Order Bookings</span>
                        <span className="text-[10px] font-mono text-slate-400">Page {orderPage} of {totalPages || 1}</span>
                      </div>

                      <div className="space-y-3">
                        {paginatedOrders.map(order => {
                          const isSelected = selectedOrder?.id === order.id;
                          const meta = statusMeta[order.status || 'pending'] || statusMeta.pending;
                          const StatusIcon = meta.icon;
                          const dateFormatted = order.createdAt ? new Date(order.createdAt).toLocaleDateString('en-LK', { dateStyle: 'medium' }) : "N/A";

                          return (
                            <div
                              key={order.id}
                              onClick={() => {
                                setSelectedOrderId(order.id);
                                // scroll to top on mobile
                                window.scrollTo({ top: 0, behavior: 'smooth' });
                              }}
                              className={`p-4 rounded-2xl border text-left transition-all cursor-pointer relative group ${
                                isSelected
                                  ? 'bg-blue-50/40 dark:bg-blue-500/5 border-blue-500 shadow-md ring-1 ring-blue-500/20'
                                  : 'bg-white dark:bg-[#101827]/75 border-slate-200/80 dark:border-slate-800/60 hover:border-slate-300 dark:hover:border-slate-700'
                              }`}
                            >
                              {/* New/Pulse Highlight */}
                              {order.status === 'pending' && (
                                <span className="absolute top-4 right-4 flex h-2 w-2">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                                </span>
                              )}

                              <div className="space-y-3">
                                {/* Row 1: Order Ref & Status */}
                                <div className="flex items-center justify-between">
                                  <span className="font-extrabold text-xs text-slate-900 dark:text-white group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors">
                                    #{order.orderNumber || order.id.substring(0, 8).toUpperCase()}
                                  </span>
                                  <span className={`inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase ${meta.bg} ${meta.color} ${meta.border} border`}>
                                    <StatusIcon className="h-2.5 w-2.5 shrink-0" />
                                    <span>{meta.label}</span>
                                  </span>
                                </div>

                                {/* Row 2: Customer Details */}
                                <div>
                                  <h4 className="font-bold text-xs text-slate-800 dark:text-slate-200 truncate">{order.customerName}</h4>
                                  <p className="text-[10px] text-slate-400 truncate">{order.customerPhone} &bull; {order.district}</p>
                                </div>

                                {/* Row 3: Items ledger Preview */}
                                <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800/60">
                                  <span className="text-[10px] text-slate-400">
                                    {order.items.length} item{order.items.length > 1 ? 's' : ''} &bull; {dateFormatted}
                                  </span>
                                  <span className="text-xs font-black text-blue-500 dark:text-blue-400">
                                    {formatPrice(order.totalPrice)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Pagination Controls */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-between pt-4">
                          <button
                            disabled={orderPage === 1}
                            onClick={() => setOrderPage(prev => Math.max(prev - 1, 1))}
                            className="px-3.5 py-1.5 bg-white dark:bg-[#111928] border border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-400 text-[10px] font-bold rounded-xl disabled:opacity-40 transition-colors cursor-pointer"
                          >
                            Previous
                          </button>
                          <span className="text-[10px] text-slate-400 font-bold">
                            Page {orderPage} of {totalPages}
                          </span>
                          <button
                            disabled={orderPage === totalPages}
                            onClick={() => setOrderPage(prev => Math.min(prev + 1, totalPages))}
                            className="px-3.5 py-1.5 bg-white dark:bg-[#111928] border border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-400 text-[10px] font-bold rounded-xl disabled:opacity-40 transition-colors cursor-pointer"
                          >
                            Next
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Right Pane: Order Details View */}
                    {/* On mobile, if order is selected, we show this full-screen overlay/block */}
                    {selectedOrder ? (
                      <div className={`lg:col-span-7 xl:col-span-8 space-y-6 ${!selectedOrderId && 'hidden lg:block'}`}>
                        
                        {/* Mobile back navigation bar */}
                        <div className="lg:hidden flex items-center mb-2">
                          <button 
                            onClick={() => setSelectedOrderId(null)}
                            className="flex items-center space-x-1.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-xl cursor-pointer"
                          >
                            <ChevronRight className="h-4 w-4 rotate-180" />
                            <span>Back to Orders List</span>
                          </button>
                        </div>

                        {/* Order Detail Main Card */}
                        <div className={`rounded-3xl border p-6 text-left space-y-6 ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-xl' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                          
                          {/* Header Block */}
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800/80">
                            <div>
                              <div className="flex items-center space-x-2">
                                <span className="text-[10px] text-slate-400 font-mono">UID: {selectedOrder.id.substring(0, 10)}...</span>
                                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[9px] font-extrabold uppercase bg-slate-100 dark:bg-slate-800 text-slate-400 border border-slate-200/40 dark:border-slate-700/60`}>
                                  {selectedOrder.paymentMethod === 'cod' ? 'Cash On Delivery' : 'WhatsApp Verify'}
                                </span>
                              </div>
                              <h3 className="text-lg font-black text-slate-900 dark:text-white tracking-tight mt-1">
                                Order #{selectedOrder.orderNumber || selectedOrder.id.substring(0, 8).toUpperCase()}
                              </h3>
                              <p className="text-[10px] text-slate-400">
                                Placed on {selectedOrder.createdAt ? new Date(selectedOrder.createdAt).toLocaleString('en-LK', { dateStyle: 'long', timeStyle: 'short' }) : "N/A"}
                              </p>
                            </div>

                            {/* Status Changer Controls */}
                            <div className="flex items-center space-x-2.5">
                              <div className="text-right hidden sm:block">
                                <span className="block text-[9px] text-slate-400 font-bold uppercase tracking-wider">Modify Order State</span>
                                <span className="text-[10px] font-medium text-slate-400">Instant database update</span>
                              </div>
                              <div className="relative">
                                <select
                                  value={selectedOrder.status || "pending"}
                                  disabled={updatingOrderStatus[selectedOrder.id]}
                                  onChange={(e) => handleUpdateOrderStatus(selectedOrder.id, e.target.value)}
                                  className="text-xs bg-slate-50 dark:bg-[#111928] border border-slate-200 dark:border-slate-850 rounded-xl px-3.5 py-2 focus:outline-hidden focus:border-blue-500 font-bold cursor-pointer disabled:opacity-50 transition-colors"
                                >
                                  <option value="pending">Pending</option>
                                  <option value="confirmed">Confirmed</option>
                                  <option value="packed">Packed</option>
                                  <option value="shipped">Shipped</option>
                                  <option value="delivered">Delivered</option>
                                  <option value="cancelled">Cancelled</option>
                                </select>
                                {updatingOrderStatus[selectedOrder.id] && (
                                  <div className="absolute right-3.5 top-2">
                                    <RefreshCw className="h-3.5 w-3.5 animate-spin text-blue-500" />
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Interactive Order Timeline Stepper */}
                          {selectedOrder.status === 'cancelled' ? (
                            <div className="bg-red-500/10 border border-red-500/25 rounded-2xl p-4 text-center space-y-1">
                              <span className="inline-flex items-center justify-center p-2 bg-red-500/20 text-red-500 rounded-full">
                                <X className="h-5 w-5" />
                              </span>
                              <h4 className="font-extrabold text-sm text-red-600 dark:text-red-400">This Booking is Cancelled</h4>
                              <p className="text-[10px] text-red-400 leading-normal max-w-sm mx-auto">
                                The transaction has been terminated. Stock quotas, supplier codes, and marketing calculations have reverted.
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-3 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-[#111928]/20 text-left">
                              <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Order Processing Timeline</span>
                              
                              {/* Stepper nodes row */}
                              <div className="grid grid-cols-5 gap-1.5 pt-2">
                                {['pending', 'confirmed', 'packed', 'shipped', 'delivered'].map((step, idx, arr) => {
                                  const stepsOrder = ['pending', 'confirmed', 'packed', 'shipped', 'delivered'];
                                  const currentIdx = stepsOrder.indexOf(selectedOrder.status || 'pending');
                                  const stepIdx = stepsOrder.indexOf(step);
                                  const isCompleted = stepIdx < currentIdx;
                                  const isActive = stepIdx === currentIdx;

                                  // Labels & styling mapping
                                  const stepLabelMap: Record<string, string> = {
                                    pending: 'Pending',
                                    confirmed: 'Confirmed',
                                    packed: 'Packed',
                                    shipped: 'Shipped',
                                    delivered: 'Delivered'
                                  };

                                  return (
                                    <div key={step} className="flex flex-col items-center relative text-center">
                                      {/* Connector Line */}
                                      {idx < arr.length - 1 && (
                                        <div className={`hidden sm:block absolute left-[50%] right-[-50%] top-3 h-[2px] z-0 transition-colors ${
                                          stepIdx < currentIdx ? 'bg-blue-500' : 'bg-slate-200 dark:bg-slate-800'
                                        }`} />
                                      )}

                                      {/* Node circle */}
                                      <div className={`relative z-10 w-6 h-6 rounded-full flex items-center justify-center border transition-all ${
                                        isActive 
                                          ? 'bg-blue-600 border-blue-600 text-white shadow-md ring-4 ring-blue-500/20' 
                                          : isCompleted 
                                            ? 'bg-emerald-500 border-emerald-500 text-white' 
                                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-400'
                                      }`}>
                                        {isCompleted ? (
                                          <Check className="h-3 w-3" />
                                        ) : (
                                          <span className="text-[9px] font-black">{idx + 1}</span>
                                        )}
                                      </div>

                                      {/* Label text */}
                                      <span className={`block mt-1.5 text-[9px] font-bold uppercase truncate max-w-full ${
                                        isActive 
                                          ? 'text-blue-500 dark:text-blue-400' 
                                          : isCompleted 
                                            ? 'text-slate-700 dark:text-slate-300' 
                                            : 'text-slate-400'
                                      }`}>
                                        {stepLabelMap[step]}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Customer Shipping & Logistics Ledger */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                            
                            {/* Card 1: Logistics Address */}
                            <div className="p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-[#111928]/10 space-y-2 text-left">
                              <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Delivery Coordinates</span>
                              <div className="text-xs space-y-1">
                                <p className="font-bold text-slate-800 dark:text-white">{selectedOrder.customerName}</p>
                                <p className="text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
                                  {selectedOrder.customerAddress}
                                </p>
                                <p className="font-bold text-slate-700 dark:text-slate-400 text-[11px] mt-1">
                                  District: <span className="uppercase text-blue-500 font-black">{selectedOrder.district || "N/A"}</span>
                                </p>
                              </div>
                              <button
                                onClick={() => handleCopyText(`${selectedOrder.customerName}\n${selectedOrder.customerAddress}\nDistrict: ${selectedOrder.district}`, selectedOrder.id)}
                                className="mt-2.5 inline-flex items-center space-x-1.5 px-3 py-1.5 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80 rounded-xl text-[10px] font-bold text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
                              >
                                {copiedAddressId === selectedOrder.id ? (
                                  <>
                                    <Check className="h-3 w-3 text-emerald-500" />
                                    <span className="text-emerald-500">Address Copied!</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3 w-3" />
                                    <span>Copy Delivery Address</span>
                                  </>
                                )}
                              </button>
                            </div>

                            {/* Card 2: Contact Ledger */}
                            <div className="p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-[#111928]/10 space-y-3 text-left flex flex-col justify-between">
                              <div>
                                <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Contact Information</span>
                                <div className="text-xs space-y-2 mt-2">
                                  <div className="flex items-center space-x-2 text-slate-600 dark:text-slate-300">
                                    <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                                    <span className="font-mono">{selectedOrder.customerPhone}</span>
                                    {selectedOrder.customerPhone2 && (
                                      <span className="text-slate-400">/ {selectedOrder.customerPhone2}</span>
                                    )}
                                  </div>
                                  <div className="flex items-center space-x-2 text-slate-600 dark:text-slate-300">
                                    <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                                    <span className="truncate">{selectedOrder.customerEmail}</span>
                                  </div>
                                </div>
                              </div>

                              <div className="flex gap-2.5 pt-3 border-t border-slate-100 dark:border-slate-800/60">
                                <a 
                                  href={`tel:${selectedOrder.customerPhone}`}
                                  className="flex-1 py-1.5 bg-blue-500/10 hover:bg-blue-500/15 text-blue-600 dark:text-blue-400 rounded-xl text-center text-[10px] font-bold transition-colors cursor-pointer"
                                >
                                  Call Client
                                </a>
                                <a 
                                  href={`https://wa.me/${selectedOrder.customerPhone.replace(/[^0-9]/g, '')}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex-1 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 rounded-xl text-center text-[10px] font-bold transition-colors cursor-pointer"
                                >
                                  WhatsApp Chat
                                </a>
                              </div>
                            </div>

                          </div>

                          {/* Ordered Products Ledger */}
                          <div className="space-y-3">
                            <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest text-left">Purchased Commodities</span>
                            <div className="border border-slate-100 dark:border-slate-800 rounded-2xl overflow-hidden">
                              <div className="overflow-x-auto">
                                <table className="w-full text-left border-collapse text-xs">
                                  <thead>
                                    <tr className="bg-slate-50 dark:bg-slate-800/40 text-slate-400 font-bold border-b border-slate-100 dark:border-slate-800">
                                      <th className="p-3">Product Name</th>
                                      <th className="p-3 text-right">Unit Rate</th>
                                      <th className="p-3 text-center">Qty</th>
                                      <th className="p-3 text-right">Subtotal</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                                    {selectedOrder.items.map((it, idx) => {
                                      const fallbackImg = "https://images.unsplash.com/photo-1594322436404-5a0526db4d13?q=80&w=200";
                                      return (
                                        <tr key={idx} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/10">
                                          <td className="p-3">
                                            <div className="flex items-center space-x-2.5 max-w-md">
                                              <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 border border-slate-100 dark:border-slate-800 bg-slate-50">
                                                <img 
                                                  src={it.imageUrl || fallbackImg} 
                                                  alt={it.name} 
                                                  className="w-full h-full object-cover" 
                                                  referrerPolicy="no-referrer"
                                                  onError={(e) => {
                                                    (e.target as HTMLImageElement).src = fallbackImg;
                                                  }}
                                                />
                                              </div>
                                              <div>
                                                <p className="font-bold text-slate-800 dark:text-slate-100 line-clamp-1">{it.name}</p>
                                                <p className="text-[9px] text-slate-400 font-mono">ID: {it.productId}</p>
                                              </div>
                                            </div>
                                          </td>
                                          <td className="p-3 text-right font-medium text-slate-500 dark:text-slate-400">
                                            {formatPrice(it.price)}
                                          </td>
                                          <td className="p-3 text-center font-bold text-slate-700 dark:text-slate-300">
                                            x{it.quantity}
                                          </td>
                                          <td className="p-3 text-right font-bold text-slate-900 dark:text-white">
                                            {formatPrice(it.price * it.quantity)}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </div>

                          {/* Invoice Financial summary */}
                          <div className="p-4 rounded-2xl bg-slate-50/50 dark:bg-[#111928]/25 border border-slate-100 dark:border-slate-800 space-y-2 text-xs">
                            <div className="flex justify-between items-center text-slate-500 dark:text-slate-400">
                              <span>Cart Subtotal</span>
                              <span className="font-medium">
                                {formatPrice(selectedOrder.totalPrice - (settings?.deliveryCharge || 350))}
                              </span>
                            </div>
                            <div className="flex justify-between items-center text-slate-500 dark:text-slate-400">
                              <span>Delivery Charge</span>
                              <span className="font-medium">
                                {formatPrice(settings?.deliveryCharge || 350)}
                              </span>
                            </div>
                            <div className="flex justify-between items-center pt-2 border-t border-slate-100 dark:border-slate-800/80 text-sm font-extrabold text-slate-900 dark:text-white">
                              <span>Grand Total (LKR)</span>
                              <span className="text-blue-500 dark:text-blue-400 font-black">
                                {formatPrice(selectedOrder.totalPrice)}
                              </span>
                            </div>
                          </div>

                        </div>
                      </div>
                    ) : (
                      <div className="lg:col-span-7 xl:col-span-8 p-12 rounded-3xl border border-dashed border-slate-200 dark:border-slate-800/80 flex flex-col items-center justify-center space-y-3 min-h-[300px]">
                        <ShoppingBag className="h-8 w-8 text-slate-300 dark:text-slate-600 animate-pulse" />
                        <h4 className="font-extrabold text-sm text-slate-800 dark:text-slate-300">No Order Selected</h4>
                        <p className="text-xs text-slate-400 max-w-xs mx-auto text-center leading-relaxed">
                          Please select an order booking from the registry ledger to load full customer logistics, chronological timeline progress, and purchased commodities.
                        </p>
                      </div>
                    )}

                  </div>
                )}

              </motion.div>
            );
          })()}

          {/* TAB 5: CUSTOMERS */}
          {activeTab === 'customers' && (() => {
            const totalCust = customers.length;
            const repeatCust = customers.filter(c => orders.filter(o => o.customerEmail === c.email).length >= 2).length;
            const activeB = customers.filter(c => orders.some(o => o.customerEmail === c.email)).length;
            const totalRev = orders.reduce((acc, o) => acc + (o.status !== 'cancelled' ? o.totalPrice : 0), 0);
            const avgLtv = activeB > 0 ? (totalRev / activeB) : 0;

            const sorted = [...filteredCustomers].sort((a, b) => {
              const aOrders = orders.filter(o => o.customerEmail === a.email);
              const bOrders = orders.filter(o => o.customerEmail === b.email);
              const aSpent = aOrders.reduce((acc, o) => acc + o.totalPrice, 0);
              const bSpent = bOrders.reduce((acc, o) => acc + o.totalPrice, 0);

              if (customerSortBy === 'totalSpent') return bSpent - aSpent;
              if (customerSortBy === 'ordersCount') return bOrders.length - aOrders.length;
              if (customerSortBy === 'createdAt') {
                const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                return tB - tA;
              }
              return (a.displayName || "").localeCompare(b.displayName || "");
            });

            const totalPages = Math.ceil(sorted.length / customersPerPage);
            const displayedCust = sorted.slice((customerPage - 1) * customersPerPage, customerPage * customersPerPage);

            // Find current selection
            const currentCust = sorted.find(c => c.email === selectedCustomerEmail) || sorted[0];

            // Helper to generate elegant profile color gradients based on display name or index
            const getAvatarGradient = (name: string) => {
              const gradients = [
                'from-blue-500 to-indigo-600',
                'from-emerald-500 to-teal-600',
                'from-purple-500 to-pink-600',
                'from-amber-500 to-orange-600',
                'from-cyan-500 to-blue-600',
                'from-rose-500 to-pink-600'
              ];
              let code = 0;
              const cleanName = name || "Customer";
              for (let i = 0; i < cleanName.length; i++) code += cleanName.charCodeAt(i);
              return gradients[code % gradients.length];
            };

            const handleCopyText = (text: string, fieldId: string) => {
              navigator.clipboard.writeText(text);
              setCopiedCustFieldId(fieldId);
              showSettingsToast("success", `Copied ${fieldId === 'email' ? 'Email' : 'Phone'} to clipboard!`);
              setTimeout(() => setCopiedCustFieldId(null), 2000);
            };

            return (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 text-slate-800 dark:text-slate-100">
                
                <div className="text-left flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <h2 className="text-xl font-extrabold tracking-tight">Active Customer Records</h2>
                    <p className="text-xs text-slate-400">Track consumer shoppers order histories, wishlist preferences and lifetime values</p>
                  </div>
                  <span className="text-[10px] bg-blue-500/10 text-blue-500 border border-blue-500/20 px-2.5 py-1 rounded-lg font-black uppercase">
                    Registered: {totalCust}
                  </span>
                </div>

                {/* Statistics / KPIs Grid */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className={`p-4 rounded-2xl border text-left flex items-center space-x-3.5 ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                    <div className="p-3 rounded-xl bg-blue-500/10 text-blue-500 shrink-0">
                      <Users className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase">Total Shoppers</p>
                      <h4 className="text-lg font-black tracking-tight">{totalCust}</h4>
                    </div>
                  </div>

                  <div className={`p-4 rounded-2xl border text-left flex items-center space-x-3.5 ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                    <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-500 shrink-0">
                      <UserCheck className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase">Active Buyers</p>
                      <h4 className="text-lg font-black tracking-tight">{activeB}</h4>
                    </div>
                  </div>

                  <div className={`p-4 rounded-2xl border text-left flex items-center space-x-3.5 ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                    <div className="p-3 rounded-xl bg-purple-500/10 text-purple-500 shrink-0">
                      <Award className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase">Avg Lifetime Value</p>
                      <h4 className="text-sm font-black tracking-tight text-purple-500 truncate">{formatPrice(avgLtv)}</h4>
                    </div>
                  </div>

                  <div className={`p-4 rounded-2xl border text-left flex items-center space-x-3.5 ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                    <div className="p-3 rounded-xl bg-amber-500/10 text-amber-500 shrink-0">
                      <TrendingUp className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-bold uppercase">Repeat Rate</p>
                      <h4 className="text-lg font-black tracking-tight">
                        {totalCust > 0 ? `${Math.round((repeatCust / totalCust) * 100)}%` : '0%'}
                      </h4>
                    </div>
                  </div>
                </div>

                {/* Sticky Header with Search & Filters */}
                <div className="sticky top-0 z-20 bg-slate-50/95 dark:bg-[#0b101c]/95 backdrop-blur-md pb-4 pt-1 border-b border-slate-100 dark:border-slate-800/80 flex flex-col md:flex-row gap-3 items-stretch md:items-center">
                  {/* Search Input */}
                  <div className="relative flex-1">
                    <Search className="h-4 w-4 absolute left-3.5 top-3.5 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search name, phone, email address..."
                      value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      className="w-full text-xs pl-10 pr-10 py-3 bg-white dark:bg-[#111928] border border-slate-200/80 dark:border-slate-800 rounded-xl focus:outline-hidden focus:border-blue-500 dark:focus:border-blue-600 focus:ring-1 focus:ring-blue-500/20 text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 shadow-xs"
                    />
                    {isSearchingCustomers ? (
                      <div className="absolute right-3.5 top-3.5">
                        <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />
                      </div>
                    ) : customerSearch ? (
                      <button 
                        onClick={() => setCustomerSearch("")}
                        className="absolute right-3.5 top-3.5 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>

                  {/* Filter Dropdown */}
                  <div className="flex items-center space-x-2 shrink-0">
                    <span className="text-[10px] text-slate-400 font-bold uppercase">Sort By:</span>
                    <select
                      value={customerSortBy}
                      onChange={(e) => setCustomerSortBy(e.target.value)}
                      className="text-xs bg-white dark:bg-[#111928] border border-slate-200/80 dark:border-slate-800 rounded-xl px-3 py-2.5 font-bold focus:outline-hidden focus:border-blue-500 text-slate-700 dark:text-slate-300 shadow-xs cursor-pointer"
                    >
                      <option value="totalSpent">Total Lifetime Spend</option>
                      <option value="ordersCount">Total Bookings</option>
                      <option value="createdAt">Registration Date</option>
                      <option value="displayName">Alphabetical Name</option>
                    </select>
                  </div>
                </div>

                {sorted.length === 0 ? (
                  <div className={`p-12 text-center rounded-3xl border flex flex-col items-center justify-center space-y-4 max-w-xl mx-auto my-8 ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                    <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800/80 flex items-center justify-center text-slate-400 dark:text-slate-500">
                      <Users className="h-8 w-8 animate-pulse" />
                    </div>
                    <div className="space-y-1.5">
                      <h3 className="font-extrabold text-sm text-slate-800 dark:text-white">No Customers Found</h3>
                      <p className="text-xs text-slate-400 max-w-sm leading-relaxed">
                        We couldn't find any customer accounts matching "{customerSearch}". Try checking spelling, clearing searches, or adjusting filters.
                      </p>
                    </div>
                    {customerSearch && (
                      <button
                        onClick={() => setCustomerSearch("")}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition-all cursor-pointer"
                      >
                        Clear Search
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                    
                    {/* Left Column: Customers List */}
                    <div className={`lg:col-span-5 xl:col-span-4 space-y-4 ${selectedCustomerEmail && 'hidden lg:block'}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Roster Registry</span>
                        <span className="text-[10px] font-mono text-slate-400">Page {customerPage} of {totalPages || 1}</span>
                      </div>

                      <div className="space-y-3">
                        {displayedCust.map((cust, idx) => {
                          const isSelected = currentCust?.email === cust.email;
                          const custOrders = orders.filter(o => o.customerEmail === cust.email);
                          const totalSpent = custOrders.reduce((acc, o) => acc + o.totalPrice, 0);
                          const initials = (cust.displayName || "Customer").split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase() || "C";
                          const regDate = cust.createdAt ? new Date(cust.createdAt).toLocaleDateString('en-LK', { dateStyle: 'medium' }) : "Guest / Via Order";

                          return (
                            <div
                              key={cust.email + idx}
                              onClick={() => {
                                setSelectedCustomerEmail(cust.email);
                                window.scrollTo({ top: 0, behavior: 'smooth' });
                              }}
                              className={`p-4 rounded-2xl border text-left transition-all cursor-pointer flex items-center justify-between relative group ${
                                isSelected
                                  ? 'bg-blue-50/40 dark:bg-blue-500/5 border-blue-500 shadow-md ring-1 ring-blue-500/20'
                                  : 'bg-white dark:bg-[#101827]/75 border-slate-200/80 dark:border-slate-800/60 hover:border-slate-300 dark:hover:border-slate-700'
                              }`}
                            >
                              <div className="flex items-center space-x-3.5 min-w-0 flex-1">
                                <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${getAvatarGradient(cust.displayName || cust.email)} text-white font-extrabold flex items-center justify-center text-xs shadow-xs shrink-0`}>
                                  {initials}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <h4 className="font-extrabold text-xs text-slate-900 dark:text-white truncate group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors">
                                    {cust.displayName || "Verified Shopper"}
                                  </h4>
                                  <p className="text-[10px] text-slate-400 truncate">{cust.email}</p>
                                  <p className="text-[9px] text-slate-400/80 mt-0.5 truncate">Registered: {regDate}</p>
                                </div>
                              </div>

                              <div className="text-right shrink-0 pl-3 flex flex-col items-end space-y-1">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${
                                  custOrders.length > 0 ? 'bg-blue-500/10 text-blue-500 border border-blue-500/15' : 'bg-slate-100 dark:bg-slate-800 text-slate-400 border border-slate-200/20 dark:border-slate-700/40'
                                }`}>
                                  {custOrders.length} {custOrders.length === 1 ? 'order' : 'orders'}
                                </span>
                                <span className="text-xs font-black text-blue-500 dark:text-blue-400">
                                  {formatPrice(totalSpent)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Pagination Controls */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-between pt-4">
                          <button
                            disabled={customerPage === 1}
                            onClick={() => setCustomerPage(prev => Math.max(prev - 1, 1))}
                            className="px-3.5 py-1.5 bg-white dark:bg-[#111928] border border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-400 text-[10px] font-bold rounded-xl disabled:opacity-40 transition-colors cursor-pointer"
                          >
                            Previous
                          </button>
                          <span className="text-[10px] text-slate-400 font-bold">
                            Page {customerPage} of {totalPages}
                          </span>
                          <button
                            disabled={customerPage === totalPages}
                            onClick={() => setCustomerPage(prev => Math.min(prev + 1, totalPages))}
                            className="px-3.5 py-1.5 bg-white dark:bg-[#111928] border border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-400 text-[10px] font-bold rounded-xl disabled:opacity-40 transition-colors cursor-pointer"
                          >
                            Next
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Right Column: Customer Details */}
                    {currentCust ? (
                      <div className={`lg:col-span-7 xl:col-span-8 space-y-6 ${!selectedCustomerEmail && 'hidden lg:block'}`}>
                        {/* Mobile Back Button */}
                        <div className="lg:hidden flex items-center mb-2">
                          <button 
                            onClick={() => setSelectedCustomerEmail(null)}
                            className="flex items-center space-x-1.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-xl cursor-pointer"
                          >
                            <ChevronRight className="h-4 w-4 rotate-180" />
                            <span>Back to Customer List</span>
                          </button>
                        </div>

                        {/* Customer Profile Detailed Card */}
                        <div className={`rounded-3xl border p-6 text-left space-y-6 ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-xl' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                          
                          {/* Profile Header Block */}
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800/80">
                            <div className="flex items-center space-x-4">
                              <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${getAvatarGradient(currentCust.displayName || currentCust.email)} text-white font-extrabold flex items-center justify-center text-xl shadow-md shrink-0`}>
                                {(currentCust.displayName || "Customer").split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase() || "C"}
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center space-x-2">
                                  <span className="text-[10px] text-slate-400 font-mono">UID: {currentCust.uid || currentCust.id || 'N/A'}</span>
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[8px] font-extrabold uppercase ${
                                    currentCust.role === 'admin' ? 'bg-red-500/15 text-red-500 border border-red-500/10' : 'bg-blue-500/15 text-blue-500 border border-blue-500/10'
                                  }`}>
                                    {currentCust.role || 'customer'}
                                  </span>
                                </div>
                                <h3 className="text-lg font-black text-slate-900 dark:text-white tracking-tight mt-1 truncate">
                                  {currentCust.displayName || "Verified Shopper"}
                                </h3>
                                <p className="text-[10px] text-slate-400 leading-normal">
                                  Registry: {currentCust.createdAt ? new Date(currentCust.createdAt).toLocaleString('en-LK', { dateStyle: 'long', timeStyle: 'short' }) : "Created via Order Checkout"}
                                </p>
                              </div>
                            </div>

                            {/* Actions bar */}
                            <div className="flex flex-wrap gap-2 shrink-0">
                              <button
                                onClick={() => handleCopyText(currentCust.email, 'email')}
                                className="flex-1 sm:flex-initial inline-flex items-center justify-center space-x-1.5 px-3 py-2 bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80 rounded-xl text-[10px] font-black text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
                              >
                                {copiedCustFieldId === 'email' ? (
                                  <>
                                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                                    <span className="text-emerald-500">Copied Email!</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3.5 w-3.5" />
                                    <span>Copy Email</span>
                                  </>
                                )}
                              </button>

                              {currentCust.phone && (
                                <>
                                  <button
                                    onClick={() => handleCopyText(currentCust.phone, 'phone')}
                                    className="flex-1 sm:flex-initial inline-flex items-center justify-center space-x-1.5 px-3 py-2 bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200/80 dark:border-slate-700/80 rounded-xl text-[10px] font-black text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
                                  >
                                    {copiedCustFieldId === 'phone' ? (
                                      <>
                                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                                        <span className="text-emerald-500">Copied Phone!</span>
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="h-3.5 w-3.5" />
                                        <span>Copy Phone</span>
                                      </>
                                    )}
                                  </button>

                                  <a
                                    href={`https://wa.me/${currentCust.phone.replace(/[^0-9]/g, '')}?text=Hello%20${encodeURIComponent(currentCust.displayName || '')}%20from%20Zyro.lk%20Support!`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex-1 sm:flex-initial inline-flex items-center justify-center space-x-1.5 px-3 py-2 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/15 rounded-xl text-[10px] font-black transition-colors cursor-pointer"
                                  >
                                    <Phone className="h-3.5 w-3.5" />
                                    <span>WhatsApp Support</span>
                                  </a>
                                </>
                              )}
                            </div>
                          </div>

                          {/* Shopper Lifetime intelligence */}
                          {(() => {
                            const custOrders = orders.filter(o => o.customerEmail === currentCust.email);
                            const totalSpent = custOrders.reduce((acc, o) => acc + o.totalPrice, 0);
                            const avgOrderSize = custOrders.length > 0 ? (totalSpent / custOrders.length) : 0;
                            
                            const purchasedProdIds = new Set();
                            custOrders.forEach(o => o.items.forEach(it => purchasedProdIds.add(it.productId)));
                            const uniqueItemsCount = purchasedProdIds.size;

                            return (
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <div className="p-3 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-[#111928]/10">
                                  <span className="block text-[9px] text-slate-400 font-bold uppercase">Lifetime Value</span>
                                  <span className="block text-sm font-extrabold text-blue-500 mt-0.5 truncate">{formatPrice(totalSpent)}</span>
                                </div>
                                <div className="p-3 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-[#111928]/10">
                                  <span className="block text-[9px] text-slate-400 font-bold uppercase">Total Bookings</span>
                                  <span className="block text-sm font-extrabold text-slate-800 dark:text-slate-100 mt-0.5">{custOrders.length} bookings</span>
                                </div>
                                <div className="p-3 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-[#111928]/10">
                                  <span className="block text-[9px] text-slate-400 font-bold uppercase">Average Ticket</span>
                                  <span className="block text-sm font-extrabold text-slate-800 dark:text-slate-100 mt-0.5 truncate">{formatPrice(avgOrderSize)}</span>
                                </div>
                                <div className="p-3 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-[#111928]/10">
                                  <span className="block text-[9px] text-slate-400 font-bold uppercase">Unique Products</span>
                                  <span className="block text-sm font-extrabold text-slate-800 dark:text-slate-100 mt-0.5">{uniqueItemsCount} devices</span>
                                </div>
                              </div>
                            );
                          })()}

                          {/* Profile Details */}
                          <div className="p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/20 dark:bg-[#111928]/5 space-y-2">
                            <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Metadata Profile Coordinates</span>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/40">
                                <span className="text-slate-400 font-medium">Primary Email</span>
                                <span className="font-bold text-slate-700 dark:text-slate-200">{currentCust.email}</span>
                              </div>
                              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/40">
                                <span className="text-slate-400 font-medium">Primary Phone</span>
                                <span className="font-bold text-slate-700 dark:text-slate-200 font-mono">{currentCust.phone || 'Not Registered'}</span>
                              </div>
                              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/40">
                                <span className="text-slate-400 font-medium">User Identity role</span>
                                <span className="font-bold capitalize text-slate-700 dark:text-slate-200">{currentCust.role || 'customer'}</span>
                              </div>
                              <div className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800/40">
                                <span className="text-slate-400 font-medium">Registration Timestamp</span>
                                <span className="font-bold text-slate-700 dark:text-slate-200">
                                  {currentCust.createdAt ? new Date(currentCust.createdAt).toLocaleDateString() : 'Direct Checkout'}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Wishlist Section */}
                          {(() => {
                            const wishlistItems = currentCust.wishlist || [];
                            return (
                              <div className="space-y-3 text-left">
                                <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Saved Wishlist ({wishlistItems.length})</span>
                                
                                {wishlistItems.length === 0 ? (
                                  <div className="p-4 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800/60 bg-slate-50/20 dark:bg-[#111928]/5 text-center">
                                    <p className="text-[11px] text-slate-400 font-medium font-sans">Customer's wishlist is empty. They haven't saved any devices yet.</p>
                                  </div>
                                ) : (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {wishlistItems.map((prod: any, idx: number) => {
                                      const fallbackImg = "https://images.unsplash.com/photo-1594322436404-5a0526db4d13?q=80&w=200";
                                      return (
                                        <div key={idx} className="p-2.5 rounded-xl border border-slate-100 dark:border-slate-850 bg-slate-50/50 dark:bg-[#111928]/10 flex items-center space-x-2.5">
                                          <div className="w-10 h-10 rounded-lg overflow-hidden border border-slate-100 dark:border-slate-800/60 bg-white shrink-0">
                                            <img 
                                              src={prod.imageUrl || fallbackImg} 
                                              alt={prod.name} 
                                              className="w-full h-full object-cover" 
                                              referrerPolicy="no-referrer"
                                              onError={(e) => {
                                                (e.target as HTMLImageElement).src = fallbackImg;
                                              }}
                                            />
                                          </div>
                                          <div className="min-w-0 flex-1 text-left">
                                            <h5 className="font-bold text-xs text-slate-800 dark:text-slate-100 truncate">{prod.name}</h5>
                                            <p className="text-[10px] text-slate-400 truncate">{prod.category || 'Electronics'}</p>
                                            <p className="text-[10px] font-extrabold text-blue-500 mt-0.5">{formatPrice(prod.price)}</p>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* Reviews Section */}
                          {(() => {
                            const customerReviews = reviews.filter(
                              r => (r.userName || "").toLowerCase() === (currentCust.displayName || "").toLowerCase() ||
                                   (r.customerName || "").toLowerCase() === (currentCust.displayName || "").toLowerCase()
                            );
                            
                            return (
                              <div className="space-y-3 text-left">
                                <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Published Product Reviews ({customerReviews.length})</span>
                                
                                {customerReviews.length === 0 ? (
                                  <div className="p-4 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800/60 bg-slate-50/20 dark:bg-[#111928]/5 text-center">
                                    <p className="text-[11px] text-slate-400 font-medium">This customer has not posted any reviews yet.</p>
                                  </div>
                                ) : (
                                  <div className="space-y-3">
                                    {customerReviews.map((rev, idx) => {
                                      const reviewedProduct = products.find(p => p.id === rev.productId);
                                      return (
                                        <div key={idx} className="p-3.5 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-[#111928]/10 text-xs space-y-1.5 text-left">
                                          <div className="flex items-center justify-between">
                                            <span className="font-extrabold text-slate-900 dark:text-white">
                                              Review for: <span className="text-blue-500">{reviewedProduct ? reviewedProduct.name : `Product ID: ${rev.productId}`}</span>
                                            </span>
                                            <span className="text-[9px] text-slate-400">
                                              {rev.createdAt ? new Date(rev.createdAt).toLocaleDateString() : 'Recent'}
                                            </span>
                                          </div>
                                          
                                          <div className="flex items-center space-x-0.5 text-amber-400">
                                            {Array.from({ length: 5 }).map((_, sIdx) => (
                                              <Star 
                                                key={sIdx} 
                                                className={`h-3 w-3 ${sIdx < rev.rating ? 'fill-amber-400' : 'text-slate-200 dark:text-slate-800'}`} 
                                              />
                                            ))}
                                          </div>

                                          <p className="text-slate-600 dark:text-slate-300 font-medium leading-relaxed italic">
                                            "{rev.comment}"
                                          </p>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* Historical Order History Grid */}
                          {(() => {
                            const custOrders = orders.filter(o => o.customerEmail === currentCust.email);
                            return (
                              <div className="space-y-3 text-left">
                                <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Chronological Orders History ({custOrders.length})</span>
                                
                                {custOrders.length === 0 ? (
                                  <div className="p-4 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800/60 bg-slate-50/20 dark:bg-[#111928]/5 text-center">
                                    <p className="text-[11px] text-slate-400 font-medium">No order bookings associated with this customer account.</p>
                                  </div>
                                ) : (
                                  <div className="border border-slate-100 dark:border-slate-800 rounded-2xl overflow-hidden text-xs">
                                    <div className="overflow-x-auto">
                                      <table className="w-full text-left border-collapse">
                                        <thead>
                                          <tr className="bg-slate-50 dark:bg-slate-800/40 text-slate-400 font-bold border-b border-slate-100 dark:border-slate-800">
                                            <th className="p-3 font-extrabold uppercase">Order Code</th>
                                            <th className="p-3 font-extrabold uppercase">Placement Date</th>
                                            <th className="p-3 font-extrabold uppercase">Commodities</th>
                                            <th className="p-3 text-right font-extrabold uppercase">Sum Rate</th>
                                            <th className="p-3 text-center font-extrabold uppercase">Status</th>
                                            <th className="p-3 text-center font-extrabold uppercase">Action</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                                          {custOrders.map((o, oIdx) => {
                                            const statusColors: Record<string, string> = {
                                              pending: 'bg-amber-500/10 text-amber-500 border border-amber-500/15',
                                              confirmed: 'bg-blue-500/10 text-blue-500 border border-blue-500/15',
                                              packed: 'bg-purple-500/10 text-purple-500 border border-purple-500/15',
                                              shipped: 'bg-cyan-500/10 text-cyan-500 border border-cyan-500/15',
                                              delivered: 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/15',
                                              cancelled: 'bg-red-500/10 text-red-500 border border-red-500/15'
                                            };
                                            const dateStr = o.createdAt ? new Date(o.createdAt).toLocaleDateString('en-LK') : "N/A";
                                            return (
                                              <tr key={o.id} className="hover:bg-slate-50/30 dark:hover:bg-slate-800/10">
                                                <td className="p-3 font-extrabold text-slate-950 dark:text-white">
                                                  #{o.orderNumber || o.id.substring(0, 8).toUpperCase()}
                                                </td>
                                                <td className="p-3 text-slate-500 dark:text-slate-400 font-medium">
                                                  {dateStr}
                                                </td>
                                                <td className="p-3 text-slate-600 dark:text-slate-300">
                                                  <p className="font-bold line-clamp-1">{o.items.map(it => it.name).join(', ')}</p>
                                                  <p className="text-[9px] text-slate-400 font-mono">{o.items.length} items</p>
                                                </td>
                                                <td className="p-3 text-right font-black text-blue-500 dark:text-blue-400">
                                                  {formatPrice(o.totalPrice)}
                                                </td>
                                                <td className="p-3 text-center">
                                                  <span className={`inline-block px-2.5 py-0.5 rounded-full text-[9px] font-black uppercase ${statusColors[o.status || 'pending']}`}>
                                                    {o.status || 'pending'}
                                                  </span>
                                                </td>
                                                <td className="p-3 text-center">
                                                  <button
                                                    onClick={() => {
                                                      setSelectedOrderId(o.id);
                                                      setActiveTab('orders');
                                                      window.scrollTo({ top: 0, behavior: 'smooth' });
                                                    }}
                                                    className="px-2.5 py-1 bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 dark:text-blue-400 text-[10px] font-black rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                                                  >
                                                    Inspect Order
                                                  </button>
                                                </td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                        </div>
                      </div>
                    ) : (
                      <div className="lg:col-span-7 xl:col-span-8 p-12 rounded-3xl border border-dashed border-slate-200 dark:border-slate-800/80 flex flex-col items-center justify-center space-y-3 min-h-[300px]">
                        <Users className="h-8 w-8 text-slate-300 dark:text-slate-600 animate-pulse" />
                        <h4 className="font-extrabold text-sm text-slate-800 dark:text-slate-300">No Customer Selected</h4>
                        <p className="text-xs text-slate-400 max-w-xs mx-auto text-center leading-relaxed">
                          Please select a customer profile from the roster to inspect registration coordinates, lifetime order value, wishlist saves, and submitted reviews.
                        </p>
                      </div>
                    )}

                  </div>
                )}

              </motion.div>
            );
          })()}

          {/* TAB: PAGES CMS */}
          {activeTab === 'pages' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              
              <div className="text-left">
                <h2 className="text-xl font-extrabold tracking-tight">Static Pages CMS</h2>
                <p className="text-xs text-slate-400">Create, write, and publish rich formatted company pages to your store's footer.</p>
              </div>

              {cmsSuccessMessage && (
                <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-2xl text-xs font-semibold flex items-center gap-2 animate-fadeIn text-left">
                  <Check className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span>{cmsSuccessMessage}</span>
                </div>
              )}

              {cmsErrorMessage && (
                <div className="p-4 bg-rose-500/10 border border-rose-500/30 text-rose-400 rounded-2xl text-xs font-semibold flex items-center gap-2 animate-fadeIn text-left" role="alert">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{cmsErrorMessage}</span>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                
                {/* Left Side: Pages List Selector */}
                <div className="lg:col-span-4 space-y-3">
                  <span className="block text-[10px] font-black uppercase tracking-widest text-blue-500 text-left">Editable Pages Index</span>
                  
                  <div className="space-y-2">
                    {[
                      { id: 'about-us', title: 'About Us', desc: 'Company mission, values, and story.' },
                      { id: 'privacy-policy', title: 'Privacy Policy', desc: 'Secure transactions & consumer data rules.' },
                      { id: 'terms-conditions', title: 'Terms & Conditions', desc: 'E-commerce shipping, prices & legal terms.' },
                      { id: 'return-policy', title: 'Return Policy', desc: '7-day replacement and warranty guidelines.' },
                      { id: 'faq', title: 'Frequently Asked Questions', desc: 'Common answers for Sri Lankan buyers.' },
                      { id: 'contact-us', title: 'Contact Us', desc: 'Inquiry form messages, support hours & feedback.' }
                    ].map(pageItem => {
                      const isActive = selectedCmsPageId === pageItem.id;
                      const isCustomized = staticPages.some(p => p.id === pageItem.id);
                      
                      return (
                        <button
                          key={pageItem.id}
                          type="button"
                          onClick={() => setSelectedCmsPageId(pageItem.id)}
                          className={`w-full text-left p-4 rounded-2xl border transition-all duration-200 flex flex-col justify-between items-stretch cursor-pointer relative overflow-hidden group ${
                            isActive 
                              ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/15' 
                              : isDarkMode 
                                ? 'bg-[#101827]/75 border-slate-800/60 hover:bg-[#141E33] text-slate-100' 
                                : 'bg-white border-slate-200/80 hover:bg-slate-50 text-slate-800 shadow-xs'
                          }`}
                        >
                          <div className="space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-black tracking-tight">{pageItem.title}</span>
                              {isCustomized ? (
                                <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded-md ${
                                  isActive ? 'bg-white/20 text-white' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                }`}>
                                  Firestore Live
                                </span>
                              ) : (
                                <span className={`text-[8px] font-bold uppercase px-2 py-0.5 rounded-md ${
                                  isActive ? 'bg-white/10 text-white/80' : 'bg-slate-100 dark:bg-slate-800 text-slate-400'
                                }`}>
                                  Default Spec
                                </span>
                              )}
                            </div>
                            <p className={`text-[10px] font-light leading-relaxed line-clamp-2 ${isActive ? 'text-white/80' : 'text-slate-400'}`}>
                              {pageItem.desc}
                            </p>
                          </div>
                          
                          <div className={`text-[9px] font-mono mt-3 pt-2 border-t flex justify-between items-center ${
                            isActive ? 'border-white/10 text-white/60' : 'border-slate-100 dark:border-slate-800/60 text-slate-500'
                          }`}>
                            <span>ID: {pageItem.id}</span>
                            <span className="group-hover:translate-x-0.5 transition-transform">Edit Page →</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Right Side: Page Edit Form */}
                <div className="lg:col-span-8">
                  <form onSubmit={handleSaveCmsPage} className={`p-6 rounded-3xl border text-left space-y-6 ${
                    isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-xl' : 'bg-white border-slate-200/80 shadow-xs'
                  }`}>
                    <div className="border-b border-slate-100 dark:border-slate-800/60 pb-4 flex justify-between items-center flex-wrap gap-4">
                      <div>
                        <span className="block text-[10px] font-black uppercase tracking-widest text-blue-500 mb-1">Interactive Content Editor</span>
                        <h3 className="text-base font-black tracking-tight text-slate-900 dark:text-white">
                          Editing: {selectedCmsPageId.replace('-', ' ').toUpperCase()}
                        </h3>
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-200/40 dark:border-slate-700/45">
                        Document ID: <span className="font-bold text-slate-800 dark:text-slate-200">{selectedCmsPageId}</span>
                      </div>
                    </div>

                    <div className="space-y-4">
                      {/* Page Title Input */}
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold block">Page Header / Display Title *</label>
                        <input
                          type="text"
                          required
                          value={cmsPageTitle}
                          onChange={(e) => setCmsPageTitle(e.target.value)}
                          placeholder="e.g. About Us"
                          className="w-full px-4 py-2.5 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden text-sm"
                        />
                      </div>

                      {/* Content Rich Textarea */}
                      <div className="space-y-1.5 text-xs">
                        <div className="flex justify-between items-center">
                          <label className="text-slate-400 font-bold block">Page Content Body (Standard Plain Text & Lists) *</label>
                          <span className="text-[9px] text-slate-400 font-medium">Auto-formats paragraphs and bullet points</span>
                        </div>
                        <textarea
                          required
                          rows={15}
                          value={cmsPageContent}
                          onChange={(e) => setCmsPageContent(e.target.value)}
                          placeholder="Write the full static page text content here. Separate paragraphs with double line breaks. Use '•' or '-' for bullet lists."
                          className="w-full px-4 py-3 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-2xl focus:outline-hidden text-sm font-light leading-relaxed font-sans"
                        />
                      </div>
                    </div>

                    {/* Editor Guidelines Checklist banner */}
                    <div className="p-4 bg-blue-500/5 border border-blue-500/10 rounded-2xl text-[11px] text-slate-400 leading-relaxed space-y-1 text-left">
                      <p className="font-bold text-blue-400 flex items-center gap-1">💡 Formatting Guide for Professional Layouts:</p>
                      <ul className="list-disc pl-4 space-y-0.5">
                        <li>Press **Enter twice** to create a clean, spaced paragraph.</li>
                        <li>Start a line with **•** or **-** to create high-contrast list bullet items.</li>
                        <li>Include numbers (like **1.** or **2.**) on their own line to create major section headers.</li>
                        <li>For FAQ pages, use **Q:** for questions and **A:** for answers to render in highlight FAQ card boxes.</li>
                      </ul>
                    </div>

                    {/* Action Panel */}
                    <div className="flex items-center justify-between pt-4 border-t border-slate-100 dark:border-slate-800/60">
                      <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleResetCmsPage}
                        disabled={savingCmsPage || deletingCmsPage}
                        className="px-4 py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 text-xs font-bold rounded-xl transition-all cursor-pointer"
                      >
                        Reset to Default
                      </button>

                      <button
                        type="button"
                        onClick={handleDeleteCustomCmsPage}
                        disabled={deletingCmsPage || !staticPages.some((page) => page.id === selectedCmsPageId)}
                        className="px-4 py-2.5 bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-40 text-rose-500 text-xs font-bold rounded-xl transition-all cursor-pointer"
                      >
                        {deletingCmsPage ? "Deleting..." : "Delete Custom Version"}
                      </button>
                      </div>

                      <button
                        type="submit"
                        disabled={savingCmsPage}
                        className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center space-x-1.5 shadow-md shadow-blue-500/15"
                      >
                        {savingCmsPage ? (
                          <>
                            <RefreshCw className="h-4 w-4 animate-spin" />
                            <span>Publishing Changes...</span>
                          </>
                        ) : (
                          <>
                            <Save className="h-4 w-4" />
                            <span>Save & Publish Live</span>
                          </>
                        )}
                      </button>
                    </div>

                  </form>
                </div>

              </div>

            </motion.div>
          )}

          {/* TAB 6: WEBSITE SETTINGS */}
          {activeTab === 'settings' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 max-w-3xl text-left mx-auto">
              
              <div>
                <h2 className="text-xl font-extrabold tracking-tight">Website Settings Form</h2>
                <p className="text-xs text-slate-400">Configure global delivery costs and slider promotional banners</p>
              </div>

              {settingsForm && (
                <form onSubmit={handleSaveSettings} className={`p-6 rounded-3xl border space-y-6 ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-xl' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                  
                  {/* General Configs */}
                  <div className="space-y-4">
                    <span className="block text-[10px] font-black uppercase tracking-widest text-blue-500">General Branding</span>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold block">Store Display Name *</label>
                        <input
                          type="text"
                          required
                          value={settingsForm.storeName}
                          onChange={(e) => setSettingsForm(prev => prev ? ({ ...prev, storeName: e.target.value }) : null)}
                          className="w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden"
                        />
                        <label className="block pt-3 font-bold text-slate-400">Favicon URL</label>
                        <input
                          type="url"
                          placeholder="https://example.com/favicon.png"
                          value={settingsForm.faviconUrl || ""}
                          onChange={(e) => setSettingsForm(prev => prev ? ({ ...prev, faviconUrl: e.target.value }) : null)}
                          aria-invalid={Boolean(settingsForm.faviconUrl?.trim() && !isHttpUrl(settingsForm.faviconUrl))}
                          className={`w-full rounded-xl border bg-slate-100/50 px-3 py-2 focus:outline-hidden dark:bg-slate-800/60 ${settingsForm.faviconUrl?.trim() && !isHttpUrl(settingsForm.faviconUrl) ? 'border-red-500' : 'border-slate-200/60 dark:border-slate-800'}`}
                        />
                        {settingsForm.faviconUrl?.trim() && !isHttpUrl(settingsForm.faviconUrl) && <p className="text-[10px] font-semibold text-red-500">Use a valid http or https image URL.</p>}
                      </div>
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold block">Branding Logo Url</label>
                        <input
                          type="url"
                          value={settingsForm.logoUrl}
                          onChange={(e) => setSettingsForm(prev => prev ? ({ ...prev, logoUrl: e.target.value }) : null)}
                          aria-invalid={Boolean(settingsForm.logoUrl?.trim() && !isHttpUrl(settingsForm.logoUrl))}
                          className={`w-full rounded-xl border bg-slate-100/50 px-3 py-2 focus:outline-hidden dark:bg-slate-800/60 ${settingsForm.logoUrl?.trim() && !isHttpUrl(settingsForm.logoUrl) ? 'border-red-500' : 'border-slate-200/60 dark:border-slate-800'}`}
                        />
                        {settingsForm.logoUrl?.trim() && !isHttpUrl(settingsForm.logoUrl) && <p className="text-[10px] font-semibold text-red-500">Use a valid http or https image URL.</p>}
                        <div className="mt-1.5 flex items-center space-x-2">
                          <span className="text-[10px] font-bold text-slate-400 uppercase block">Upload File</span>
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/svg+xml"
                            onChange={handleLogoUpload}
                            className="text-[10px] text-slate-500 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-[10px] file:font-semibold file:bg-slate-200 dark:file:bg-slate-700 dark:file:text-white cursor-pointer"
                          />
                        </div>
                        {/* Live logo preview card */}
                        <div className="mt-3 flex justify-center">
                          <div className={`w-[120px] h-[120px] rounded-2xl flex items-center justify-center border overflow-hidden shadow-xs relative bg-white dark:bg-slate-900 ${isDarkMode ? 'border-slate-800/80' : 'border-slate-200'}`}>
                            {settingsForm.logoUrl && !logoError ? (
                              <img
                                src={settingsForm.logoUrl}
                                alt="Logo Preview"
                                onError={() => setLogoError(true)}
                                className="max-w-full max-h-full object-contain p-2"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <div className="flex flex-col items-center justify-center text-slate-400 space-y-1">
                                <Image className="h-6 w-6 text-slate-300 dark:text-slate-600" />
                                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">No Logo</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Delivery Charges */}
                  <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800">
                    <span className="block text-[10px] font-black uppercase tracking-widest text-blue-500">Delivery Logistics</span>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold block">Flat Courier Charge (LKR)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={tempDeliveryCharge}
                          onChange={(e) => setTempDeliveryCharge(e.target.value)}
                          className="w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden"
                        />
                      </div>
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold block">Free Shipping Threshold Limit (LKR)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={tempFreeDeliveryMin}
                          onChange={(e) => setTempFreeDeliveryMin(e.target.value)}
                          className="w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Contact Info */}
                  <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800">
                    <span className="block text-[10px] font-black uppercase tracking-widest text-blue-500">Corporate Contacts</span>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1 text-xs col-span-2 sm:col-span-1">
                        <label className="text-slate-400 font-bold block">Contact Email</label>
                        <input
                          type="email"
                          value={settingsForm.contactEmail || ""}
                          onChange={(e) => setSettingsForm(prev => prev ? ({ ...prev, contactEmail: e.target.value }) : null)}
                          className="w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden text-slate-800 dark:text-slate-100"
                        />
                      </div>
                      <div className="space-y-1 text-xs col-span-2 sm:col-span-1">
                        <label className="text-slate-400 font-bold block">WhatsApp Number (For Order Checkout)</label>
                        <input
                          type="text"
                          value={settingsForm.whatsappNumber || ""}
                          onChange={(e) => setSettingsForm(prev => prev ? ({ ...prev, whatsappNumber: e.target.value }) : null)}
                          className="w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden text-slate-800 dark:text-slate-100"
                          placeholder="+94771234567"
                        />
                      </div>
                      <div className="space-y-1 text-xs col-span-2 sm:col-span-1">
                        <label className="text-slate-400 font-bold block">Primary Telephone</label>
                        <input
                          type="text"
                          value={settingsForm.contactPhone || ""}
                          onChange={(e) => setSettingsForm(prev => prev ? ({ ...prev, contactPhone: e.target.value }) : null)}
                          className="w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden text-slate-800 dark:text-slate-100"
                        />
                      </div>
                      <div className="space-y-1 text-xs col-span-2 sm:col-span-1">
                        <label className="text-slate-400 font-bold block">Backup Telephone / Hotline</label>
                        <input
                          type="text"
                          value={settingsForm.contactPhone2 || ""}
                          onChange={(e) => setSettingsForm(prev => prev ? ({ ...prev, contactPhone2: e.target.value }) : null)}
                          className="w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden text-slate-800 dark:text-slate-100"
                        />
                      </div>
                      <div className="space-y-1 text-xs col-span-2">
                        <label className="text-slate-400 font-bold block">Showroom Address</label>
                        <textarea
                          rows={2}
                          value={settingsForm.contactAddress || ""}
                          onChange={(e) => setSettingsForm(prev => prev ? ({ ...prev, contactAddress: e.target.value }) : null)}
                          className="w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden text-slate-800 dark:text-slate-100 resize-none"
                          placeholder="No. 458, Galle Road, Colombo 03, Sri Lanka"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Social Media */}
                  <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800">
                    <span className="block text-[10px] font-black uppercase tracking-widest text-blue-500">Social Media</span>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      
                      {/* Facebook URL */}
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold flex items-center gap-1.5 mb-1">
                          <Facebook className="h-4 w-4 text-blue-600" />
                          <span>Facebook URL</span>
                        </label>
                        <input
                          type="text"
                          placeholder="https://facebook.com/yourpage"
                          value={settingsForm.facebookUrl || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSettingsForm(prev => prev ? ({ ...prev, facebookUrl: val }) : null);
                          }}
                          className={`w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border rounded-xl focus:outline-hidden ${
                            settingsForm.facebookUrl && !isValidUrl(settingsForm.facebookUrl)
                              ? 'border-red-500 focus:border-red-500'
                              : 'border-slate-200/60 dark:border-slate-800'
                          }`}
                        />
                        {settingsForm.facebookUrl && !isValidUrl(settingsForm.facebookUrl) && (
                          <p className="text-[10px] text-red-500 font-semibold mt-0.5">Please enter a valid URL (e.g. https://facebook.com/...)</p>
                        )}
                      </div>

                      {/* Instagram URL */}
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold flex items-center gap-1.5 mb-1">
                          <Instagram className="h-4 w-4 text-pink-600" />
                          <span>Instagram URL</span>
                        </label>
                        <input
                          type="text"
                          placeholder="https://instagram.com/yourhandle"
                          value={settingsForm.instagramUrl || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSettingsForm(prev => prev ? ({ ...prev, instagramUrl: val }) : null);
                          }}
                          className={`w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border rounded-xl focus:outline-hidden ${
                            settingsForm.instagramUrl && !isValidUrl(settingsForm.instagramUrl)
                              ? 'border-red-500 focus:border-red-500'
                              : 'border-slate-200/60 dark:border-slate-800'
                          }`}
                        />
                        {settingsForm.instagramUrl && !isValidUrl(settingsForm.instagramUrl) && (
                          <p className="text-[10px] text-red-500 font-semibold mt-0.5">Please enter a valid URL (e.g. https://instagram.com/...)</p>
                        )}
                      </div>

                      {/* TikTok URL */}
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold flex items-center gap-1.5 mb-1">
                          <Music className="h-4 w-4 text-black dark:text-white" />
                          <span>TikTok URL</span>
                        </label>
                        <input
                          type="text"
                          placeholder="https://tiktok.com/@yourhandle"
                          value={settingsForm.tiktokUrl || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSettingsForm(prev => prev ? ({ ...prev, tiktokUrl: val }) : null);
                          }}
                          className={`w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border rounded-xl focus:outline-hidden ${
                            settingsForm.tiktokUrl && !isValidUrl(settingsForm.tiktokUrl)
                              ? 'border-red-500 focus:border-red-500'
                              : 'border-slate-200/60 dark:border-slate-800'
                          }`}
                        />
                        {settingsForm.tiktokUrl && !isValidUrl(settingsForm.tiktokUrl) && (
                          <p className="text-[10px] text-red-500 font-semibold mt-0.5">Please enter a valid URL (e.g. https://tiktok.com/...)</p>
                        )}
                      </div>

                      {/* YouTube URL */}
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold flex items-center gap-1.5 mb-1">
                          <Youtube className="h-4 w-4 text-red-600" />
                          <span>YouTube URL</span>
                        </label>
                        <input
                          type="text"
                          placeholder="https://youtube.com/@yourchannel"
                          value={settingsForm.youtubeUrl || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSettingsForm(prev => prev ? ({ ...prev, youtubeUrl: val }) : null);
                          }}
                          className={`w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border rounded-xl focus:outline-hidden ${
                            settingsForm.youtubeUrl && !isValidUrl(settingsForm.youtubeUrl)
                              ? 'border-red-500 focus:border-red-500'
                              : 'border-slate-200/60 dark:border-slate-800'
                          }`}
                        />
                        {settingsForm.youtubeUrl && !isValidUrl(settingsForm.youtubeUrl) && (
                          <p className="text-[10px] text-red-500 font-semibold mt-0.5">Please enter a valid URL (e.g. https://youtube.com/...)</p>
                        )}
                      </div>

                    </div>
                  </div>

                  {/* Slider Promotional Hero Banners */}
                  <HeroSliderEditor
                    settings={settingsForm}
                    setSettings={setSettingsForm}
                    bannerErrors={bannerErrors}
                    setBannerErrors={setBannerErrors}
                    onImageUpload={handleBannerImageUpload}
                  />
                  <div className="hidden">
                    <span className="block text-[10px] font-black uppercase tracking-widest text-blue-500">Promotional Slider Banners</span>
                    {false && settingsForm.heroBanners.map((banner, index) => (
                      <div key={banner.id} className="p-4 bg-slate-100/50 dark:bg-slate-800/40 rounded-2xl border border-slate-200/50 dark:border-slate-800/60 space-y-3">
                        <div className="flex items-center justify-between border-b pb-1.5">
                          <span className="text-[10px] font-bold text-slate-500 uppercase">Banner Slide #{index + 1}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1 text-xs">
                            <label className="text-[10px] font-bold text-slate-400 uppercase">Badge Label</label>
                            <input
                              type="text"
                              value={banner.badge}
                              onChange={(e) => setSettingsForm(prev => {
                                if (!prev) return prev;
                                const updated = prev.heroBanners.map(b => b.id === banner.id ? { ...b, badge: e.target.value } : b);
                                return { ...prev, heroBanners: updated };
                              })}
                              className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800 rounded-lg text-[11px]"
                            />
                          </div>
                          <div className="space-y-1 text-xs">
                            <label className="text-[10px] font-bold text-slate-400 uppercase">Slide Title</label>
                            <input
                              type="text"
                              value={banner.title}
                              onChange={(e) => setSettingsForm(prev => {
                                if (!prev) return prev;
                                const updated = prev.heroBanners.map(b => b.id === banner.id ? { ...b, title: e.target.value } : b);
                                return { ...prev, heroBanners: updated };
                              })}
                              className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800 rounded-lg text-[11px]"
                            />
                          </div>
                        </div>
                        <div className="space-y-1 text-xs">
                          <label className="text-[10px] font-bold text-slate-400 uppercase">Description Paragraph</label>
                          <textarea
                            rows={2}
                            value={banner.description}
                            onChange={(e) => setSettingsForm(prev => {
                              if (!prev) return prev;
                              const updated = prev.heroBanners.map(b => b.id === banner.id ? { ...b, description: e.target.value } : b);
                              return { ...prev, heroBanners: updated };
                            })}
                            className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800 rounded-lg text-[11px]"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3 items-center">
                          <div className="space-y-1 text-xs">
                            <label className="text-[10px] font-bold text-slate-400 uppercase font-mono text-[9px]">Image URL</label>
                            <input
                              type="text"
                              value={banner.image}
                              onChange={(e) => setSettingsForm(prev => {
                                if (!prev) return prev;
                                const updated = prev.heroBanners.map(b => b.id === banner.id ? { ...b, image: e.target.value } : b);
                                return { ...prev, heroBanners: updated };
                              })}
                              className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800 rounded-lg text-[11px]"
                            />
                          </div>
                          <div>
                            <span className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Upload File</span>
                            <input
                              type="file"
                              onChange={(e) => handleBannerImageUpload(e, banner.id)}
                              className="text-[10px] text-slate-500 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-[10px] file:font-semibold file:bg-slate-200 dark:file:bg-slate-700 dark:file:text-white cursor-pointer"
                            />
                          </div>
                        </div>
                        {/* Live banner preview */}
                        <div className="mt-3">
                          <span className="text-[10px] font-bold text-slate-400 uppercase block mb-1.5">Live Banner Preview</span>
                          <div className={`w-full aspect-video rounded-2xl flex items-center justify-center border overflow-hidden shadow-xs relative bg-white dark:bg-slate-900 ${isDarkMode ? 'border-slate-800/80' : 'border-slate-200'}`}>
                            {banner.image && !bannerErrors[banner.id] ? (
                              <img
                                src={banner.image}
                                alt={`Banner Slide ${index + 1} Preview`}
                                onError={() => setBannerErrors(prev => ({ ...prev, [banner.id]: true }))}
                                className="w-full h-full object-cover"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <div className="flex flex-col items-center justify-center text-slate-400 space-y-1.5">
                                <Image className="h-8 w-8 text-slate-300 dark:text-slate-600" />
                                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">No Banner Image</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    type="submit"
                    disabled={savingSettings}
                    className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl text-xs transition-all shadow-md shadow-blue-500/20 flex items-center justify-center space-x-1 cursor-pointer disabled:bg-slate-700 disabled:opacity-80"
                  >
                    {savingSettings ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    <span>{savingSettings ? "Saving..." : "Save Corporate Settings"}</span>
                  </button>

                </form>
              )}

            </motion.div>
          )}

          {/* TAB 8: SUPPLIER HUB WORKFLOW PORTAL (Consolidated into SupplierHubFiveStars) */}
          {false && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6 text-left mx-auto">
              
              {/* Header section */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-100 dark:border-slate-800/60 pb-5">
                <div>
                  <h2 className="text-xl font-extrabold tracking-tight text-slate-900 dark:text-white font-display">Supplier Sync Portal</h2>
                  <p className="text-xs text-slate-400">Pristine workflow workbench for automated distributor catalog feed ingestion, verification, and live listing mapping.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleTriggerImport}
                    disabled={processingImportId !== null}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white font-bold rounded-xl text-xs transition-colors shadow-lg shadow-blue-500/20 flex items-center space-x-1.5 cursor-pointer"
                  >
                    <RefreshCw className={`h-4 w-4 ${processingImportId !== null ? 'animate-spin' : ''}`} />
                    <span>{processingImportId !== null ? 'Syncing Feeds...' : 'Sync All Feeds'}</span>
                  </button>
                  <button
                    onClick={() => setShowConnectModal(true)}
                    className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs transition-colors border border-slate-200/50 dark:border-slate-700 flex items-center space-x-1.5 cursor-pointer"
                  >
                    <Plus className="h-4 w-4 text-emerald-500" />
                    <span>Connect Supplier</span>
                  </button>
                </div>
              </div>

              {/* Success Notification Alert Overlay */}
              {syncSuccessMsg && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }} 
                  animate={{ opacity: 1, y: 0 }} 
                  className="p-3.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold rounded-2xl border border-emerald-500/20 flex items-center gap-2.5"
                >
                  <Check className="h-4.5 w-4.5 shrink-0" />
                  <span>{syncSuccessMsg}</span>
                </motion.div>
              )}

              {/* WORKFLOW SUB-TABS NAVIGATION BAR */}
              <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 dark:border-slate-800 pb-1.5 overflow-x-auto">
                {[
                  { id: 'sources', label: 'Supplier Sources', badge: supplierSources.length, icon: Globe },
                  { id: 'review', label: 'Review Queue', badge: supplierReviewQueue.length, icon: UserCheck, badgeColor: 'bg-rose-500 text-white' },
                  { id: 'import', label: 'Import Queue', badge: supplierImportQueue.length, icon: Activity, badgeColor: 'bg-blue-500 text-white animate-pulse' },
                  { id: 'changes', label: 'Pending Changes', badge: supplierPendingChanges.length, icon: SlidersHorizontal, badgeColor: 'bg-amber-500 text-slate-900' },
                  { id: 'history', label: 'Sync History', badge: supplierSyncHistory.length, icon: History },
                  { id: 'settings', label: 'Settings', badge: null, icon: Settings },
                ].map((tab) => {
                  const TabIcon = tab.icon;
                  const isSubActive = supplierSubTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setSupplierSubTab(tab.id as any)}
                      className={`px-4 py-2.5 rounded-xl font-bold text-xs transition-all flex items-center space-x-2 border cursor-pointer whitespace-nowrap ${
                        isSubActive 
                          ? 'bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-500/10' 
                          : 'bg-slate-50 dark:bg-slate-900/40 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200/50 dark:border-slate-800/60'
                      }`}
                    >
                      <TabIcon className="h-4 w-4" />
                      <span>{tab.label}</span>
                      {tab.badge !== null && (
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

                {/* SUB-TAB 1: SUPPLIER SOURCES */}
                {supplierSubTab === 'sources' && (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Connected Feeds</h3>
                        <p className="text-[11px] text-slate-400">Direct endpoints parsed for catalog updates, inventory streams, and pricing matrices.</p>
                      </div>
                      <span className="text-[10px] text-slate-400 font-mono bg-slate-100 dark:bg-slate-800/50 px-2.5 py-1 rounded-lg border border-slate-200/50 dark:border-slate-800">{supplierSources.length} Connected Feed(s)</span>
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
                            <div className={`absolute top-0 bottom-0 left-0 w-1 ${source.connectionStatus === 'connected' ? 'bg-emerald-500' : source.connectionStatus === 'pending' ? 'bg-amber-500' : 'bg-rose-500'}`} />
                            
                            <div className="flex items-start justify-between">
                              <div className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-extrabold text-sm text-slate-900 dark:text-white">{source.name}</span>
                                  {source.id.includes('whatsapp') ? (
                                    <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-500 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-emerald-500/20">
                                      <Phone className="h-2.5 w-2.5" /> WhatsApp
                                    </span>
                                  ) : (
                                    <span className="px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-500 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-blue-500/20">
                                      <Globe className="h-2.5 w-2.5" /> API Feed
                                    </span>
                                  )}
                                </div>
                                <p className="text-[10px] text-slate-400 font-mono">ID: {source.id}</p>
                              </div>

                              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold border flex items-center gap-1 uppercase tracking-wider ${
                                source.connectionStatus === 'connected' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' :
                                source.connectionStatus === 'pending' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' :
                                'bg-rose-500/10 text-rose-500 border-rose-500/20'
                              }`}>
                                <span className={`h-1.5 w-1.5 rounded-full ${
                                  source.connectionStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
                                  source.connectionStatus === 'pending' ? 'bg-amber-500 animate-pulse' :
                                  'bg-rose-500'
                                }`} />
                                {source.connectionStatus}
                              </span>
                            </div>

                            <div className="grid grid-cols-2 gap-4 mt-6 p-3 bg-slate-50 dark:bg-slate-900/40 rounded-2xl border border-slate-100/50 dark:border-slate-800/40 text-xs">
                              <div className="space-y-0.5">
                                <span className="text-slate-400 font-bold block text-[10px] uppercase">Last Synchronization</span>
                                <span className="text-slate-700 dark:text-slate-200 font-medium font-mono">{source.lastSync}</span>
                              </div>
                              <div className="space-y-0.5">
                                <span className="text-slate-400 font-bold block text-[10px] uppercase">Operational Status</span>
                                <span className={`font-bold capitalize ${source.sourceStatus === 'active' ? 'text-emerald-500' : 'text-slate-500'}`}>{source.sourceStatus}</span>
                              </div>
                              <div className="col-span-2 space-y-0.5 border-t border-slate-100 dark:border-slate-800/40 pt-2">
                                <span className="text-slate-400 font-bold block text-[10px] uppercase">Last Recorded Error</span>
                                <span className={`font-medium block truncate ${source.lastError === 'None' ? 'text-slate-400 font-sans' : 'text-rose-500 font-mono bg-rose-500/5 px-2 py-0.5 rounded-md border border-rose-500/10 text-[10px]'}`}>
                                  {source.lastError}
                                </span>
                              </div>
                            </div>

                            <div className="mt-5 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-1 text-[10px] text-slate-400">
                                <Info className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                                <span>Integrates with standard scraper API</span>
                              </div>
                              <button
                                onClick={() => handleTriggerSync(source.id)}
                                disabled={syncingSourceId !== null}
                                className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:opacity-50 text-white font-bold rounded-lg text-[10px] flex items-center gap-1.5 cursor-pointer transition-colors"
                              >
                                <RefreshCw className={`h-3 w-3 ${syncingSourceId === source.id ? 'animate-spin' : ''}`} />
                                <span>{syncingSourceId === source.id ? 'Syncing...' : 'Sync Now'}</span>
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* SUB-TAB 2: REVIEW QUEUE */}
                {supplierSubTab === 'review' && (
                  <div className="space-y-6">
                    {/* Header Card */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900/20 p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40">
                      <div>
                        <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Review Queue</h3>
                        <p className="text-[11px] text-slate-400">Human-in-the-loop validation of newly identified items from distributor feeds before live catalog mapping.</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-blue-500 font-bold bg-blue-500/10 px-2.5 py-1 rounded-lg border border-blue-500/20 font-mono">
                          {supplierReviewQueue.length} Total Logs
                        </span>
                        <span className="text-[10px] text-amber-500 font-bold bg-amber-500/10 px-2.5 py-1 rounded-lg border border-amber-500/20 font-mono">
                          {supplierReviewQueue.filter(x => x.status === 'Pending').length} Pending
                        </span>
                      </div>
                    </div>

                    {/* Filter and Search Bar */}
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      {/* Sub-tabs for filters */}
                      <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 dark:bg-[#111928] p-1.5 rounded-2xl border border-slate-200/50 dark:border-slate-800/60 w-fit">
                        {(['All', 'Pending', 'Approved', 'Rejected'] as const).map((tab) => {
                          const count = tab === 'All' 
                            ? supplierReviewQueue.length 
                            : supplierReviewQueue.filter(x => x.status === tab).length;
                          return (
                            <button
                              key={tab}
                              onClick={() => setReviewFilter(tab)}
                              className={`px-4 py-1.5 text-xs font-bold rounded-xl transition-all flex items-center gap-2 cursor-pointer ${
                                reviewFilter === tab
                                  ? 'bg-blue-600 text-white shadow-md shadow-blue-500/10'
                                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                              }`}
                            >
                              <span>{tab}</span>
                              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md ${
                                reviewFilter === tab
                                  ? 'bg-white/20 text-white'
                                  : 'bg-slate-200 dark:bg-slate-800 text-slate-500'
                              }`}>{count}</span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Search field */}
                      <div className="relative flex-1 max-w-md w-full">
                        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                        <input
                          type="text"
                          placeholder="Search by Product Name or Supplier Code..."
                          value={reviewSearch}
                          onChange={(e) => setReviewSearch(e.target.value)}
                          className="w-full pl-10 pr-10 py-2.5 text-xs bg-slate-100 dark:bg-[#111928] text-slate-900 dark:text-white border border-slate-200/50 dark:border-slate-800/60 rounded-2xl focus:outline-hidden focus:border-blue-500/50"
                        />
                        {reviewSearch && (
                          <button
                            onClick={() => setReviewSearch('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Review Queue Items */}
                    {isReviewQueueLoading ? (
                      /* Skeletons */
                      <div className="space-y-4">
                        {[1, 2, 3].map((idx) => (
                          <div
                            key={idx}
                            className="p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40 bg-slate-50/50 dark:bg-slate-900/10 animate-pulse flex flex-col md:flex-row items-start md:items-center justify-between gap-6"
                          >
                            <div className="flex items-start gap-4 flex-1 w-full">
                              <div className="h-16 w-16 bg-slate-200 dark:bg-slate-800 rounded-xl shrink-0 animate-pulse" />
                              <div className="space-y-2 flex-1">
                                <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded-md w-2/3 animate-pulse" />
                                <div className="h-3 bg-slate-200 dark:bg-slate-800 rounded-md w-1/3 animate-pulse" />
                                <div className="h-8 bg-slate-200 dark:bg-slate-800 rounded-md w-full animate-pulse" />
                              </div>
                            </div>
                            <div className="flex items-center gap-3 shrink-0 w-full md:w-auto">
                              <div className="h-10 bg-slate-200 dark:bg-slate-800 rounded-xl w-24 animate-pulse" />
                              <div className="h-10 bg-slate-200 dark:bg-slate-800 rounded-xl w-24 animate-pulse" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : supplierReviewQueue.length === 0 ? (
                      <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                        <UserCheck className="h-10 w-10 text-slate-300 mx-auto" />
                        <div className="space-y-1">
                          <p className="text-sm font-bold text-slate-900 dark:text-white">No data available.</p>
                        </div>
                      </div>
                    ) : supplierReviewQueue.filter(item => {
                      if (reviewFilter !== 'All' && item.status !== reviewFilter) return false;
                      if (reviewSearch.trim()) {
                        const q = reviewSearch.toLowerCase();
                        const pName = (item.productName || '').toLowerCase();
                        const sCode = (item.supplierCode || '').toLowerCase();
                        if (!pName.includes(q) && !sCode.includes(q)) return false;
                      }
                      return true;
                    }).length === 0 ? (
                      <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                        <UserCheck className="h-10 w-10 text-slate-300 mx-auto" />
                        <div className="space-y-1">
                          <p className="text-sm font-bold text-slate-900 dark:text-white">No matches found</p>
                          <p className="text-xs text-slate-400">
                            No review queue records match your search criteria.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {supplierReviewQueue
                          .filter(item => {
                            if (reviewFilter !== 'All' && item.status !== reviewFilter) return false;
                            if (reviewSearch.trim()) {
                              const q = reviewSearch.toLowerCase();
                              const pName = (item.productName || '').toLowerCase();
                              const sCode = (item.supplierCode || '').toLowerCase();
                              if (!pName.includes(q) && !sCode.includes(q)) return false;
                            }
                            return true;
                          })
                          .map((item) => {
                            // Determine Source badge
                            const isWhatsApp = item.source === 'WhatsApp';
                            const sourceBadge = isWhatsApp ? (
                              <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-500 text-[9px] font-mono font-bold uppercase border border-emerald-500/20 flex items-center gap-1">
                                <MessageCircle className="h-3 w-3" /> WhatsApp
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-md bg-sky-500/10 text-sky-500 text-[9px] font-mono font-bold uppercase border border-sky-500/20 flex items-center gap-1">
                                <Globe className="h-3 w-3" /> Website
                              </span>
                            );

                            // Determine Change Type badge
                            let changeBadge = null;
                            switch (item.changeType) {
                              case 'NEW_PRODUCT':
                                changeBadge = (
                                  <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-500 text-[9px] font-bold uppercase border border-emerald-500/20 flex items-center gap-1">
                                    <Sparkles className="h-3 w-3" /> New Product
                                  </span>
                                );
                                break;
                              case 'PRICE_CHANGED':
                                changeBadge = (
                                  <span className="px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-500 text-[9px] font-bold uppercase border border-blue-500/20 flex items-center gap-1">
                                    <TrendingUp className="h-3 w-3" /> Price Changed
                                  </span>
                                );
                                break;
                              case 'STOCK_CHANGED':
                                changeBadge = (
                                  <span className="px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-500 text-[9px] font-bold uppercase border border-amber-500/20 flex items-center gap-1">
                                    <Activity className="h-3 w-3" /> Stock Changed
                                  </span>
                                );
                                break;
                              case 'IMAGE_CHANGED':
                                changeBadge = (
                                  <span className="px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-500 text-[9px] font-bold uppercase border border-purple-500/20 flex items-center gap-1">
                                    <Image className="h-3 w-3" /> Image Changed
                                  </span>
                                );
                                break;
                              case 'DESCRIPTION_CHANGED':
                                changeBadge = (
                                  <span className="px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-500 text-[9px] font-bold uppercase border border-indigo-500/20 flex items-center gap-1">
                                    <FileText className="h-3 w-3" /> Desc Changed
                                  </span>
                                );
                                break;
                            }

                            // Determine Status badge
                            const statusBadge = (
                              <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold border flex items-center gap-1 uppercase tracking-wider ${
                                item.status === 'Approved' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' :
                                item.status === 'Rejected' ? 'bg-rose-500/10 text-rose-500 border-rose-500/20' :
                                'bg-amber-500/10 text-amber-500 border-amber-500/20'
                              }`}>
                                <span className={`h-1 w-1 rounded-full ${
                                  item.status === 'Approved' ? 'bg-emerald-500' :
                                  item.status === 'Rejected' ? 'bg-rose-500' :
                                  'bg-amber-500 animate-pulse'
                                }`} />
                                {item.status}
                              </span>
                            );

                            return (
                              <div 
                                key={item.id}
                                className={`p-5 rounded-3xl border ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-xl shadow-slate-950/20' : 'bg-white border-slate-200 shadow-xs'} transition-all flex flex-col md:flex-row items-start md:items-center justify-between gap-6`}
                              >
                                <div className="flex items-start gap-4 flex-1">
                                  <div className="h-14 w-14 rounded-2xl bg-slate-100 dark:bg-slate-800/40 border border-slate-200/50 dark:border-slate-800/60 flex items-center justify-center shrink-0 overflow-hidden">
                                    {item.changeType === 'IMAGE_CHANGED' || (item.changeType === 'NEW_PRODUCT' && item.newValue.includes('http')) ? (
                                      <img 
                                        src={item.changeType === 'IMAGE_CHANGED' ? item.newValue : (item.oldValue || 'https://images.unsplash.com/photo-1546868871-7041f2a55e12?auto=format&fit=crop&w=600&q=80')} 
                                        alt="preview" 
                                        referrerPolicy="no-referrer"
                                        className="h-full w-full object-cover"
                                      />
                                    ) : (
                                      <Package className="h-6 w-6 text-slate-400" />
                                    )}
                                  </div>
                                  
                                  <div className="space-y-1.5 flex-1 text-xs">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-extrabold text-sm text-slate-900 dark:text-white leading-tight">{item.productName}</span>
                                      <span className="px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-500 text-[9px] font-mono font-bold uppercase border border-blue-500/20">{item.supplierCode}</span>
                                      {sourceBadge}
                                      {changeBadge}
                                      {statusBadge}
                                    </div>
                                    
                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-400 text-[10px] font-medium">
                                      <span>Supplier: <strong className="text-slate-600 dark:text-slate-200">{item.supplierName}</strong></span>
                                      <span className="flex items-center gap-1">
                                        <Clock className="h-3 w-3 text-slate-500" />
                                        Created: <strong className="text-slate-600 dark:text-slate-200 font-mono">{new Date(item.createdAt).toLocaleString('en-US', { hour12: true })}</strong>
                                      </span>
                                      {item.reviewedAt && (
                                        <span className="flex items-center gap-1">
                                          <ShieldCheck className="h-3 w-3 text-emerald-500" />
                                          Reviewed: <strong className="text-slate-600 dark:text-slate-200 font-mono">{new Date(item.reviewedAt).toLocaleString('en-US', { hour12: true })} by {item.reviewedBy}</strong>
                                        </span>
                                      )}
                                    </div>

                                    {/* Quick visual diff preview */}
                                    <div className="mt-2 text-[10px] bg-slate-50 dark:bg-slate-900/30 p-2.5 rounded-xl border border-slate-100 dark:border-slate-800/40 text-slate-500 dark:text-slate-400">
                                      {item.changeType === 'PRICE_CHANGED' && (
                                        <p className="flex items-center gap-2">
                                          <span>Cost update:</span>
                                          <span className="line-through text-rose-500 font-mono">{item.oldValue}</span>
                                          <ArrowRight className="h-3 w-3" />
                                          <span className="text-emerald-500 font-bold font-mono">{item.newValue}</span>
                                        </p>
                                      )}
                                      {item.changeType === 'STOCK_CHANGED' && (
                                        <p className="flex items-center gap-2">
                                          <span>Stock level:</span>
                                          <span className="text-slate-400 font-mono">{item.oldValue}</span>
                                          <ArrowRight className="h-3 w-3" />
                                          <span className="text-blue-500 font-bold font-mono">{item.newValue}</span>
                                        </p>
                                      )}
                                      {item.changeType === 'NEW_PRODUCT' && (
                                        <p className="truncate">
                                          <span>New product payload detected. Click compare to view full data structure.</span>
                                        </p>
                                      )}
                                      {item.changeType === 'IMAGE_CHANGED' && (
                                        <p className="truncate">
                                          <span>Visual asset updated. Hover or compare to verify picture.</span>
                                        </p>
                                      )}
                                      {item.changeType === 'DESCRIPTION_CHANGED' && (
                                        <p className="line-clamp-1 italic">
                                          <span>"{item.newValue}"</span>
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                {/* Action buttons */}
                                <div className="flex items-center gap-2 shrink-0 w-full md:w-auto justify-end border-t md:border-t-0 border-slate-100 dark:border-slate-800/60 pt-4 md:pt-0">
                                  <button
                                    onClick={() => setComparingItem(item)}
                                    className="px-3.5 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold rounded-xl text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer border border-slate-200/50 dark:border-slate-800/60"
                                  >
                                    <Eye className="h-4 w-4" />
                                    <span>Compare</span>
                                  </button>

                                  {item.status === 'Pending' && (
                                    <>
                                      <button
                                        onClick={() => handleRejectReview(item)}
                                        disabled={processingReviewId === item.id}
                                        className="px-3.5 py-2 hover:bg-rose-500/10 text-rose-500 font-bold rounded-xl text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer border border-rose-500/20"
                                      >
                                        <X className="h-4 w-4" />
                                        <span>Reject</span>
                                      </button>
                                      <button
                                        onClick={() => handleApproveReview(item)}
                                        disabled={processingReviewId === item.id}
                                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 text-white font-bold rounded-xl text-xs transition-colors flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 cursor-pointer"
                                      >
                                        {processingReviewId === item.id ? (
                                          <RefreshCw className="h-4 w-4 animate-spin" />
                                        ) : (
                                          <Check className="h-4 w-4" />
                                        )}
                                        <span>Approve</span>
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                )}

                {/* SUB-TAB 3: IMPORT QUEUE */}
                {supplierSubTab === 'import' && (
                  <div className="space-y-6">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Import Ingestion Monitor</h3>
                        <p className="text-[11px] text-slate-400">Real-time status tracking of automated catalog downloads, parses, and extraction jobs.</p>
                      </div>
                      <div className="flex items-center gap-2 self-end md:self-auto">
                        {(supplierImportQueue.some(i => (i.importStatus || '').toLowerCase() === 'completed' || (i.status || '').toLowerCase() === 'completed')) && (
                          <button
                            onClick={handleClearImportQueue}
                            className="px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold rounded-xl text-[10px] transition-colors border border-slate-200/50 dark:border-slate-800 cursor-pointer"
                          >
                            Clear Completed
                          </button>
                        )}
                        <button
                          onClick={handleTriggerImport}
                          disabled={processingImportId !== null}
                          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white font-bold rounded-xl text-[10px] transition-colors shadow-lg shadow-blue-500/20 flex items-center gap-1 cursor-pointer"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>Trigger Manual Import</span>
                        </button>
                      </div>
                    </div>

                    {/* Filter Tabs and Search Bar */}
                    <div className="flex flex-col md:flex-row gap-3 items-center justify-between bg-slate-50/50 dark:bg-slate-900/20 p-2.5 rounded-2xl border border-slate-100/60 dark:border-slate-800/60">
                      <div className="flex items-center gap-1 bg-white dark:bg-[#101827] p-1 rounded-xl border border-slate-200/40 dark:border-slate-800/40 w-full md:w-auto overflow-x-auto">
                        {(['All', 'Running', 'Completed', 'Failed'] as const).map((filterOpt) => (
                          <button
                            key={filterOpt}
                            onClick={() => setImportFilter(filterOpt)}
                            className={`px-3 py-1 rounded-lg text-[10px] font-bold transition-all cursor-pointer whitespace-nowrap ${
                              importFilter === filterOpt
                                ? 'bg-slate-900 text-white dark:bg-slate-800'
                                : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            {filterOpt}
                          </button>
                        ))}
                      </div>

                      <div className="relative w-full md:w-72">
                        <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
                        <input
                          type="text"
                          placeholder="Search by Code or Product..."
                          value={importSearch}
                          onChange={(e) => setImportSearch(e.target.value)}
                          className="w-full pl-9 pr-4 py-1.5 text-xs rounded-xl border border-slate-200/60 dark:border-slate-800/60 bg-white dark:bg-[#101827] focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:text-white"
                        />
                      </div>
                    </div>

                    {/* Ingestion Monitor List */}
                    <div className="space-y-4">
                      {isImportQueueLoading ? (
                        <div className="space-y-4 animate-pulse">
                          {[1, 2, 3].map((n) => (
                            <div key={n} className="p-5 rounded-3xl border border-slate-200/50 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/20 space-y-4">
                              <div className="flex justify-between items-center">
                                <div className="h-4 w-1/4 bg-slate-200 dark:bg-slate-800 rounded-lg" />
                                <div className="h-4 w-16 bg-slate-200 dark:bg-slate-800 rounded-full" />
                              </div>
                              <div className="space-y-2">
                                <div className="h-3 w-1/2 bg-slate-200 dark:bg-slate-800 rounded-lg" />
                                <div className="h-2 bg-slate-200 dark:bg-slate-800 rounded-full w-full" />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (() => {
                        if (supplierImportQueue.length === 0) {
                          return (
                            <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                              <Activity className="h-10 w-10 text-slate-300 mx-auto" />
                              <div className="space-y-1">
                                <p className="text-sm font-bold text-slate-900 dark:text-white">No data available.</p>
                              </div>
                            </div>
                          );
                        }

                        const filteredImports = supplierImportQueue.filter((job) => {
                          const matchesSearch = 
                            (job.supplierCode || '').toLowerCase().includes(importSearch.toLowerCase()) ||
                            (job.productName || '').toLowerCase().includes(importSearch.toLowerCase()) ||
                            (job.supplierName || '').toLowerCase().includes(importSearch.toLowerCase());

                          if (!matchesSearch) return false;

                          const status = (job.importStatus || job.status || '').toLowerCase();
                          if (importFilter === 'Running') {
                            return status === 'waiting' || status === 'downloading' || status === 'processing';
                          } else if (importFilter === 'Completed') {
                            return status === 'completed';
                          } else if (importFilter === 'Failed') {
                            return status === 'failed';
                          }
                          return true;
                        });

                        if (filteredImports.length === 0) {
                          return (
                            <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                              <Activity className="h-10 w-10 text-slate-300 mx-auto" />
                              <div className="space-y-1">
                                <p className="text-sm font-bold text-slate-900 dark:text-white">No matches found</p>
                                <p className="text-xs text-slate-400">Try adjusting your search criteria or start a manual synchronization run.</p>
                              </div>
                            </div>
                          );
                        }

                        return filteredImports.map((job) => {
                          const status = (job.importStatus || job.status || 'Waiting');
                          const statusLower = status.toLowerCase();
                          
                          // Determine color mappings
                          let statusPillClasses = 'bg-slate-500/10 text-slate-500 border-slate-500/20';
                          let progressBarClass = 'bg-slate-400';
                          let dotClass = 'bg-slate-400';
                          
                          if (statusLower === 'downloading') {
                            statusPillClasses = 'bg-blue-500/10 text-blue-500 border-blue-500/20';
                            progressBarClass = 'bg-blue-600';
                            dotClass = 'bg-blue-500 animate-pulse';
                          } else if (statusLower === 'processing') {
                            statusPillClasses = 'bg-orange-500/10 text-orange-500 border-orange-500/20';
                            progressBarClass = 'bg-orange-500';
                            dotClass = 'bg-orange-500 animate-pulse';
                          } else if (statusLower === 'completed') {
                            statusPillClasses = 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
                            progressBarClass = 'bg-emerald-500';
                            dotClass = 'bg-emerald-500';
                          } else if (statusLower === 'failed') {
                            statusPillClasses = 'bg-rose-500/10 text-rose-500 border-rose-500/20';
                            progressBarClass = 'bg-rose-500';
                            dotClass = 'bg-rose-500';
                          }

                          return (
                            <motion.div 
                              key={job.id}
                              whileHover={{ y: -2 }}
                              onClick={() => setViewingImportJob(job)}
                              className={`p-5 rounded-3xl border cursor-pointer transition-all space-y-4 hover:shadow-lg ${
                                isDarkMode 
                                  ? 'bg-[#101827]/75 border-slate-800/60 hover:border-slate-700/80 shadow-xl shadow-slate-950/20' 
                                  : 'bg-white border-slate-200/70 hover:border-slate-300 shadow-xs'
                              }`}
                            >
                              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-extrabold text-slate-900 dark:text-white text-sm">{job.supplierName}</span>
                                    <span className="font-mono text-[9px] font-bold text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-900 px-1.5 py-0.5 rounded-md border border-slate-200/30 dark:border-slate-800/30">{job.supplierCode || 'N/A'}</span>
                                  </div>
                                  <p className="text-slate-700 dark:text-slate-300 font-medium text-xs font-sans">{job.productName || 'No target products defined'}</p>
                                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-400 font-mono">
                                    <span>ID: {job.id}</span>
                                    <span>•</span>
                                    <span className="flex items-center gap-1">
                                      {job.source === 'Website' ? <Globe className="h-3 w-3 text-sky-400" /> : <MessageCircle className="h-3 w-3 text-emerald-400" />}
                                      <span>{job.source || 'Website'}</span>
                                    </span>
                                    <span>•</span>
                                    <span>{job.createdAt ? new Date(job.createdAt).toLocaleString() : 'N/A'}</span>
                                  </div>
                                </div>
                                
                                <span className={`px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-wider border flex items-center gap-1.5 self-start sm:self-auto ${statusPillClasses}`}>
                                  <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
                                  {status}
                                </span>
                              </div>

                              {/* Progress bar info */}
                              <div className="space-y-2">
                                <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 font-bold">
                                  <span className="font-sans">Ingestion In-Progress Stream:</span>
                                  <span>{job.downloadedImages || 0} / {job.totalImages || 0} images ({job.progress || 0}%)</span>
                                </div>
                                <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-200/20 dark:border-slate-800/20">
                                  <motion.div 
                                    initial={{ width: 0 }} 
                                    animate={{ width: `${job.progress || 0}%` }} 
                                    className={`h-full rounded-full ${progressBarClass}`} 
                                  />
                                </div>
                                <div className="flex justify-between items-center text-[10px]">
                                  <span className="text-slate-400 italic">Click card to trace job details</span>
                                  {job.errorMessage && (
                                    <span className="text-rose-500 font-bold font-mono flex items-center gap-1 bg-rose-500/5 px-2 py-0.5 rounded-md border border-rose-500/10">
                                      <AlertTriangle className="h-3 w-3" />
                                      Error logged
                                    </span>
                                  )}
                                </div>
                              </div>
                            </motion.div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}

                {/* SUB-TAB 4: PENDING CHANGES */}
                {supplierSubTab === 'changes' && (
                  <div className="space-y-6">
                    {/* Header Card */}
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
                      {/* Sub-tabs for filters */}
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

                      {/* Search field */}
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
                    {isPendingChangesLoading ? (
                      /* Skeletons */
                      <div className="space-y-4 animate-pulse">
                        {[1, 2, 3].map((n) => (
                          <div key={n} className="p-5 rounded-3xl border border-slate-200/50 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-4">
                            <div className="flex justify-between items-center">
                              <div className="h-4 w-1/4 bg-slate-200 dark:bg-slate-800 rounded-lg" />
                              <div className="h-4 w-16 bg-slate-200 dark:bg-slate-800 rounded-full" />
                            </div>
                            <div className="space-y-2">
                              <div className="h-3 w-1/2 bg-slate-200 dark:bg-slate-800 rounded-lg" />
                              <div className="h-2 bg-slate-200 dark:bg-slate-800 rounded-full w-full" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (() => {
                      if (supplierPendingChanges.length === 0) {
                        return (
                          <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                            <SlidersHorizontal className="h-10 w-10 text-slate-300 mx-auto" />
                            <div className="space-y-1">
                              <p className="text-sm font-bold text-slate-900 dark:text-white">No data available.</p>
                            </div>
                          </div>
                        );
                      }

                      const filteredChanges = supplierPendingChanges.filter((change) => {
                        const matchesSearch = 
                          (change.supplierCode || '').toLowerCase().includes(pendingChangesSearch.toLowerCase()) ||
                          (change.productName || '').toLowerCase().includes(pendingChangesSearch.toLowerCase()) ||
                          (change.supplierName || '').toLowerCase().includes(pendingChangesSearch.toLowerCase());

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
                                      <Package className="h-3 w-3" /> Stock Changed
                                    </span>
                                  )}
                                  {change.changeType === 'IMAGE_CHANGED' && (
                                    <span className="px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-500 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-indigo-500/20">
                                      <Image className="h-3 w-3" /> Image Changed
                                    </span>
                                  )}
                                  {change.changeType === 'DESCRIPTION_CHANGED' && (
                                    <span className="px-2 py-0.5 rounded-md bg-purple-500/10 text-purple-500 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border border-purple-500/20">
                                      <FileText className="h-3 w-3" /> Description Changed
                                    </span>
                                  )}
                                </div>

                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-400 text-[10px] font-medium font-mono">
                                  <span className="flex items-center gap-1">
                                    <User className="h-3.5 w-3.5" /> Supplier: {change.supplierName} ({change.supplierCode || 'N/A'})
                                  </span>
                                  <span>•</span>
                                  <span className="flex items-center gap-1">
                                    {change.source === 'Website' ? <Globe className="h-3 w-3 text-sky-500" /> : <MessageCircle className="h-3 w-3 text-emerald-500" />}
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

                {/* SUB-TAB 5: SYNC HISTORY */}
                {supplierSubTab === 'history' && (
                  <div className="space-y-6">
                    {/* Header Card */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 dark:bg-slate-900/20 p-5 rounded-3xl border border-slate-100 dark:border-slate-800/40">
                      <div>
                        <h3 className="text-sm font-extrabold text-slate-900 dark:text-white uppercase tracking-wider">Sync History</h3>
                        <p className="text-[11px] text-slate-400">Chronological list of background and manual catalog synchronization and update jobs.</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-blue-500 font-bold bg-blue-500/10 px-2.5 py-1 rounded-lg border border-blue-500/20 font-mono">
                          {supplierSyncHistory.length} Total Runs
                        </span>
                        <span className="text-[10px] text-emerald-500 font-bold bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20 font-mono">
                          {supplierSyncHistory.filter(x => x.status === 'Success').length} Success
                        </span>
                      </div>
                    </div>

                    {/* Filter and Search Bar */}
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      {/* Sub-tabs for filters */}
                      <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 dark:bg-[#111928] p-1.5 rounded-2xl border border-slate-200/50 dark:border-slate-800/60 w-fit">
                        {(['All', 'Success', 'Failed', 'Partial'] as const).map((tab) => {
                          const count = tab === 'All' 
                            ? supplierSyncHistory.length 
                            : supplierSyncHistory.filter(x => x.status === tab).length;
                          return (
                            <button
                              key={tab}
                              onClick={() => setSyncHistoryFilter(tab)}
                              className={`px-4 py-1.5 text-xs font-bold rounded-xl transition-all flex items-center gap-2 cursor-pointer ${
                                syncHistoryFilter === tab
                                  ? 'bg-blue-600 text-white shadow-md shadow-blue-500/10'
                                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                              }`}
                            >
                              <span>{tab}</span>
                              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md ${
                                syncHistoryFilter === tab
                                  ? 'bg-white/20 text-white'
                                  : 'bg-slate-200 dark:bg-slate-800 text-slate-500'
                              }`}>{count}</span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Search field */}
                      <div className="relative flex-1 max-w-md w-full">
                        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                        <input
                          type="text"
                          placeholder="Search by Source or Triggered By..."
                          value={syncHistorySearch}
                          onChange={(e) => setSyncHistorySearch(e.target.value)}
                          className="w-full pl-10 pr-10 py-2.5 text-xs bg-slate-100 dark:bg-[#111928] text-slate-900 dark:text-white border border-slate-200/50 dark:border-slate-800/60 rounded-2xl focus:outline-hidden focus:border-blue-500/50"
                        />
                        {syncHistorySearch && (
                          <button
                            onClick={() => setSyncHistorySearch('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Sync History List */}
                    {isSyncHistoryLoading ? (
                      /* Skeletons */
                      <div className="space-y-4 animate-pulse">
                        {[1, 2, 3].map((n) => (
                          <div key={n} className="p-5 rounded-3xl border border-slate-200/50 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-4">
                            <div className="flex justify-between items-center">
                              <div className="h-4 w-1/4 bg-slate-200 dark:bg-slate-800 rounded-lg" />
                              <div className="h-4 w-16 bg-slate-200 dark:bg-slate-800 rounded-full" />
                            </div>
                            <div className="space-y-2">
                              <div className="h-3 w-1/2 bg-slate-200 dark:bg-slate-800 rounded-lg" />
                              <div className="h-2 bg-slate-200 dark:bg-slate-800 rounded-full w-full" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (() => {
                      if (supplierSyncHistory.length === 0) {
                        return (
                          <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                            <History className="h-10 w-10 text-slate-300 mx-auto" />
                            <div className="space-y-1">
                              <p className="text-sm font-bold text-slate-900 dark:text-white">No data available.</p>
                            </div>
                          </div>
                        );
                      }

                      const filteredHistory = supplierSyncHistory.filter((log) => {
                        const matchesSearch = 
                          (log.source || '').toLowerCase().includes(syncHistorySearch.toLowerCase()) ||
                          (log.triggeredBy || '').toLowerCase().includes(syncHistorySearch.toLowerCase());

                        if (!matchesSearch) return false;

                        if (syncHistoryFilter !== 'All') {
                          return log.status === syncHistoryFilter;
                        }
                        return true;
                      });

                      if (filteredHistory.length === 0) {
                        return (
                          <div className="p-12 text-center rounded-3xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/10 space-y-3">
                            <History className="h-10 w-10 text-slate-300 mx-auto" />
                            <div className="space-y-1">
                              <p className="text-sm font-bold text-slate-900 dark:text-white">No matches found</p>
                              <p className="text-xs text-slate-400">Try adjusting your filters or search query.</p>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div className="space-y-4">
                          {filteredHistory.map((log) => (
                            <div 
                              key={log.id}
                              className={`p-5 rounded-3xl border ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-xl shadow-slate-950/20' : 'bg-white border-slate-200 shadow-xs'} hover:border-blue-500/50 dark:hover:border-blue-500/40 transition-all flex flex-col md:flex-row items-start md:items-center justify-between gap-6 cursor-pointer`}
                              onClick={() => setViewingSyncLog(log)}
                            >
                              <div className="space-y-2.5 flex-1 text-xs text-left">
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="flex items-center gap-1.5 font-extrabold text-sm text-slate-900 dark:text-white leading-tight">
                                    {log.source === 'Website' ? <Globe className="h-4 w-4 text-sky-500" /> : <MessageCircle className="h-4 w-4 text-emerald-500" />}
                                    <span>{log.source || 'N/A'} Feed Ingestion</span>
                                  </div>
                                  
                                  <span className={`px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider border ${
                                    log.status === 'Success'
                                      ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                                      : log.status === 'Failed'
                                      ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                                      : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                                  }`}>
                                    {log.status || 'Unknown'}
                                  </span>

                                  <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[9px] font-bold font-mono">
                                    {log.syncType}
                                  </span>
                                </div>

                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-400 text-[10px] font-medium font-mono">
                                  <span className="flex items-center gap-1">
                                    <Clock className="h-3.5 w-3.5" /> Started: {log.startedAt ? new Date(log.startedAt).toLocaleTimeString() : 'N/A'}
                                  </span>
                                  <span>•</span>
                                  <span className="flex items-center gap-1">
                                    <User className="h-3.5 w-3.5" /> Triggered By: {log.triggeredBy || 'System Job'}
                                  </span>
                                  <span>•</span>
                                  <span className="flex items-center gap-1 font-semibold text-slate-500 dark:text-slate-300">
                                    Duration: {(() => {
                                      const sec = log.duration;
                                      if (sec === undefined || sec === null) return 'N/A';
                                      const num = Number(sec);
                                      if (isNaN(num)) return String(sec);
                                      if (num < 1) return `${(num * 1000).toFixed(0)}ms`;
                                      if (num < 60) return `${num.toFixed(1)}s`;
                                      const mins = Math.floor(num / 60);
                                      const remainingSecs = num % 60;
                                      return `${mins}m ${remainingSecs.toFixed(0)}s`;
                                    })()}
                                  </span>
                                </div>

                                {/* Mini summaries counts bar */}
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1 text-[10px] font-mono text-slate-500 dark:text-slate-400">
                                  <span className="flex items-center gap-1 bg-slate-50 dark:bg-slate-900/60 px-2 py-0.5 rounded-md border border-slate-100 dark:border-slate-800/40">
                                    New: <strong className="text-blue-500">+{log.newProducts || 0}</strong>
                                  </span>
                                  <span className="flex items-center gap-1 bg-slate-50 dark:bg-slate-900/60 px-2 py-0.5 rounded-md border border-slate-100 dark:border-slate-800/40">
                                    Prices: <strong className="text-emerald-500">+{log.priceChanges || 0}</strong>
                                  </span>
                                  <span className="flex items-center gap-1 bg-slate-50 dark:bg-slate-900/60 px-2 py-0.5 rounded-md border border-slate-100 dark:border-slate-800/40">
                                    Stock: <strong className="text-amber-500">+{log.stockChanges || 0}</strong>
                                  </span>
                                  <span className="flex items-center gap-1 bg-slate-50 dark:bg-slate-900/60 px-2 py-0.5 rounded-md border border-slate-100 dark:border-slate-800/40">
                                    Images: <strong className="text-purple-500">+{log.imageChanges || 0}</strong>
                                  </span>
                                  <span className="flex items-center gap-1 bg-slate-50 dark:bg-slate-900/60 px-2 py-0.5 rounded-md border border-slate-100 dark:border-slate-800/40">
                                    Desc: <strong className="text-indigo-500">+{log.descriptionChanges || 0}</strong>
                                  </span>
                                </div>
                              </div>

                              {/* View Details button */}
                              <div className="shrink-0 w-full md:w-auto flex justify-end">
                                <button 
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setViewingSyncLog(log);
                                  }}
                                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs transition-colors cursor-pointer"
                                >
                                  View Summary
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* SUB-TAB 6: CONFIGURATION SETTINGS */}
                {supplierSubTab === 'settings' && (
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

                    {isSettingsLoading ? (
                      /* Skeletons */
                      <div className="p-6 rounded-3xl border border-slate-200/50 dark:border-slate-800/60 bg-slate-50/50 dark:bg-[#101827]/30 space-y-6 animate-pulse">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                          {[1, 2, 3, 4, 5, 6].map((i) => (
                            <div key={i} className="space-y-2">
                              <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-1/3" />
                              <div className="h-10 bg-slate-200 dark:bg-slate-800 rounded-xl w-full" />
                            </div>
                          ))}
                        </div>
                        <div className="flex justify-end gap-3 pt-4">
                          <div className="h-10 bg-slate-200 dark:bg-slate-800 rounded-xl w-28" />
                          <div className="h-10 bg-slate-200 dark:bg-slate-800 rounded-xl w-36" />
                        </div>
                      </div>
                    ) : (
                      <form onSubmit={handleSaveSupplierSettings} className="p-6 rounded-3xl border border-slate-200/50 dark:border-slate-800/60 bg-slate-50/50 dark:bg-[#101827]/30 text-xs space-y-6">
                        
                        {/* Section 1: Ingestion Channels (Website, WhatsApp, Automation) */}
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
                                  <MessageCircle className="h-4 w-4 text-emerald-500" />
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
                                  <Image className="h-4 w-4 text-purple-500" />
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

                            {/* Push Fluctuation Notifications */}
                            <div className="p-4 bg-white dark:bg-slate-900/60 border border-slate-150 dark:border-slate-800 rounded-2xl flex items-center justify-between md:col-span-2">
                              <div className="space-y-1 pr-4">
                                <div className="flex items-center gap-1.5 font-bold text-slate-900 dark:text-white text-xs">
                                  <Bell className="h-4 w-4 text-amber-500" />
                                  <span>System Notifications</span>
                                </div>
                                <p className="text-[10px] text-slate-400">Push status reports, import alerts, and large catalog fluctuation events to admin logs.</p>
                              </div>
                              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                                <input 
                                  type="checkbox" 
                                  checked={!!supplierSettings.notificationEnabled}
                                  onChange={(e) => setSupplierSettings(prev => ({ ...prev, notificationEnabled: e.target.checked }))}
                                  className="sr-only peer" 
                                />
                                <div className="w-10 h-5 bg-slate-200 dark:bg-slate-800 peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                              </label>
                            </div>

                          </div>
                        </div>

                        {/* Section 2: Ingestion Schedule & Math Parameters */}
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
                    )}
                  </div>
                )}

              </div>

            </motion.div>
          )}

          {/* AI MANAGER: READ-ONLY INTELLIGENCE FOUNDATION */}
          {activeTab === 'aiManager' && (
            <Suspense fallback={<AdminLazyPanelFallback />}>
              <AIManagerPanel
                isDarkMode={isDarkMode}
                sourceData={{
                  products,
                  categories,
                  orders,
                  customers,
                  reviews,
                  supplierSources,
                  supplierReviewQueue,
                  supplierPendingChanges,
                  supplierSyncHistory,
                  settings,
                }}
              />
            </Suspense>
          )}

          {/* SUPPLIER HUB ⭐⭐⭐⭐⭐ */}
          {activeTab === 'supplierHubFiveStars' && (
            <Suspense fallback={<AdminLazyPanelFallback />}>
              <SupplierHubFiveStars isDarkMode={isDarkMode} />
            </Suspense>
          )}

        </main>
      </div>

      {/* --- ADD/EDIT PRODUCT MODAL --- */}
      {showProductModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-3xl w-full p-6 text-left max-h-[90vh] overflow-y-auto shadow-2xl flex flex-col space-y-4">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-blue-500/10 text-blue-500 rounded-xl">
                  <Package className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold font-display text-slate-900 dark:text-white">
                    {editingProduct ? "Modify Listing Details" : "Create Stock Item Record"}
                  </h3>
                  <p className="text-[10px] text-slate-400">Ensure catalog attributes are correct and optimized</p>
                </div>
              </div>
              <button 
                onClick={() => setShowProductModal(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full cursor-pointer transition-colors"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="space-y-6 text-xs dark:text-slate-300">
              
              {/* Responsive Form Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                
                {/* Left Column: Core Fields & Pricing */}
                <div className="space-y-5">
                  
                  {/* General Info Group */}
                  <div className="space-y-3.5 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/10">
                    <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">General Information</span>
                    
                    <div className="space-y-1">
                      <label className="text-slate-400 font-bold flex items-center">
                        Product Name <span className="text-red-500 ml-0.5">*</span>
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="e.g. Sony WH-1000XM5 Headphones"
                        value={newProduct.name || ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          setNewProduct(prev => {
                            const updated = { ...prev, name: val };
                            if (!editingProduct) {
                              updated.id = generateSlug(val);
                            }
                            return updated;
                          });
                        }}
                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-slate-400 font-bold">Description</label>
                      <textarea
                        rows={3}
                        placeholder="Detailed product features, inclusions, and overview..."
                        value={newProduct.description || ""}
                        onChange={(e) => setNewProduct(prev => ({ ...prev, description: e.target.value }))}
                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs"
                      ></textarea>
                    </div>

                    <div className="space-y-1">
                      <label className="text-slate-400 font-bold flex items-center">
                        Category <span className="text-red-500 ml-0.5">*</span>
                      </label>
                      <select
                        value={newProduct.category || "electronics"}
                        onChange={(e) => setNewProduct(prev => ({ ...prev, category: e.target.value }))}
                        className="w-full px-3 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs cursor-pointer"
                      >
                        {categories.length === 0 && <option value="">No categories available</option>}
                        {categories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}{cat.isActive === false ? ' (Inactive)' : ''}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Pricing Group */}
                  <div className="space-y-3.5 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/10">
                    <div className="flex items-center justify-between">
                      <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Pricing & Discounts</span>
                      {(() => {
                        const salePriceNum = Number(newProduct.price || 0);
                        const regularPriceNum = Number(newProduct.originalPrice || 0);
                        const liveDiscount = (regularPriceNum > salePriceNum && salePriceNum > 0)
                          ? Math.round(((regularPriceNum - salePriceNum) / regularPriceNum) * 100)
                          : 0;
                        return liveDiscount > 0 ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 uppercase tracking-wider animate-pulse">
                            {liveDiscount}% OFF
                          </span>
                        ) : null;
                      })()}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold flex items-center">
                          Sale Price (LKR) <span className="text-red-500 ml-0.5">*</span>
                        </label>
                        <input
                          type="number"
                          required
                          placeholder="e.g. 118000"
                          value={newProduct.price || ""}
                          onChange={(e) => setNewProduct(prev => ({ ...prev, price: e.target.value ? Number(e.target.value) : 0 }))}
                          className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold">Regular Price (Optional)</label>
                        <input
                          type="number"
                          placeholder="e.g. 130000"
                          value={newProduct.originalPrice || ""}
                          onChange={(e) => setNewProduct(prev => ({ ...prev, originalPrice: e.target.value ? Number(e.target.value) : undefined }))}
                          className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs"
                        />
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-tight">
                      * If the Regular Price is greater than the Sale Price, a discount badge is automatically applied.
                    </p>
                  </div>

                  {/* Status & Badges Group */}
                  <div className="space-y-3.5 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/10">
                    <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Visibility & Badges</span>
                    
                    <div className="space-y-2">
                      <label className="text-slate-400 font-bold block mb-1">Active / Inactive Status</label>
                      <div className="grid grid-cols-2 gap-2.5">
                        <button
                          type="button"
                          onClick={() => setNewProduct(prev => ({ ...prev, isActive: true }))}
                          className={`p-2.5 border rounded-xl flex items-center justify-center space-x-2 transition-all font-bold cursor-pointer text-xs ${
                            newProduct.isActive !== false
                              ? 'bg-emerald-500/10 border-emerald-500 text-emerald-600 dark:text-emerald-400'
                              : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-400 hover:bg-slate-50'
                          }`}
                        >
                          <Check className="h-4 w-4" />
                          <span>Active / Published</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setNewProduct(prev => ({ ...prev, isActive: false }))}
                          className={`p-2.5 border rounded-xl flex items-center justify-center space-x-2 transition-all font-bold cursor-pointer text-xs ${
                            newProduct.isActive === false
                              ? 'bg-amber-500/10 border-amber-500 text-amber-600 dark:text-amber-400'
                              : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-400 hover:bg-slate-50'
                          }`}
                        >
                          <Power className="h-4 w-4" />
                          <span>Draft / Hidden</span>
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-slate-400 font-bold block">Promotional Flags</label>
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() => setNewProduct(prev => ({ ...prev, isFeatured: !prev.isFeatured }))}
                          className={`p-2 border rounded-xl flex flex-col items-center justify-center gap-1.5 transition-all text-[10px] font-bold cursor-pointer ${
                            newProduct.isFeatured
                              ? 'bg-blue-600/10 border-blue-500 text-blue-600 dark:text-blue-400'
                              : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-700 text-slate-400 hover:bg-slate-50'
                          }`}
                        >
                          <Star className={`h-4 w-4 ${newProduct.isFeatured ? 'fill-current' : ''}`} />
                          <span>Featured</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setNewProduct(prev => ({ ...prev, isNew: !prev.isNew }))}
                          className={`p-2 border rounded-xl flex flex-col items-center justify-center gap-1.5 transition-all text-[10px] font-bold cursor-pointer ${
                            newProduct.isNew
                              ? 'bg-purple-600/10 border-purple-500 text-purple-600 dark:text-purple-400'
                              : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-700 text-slate-400 hover:bg-slate-50'
                          }`}
                        >
                          <Sparkles className="h-4 w-4" />
                          <span>New Arrival</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setNewProduct(prev => ({ ...prev, isBestSeller: !prev.isBestSeller }))}
                          className={`p-2 border rounded-xl flex flex-col items-center justify-center gap-1.5 transition-all text-[10px] font-bold cursor-pointer ${
                            newProduct.isBestSeller
                              ? 'bg-amber-600/10 border-amber-500 text-amber-600 dark:text-amber-400'
                              : 'bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-700 text-slate-400 hover:bg-slate-50'
                          }`}
                        >
                          <Flame className="h-4 w-4" />
                          <span>Best Seller</span>
                        </button>
                      </div>
                    </div>
                  </div>

                </div>

                {/* Right Column: Identifiers, Specs & Images */}
                <div className="space-y-5">
                  
                  {/* Identifiers Group */}
                  <div className="space-y-3.5 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/10">
                    <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Inventory & Stock Tracking</span>
                    
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold flex items-center">
                          Product Slug / ID <span className="text-red-500 ml-0.5">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="prod-sony-headphones"
                          value={newProduct.id || ""}
                          onChange={(e) => setNewProduct(prev => ({ ...prev, id: generateSlug(e.target.value) }))}
                          disabled={!!editingProduct}
                          className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden disabled:opacity-50 text-xs font-mono"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold flex items-center">
                          Product SKU <span className="text-slate-400 ml-1 font-normal">(Read-Only)</span>
                        </label>
                        <input
                          type="text"
                          readOnly
                          disabled
                          placeholder="Auto-assigned on save"
                          value={newProduct.sku || ""}
                          className="w-full px-3 py-2 bg-slate-100 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-mono text-slate-500 cursor-not-allowed opacity-75"
                        />
                      </div>
                    </div>

                    {/* SKU Validation Check */}
                    <div className="mt-1 pb-1">
                      {newProduct.sku ? (
                        <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1 bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20 font-mono">
                          <Check className="h-3.5 w-3.5 shrink-0" />
                          <span>SKU: {newProduct.sku} (Guaranteed Unique)</span>
                        </span>
                      ) : (
                        <span className="text-[10px] text-blue-600 dark:text-blue-400 font-semibold flex items-center gap-1 bg-blue-500/10 p-2 rounded-lg border border-blue-500/20 font-mono">
                          <Info className="h-3.5 w-3.5 shrink-0" />
                          <span>Sequential SKU will be automatically assigned on save.</span>
                        </span>
                      )}
                    </div>

                    <div className="space-y-1">
                      <label className="text-slate-400 font-bold flex items-center">
                        Stock Quantity <span className="text-red-500 ml-0.5">*</span>
                      </label>
                      <input
                        type="number"
                        required
                        min="0"
                        step="1"
                        placeholder="15"
                        value={newProduct.stock ?? 10}
                        onChange={(e) => setNewProduct(prev => ({ ...prev, stock: Number(e.target.value) }))}
                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 text-xs"
                      />
                    </div>
                  </div>

                  {/* Corporate Group */}
                  <div className="space-y-3.5 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/10">
                    <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Corporate Record Details</span>
                    <div className="grid grid-cols-3 gap-2.5">
                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold">Supplier Code</label>
                        <input
                          type="text"
                          value={newProduct.supplierItemCode || ""}
                          onChange={(e) => setNewProduct(prev => ({ ...prev, supplierItemCode: e.target.value }))}
                          className="w-full text-xs px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold">Cost (LKR)</label>
                        <input
                          type="number"
                          value={newProduct.costPrice || ""}
                          onChange={(e) => setNewProduct(prev => ({ ...prev, costPrice: e.target.value ? Number(e.target.value) : undefined }))}
                          className="w-full text-xs px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold">Market (LKR)</label>
                        <input
                          type="number"
                          value={newProduct.marketPrice || ""}
                          onChange={(e) => setNewProduct(prev => ({ ...prev, marketPrice: e.target.value ? Number(e.target.value) : undefined }))}
                          className="w-full text-xs px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Specifications Builder Group */}
                  <div className="space-y-3.5 p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/10">
                    <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Product Specifications</span>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <input 
                          type="text" 
                          placeholder="e.g. Battery" 
                          value={specKey} 
                          onChange={(e) => setSpecKey(e.target.value)} 
                          className="w-full bg-white dark:bg-slate-900 px-2.5 py-1.5 border border-slate-200 dark:border-slate-700 rounded-xl text-xs focus:outline-hidden" 
                        />
                      </div>
                      <div className="space-y-1">
                        <input 
                          type="text" 
                          placeholder="e.g. 5000mAh" 
                          value={specVal} 
                          onChange={(e) => setSpecVal(e.target.value)} 
                          className="w-full bg-white dark:bg-slate-900 px-2.5 py-1.5 border border-slate-200 dark:border-slate-700 rounded-xl text-xs focus:outline-hidden" 
                        />
                      </div>
                    </div>
                    <button 
                      type="button" 
                      onClick={addSpecItem} 
                      className="px-3.5 py-1.5 bg-slate-900 dark:bg-slate-800 hover:bg-slate-800 text-white rounded-xl font-bold cursor-pointer transition-colors text-[10px]"
                    >
                      Add Attribute Specification
                    </button>
                    {newProduct.specs && Object.keys(newProduct.specs).length > 0 && (
                      <div className="pt-2 divide-y divide-slate-100 dark:divide-slate-800/60 text-[10px]">
                        {Object.entries(newProduct.specs).map(([k, v]) => (
                          <div key={k} className="flex justify-between items-center py-1.5">
                            <span className="font-medium text-slate-700 dark:text-slate-300">
                              {k}: <span className="text-slate-400 font-semibold">{v}</span>
                            </span>
                            <button 
                              type="button" 
                              onClick={() => removeSpecItem(k)} 
                              className="text-red-500 hover:text-red-600 font-bold hover:underline cursor-pointer"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                </div>

              </div>

              {/* Media Section: Previews and Multiple Images (Full Width Row) */}
              <div className="p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/10 space-y-4">
                <span className="block text-[9px] font-black text-blue-500 uppercase tracking-widest">Product Media Gallery</span>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  
                  {/* Primary Image Upload & Preview */}
                  <div className="space-y-3.5">
                    <label className="flex items-center font-bold text-slate-400">
                      Primary Product Image <span className="ml-0.5 text-red-500">*</span>
                    </label>

                    <div className="space-y-2">
                      <input
                        type="text"
                        placeholder="Paste image URL here..."
                        value={newProduct.imageUrl || ""}
                        onChange={(e) => setNewProduct(prev => ({ ...prev, imageUrl: e.target.value }))}
                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 text-xs"
                      />
                      <CloudinaryUpload
                        value={newProduct.imageUrl || ""}
                        onChange={(url) => setNewProduct(prev => ({ ...prev, imageUrl: url }))}
                        placeholder="Or click here to upload catalog image"
                      />
                    </div>

                    {/* Live Primary Image Preview */}
                    <div className="space-y-1">
                      <span className="text-[10px] text-slate-400 font-bold">Primary Preview:</span>
                      <div className="relative aspect-video w-full rounded-2xl overflow-hidden bg-slate-100 dark:bg-slate-900/60 border border-slate-200/50 dark:border-slate-800 flex items-center justify-center">
                        {newProduct.imageUrl ? (
                          <img 
                            src={newProduct.imageUrl} 
                            alt="Primary Listing Preview" 
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="text-center p-6 space-y-1">
                            <Image className="h-8 w-8 text-slate-300 dark:text-slate-600 mx-auto" />
                            <span className="block text-[10px] text-slate-400 font-bold">No Image Url Loaded</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Secondary Images Upload & Miniatures Row */}
                  <div className="space-y-3.5">
                    <div className="flex items-center justify-between">
                      <label className="text-slate-400 font-bold uppercase tracking-wider">Secondary Images (Multiple)</label>
                      <span className="text-[10px] text-slate-400 font-semibold">({newProduct.imageUrls?.length || 0} loaded)</span>
                    </div>

                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder="Paste secondary image URL..."
                          value={tempSecondaryImage}
                          onChange={(e) => setTempSecondaryImage(e.target.value)}
                          className="flex-1 px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (tempSecondaryImage.trim()) {
                              setNewProduct(prev => ({
                                ...prev,
                                imageUrls: [...(prev.imageUrls || []), tempSecondaryImage.trim()]
                              }));
                              setTempSecondaryImage("");
                            }
                          }}
                          className="px-4 bg-slate-900 dark:bg-slate-800 hover:bg-slate-800 text-white rounded-xl font-bold cursor-pointer transition-colors text-xs"
                        >
                          Add URL
                        </button>
                      </div>

                      <CloudinaryUpload
                        value=""
                        onChange={(url) => {
                          if (url) {
                            setNewProduct(prev => ({
                              ...prev,
                              imageUrls: [...(prev.imageUrls || []), url]
                            }));
                          }
                        }}
                        placeholder="Upload secondary additional image"
                      />
                    </div>

                    {/* Horizontal Miniatures Roll */}
                    <div className="space-y-1">
                      <span className="text-[10px] text-slate-400 font-bold">Secondary Previews:</span>
                      <div className="min-h-16 p-2 rounded-2xl bg-slate-100 dark:bg-slate-900/60 border border-slate-200/50 dark:border-slate-800 flex flex-wrap gap-2 items-center justify-start">
                        {newProduct.imageUrls && newProduct.imageUrls.length > 0 ? (
                          newProduct.imageUrls.map((url, idx) => (
                            <div key={idx} className="relative group w-14 h-14 rounded-xl overflow-hidden bg-white border border-slate-200 dark:border-slate-800 shadow-xs">
                              <img src={url} alt={`Preview index ${idx}`} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                              <button
                                type="button"
                                onClick={() => {
                                  setNewProduct(prev => ({
                                    ...prev,
                                    imageUrls: (prev.imageUrls || []).filter((_, i) => i !== idx)
                                  }));
                                }}
                                className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white cursor-pointer"
                              >
                                <Trash2 className="h-4 w-4 text-red-400" />
                              </button>
                            </div>
                          ))
                        ) : (
                          <p className="text-[10px] text-slate-400 font-medium italic px-2">No additional images loaded. Hover previews to remove.</p>
                        )}
                      </div>
                    </div>
                  </div>

                </div>
              </div>

              {/* Action Buttons */}
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row justify-end gap-3.5">
                <button 
                  type="button" 
                  onClick={() => setShowProductModal(false)}
                  className="px-4 py-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-300 font-bold rounded-xl text-xs cursor-pointer transition-colors"
                >
                  Discard Changes
                </button>
                <button 
                  type="submit" 
                  disabled={savingProduct}
                  className="flex-1 sm:flex-initial px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white font-bold rounded-xl text-xs transition-all shadow-md shadow-blue-500/20 flex items-center justify-center space-x-2 cursor-pointer"
                >
                  {savingProduct ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      <span>Saving Product...</span>
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4" />
                      <span>Save Stock Item details</span>
                    </>
                  )}
                </button>
              </div>

            </form>
          </div>
        </div>
      )}

      {/* --- ADD CATEGORY MODAL --- */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCategoryModal(); }}>
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-sm w-full p-6 text-left shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="category-modal-title">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
              <h3 id="category-modal-title" className="text-sm font-bold font-display text-slate-900 dark:text-white">{editingCategory ? 'Edit Category' : 'Create Custom Category'}</h3>
              <button type="button" onClick={closeCategoryModal} className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25 dark:bg-slate-800 dark:hover:text-white" aria-label="Close category dialog">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <form onSubmit={handleSaveCategory} className="space-y-4 text-xs dark:text-slate-300">
              {editingCategory ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800">
                  <span className="block text-[10px] font-bold uppercase text-slate-400">Permanent Category Slug / ID</span>
                  <span className="mt-1 block font-mono text-xs text-slate-700 dark:text-slate-200">{editingCategory.id}</span>
                </div>
              ) : (
              <div>
                <label htmlFor="category-slug" className="block text-slate-400 font-bold mb-1 uppercase">Category Slug / ID *</label>
                <input
                  ref={categorySlugInputRef}
                  id="category-slug"
                  type="text"
                  required
                  placeholder="e.g. smart-watches"
                  value={newCategory.id}
                  onChange={(e) => setNewCategory(prev => ({ ...prev, id: e.target.value }))}
                  className="min-h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25 dark:border-slate-700 dark:bg-slate-800"
                />
              </div>
              )}
              <div>
                <label htmlFor="category-name" className="block text-slate-400 font-bold mb-1 uppercase">Display Name *</label>
                <input
                  ref={categoryNameInputRef}
                  id="category-name"
                  type="text"
                  required
                  placeholder="e.g. Smart Watches"
                  value={newCategory.name}
                  onChange={(e) => setNewCategory(prev => ({ ...prev, name: e.target.value }))}
                  className="min-h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25 dark:border-slate-700 dark:bg-slate-800"
                />
              </div>
              <div>
                <label htmlFor="category-icon" className="block text-slate-400 font-bold mb-1 uppercase">Icon Name</label>
                <input id="category-icon" type="text" value={newCategory.icon} onChange={(e) => setNewCategory(prev => ({ ...prev, icon: e.target.value }))} className="min-h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25 dark:border-slate-700 dark:bg-slate-800" />
              </div>
              <div>
                <label htmlFor="category-image-url" className="block text-slate-400 font-bold mb-1 uppercase">Image URL</label>
                <input id="category-image-url" type="url" placeholder="https://..." value={newCategory.imageUrl} onChange={(e) => setNewCategory(prev => ({ ...prev, imageUrl: e.target.value }))} className="min-h-11 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25 dark:border-slate-700 dark:bg-slate-800" />
              </div>
              <label className="flex min-h-11 items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 dark:border-slate-700 dark:bg-slate-800">
                <span className="font-bold uppercase text-slate-400">Active on storefront</span>
                <input type="checkbox" checked={newCategory.isActive} onChange={(e) => setNewCategory(prev => ({ ...prev, isActive: e.target.checked }))} className="h-4 w-4 accent-blue-600" />
              </label>
              <button type="submit" disabled={savingCategory} className="min-h-11 w-full rounded-xl bg-blue-600 py-2.5 font-bold text-white transition-all hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/30 disabled:cursor-wait disabled:opacity-60">
                {savingCategory ? 'Saving...' : editingCategory ? 'Update Category' : 'Save Category'}
              </button>
            </form>
          </div>
        </div>
      )}

      {categoryToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs" role="presentation">
          <div className="w-full max-w-sm rounded-3xl border border-slate-200/50 bg-white p-6 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928]" role="alertdialog" aria-modal="true" aria-labelledby="delete-category-title" aria-describedby="delete-category-description">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-500"><Trash2 className="h-5 w-5" aria-hidden="true" /></div>
            <h3 id="delete-category-title" className="mt-4 text-base font-bold text-slate-900 dark:text-white">Delete {categoryToDelete.name}?</h3>
            <p id="delete-category-description" className="mt-2 text-xs leading-relaxed text-slate-500">This empty category will be permanently deleted. Product data will not be changed.</p>
            <div className="mt-6 flex justify-end gap-3">
              <button ref={categoryDeleteCancelRef} type="button" onClick={closeCategoryDeleteConfirmation} className="min-h-11 rounded-xl border border-slate-200 px-4 text-xs font-bold text-slate-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-400/25 dark:border-slate-700 dark:text-slate-200">Cancel</button>
              <button type="button" onClick={confirmDeleteCategory} disabled={savingCategory} className="min-h-11 rounded-xl bg-red-600 px-4 text-xs font-bold text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/30 disabled:cursor-wait disabled:opacity-60">{savingCategory ? 'Deleting...' : 'Delete Category'}</button>
            </div>
          </div>
        </div>
      )}

      {/* --- SUPPLIER SYNC COMPARE MODAL --- */}
      {comparingItem && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-lg w-full p-6 text-left shadow-2xl relative flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="text-sm font-bold font-display text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                  <span>Compare Feed Item</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-500 border border-blue-500/20">
                    {comparingItem.changeType}
                  </span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">Supplier: {comparingItem.supplierName} ({comparingItem.supplierCode})</p>
              </div>
              <button 
                onClick={() => setComparingItem(null)} 
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="mt-4 space-y-4 overflow-y-auto pr-1 flex-1 text-xs text-slate-700 dark:text-slate-300">
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Product Name</span>
                <p className="text-sm font-extrabold text-slate-900 dark:text-white">{comparingItem.productName}</p>
              </div>

              {/* Conditional render based on Change Type */}
              {comparingItem.changeType === 'PRICE_CHANGED' && (
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div className="bg-rose-500/5 p-4 rounded-2xl border border-rose-500/10 text-center">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block mb-1">Previous Cost</span>
                    <span className="text-lg font-black font-mono text-rose-500 line-through">{comparingItem.oldValue}</span>
                  </div>
                  <div className="bg-emerald-500/5 p-4 rounded-2xl border border-emerald-500/10 text-center">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block mb-1">Proposed Cost</span>
                    <span className="text-lg font-black font-mono text-emerald-500">{comparingItem.newValue}</span>
                  </div>
                </div>
              )}

              {comparingItem.changeType === 'STOCK_CHANGED' && (
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div className="bg-slate-100 dark:bg-slate-900/60 p-4 rounded-2xl text-center border border-slate-200/40 dark:border-slate-800/40">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block mb-1">Old Stock Level</span>
                    <span className="text-lg font-black font-mono text-slate-500">{comparingItem.oldValue}</span>
                  </div>
                  <div className="bg-blue-500/5 p-4 rounded-2xl border border-blue-500/10 text-center">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block mb-1">New Stock Level</span>
                    <span className="text-lg font-black font-mono text-blue-500">{comparingItem.newValue}</span>
                  </div>
                </div>
              )}

              {comparingItem.changeType === 'IMAGE_CHANGED' && (
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div className="space-y-2 text-center">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block">Before</span>
                    <div className="h-40 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-100 dark:bg-slate-950/40 flex items-center justify-center p-2">
                      {comparingItem.oldValue ? (
                        <img src={comparingItem.oldValue} alt="Before" className="max-h-full max-w-full object-contain" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="text-slate-400 text-[10px]">No Image</span>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2 text-center">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block">After</span>
                    <div className="h-40 rounded-2xl border border-emerald-500/20 overflow-hidden bg-emerald-500/5 flex items-center justify-center p-2">
                      {comparingItem.newValue ? (
                        <img src={comparingItem.newValue} alt="After" className="max-h-full max-w-full object-contain" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="text-slate-400 text-[10px]">No Image</span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {comparingItem.changeType === 'DESCRIPTION_CHANGED' && (
                <div className="space-y-3 pt-2">
                  <div className="p-3.5 rounded-2xl bg-rose-500/5 border border-rose-500/10 text-left">
                    <span className="text-[10px] font-bold uppercase text-rose-500 block mb-1">Previous Description</span>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed font-sans">{comparingItem.oldValue || "(None)"}</p>
                  </div>
                  <div className="p-3.5 rounded-2xl bg-emerald-500/5 border border-emerald-500/10 text-left">
                    <span className="text-[10px] font-bold uppercase text-emerald-500 block mb-1">New Description</span>
                    <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed font-sans">{comparingItem.newValue}</p>
                  </div>
                </div>
              )}

              {comparingItem.changeType === 'NEW_PRODUCT' && (
                <div className="space-y-3 pt-2">
                  <span className="text-slate-400 text-[10px] uppercase font-bold block">New Product Data Payload</span>
                  <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-left font-mono text-[10px] overflow-x-auto space-y-1.5 max-h-[220px]">
                    {(() => {
                      try {
                        const parsed = JSON.parse(comparingItem.newValue);
                        return Object.entries(parsed).map(([key, val]) => (
                          <div key={key} className="flex justify-between gap-4 border-b border-slate-100/30 dark:border-slate-800/30 pb-1 last:border-0 last:pb-0">
                            <span className="text-slate-400 font-bold uppercase">{key}:</span>
                            <span className="text-slate-900 dark:text-slate-100 font-bold truncate max-w-[200px]">{String(val)}</span>
                          </div>
                        ));
                      } catch {
                        return <p className="whitespace-pre-wrap break-all text-slate-500">{comparingItem.newValue}</p>;
                      }
                    })()}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <span className="text-[10px] text-slate-400 font-medium">
                Created: {new Date(comparingItem.createdAt).toLocaleDateString()}
              </span>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setComparingItem(null)}
                  className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs transition-colors cursor-pointer"
                >
                  Close
                </button>

                {comparingItem.status === 'Pending' ? (
                  <>
                    <button
                      onClick={async () => {
                        await handleRejectReview(comparingItem);
                        setComparingItem(null);
                      }}
                      disabled={processingReviewId === comparingItem.id}
                      className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
                    >
                      Reject
                    </button>
                    <button
                      onClick={async () => {
                        await handleApproveReview(comparingItem);
                        setComparingItem(null);
                      }}
                      disabled={processingReviewId === comparingItem.id}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
                    >
                      Approve
                    </button>
                  </>
                ) : (
                  <span className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${
                    comparingItem.status === 'Approved' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                  }`}>
                    {comparingItem.status}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- IMPORT JOB DETAILS MODAL --- */}
      {viewingImportJob && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-lg w-full p-6 text-left shadow-2xl relative flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="text-sm font-bold font-display text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                  <span>Import Job Details</span>
                  <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                    (viewingImportJob.importStatus || viewingImportJob.status || '').toLowerCase() === 'completed'
                      ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                      : (viewingImportJob.importStatus || viewingImportJob.status || '').toLowerCase() === 'failed'
                      ? 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                      : 'bg-blue-500/10 text-blue-500 border-blue-500/20'
                  }`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${
                      (viewingImportJob.importStatus || viewingImportJob.status || '').toLowerCase() === 'completed'
                        ? 'bg-emerald-500'
                        : (viewingImportJob.importStatus || viewingImportJob.status || '').toLowerCase() === 'failed'
                        ? 'bg-rose-500'
                        : 'bg-blue-500 animate-pulse'
                    }`} />
                    {viewingImportJob.importStatus || viewingImportJob.status || 'Waiting'}
                  </span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5 font-mono">Job ID: {viewingImportJob.id}</p>
              </div>
              <button 
                onClick={() => setViewingImportJob(null)} 
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full cursor-pointer transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="mt-4 space-y-4 overflow-y-auto pr-1 flex-1 text-xs text-slate-700 dark:text-slate-300">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-sans">Supplier Code</span>
                  <p className="text-xs font-mono font-bold text-slate-900 dark:text-white">{viewingImportJob.supplierCode || 'N/A'}</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-sans">Supplier Name</span>
                  <p className="text-xs font-bold text-slate-900 dark:text-white">{viewingImportJob.supplierName}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1 col-span-2">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-sans">Product Name / Job Target</span>
                  <p className="text-xs font-bold text-slate-900 dark:text-white">{viewingImportJob.productName || 'N/A'}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-sans">Source Channel</span>
                  <p className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                    {viewingImportJob.source === 'Website' ? <Globe className="h-3.5 w-3.5 text-sky-500" /> : <MessageCircle className="h-3.5 w-3.5 text-emerald-500" />}
                    <span>{viewingImportJob.source || 'Website'}</span>
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-sans">Current Stage</span>
                  <p className="text-xs font-bold text-slate-900 dark:text-white">{viewingImportJob.importStatus || viewingImportJob.status || 'Waiting'}</p>
                </div>
              </div>

              {/* Progress and Images */}
              <div className="space-y-2 bg-slate-50 dark:bg-slate-900/40 p-4 rounded-2xl border border-slate-100 dark:border-slate-800">
                <div className="flex items-center justify-between text-[10px] font-bold text-slate-400 font-mono">
                  <span>Progress Stage ({viewingImportJob.progress || 0}%):</span>
                  <span>
                    {viewingImportJob.downloadedImages || 0} / {viewingImportJob.totalImages || 0} images processed
                  </span>
                </div>
                <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-2 overflow-hidden">
                  <div 
                    className={`h-full rounded-full transition-all duration-500 ${
                      (viewingImportJob.importStatus || '').toLowerCase() === 'completed' || (viewingImportJob.status || '').toLowerCase() === 'completed'
                        ? 'bg-emerald-500'
                        : (viewingImportJob.importStatus || '').toLowerCase() === 'failed' || (viewingImportJob.status || '').toLowerCase() === 'failed'
                        ? 'bg-rose-500'
                        : (viewingImportJob.importStatus || '').toLowerCase() === 'processing'
                        ? 'bg-orange-500'
                        : 'bg-blue-600'
                    }`} 
                    style={{ width: `${viewingImportJob.progress || 0}%` }}
                  />
                </div>
              </div>

              {/* Error Box */}
              {viewingImportJob.errorMessage && (
                <div className="bg-rose-500/5 border border-rose-500/15 p-4 rounded-2xl space-y-1 text-xs">
                  <span className="text-[10px] font-bold text-rose-500 uppercase tracking-wider flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>Fatal Error Encountered</span>
                  </span>
                  <p className="text-rose-600 dark:text-rose-400 font-medium leading-relaxed font-mono text-[11px]">{viewingImportJob.errorMessage}</p>
                </div>
              )}

              {/* Timeline */}
              <div className="space-y-2 pt-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider font-sans">Job Timeline & Traces</span>
                <div className="space-y-3 pl-2 border-l-2 border-slate-100 dark:border-slate-800 ml-1">
                  <div className="relative">
                    <span className="absolute -left-[13px] top-1 h-2 w-2 rounded-full bg-blue-500" />
                    <div className="pl-3 text-[11px]">
                      <p className="font-extrabold text-slate-900 dark:text-white font-sans">Created / Queued</p>
                      <p className="text-slate-400 font-mono mt-0.5">
                        {viewingImportJob.createdAt ? new Date(viewingImportJob.createdAt).toLocaleString() : 'N/A'}
                      </p>
                    </div>
                  </div>
                  <div className="relative">
                    <span className={`absolute -left-[13px] top-1 h-2 w-2 rounded-full ${
                      viewingImportJob.completedAt ? 'bg-emerald-500' : 'bg-slate-300 animate-pulse'
                    }`} />
                    <div className="pl-3 text-[11px]">
                      <p className="font-extrabold text-slate-900 dark:text-white font-sans">Ingestion Completed</p>
                      <p className="text-slate-400 font-mono mt-0.5">
                        {viewingImportJob.completedAt ? new Date(viewingImportJob.completedAt).toLocaleString() : 'Processing Stream...'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer buttons */}
            <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-100 dark:border-slate-800 mt-4">
              <button
                onClick={() => setViewingImportJob(null)}
                className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                Close Trace
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- SUPPLIER PENDING CHANGE COMPARE MODAL --- */}
      {comparingChange && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-lg w-full p-6 text-left shadow-2xl relative flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="text-sm font-bold font-display text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                  <span>Compare Pending Change</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-blue-600/10 text-blue-600 dark:text-blue-400 border border-blue-600/20">
                    {comparingChange.changeType}
                  </span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">Supplier: {comparingChange.supplierName} ({comparingChange.supplierCode || 'N/A'}) • Source: {comparingChange.source}</p>
              </div>
              <button 
                onClick={() => setComparingChange(null)} 
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full cursor-pointer transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="mt-4 space-y-4 overflow-y-auto pr-1 flex-1 text-xs text-slate-700 dark:text-slate-300">
              <div className="space-y-1">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Product Name</span>
                <p className="text-sm font-extrabold text-slate-900 dark:text-white">{comparingChange.productName}</p>
              </div>

              {/* Conditional render based on Change Type */}
              {comparingChange.changeType === 'PRICE_CHANGED' && (
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div className="bg-rose-500/5 p-4 rounded-2xl border border-rose-500/10 text-center">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block mb-1">Previous Value</span>
                    <span className="text-sm font-black font-mono text-rose-500 line-through">{comparingChange.oldValue}</span>
                  </div>
                  <div className="bg-emerald-500/5 p-4 rounded-2xl border border-emerald-500/10 text-center">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block mb-1">New Value</span>
                    <span className="text-sm font-black font-mono text-emerald-500">{comparingChange.newValue}</span>
                  </div>
                </div>
              )}

              {comparingChange.changeType === 'STOCK_CHANGED' && (
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div className="bg-slate-100 dark:bg-slate-900/60 p-4 rounded-2xl text-center border border-slate-200/40 dark:border-slate-800/40">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block mb-1">Previous Level</span>
                    <span className="text-sm font-black font-mono text-slate-500">{comparingChange.oldValue}</span>
                  </div>
                  <div className="bg-blue-600/5 p-4 rounded-2xl border border-blue-600/10 text-center">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block mb-1">New Level</span>
                    <span className="text-sm font-black font-mono text-blue-600 dark:text-blue-400">{comparingChange.newValue}</span>
                  </div>
                </div>
              )}

              {comparingChange.changeType === 'IMAGE_CHANGED' && (
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div className="space-y-2 text-center">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block">Previous Image</span>
                    <div className="h-40 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-100 dark:bg-slate-950/40 flex items-center justify-center p-2">
                      {comparingChange.oldValue ? (
                        <img src={comparingChange.oldValue} alt="Before" className="max-h-full max-w-full object-contain" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="text-slate-400 text-[10px]">No Image</span>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2 text-center">
                    <span className="text-slate-400 text-[10px] uppercase font-bold block">New Image</span>
                    <div className="h-40 rounded-2xl border border-emerald-500/20 overflow-hidden bg-emerald-500/5 flex items-center justify-center p-2">
                      {comparingChange.newValue ? (
                        <img src={comparingChange.newValue} alt="After" className="max-h-full max-w-full object-contain" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="text-slate-400 text-[10px]">No Image</span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {comparingChange.changeType === 'DESCRIPTION_CHANGED' && (
                <div className="space-y-3 pt-2">
                  <div className="p-3.5 rounded-2xl bg-rose-500/5 border border-rose-500/10 text-left">
                    <span className="text-[10px] font-bold uppercase text-rose-500 block mb-1">Previous Description</span>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed font-sans whitespace-pre-wrap">{comparingChange.oldValue || "(None)"}</p>
                  </div>
                  <div className="p-3.5 rounded-2xl bg-emerald-500/5 border border-emerald-500/10 text-left">
                    <span className="text-[10px] font-bold uppercase text-emerald-500 block mb-1">New Description</span>
                    <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed font-sans whitespace-pre-wrap">{comparingChange.newValue}</p>
                  </div>
                </div>
              )}

              {/* Display reviewed details if approved or rejected */}
              {comparingChange.status !== 'Pending' && (
                <div className="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-left space-y-1 mt-4">
                  <span className="text-[10px] font-bold uppercase text-slate-400 block">Review Metadata</span>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <span className="text-slate-400">Reviewed By:</span>
                      <p className="font-bold text-slate-800 dark:text-slate-200">{comparingChange.reviewedBy || 'N/A'}</p>
                    </div>
                    <div>
                      <span className="text-slate-400">Reviewed At:</span>
                      <p className="font-bold text-slate-800 dark:text-slate-200">
                        {comparingChange.reviewedAt ? new Date(comparingChange.reviewedAt).toLocaleString() : 'N/A'}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <span className="text-[10px] text-slate-400 font-medium font-mono">
                Detected: {comparingChange.detectedAt ? new Date(comparingChange.detectedAt).toLocaleString() : 'N/A'}
              </span>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setComparingChange(null)}
                  className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs transition-colors cursor-pointer"
                >
                  Close
                </button>

                {comparingChange.status === 'Pending' ? (
                  <>
                    <button
                      onClick={async () => {
                        await handleRejectPendingChange(comparingChange);
                        setComparingChange(null);
                      }}
                      disabled={processingChangeId === comparingChange.id}
                      className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer flex items-center gap-1"
                    >
                      {processingChangeId === comparingChange.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
                      Reject
                    </button>
                    <button
                      onClick={async () => {
                        await handleApprovePendingChange(comparingChange);
                        setComparingChange(null);
                      }}
                      disabled={processingChangeId === comparingChange.id}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer flex items-center gap-1"
                    >
                      {processingChangeId === comparingChange.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
                      Approve
                    </button>
                  </>
                ) : (
                  <span className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${
                    comparingChange.status === 'Approved' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                  }`}>
                    {comparingChange.status}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- SYNC RUN HISTORY DETAILS MODAL --- */}
      {viewingSyncLog && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-lg w-full p-6 text-left shadow-2xl relative flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h3 className="text-sm font-bold font-display text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                  <span>Sync Run Details</span>
                  <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider border flex items-center gap-1 ${
                    viewingSyncLog.status === 'Success'
                      ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                      : viewingSyncLog.status === 'Failed'
                      ? 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                      : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                  }`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${
                      viewingSyncLog.status === 'Success'
                        ? 'bg-emerald-500'
                        : viewingSyncLog.status === 'Failed'
                        ? 'bg-rose-500'
                        : 'bg-amber-500'
                    }`} />
                    {viewingSyncLog.status}
                  </span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">ID: {viewingSyncLog.id} • Run Ingest Record</p>
              </div>
              <button 
                onClick={() => setViewingSyncLog(null)} 
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full cursor-pointer transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="mt-4 space-y-4 overflow-y-auto pr-1 flex-1 text-xs text-slate-700 dark:text-slate-300 text-left">
              
              {/* Grid metadata */}
              <div className="grid grid-cols-2 gap-4 bg-slate-50 dark:bg-slate-900/40 p-4 rounded-2xl border border-slate-100 dark:border-slate-800/40">
                <div className="space-y-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400 block">Feed Source</span>
                  <div className="flex items-center gap-1.5 text-slate-900 dark:text-white font-bold">
                    {viewingSyncLog.source === 'Website' ? <Globe className="h-3.5 w-3.5 text-sky-500" /> : <MessageCircle className="h-3.5 w-3.5 text-emerald-500" />}
                    <span>{viewingSyncLog.source}</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400 block">Sync Type</span>
                  <div className="flex items-center gap-1.5 text-slate-900 dark:text-white font-bold">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-blue-500" />
                    <span>{viewingSyncLog.syncType}</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400 block">Triggered By</span>
                  <div className="flex items-center gap-1.5 text-slate-900 dark:text-white font-bold">
                    <User className="h-3.5 w-3.5 text-purple-500" />
                    <span>{viewingSyncLog.triggeredBy || 'System Job'}</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400 block">Execution Duration</span>
                  <div className="flex items-center gap-1.5 text-slate-900 dark:text-white font-bold font-mono">
                    <Clock className="h-3.5 w-3.5 text-amber-500" />
                    <span>
                      {(() => {
                        const sec = viewingSyncLog.duration;
                        if (sec === undefined || sec === null) return 'N/A';
                        const num = Number(sec);
                        if (isNaN(num)) return String(sec);
                        if (num < 1) return `${(num * 1000).toFixed(0)}ms`;
                        if (num < 60) return `${num.toFixed(1)}s`;
                        const mins = Math.floor(num / 60);
                        const remainingSecs = num % 60;
                        return `${mins}m ${remainingSecs.toFixed(0)}s`;
                      })()}
                    </span>
                  </div>
                </div>
              </div>

              {/* Counts Bento Area */}
              <div className="space-y-2">
                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Synchronization Summary Counts</span>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                  <div className="p-3 bg-blue-500/5 rounded-2xl border border-blue-500/10 text-center space-y-0.5">
                    <span className="text-[9px] font-bold text-slate-400 uppercase block">New Products</span>
                    <span className="text-sm font-black font-mono text-blue-500">+{viewingSyncLog.newProducts || 0}</span>
                  </div>
                  <div className="p-3 bg-emerald-500/5 rounded-2xl border border-emerald-500/10 text-center space-y-0.5">
                    <span className="text-[9px] font-bold text-slate-400 uppercase block">Price Changes</span>
                    <span className="text-sm font-black font-mono text-emerald-500">+{viewingSyncLog.priceChanges || 0}</span>
                  </div>
                  <div className="p-3 bg-amber-500/5 rounded-2xl border border-amber-500/10 text-center space-y-0.5">
                    <span className="text-[9px] font-bold text-slate-400 uppercase block">Stock Changes</span>
                    <span className="text-sm font-black font-mono text-amber-500">+{viewingSyncLog.stockChanges || 0}</span>
                  </div>
                  <div className="p-3 bg-purple-500/5 rounded-2xl border border-purple-500/10 text-center space-y-0.5">
                    <span className="text-[9px] font-bold text-slate-400 uppercase block">Image Changes</span>
                    <span className="text-sm font-black font-mono text-purple-500">+{viewingSyncLog.imageChanges || 0}</span>
                  </div>
                  <div className="p-3 bg-indigo-500/5 rounded-2xl border border-indigo-500/10 text-center space-y-0.5 col-span-2 sm:col-span-1">
                    <span className="text-[9px] font-bold text-slate-400 uppercase block">Desc. Changes</span>
                    <span className="text-sm font-black font-mono text-indigo-500">+{viewingSyncLog.descriptionChanges || 0}</span>
                  </div>
                </div>
              </div>

              {/* Error block if any */}
              {viewingSyncLog.errorMessage && (
                <div className="p-3.5 rounded-2xl bg-rose-500/5 border border-rose-500/10 text-left space-y-1.5">
                  <div className="flex items-center gap-1.5 text-rose-500 font-bold">
                    <AlertTriangle className="h-4 w-4" />
                    <span>Sync Error Message</span>
                  </div>
                  <p className="font-mono text-[11px] text-rose-600 dark:text-rose-400 whitespace-pre-wrap leading-relaxed bg-[#101827]/5 dark:bg-[#101827]/50 p-2.5 rounded-xl border border-rose-500/10">
                    {viewingSyncLog.errorMessage}
                  </p>
                </div>
              )}

              {/* Execution Timeline */}
              <div className="space-y-2">
                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Execution Timeline</span>
                <div className="relative border-l border-slate-200 dark:border-slate-800 pl-4 ml-2.5 space-y-4">
                  {/* Item 1: Start */}
                  <div className="relative">
                    <div className="absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full bg-blue-500 border-2 border-white dark:border-[#111928]" />
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Start Ingestion Stream</span>
                    <p className="font-mono text-[11px] text-slate-800 dark:text-slate-200">
                      {viewingSyncLog.startedAt ? new Date(viewingSyncLog.startedAt).toLocaleString() : 'N/A'}
                    </p>
                  </div>
                  {/* Item 2: Completed */}
                  <div className="relative">
                    <div className={`absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-[#111928] ${
                      viewingSyncLog.status === 'Success' ? 'bg-emerald-500' : viewingSyncLog.status === 'Failed' ? 'bg-rose-500' : 'bg-amber-500'
                    }`} />
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Pipeline Completed</span>
                    <p className="font-mono text-[11px] text-slate-800 dark:text-slate-200">
                      {viewingSyncLog.completedAt ? new Date(viewingSyncLog.completedAt).toLocaleString() : 'N/A'}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end">
              <button
                onClick={() => setViewingSyncLog(null)}
                className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                Close Summary
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- RESET CONFIGURATION CONFIRMATION DIALOG --- */}
      {showResetSettingsConfirm && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-100 dark:border-slate-800 rounded-3xl max-w-sm w-full p-6 text-left shadow-2xl space-y-6">
            <div className="mx-auto w-12 h-12 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center border border-amber-100 dark:bg-amber-500/10 dark:text-amber-500 dark:border-amber-500/20">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div className="text-center space-y-2">
              <h3 className="font-bold text-slate-900 dark:text-white">Reset Hub Settings?</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Are you sure you want to reset all Supplier Hub configuration values to system defaults? This will restore standard margins, markup, limits, and disable third-party channel syncs.
              </p>
            </div>
            <div className="flex gap-3">
              <button 
                onClick={() => setShowResetSettingsConfirm(false)} 
                className="flex-1 py-2.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-xl cursor-pointer"
              >
                Cancel
              </button>
              <button 
                onClick={handleResetSupplierSettings} 
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl cursor-pointer"
              >
                Reset Defaults
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- DELETE CONFIRMATION MODAL --- */}
      {productToDelete && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-100 dark:border-slate-800 rounded-3xl max-w-sm w-full p-6 text-left shadow-2xl space-y-6">
            <div className="mx-auto w-12 h-12 bg-red-50 text-red-600 rounded-2xl flex items-center justify-center border border-red-100 dark:bg-red-500/10 dark:text-red-500 dark:border-red-500/20">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div className="text-center space-y-2">
              <h3 className="font-bold text-slate-900 dark:text-white">Delete stock product?</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                Are you sure you want to delete <span className="font-semibold">"{productToDelete.name}"</span>? This will remove the listing and cannot be undone.
              </p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setProductToDelete(null)} className="flex-1 py-2.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-xl cursor-pointer">Cancel</button>
              <button onClick={confirmDeleteProduct} className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-xl cursor-pointer">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* --- TOASTS NOTIFICATIONS --- */}
      <div className="fixed top-6 right-6 z-[100] space-y-3 max-w-sm w-full pointer-events-none px-4">
        {settingsToasts.map(toast => (
          <div 
            key={toast.id} 
            className={`pointer-events-auto rounded-2xl p-4 shadow-2xl border flex items-start space-x-3 transition-all animate-slideInRight ${
              toast.type === 'success' 
                ? 'bg-slate-900/95 dark:bg-[#0c1322]/95 border-emerald-500/30 text-white shadow-emerald-500/5' 
                : 'bg-slate-900/95 dark:bg-[#0c1322]/95 border-red-500/30 text-white shadow-red-500/5'
            }`}
          >
            <div className={`p-1.5 rounded-xl ${
              toast.type === 'success' ? 'bg-emerald-500/25 text-emerald-400' : 'bg-red-500/25 text-red-400'
            }`}>
              {toast.type === 'success' ? (
                <Check className="h-4.5 w-4.5" />
              ) : (
                <AlertCircle className="h-4.5 w-4.5" />
              )}
            </div>
            <div className="flex-1 text-left min-w-0">
              <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
              }`}>
                {toast.type === 'success' ? 'Success' : 'Error'}
              </span>
              <p className="text-xs font-semibold mt-1.5 break-words">{toast.message}</p>
            </div>
            <button 
              onClick={() => setSettingsToasts(prev => prev.filter(t => t.id !== toast.id))} 
              className="text-slate-400 hover:text-white shrink-0 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {toasts.map(toast => (
          <div key={toast.id} className="pointer-events-auto bg-slate-900 text-white rounded-2xl p-4 shadow-2xl border border-slate-800 flex items-start space-x-3 animate-slideInRight">
            <div className="p-1.5 bg-blue-600/25 text-blue-400 rounded-xl">
              <ShoppingBag className="h-4.5 w-4.5" />
            </div>
            <div className="flex-1 text-left">
              <div className="flex items-center justify-between">
                <span className="text-[9px] bg-blue-600 text-white px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">New Order</span>
                <span className="text-[10px] text-slate-400 font-mono">#{toast.orderNumber}</span>
              </div>
              <p className="text-xs font-bold mt-1">{toast.customerName}</p>
              <p className="text-[11px] text-blue-400 font-semibold">{formatPrice(toast.totalPrice)}</p>
            </div>
            <button onClick={() => setToasts(prev => prev.filter(t => t.id !== toast.id))} className="text-slate-400 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* --- SUPPLIER SYNC HISTORY MODAL --- */}
      {showSyncHistoryModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-2xl w-full p-6 text-left max-h-[85vh] overflow-y-auto shadow-2xl flex flex-col space-y-4">
            
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-blue-500/10 text-blue-500 rounded-xl">
                  <History className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold font-display text-slate-900 dark:text-white">Supplier Sync History</h3>
                  <p className="text-[10px] text-slate-400 font-mono">Collection: supplierSyncLogs</p>
                </div>
              </div>
              <button 
                onClick={() => setShowSyncHistoryModal(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full cursor-pointer transition-colors"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            {/* Logs List */}
            <div className="space-y-3.5 overflow-y-auto max-h-[50vh] pr-1.5">
              {syncLogs.length === 0 ? (
                <div className="py-8 text-center text-slate-400 text-xs">
                  No data available.
                </div>
              ) : (
                syncLogs.map((log) => (
                  <div 
                    key={log.id}
                    className="p-4 rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/10 text-xs space-y-2.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <span className="font-extrabold text-slate-900 dark:text-white">{log.supplierName}</span>
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                          <span className="font-mono">{log.timestamp}</span>
                          <span>•</span>
                          <span>By: {log.triggeredBy}</span>
                        </div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
                        log.status === 'success' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                      }`}>
                        {log.status}
                      </span>
                    </div>

                    {/* Stats diff row */}
                    <div className="grid grid-cols-5 gap-1.5 text-center py-2 px-1 bg-white dark:bg-slate-900/40 rounded-xl border border-slate-100 dark:border-slate-800/40 text-[10px] font-mono">
                      <div>
                        <span className="block text-slate-400 text-[8px] font-bold uppercase">New</span>
                        <span className="font-bold text-blue-500">+{log.newProducts || 0}</span>
                      </div>
                      <div>
                        <span className="block text-slate-400 text-[8px] font-bold uppercase">Prices</span>
                        <span className="font-bold text-amber-500">+{log.priceChanges || 0}</span>
                      </div>
                      <div>
                        <span className="block text-slate-400 text-[8px] font-bold uppercase">Stock</span>
                        <span className="font-bold text-indigo-500">+{log.stockChanges || 0}</span>
                      </div>
                      <div>
                        <span className="block text-slate-400 text-[8px] font-bold uppercase">Images</span>
                        <span className="font-bold text-purple-500">+{log.imageChanges || 0}</span>
                      </div>
                      <div>
                        <span className="block text-slate-400 text-[8px] font-bold uppercase">Reviews</span>
                        <span className="font-bold text-rose-500">+{log.pendingReviews || 0}</span>
                      </div>
                    </div>

                    {log.error && log.error !== 'None' && (
                      <div className="p-2 bg-rose-500/5 text-rose-500 border border-rose-500/10 rounded-lg text-[10px] font-mono break-words">
                        <strong>Error:</strong> {log.error}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
              <button
                onClick={() => setShowSyncHistoryModal(false)}
                className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                Close History
              </button>
            </div>

          </div>
        </div>
      )}

      {/* --- CONNECT SUPPLIER MODAL --- */}
      {showConnectModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-md w-full p-6 text-left shadow-2xl flex flex-col space-y-4">
            
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-blue-500/10 text-blue-500 rounded-xl">
                  <Plus className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-extrabold font-display text-slate-900 dark:text-white">Connect New Supplier</h3>
                  <p className="text-[10px] text-slate-400">Establish feed connection with external distributor</p>
                </div>
              </div>
              <button 
                onClick={() => setShowConnectModal(false)} 
                className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full cursor-pointer transition-colors"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            <form onSubmit={handleConnectSupplier} className="space-y-4 text-xs">
              <div className="space-y-1">
                <label className="text-slate-400 font-bold block">Supplier / Company Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. A2Z Wholesalers"
                  value={newSupplierName}
                  onChange={(e) => setNewSupplierName(e.target.value)}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs text-slate-900 dark:text-white"
                />
              </div>

              <div className="space-y-1">
                <label className="text-slate-400 font-bold block">Feed Connection Type *</label>
                <select
                  value={newSupplierType}
                  onChange={(e) => setNewSupplierType(e.target.value)}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs text-slate-900 dark:text-white"
                >
                  <option value="website">Website (Scraper API Link)</option>
                  <option value="whatsapp">WhatsApp Community Stream</option>
                  <option value="csv">Scheduled CSV/FTP Download</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-slate-400 font-bold block">Feed Source URL / Invitation Address *</label>
                <input
                  type="text"
                  required
                  placeholder={newSupplierType === 'whatsapp' ? 'https://chat.whatsapp.com/invite-code' : 'https://api.supplier.lk/v1/feed.json'}
                  value={newSupplierUrl}
                  onChange={(e) => setNewSupplierUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs font-mono text-slate-900 dark:text-white"
                />
              </div>

              <div className="p-3 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-xl text-[10px] space-y-1 border border-blue-500/20">
                <strong className="block uppercase font-black tracking-wider">Note on Integration phase:</strong>
                <span>Currently preparing structure only. Establishes the descriptor record in the <strong>supplierHub</strong> Firestore collection to model synchronization variables. No actual networks will be pinged.</span>
              </div>

              {/* Footer Buttons */}
              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setShowConnectModal(false)}
                  className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSupplier}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white font-bold rounded-xl text-xs transition-colors shadow-lg shadow-blue-500/20 flex items-center space-x-1 cursor-pointer"
                >
                  {savingSupplier ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  <span>Connect Link</span>
                </button>
              </div>
            </form>

          </div>
        </div>
      )}

    </div>
  );
}
