import React, { Suspense, lazy, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { 
  TrendingUp, ShoppingBag, Users, Layers, Plus, Trash2, Edit3, Check, 
  X, RefreshCw, AlertCircle, DollarSign, ArrowUpRight, Upload,
  Settings, Search, Image, ShieldCheck, Power, Phone,
  Copy, Star, Bell, Moon, Sun, ChevronRight,
  Menu, Info, Filter, Clock, BarChart3, Archive, Package, FileText, Save,
  Facebook, Instagram, Youtube, Music, Sparkles, Flame, Award, UserCheck, Activity,
  ArrowDownRight, AlertTriangle, ArrowRight, History, User
} from 'lucide-react';
import { 
  collection, documentId, getAggregateFromServer, getCountFromServer, getDocs, doc, updateDoc, deleteDoc, getDoc, limit,
  onSnapshot, orderBy, query, QueryDocumentSnapshot, setDoc, startAfter, sum, where
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { onAuthStateChanged } from 'firebase/auth';
import { db, auth } from '../firebase';
import { storage } from '../firebaseStorage';
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
import {
  countProductsForBrand,
  isDuplicateBrand,
  normalizeBrandId,
  normalizeBrandName,
  sortBrandsAlphabetically,
} from '../services/brands/brandUtils';
import {
  applySpecificationTemplate,
  createProductDraft,
  getActiveSubcategories,
  getSelectedCategory,
  normalizeCategoryBlueprint,
  normalizeProductForEditor,
  normalizeSpecificationTemplate,
  normalizeSubcategories,
} from '../services/products/productBlueprint';
import { Product, Category, Brand, Order, WebsiteSettings } from '../types';
import { PRODUCTION_ADMIN_EMAIL } from '../config/admin';
import { CloudinaryUpload } from './CloudinaryUpload';
import HeroSliderEditor from './HeroSliderEditor';
import BusinessConfigurationEditor from './admin/BusinessConfigurationEditor';
import PaymentConfigurationPanel from './admin/PaymentConfigurationPanel';
import { normalizeSlideSpeed, validateHeroSlides } from '../services/hero-slider/heroSlider';
import { validateProductForSave } from '../services/products/productValidation';
import {
  mergeProductCommercialData,
  PRODUCT_PRIVATE_COLLECTION,
} from '../services/products/productCommercialData';
import {
  archiveAdminProduct,
  createAdminProduct,
  updateAdminProduct,
} from '../services/admin/adminProductApi';
import {
  assignAdminOrderFulfilmentGroup,
  correctAdminOrderFulfilmentTracking,
  loadAdminOrderFulfilment,
  type AdminFulfilmentGroup,
  type AdminOrderFulfilmentView,
} from '../services/admin/orderFulfilmentApi';
import { isHttpUrl, validateStoreSettings } from '../services/settings/storeSettingsValidation';
import { getAppCheckRequestHeaders } from '../services/security/appCheck';
import { normalizeWebsiteSettings } from '../services/settings/websiteSettings';
import { reportClientIssue } from '../services/observability/clientDiagnostics';
import {
  hasBrandProductReference,
  hasCategoryProductReference,
  updateBrandProductReferences,
} from '../services/admin/adminCatalogReferences';
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, 
  CartesianGrid, Tooltip, PieChart, Pie, Cell, BarChart, Bar, Legend
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';

const SupplierHubFiveStars = lazy(() => import('./SupplierHubFiveStars'));
const AIManagerPanel = lazy(() => import('../features/ai-manager'));

const ADMIN_PRODUCT_PAGE_SIZE = 120;
const ADMIN_ORDER_READ_LIMIT = 250;
const ADMIN_REVIEW_READ_LIMIT = 200;
const ADMIN_USER_READ_LIMIT = 250;
const ADMIN_FULFILMENT_NOTIFICATION_LIMIT = 30;

interface AdminFulfilmentNotification {
  id: string;
  text: string;
  time: string;
}

const formatAdminNotificationTime = (value: unknown): string => {
  const date = value && typeof value === 'object' && 'toDate' in value
    && typeof (value as { toDate?: unknown }).toDate === 'function'
    ? (value as { toDate: () => Date }).toDate()
    : new Date(typeof value === 'string' || typeof value === 'number' ? value : '');
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Recent';
};
const ADMIN_REGISTRY_READ_LIMIT = 100;
const ADMIN_CMS_READ_LIMIT = 50;
const FIRESTORE_IN_QUERY_LIMIT = 30;

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

const DEFAULT_WEBSITE_SETTINGS: WebsiteSettings = normalizeWebsiteSettings({
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
});

const isValidUrl = (url: string) => !url.trim() || isHttpUrl(url);

const formatAdminTimestamp = (value: unknown): string => {
  if (!value) return 'Legacy product — timestamp will be added on save';
  const resolved = typeof value === 'object' && value !== null && 'toDate' in value && typeof value.toDate === 'function'
    ? value.toDate()
    : new Date(String(value));
  return Number.isNaN(resolved.getTime()) ? 'Timestamp unavailable' : resolved.toLocaleString();
};

interface CategoryDraft {
  id: string;
  name: string;
  icon: string;
  imageUrl: string;
  isActive: boolean;
  subcategories: NonNullable<Category['subcategories']>;
  specificationTemplate: NonNullable<Category['specificationTemplate']>;
}

const createEmptyCategoryDraft = (): CategoryDraft => ({
  id: '',
  name: '',
  icon: 'Smartphone',
  imageUrl: '',
  isActive: true,
  subcategories: [],
  specificationTemplate: [],
});

interface BrandDraft {
  id: string;
  name: string;
  isActive: boolean;
}

const createEmptyBrandDraft = (): BrandDraft => ({ id: '', name: '', isActive: true });

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
    id: "warranty-policy",
    title: "Warranty Policy",
    content: `Warranty coverage applies only where it is explicitly stated on the product page, order record, invoice, or documentation supplied with the item. Duration and provider vary by product. Proof of purchase may be required. Accidental damage, misuse, unauthorized repairs, consumable wear, and incompatible power or accessories are excluded unless the product-specific terms state otherwise. Contact Zyro.lk with your order reference and issue details so the applicable terms can be confirmed before inspection or service.`
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

interface AdminDashboardProps {
  initialTab?: 'stats' | 'aiManager' | 'products' | 'categories' | 'orders' | 'customers' | 'pages' | 'settings' | 'supplierHubFiveStars';
  initialCmsPageId?: string;
}

interface AdminOperationsSummary {
  generatedAt: string;
  emailNotifications: {
    handed_off: number;
    delivering: number;
    delivered: number;
    retry_pending: number;
    failed: number;
    inProgress: number;
    lastFailure: null | { id: string; kind: string; attemptCount: number; message: string; updatedAt: string | null };
  };
  supplierAlerts: { active: number };
  coupons: { total: number; active: number };
  audit: { latestSupplierEventAt: string | null };
}

const formatOperationsTimestamp = (value: string | null): string => {
  if (!value) return 'No activity recorded';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'No activity recorded';
};

export default function AdminDashboard({ initialTab = 'stats', initialCmsPageId = 'about-us' }: AdminDashboardProps = {}) {
  const [activeTab, setActiveTab] = useState<'stats' | 'aiManager' | 'products' | 'categories' | 'orders' | 'customers' | 'pages' | 'settings' | 'supplierHubFiveStars'>(initialTab);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);
  const [showNotifications, setShowNotifications] = useState<boolean>(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMenuCloseRef = useRef<HTMLButtonElement>(null);

  // States loaded from Firestore
  const [publicProducts, setPublicProducts] = useState<Product[]>([]);
  const [productCommercialById, setProductCommercialById] = useState<Record<string, Record<string, unknown>>>({});
  const products = useMemo(() => publicProducts.map((product) => (
    mergeProductCommercialData(product, productCommercialById[product.id])
  )), [productCommercialById, publicProducts]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [reviews, setReviews] = useState<any[]>([]);
  const [staticPages, setStaticPages] = useState<any[]>([]);
  const [adminSummaryCounts, setAdminSummaryCounts] = useState({ orders: 0, users: 0, products: 0, reviews: 0 });
  const [adminGrossSales, setAdminGrossSales] = useState<number | null>(null);
  const [operationsSummary, setOperationsSummary] = useState<AdminOperationsSummary | null>(null);
  const [adminFulfilmentNotifications, setAdminFulfilmentNotifications] = useState<AdminFulfilmentNotification[]>([]);
  const [operationsSummaryError, setOperationsSummaryError] = useState('');
  const [loadingOperationsSummary, setLoadingOperationsSummary] = useState(false);
  const [adminDataIssues, setAdminDataIssues] = useState<Record<string, string>>({});
  const [hasMoreAdminProducts, setHasMoreAdminProducts] = useState(false);
  const [loadingMoreAdminProducts, setLoadingMoreAdminProducts] = useState(false);
  const [hasMoreAdminOrders, setHasMoreAdminOrders] = useState(false);
  const [loadingMoreAdminOrders, setLoadingMoreAdminOrders] = useState(false);
  const [hasMoreAdminUsers, setHasMoreAdminUsers] = useState(false);
  const [loadingMoreAdminUsers, setLoadingMoreAdminUsers] = useState(false);
  const adminProductCursorRef = useRef<QueryDocumentSnapshot | null>(null);
  const adminOrderCursorRef = useRef<QueryDocumentSnapshot | null>(null);
  const adminUserCursorRef = useRef<QueryDocumentSnapshot | null>(null);
  const adminFirstProductPageIdsRef = useRef<Set<string>>(new Set());
  const adminFirstCommercialPageIdsRef = useRef<Set<string>>(new Set());
  const adminFirstOrderPageIdsRef = useRef<Set<string>>(new Set());
  const adminFirstUserPageIdsRef = useRef<Set<string>>(new Set());
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
  const [selectedOrderFulfilment, setSelectedOrderFulfilment] = useState<AdminOrderFulfilmentView | null>(null);
  const [loadingOrderFulfilment, setLoadingOrderFulfilment] = useState(false);
  const [orderFulfilmentError, setOrderFulfilmentError] = useState('');
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
  const [manualProductRequestId, setManualProductRequestId] = useState('');
  const productModalRef = useRef<HTMLDivElement>(null);
  const productModalCloseRef = useRef<HTMLButtonElement>(null);
  const productModalPreviousFocusRef = useRef<HTMLElement | null>(null);
  const savingProductRef = useRef(false);
  
  const [newProduct, setNewProduct] = useState<Partial<Product>>(() => createProductDraft('electronics', ''));

  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [newCategory, setNewCategory] = useState<CategoryDraft>(createEmptyCategoryDraft);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryToDelete, setCategoryToDelete] = useState<Category | null>(null);
  const [savingCategory, setSavingCategory] = useState(false);
  const categoryTriggerRef = useRef<HTMLElement | null>(null);
  const categorySlugInputRef = useRef<HTMLInputElement | null>(null);
  const categoryNameInputRef = useRef<HTMLInputElement | null>(null);
  const categoryDeleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const [specKey, setSpecKey] = useState("");
  const [specVal, setSpecVal] = useState("");
  const [subcategoryName, setSubcategoryName] = useState('');
  const [specificationTemplateName, setSpecificationTemplateName] = useState('');
  const [specificationTemplateRequired, setSpecificationTemplateRequired] = useState(false);
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [brandDraft, setBrandDraft] = useState<BrandDraft>(createEmptyBrandDraft);
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [brandToDelete, setBrandToDelete] = useState<Brand | null>(null);
  const [savingBrand, setSavingBrand] = useState(false);

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

  useEffect(() => { savingProductRef.current = savingProduct; }, [savingProduct]);

  useEffect(() => {
    if (!showProductModal) return;
    productModalPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => productModalCloseRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingProductRef.current) {
        event.preventDefault();
        setShowProductModal(false);
        return;
      }
      if (event.key !== 'Tab' || !productModalRef.current) return;
      const focusable = (Array.from(productModalRef.current.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      )) as HTMLElement[]).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
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
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      productModalPreviousFocusRef.current?.focus();
    };
  }, [showProductModal]);

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
  const selectedProductCategory = useMemo(
    () => getSelectedCategory(categories, newProduct.category),
    [categories, newProduct.category],
  );
  const selectedProductSubcategories = useMemo(
    () => getActiveSubcategories(selectedProductCategory),
    [selectedProductCategory],
  );
  const selectedProductSpecificationTemplate = useMemo(
    () => normalizeSpecificationTemplate(selectedProductCategory?.specificationTemplate),
    [selectedProductCategory],
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
    if (!selectedOrderId || !authorized || !auth.currentUser) {
      setSelectedOrderFulfilment(null);
      setOrderFulfilmentError('');
      return;
    }
    let active = true;
    setLoadingOrderFulfilment(true);
    setOrderFulfilmentError('');
    void loadAdminOrderFulfilment(auth.currentUser, selectedOrderId)
      .then((result) => { if (active) setSelectedOrderFulfilment(result); })
      .catch((error: unknown) => {
        if (active) setOrderFulfilmentError(error instanceof Error ? error.message : 'Fulfilment groups could not be loaded.');
      })
      .finally(() => { if (active) setLoadingOrderFulfilment(false); });
    return () => { active = false; };
  }, [authorized, selectedOrderId]);

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
      const pageSnap = await getDocs(query(
        collection(db, "pages"),
        orderBy(documentId()),
        limit(ADMIN_CMS_READ_LIMIT),
      ));
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
    const pageSnap = await getDocs(query(
      collection(db, "pages"),
      orderBy(documentId()),
      limit(ADMIN_CMS_READ_LIMIT),
    ));
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
      const catSnap = await getDocs(query(
        collection(db, "categories"),
        orderBy(documentId()),
        limit(ADMIN_REGISTRY_READ_LIMIT),
      ));
      const catList: Category[] = [];
      catSnap.forEach((d) => catList.push(normalizeCategoryBlueprint({ id: d.id, ...d.data() } as Category)));
      setCategories(sortCategoriesAlphabetically(catList));
    } catch (e) { console.warn("Categories load error", e); }

    try {
      const brandSnap = await getDocs(query(
        collection(db, 'brands'),
        orderBy(documentId()),
        limit(ADMIN_REGISTRY_READ_LIMIT),
      ));
      const brandList: Brand[] = [];
      brandSnap.forEach((d) => brandList.push({ id: d.id, ...d.data() } as Brand));
      setBrands(sortBrandsAlphabetically(brandList));
    } catch (e) { console.warn('Brands load error', e); }

    try {
      const userSnap = await getDocs(query(
        collection(db, "users"),
        orderBy(documentId()),
        limit(ADMIN_USER_READ_LIMIT),
      ));
      const userList: any[] = [];
      userSnap.forEach((d) => userList.push({ id: d.id, ...d.data() }));
      const previousFirstPageIds = adminFirstUserPageIdsRef.current;
      const nextFirstPageIds = new Set(userList.map((user) => user.id));
      setUsers((current) => [
        ...userList,
        ...current.filter((user) => !previousFirstPageIds.has(user.id) && !nextFirstPageIds.has(user.id)),
      ]);
      adminFirstUserPageIdsRef.current = nextFirstPageIds;
      adminUserCursorRef.current = userSnap.docs.at(-1) || null;
      setHasMoreAdminUsers(userSnap.docs.length === ADMIN_USER_READ_LIMIT);
    } catch (e) { console.warn("Users load error", e); }

    try {
      const settingsSnap = await getDoc(doc(db, "settings", "website"));
      if (settingsSnap.exists()) {
        const sData = settingsSnap.data() as WebsiteSettings;
        const merged = normalizeWebsiteSettings(sData);
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
      const pageSnap = await getDocs(query(
        collection(db, "pages"),
        orderBy(documentId()),
        limit(ADMIN_CMS_READ_LIMIT),
      ));
      const pageList: any[] = [];
      pageSnap.forEach((d) => pageList.push({ id: d.id, ...d.data() }));
      setStaticPages(pageList);
    } catch (e) {
      console.warn("Pages load error", e);
    }

    setLoading(false);
  };

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => mobileMenuCloseRef.current?.focus());
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMobileMenuOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleEscape);
      mobileMenuButtonRef.current?.focus();
    };
  }, [isMobileMenuOpen]);

  const reportAdminDataIssue = (key: string, message: string, error: unknown): void => {
    reportClientIssue(`admin-${key}`, error, 'error');
    setAdminDataIssues((current) => ({ ...current, [key]: message }));
  };

  const clearAdminDataIssue = (key: string): void => {
    setAdminDataIssues((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const loadOperationsSummary = useCallback(async (): Promise<void> => {
    if (!authorized || loadingOperationsSummary) return;
    setLoadingOperationsSummary(true);
    setOperationsSummaryError('');
    try {
      const [token, appCheckHeaders] = await Promise.all([
        auth.currentUser?.getIdToken(),
        getAppCheckRequestHeaders(),
      ]);
      if (!token) throw new Error('Admin authentication is required.');
      const response = await fetch('/api/admin/operations-summary', {
        headers: { Authorization: `Bearer ${token}`, ...appCheckHeaders },
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        summary?: AdminOperationsSummary;
        error?: string;
      };
      if (!response.ok || !payload.success || !payload.summary) {
        throw new Error(payload.error || 'Operational status is unavailable.');
      }
      setOperationsSummary(payload.summary);
    } catch (error) {
      console.warn('Admin operations summary could not be loaded.', error);
      setOperationsSummaryError('Operational status could not be refreshed. Existing administration tools remain available.');
    } finally {
      setLoadingOperationsSummary(false);
    }
  }, [authorized, loadingOperationsSummary]);

  useEffect(() => {
    if (authorized) void loadOperationsSummary();
  }, [authorized]);

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
        const tokenResult = await currentUser.getIdTokenResult(true);
        if (tokenResult.claims.admin === true || tokenResult.claims.role === 'admin') {
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
    let isMounted = true;

    const unsubscribeOrders = onSnapshot(query(
      collection(db, "orders"),
      orderBy('createdAt', 'desc'),
      limit(ADMIN_ORDER_READ_LIMIT),
    ), async (snapshot) => {
      const orderList: Order[] = [];
      snapshot.forEach((d) => {
        orderList.push({ id: d.id, ...d.data() } as Order);
      });

      orderList.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return (isNaN(timeA) ? 0 : timeA) - (isNaN(timeB) ? 0 : timeB);
      });

      orderList.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
      });
      const previousFirstPageIds = adminFirstOrderPageIdsRef.current;
      const nextFirstPageIds = new Set(orderList.map((order) => order.id));
      setOrders((current) => [
        ...orderList,
        ...current.filter((order) => !previousFirstPageIds.has(order.id) && !nextFirstPageIds.has(order.id)),
      ].sort((left, right) => {
        const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
        const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
        return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
      }));
      adminFirstOrderPageIdsRef.current = nextFirstPageIds;
      adminOrderCursorRef.current = snapshot.docs.at(-1) || null;
      setHasMoreAdminOrders(snapshot.docs.length === ADMIN_ORDER_READ_LIMIT);
      clearAdminDataIssue('orders');

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
    }, (error) => reportAdminDataIssue('orders', 'Live order updates are temporarily unavailable.', error));

    const unsubscribeReviews = onSnapshot(query(
      collection(db, "reviews"),
      orderBy('createdAt', 'desc'),
      limit(ADMIN_REVIEW_READ_LIMIT),
    ), (snapshot) => {
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
      clearAdminDataIssue('reviews');
    }, (error) => reportAdminDataIssue('reviews', 'Live review updates are temporarily unavailable.', error));

    const unsubscribeFulfilmentNotifications = onSnapshot(query(
      collection(db, 'supplier_notifications'),
      where('audience', '==', 'admin'),
      orderBy('createdAt', 'desc'),
      limit(ADMIN_FULFILMENT_NOTIFICATION_LIMIT),
    ), (snapshot) => {
      setAdminFulfilmentNotifications(snapshot.docs.map((document) => ({
        id: document.id,
        text: String(document.data().message || 'Supplier fulfilment requires attention.'),
        time: formatAdminNotificationTime(document.data().createdAt),
      })));
      clearAdminDataIssue('fulfilment-notifications');
    }, (error) => reportAdminDataIssue(
      'fulfilment-notifications',
      'Supplier fulfilment alerts are temporarily unavailable.',
      error,
    ));

    const unsubscribeProducts = onSnapshot(query(
      collection(db, "products"),
      orderBy(documentId()),
      limit(ADMIN_PRODUCT_PAGE_SIZE),
    ), (snapshot) => {
      const prodList: Product[] = [];
      snapshot.forEach((d) => {
        prodList.push({ id: d.id, ...d.data() } as Product);
      });
      const previousFirstPageIds = adminFirstProductPageIdsRef.current;
      const nextFirstPageIds = new Set(prodList.map((product) => product.id));
      setPublicProducts((current) => [
        ...prodList,
        ...current.filter((product) => !previousFirstPageIds.has(product.id) && !nextFirstPageIds.has(product.id)),
      ]);
      adminFirstProductPageIdsRef.current = nextFirstPageIds;
      adminProductCursorRef.current = snapshot.docs.at(-1) || null;
      setHasMoreAdminProducts(snapshot.docs.length === ADMIN_PRODUCT_PAGE_SIZE);
      clearAdminDataIssue('products');
    }, (error) => {
      reportAdminDataIssue('products', 'Live product updates are temporarily unavailable.', error);
    });

    const unsubscribeProductCommercial = onSnapshot(query(
      collection(db, PRODUCT_PRIVATE_COLLECTION),
      orderBy(documentId()),
      limit(ADMIN_PRODUCT_PAGE_SIZE),
    ), (snapshot) => {
      const nextPage = Object.fromEntries(snapshot.docs.map((document) => [document.id, document.data()]));
      const previousFirstPageIds = adminFirstCommercialPageIdsRef.current;
      setProductCommercialById((current) => ({
        ...Object.fromEntries(Object.entries(current).filter(([id]) => !previousFirstPageIds.has(id))),
        ...nextPage,
      }));
      adminFirstCommercialPageIdsRef.current = new Set(snapshot.docs.map((document) => document.id));
      clearAdminDataIssue('product-commercial');
    }, (error) => {
      reportAdminDataIssue('product-commercial', 'Private product controls are temporarily unavailable.', error);
    });

    void Promise.all([
      getCountFromServer(collection(db, 'orders')),
      getCountFromServer(collection(db, 'users')),
      getCountFromServer(collection(db, 'products')),
      getCountFromServer(collection(db, 'reviews')),
    ]).then(([orderCount, userCount, productCount, reviewCount]) => {
      if (!isMounted) return;
      setAdminSummaryCounts({
        orders: orderCount.data().count,
        users: userCount.data().count,
        products: productCount.data().count,
        reviews: reviewCount.data().count,
      });
    }).catch((error) => console.warn('Admin summary counts could not be loaded', error));

    void getAggregateFromServer(
      query(collection(db, 'orders'), where('status', 'in', ['confirmed', 'delivered'])),
      { totalSales: sum('totalPrice') },
    ).then((snapshot) => {
      if (!isMounted) return;
      setAdminGrossSales(snapshot.data().totalSales);
    }).catch((error) => console.warn('Admin sales aggregate could not be loaded', error));

    loadData();

    return () => {
      isMounted = false;
      unsubscribeOrders();
      unsubscribeReviews();
      unsubscribeFulfilmentNotifications();
      unsubscribeProducts();
      unsubscribeProductCommercial();
    };
  }, [authorized]);

  const loadMoreAdminProducts = async (): Promise<void> => {
    const cursor = adminProductCursorRef.current;
    if (!cursor || loadingMoreAdminProducts) return;
    setLoadingMoreAdminProducts(true);
    try {
      const productSnapshot = await getDocs(query(
        collection(db, 'products'),
        orderBy(documentId()),
        startAfter(cursor),
        limit(ADMIN_PRODUCT_PAGE_SIZE),
      ));
      const nextProducts = productSnapshot.docs.map((document) => ({
        id: document.id,
        ...document.data(),
      } as Product));
      const commercialEntries: Array<[string, Record<string, unknown>]> = [];
      for (let index = 0; index < nextProducts.length; index += FIRESTORE_IN_QUERY_LIMIT) {
        const productIds = nextProducts.slice(index, index + FIRESTORE_IN_QUERY_LIMIT).map((product) => product.id);
        if (productIds.length === 0) continue;
        const commercialSnapshot = await getDocs(query(
          collection(db, PRODUCT_PRIVATE_COLLECTION),
          where(documentId(), 'in', productIds),
          limit(FIRESTORE_IN_QUERY_LIMIT),
        ));
        commercialSnapshot.docs.forEach((document) => commercialEntries.push([
          document.id,
          document.data(),
        ]));
      }
      setPublicProducts((current) => {
        const byId = new Map(current.map((product) => [product.id, product]));
        nextProducts.forEach((product) => byId.set(product.id, product));
        return [...byId.values()];
      });
      setProductCommercialById((current) => ({ ...current, ...Object.fromEntries(commercialEntries) }));
      adminProductCursorRef.current = productSnapshot.docs.at(-1) || null;
      setHasMoreAdminProducts(productSnapshot.docs.length === ADMIN_PRODUCT_PAGE_SIZE);
    } catch (error) {
      console.warn('Additional admin products could not be loaded', error);
      showSettingsToast('error', 'More products could not be loaded. Please try again.');
    } finally {
      setLoadingMoreAdminProducts(false);
    }
  };

  const loadMoreAdminOrders = async (): Promise<number> => {
    const cursor = adminOrderCursorRef.current;
    if (!cursor || loadingMoreAdminOrders) return 0;
    setLoadingMoreAdminOrders(true);
    try {
      const snapshot = await getDocs(query(
        collection(db, 'orders'),
        orderBy('createdAt', 'desc'),
        startAfter(cursor),
        limit(ADMIN_ORDER_READ_LIMIT),
      ));
      const nextOrders = snapshot.docs.map((document) => ({ id: document.id, ...document.data() } as Order));
      setOrders((current) => {
        const byId = new Map<string, Order>(current.map((order) => [order.id, order]));
        nextOrders.forEach((order) => byId.set(order.id, order));
        return [...byId.values()].sort((left, right) => {
          const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
          const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
          return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
        });
      });
      adminOrderCursorRef.current = snapshot.docs.at(-1) || null;
      setHasMoreAdminOrders(snapshot.docs.length === ADMIN_ORDER_READ_LIMIT);
      return nextOrders.length;
    } catch (error) {
      console.warn('Older admin orders could not be loaded', error);
      showSettingsToast('error', 'Older orders could not be loaded. Please try again.');
      return 0;
    } finally {
      setLoadingMoreAdminOrders(false);
    }
  };

  const loadMoreAdminUsers = async (): Promise<number> => {
    const cursor = adminUserCursorRef.current;
    if (!cursor || loadingMoreAdminUsers) return 0;
    setLoadingMoreAdminUsers(true);
    try {
      const snapshot = await getDocs(query(
        collection(db, 'users'),
        orderBy(documentId()),
        startAfter(cursor),
        limit(ADMIN_USER_READ_LIMIT),
      ));
      const nextUsers = snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
      setUsers((current) => {
        const byId = new Map(current.map((user) => [user.id, user]));
        nextUsers.forEach((user) => byId.set(user.id, user));
        return [...byId.values()];
      });
      adminUserCursorRef.current = snapshot.docs.at(-1) || null;
      setHasMoreAdminUsers(snapshot.docs.length === ADMIN_USER_READ_LIMIT);
      return nextUsers.length;
    } catch (error) {
      console.warn('Additional admin customers could not be loaded', error);
      showSettingsToast('error', 'More customers could not be loaded. Please try again.');
      return 0;
    } finally {
      setLoadingMoreAdminUsers(false);
    }
  };

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
    if (!authorized || savingProductRef.current) return;

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

    const productErrors = validateProductForSave({
      product: newProduct,
      products,
      categories,
      brands,
      editingProductId: editingProduct?.id,
      serverAssignedIdentity: !editingProduct,
    });
    if (productErrors.length > 0) {
      showSettingsToast("error", productErrors[0]);
      return;
    }

    const createRequestId = manualProductRequestId || globalThis.crypto.randomUUID();
    if (!editingProduct && !manualProductRequestId) setManualProductRequestId(createRequestId);
    setSavingProduct(true);
    try {
      const result = editingProduct
        ? await updateAdminProduct(editingProduct.id, newProduct)
        : await createAdminProduct(
          { ...newProduct, id: undefined, sku: undefined },
          createRequestId,
        );

      if (editingProduct) {
        showSettingsToast("success", `Product "${newProduct.name}" updated successfully.`);
      } else {
        showSettingsToast("success", `Product "${newProduct.name}" created with SKU ${result.sku}.`);
      }

      setShowProductModal(false);
      setEditingProduct(null);
      setManualProductRequestId('');
      setNewProduct(createProductDraft(categories[0]?.id || '', ''));
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
    setManualProductRequestId('');
    setNewProduct(normalizeProductForEditor(prod, brands, categories));
    setShowProductModal(true);
  };

  // Duplicate Product Handler
  const handleDuplicateProduct = (prod: Product) => {
    const duplicatedName = `${prod.name} (Copy)`;

    setEditingProduct(null);
    setManualProductRequestId(globalThis.crypto.randomUUID());
    setNewProduct({
      ...prod,
      id: '',
      sku: '',
      supplierId: undefined,
      supplierItemCode: undefined,
      name: duplicatedName,
      isActive: prod.isActive !== false,
      imageUrls: prod.imageUrls || []
    });
    setSpecKey("");
    setSpecVal("");
    setShowProductModal(true);
  };

  const confirmDeleteProduct = async () => {
    if (!productToDelete || !authorized || savingProductRef.current) return;
    setSavingProduct(true);
    try {
      const productName = productToDelete.name;
      await archiveAdminProduct(productToDelete.id);
      showSettingsToast("success", `Product "${productName}" archived successfully.`);
      setProductToDelete(null);
      loadData();
    } catch (err: any) {
      console.error("Archive failed:", err);
      showSettingsToast("error", err?.message || "Failed to archive product.");
    } finally {
      setSavingProduct(false);
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
        subcategories: normalizeSubcategories(newCategory.subcategories),
        specificationTemplate: normalizeSpecificationTemplate(newCategory.specificationTemplate),
        updatedAt: new Date().toISOString(),
      }, { merge: Boolean(editingCategory) });
      showSettingsToast('success', `Category "${name}" ${editingCategory ? 'updated' : 'created'} successfully.`);
      setNewCategory(createEmptyCategoryDraft());
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
    setNewCategory(createEmptyCategoryDraft());
    setSubcategoryName('');
    setSpecificationTemplateName('');
    setSpecificationTemplateRequired(false);
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
      subcategories: normalizeSubcategories(category.subcategories),
      specificationTemplate: normalizeSpecificationTemplate(category.specificationTemplate),
    });
    setSubcategoryName('');
    setSpecificationTemplateName('');
    setSpecificationTemplateRequired(false);
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
      if (await hasCategoryProductReference(db, categoryToDelete.id)) {
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

  const openCreateBrand = () => {
    setEditingBrand(null);
    setBrandDraft(createEmptyBrandDraft());
    setShowBrandModal(true);
  };

  const openEditBrand = (brand: Brand) => {
    setEditingBrand(brand);
    setBrandDraft({ id: brand.id, name: brand.name, isActive: brand.isActive !== false });
    setShowBrandModal(true);
  };

  const handleSaveBrand = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!authorized) return;
    const name = normalizeBrandName(brandDraft.name);
    const id = editingBrand?.id ?? normalizeBrandId(brandDraft.id || name);
    if (!id || !name) {
      showSettingsToast('error', 'Brand name and brand ID are required.');
      return;
    }
    if (isDuplicateBrand(brands, id, name, editingBrand?.id)) {
      showSettingsToast('error', 'A brand with this name or ID already exists.');
      return;
    }
    setSavingBrand(true);
    try {
      if (!editingBrand) {
        const existingBrand = await getDoc(doc(db, 'brands', id));
        if (existingBrand.exists()) {
          showSettingsToast('error', `Brand ID "${id}" already exists.`);
          return;
        }
      }
      const now = new Date().toISOString();
      await setDoc(doc(db, 'brands', id), {
        id,
        name,
        isActive: brandDraft.isActive,
        createdAt: editingBrand?.createdAt ?? now,
        updatedAt: now,
      }, { merge: Boolean(editingBrand) });
      if (editingBrand && editingBrand.name !== name) {
        await updateBrandProductReferences(db, editingBrand, name, now);
      }
      showSettingsToast('success', `Brand "${name}" ${editingBrand ? 'updated' : 'created'} successfully.`);
      setShowBrandModal(false);
      setEditingBrand(null);
      setBrandDraft(createEmptyBrandDraft());
      loadData();
    } catch (error: unknown) {
      console.error('Save brand failed:', error);
      showSettingsToast('error', error instanceof Error ? error.message : 'Failed to save brand.');
    } finally {
      setSavingBrand(false);
    }
  };

  const toggleBrandActive = async (brand: Brand) => {
    if (!authorized) return;
    try {
      await updateDoc(doc(db, 'brands', brand.id), {
        isActive: brand.isActive === false,
        updatedAt: new Date().toISOString(),
      });
      showSettingsToast('success', `Brand "${brand.name}" ${brand.isActive === false ? 'activated' : 'deactivated'}.`);
      loadData();
    } catch (error: unknown) {
      console.error('Update brand status failed:', error);
      showSettingsToast('error', error instanceof Error ? error.message : 'Failed to update brand status.');
    }
  };

  const confirmDeleteBrand = async () => {
    if (!authorized || !brandToDelete) return;
    setSavingBrand(true);
    try {
      if (await hasBrandProductReference(db, brandToDelete)) {
        showSettingsToast('error', 'This brand is currently used by products and cannot be deleted.');
        setBrandToDelete(null);
        return;
      }
      await deleteDoc(doc(db, 'brands', brandToDelete.id));
      showSettingsToast('success', `Brand "${brandToDelete.name}" deleted successfully.`);
      setBrandToDelete(null);
      loadData();
    } catch (error: unknown) {
      console.error('Delete brand failed:', error);
      showSettingsToast('error', error instanceof Error ? error.message : 'Failed to delete brand.');
    } finally {
      setSavingBrand(false);
    }
  };

  const reloadOrderFulfilment = async (orderId: string): Promise<void> => {
    if (!auth.currentUser) return;
    const result = await loadAdminOrderFulfilment(auth.currentUser, orderId);
    setSelectedOrderFulfilment(result);
    setOrderFulfilmentError('');
  };

  const handleUpdateOrderStatus = async (orderId: string, newStatus: string) => {
    if (!authorized) return;
    setUpdatingOrderStatus(prev => ({ ...prev, [orderId]: true }));
    try {
      const [token, appCheckHeaders] = await Promise.all([
        auth.currentUser?.getIdToken(),
        getAppCheckRequestHeaders(),
      ]);
      if (!token) throw new Error("Admin authentication is required. Please sign in again.");
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...appCheckHeaders },
        body: JSON.stringify({
          status: newStatus,
          ...(selectedOrderFulfilment?.orderId === orderId && selectedOrderFulfilment.orderPrivateRevision ? {
            expectedOrderPrivateRevision: selectedOrderFulfilment.orderPrivateRevision,
            expectedGroupRevisions: Object.fromEntries(selectedOrderFulfilment.groups.map((group) => [group.groupId, group.revision])),
          } : {}),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to update order status.');
      if (selectedOrderId === orderId) await reloadOrderFulfilment(orderId);
      showSettingsToast("success", `Order #${orderId.substring(0, 8).toUpperCase()} status set to ${newStatus.toUpperCase()}`);
    } catch (err: any) {
      console.error("Order update failed:", err);
      showSettingsToast("error", err?.message || `Failed to update order #${orderId.substring(0, 8).toUpperCase()}`);
    } finally {
      setUpdatingOrderStatus(prev => ({ ...prev, [orderId]: false }));
    }
  };

  const handleAssignOrderSupplier = async (orderId: string, group: AdminFulfilmentGroup) => {
    if (!authorized || !auth.currentUser || !selectedOrderFulfilment?.orderPrivateRevision) return;
    const operationKey = `supplier-${orderId}-${group.groupId}`;
    setUpdatingOrderStatus(prev => ({ ...prev, [operationKey]: true }));
    try {
      await assignAdminOrderFulfilmentGroup(
        auth.currentUser,
        orderId,
        group,
        selectedOrderFulfilment.orderPrivateRevision,
      );
      await reloadOrderFulfilment(orderId);
      showSettingsToast('success', `Order #${orderId.substring(0, 8).toUpperCase()} fulfilment group assigned.`);
    } catch (error: unknown) {
      console.error('Supplier order assignment failed:', error);
      showSettingsToast('error', error instanceof Error ? error.message : 'Failed to assign supplier.');
    } finally {
      setUpdatingOrderStatus(prev => ({ ...prev, [operationKey]: false }));
    }
  };

  const handleCorrectOrderTracking = async (orderId: string, group: AdminFulfilmentGroup) => {
    if (!authorized || !auth.currentUser || !selectedOrderFulfilment?.orderPrivateRevision || !group.tracking) return;
    const courierName = window.prompt('Correct courier name', group.tracking.courierName)?.trim();
    if (!courierName) return;
    const trackingNumber = window.prompt('Correct tracking number', group.tracking.trackingNumber)?.trim();
    if (!trackingNumber) return;
    if (!window.confirm('Confirm this tracking correction? The previous value remains in immutable audit history.')) return;
    const operationKey = `tracking-${orderId}-${group.groupId}`;
    setUpdatingOrderStatus(prev => ({ ...prev, [operationKey]: true }));
    try {
      await correctAdminOrderFulfilmentTracking(
        auth.currentUser,
        orderId,
        group,
        selectedOrderFulfilment.orderPrivateRevision,
        courierName,
        trackingNumber,
      );
      await reloadOrderFulfilment(orderId);
      showSettingsToast('success', `Order #${orderId.substring(0, 8).toUpperCase()} tracking corrected.`);
    } catch (error: unknown) {
      console.error('Tracking correction failed:', error);
      showSettingsToast('error', error instanceof Error ? error.message : 'Tracking could not be corrected.');
    } finally {
      setUpdatingOrderStatus(prev => ({ ...prev, [operationKey]: false }));
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

  const addSubcategoryToDraft = () => {
    const name = normalizeCategoryName(subcategoryName);
    const id = normalizeCategorySlug(name);
    if (!name || !id) return;
    if (newCategory.subcategories.some((subcategory) => subcategory.id === id)) {
      showSettingsToast('error', `Sub category "${name}" already exists in this category.`);
      return;
    }
    setNewCategory((previous) => ({
      ...previous,
      subcategories: [...previous.subcategories, { id, name, isActive: true }],
    }));
    setSubcategoryName('');
  };

  const removeSubcategoryFromDraft = (subcategoryId: string) => {
    const isUsed = editingCategory && products.some((product) => (
      categoryMatches(product.category, editingCategory.id) && product.subcategory === subcategoryId
    ));
    if (isUsed) {
      showSettingsToast('error', 'This sub category is currently used by products. Deactivate it instead.');
      return;
    }
    setNewCategory((previous) => ({
      ...previous,
      subcategories: previous.subcategories.filter((subcategory) => subcategory.id !== subcategoryId),
    }));
  };

  const addSpecificationTemplateField = () => {
    const name = normalizeCategoryName(specificationTemplateName);
    if (!name) return;
    if (newCategory.specificationTemplate.some((field) => field.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      showSettingsToast('error', `Specification "${name}" already exists in this template.`);
      return;
    }
    setNewCategory((previous) => ({
      ...previous,
      specificationTemplate: [
        ...previous.specificationTemplate,
        { name, required: specificationTemplateRequired },
      ],
    }));
    setSpecificationTemplateName('');
    setSpecificationTemplateRequired(false);
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

    const updatedSettings: WebsiteSettings = normalizeWebsiteSettings({
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
    });

    setSavingSettings(true);
    try {
      await setDoc(doc(db, "settings", "website"), updatedSettings);
      const persistedSnapshot = await getDoc(doc(db, "settings", "website"));
      if (!persistedSnapshot.exists()) throw new Error('Settings could not be verified after saving.');
      const persistedSettings = normalizeWebsiteSettings(persistedSnapshot.data() as Partial<WebsiteSettings>);
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
  const totalSalesVal = adminGrossSales ?? orders
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
    ...adminFulfilmentNotifications.map(notification => ({ ...notification, type: 'fulfilment' })),
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
      {isMobileMenuOpen && <button type="button" onClick={() => setIsMobileMenuOpen(false)} className="fixed inset-0 z-30 bg-slate-950/60 md:hidden" aria-label="Close Admin navigation" />}
      
      {/* --- SIDEBAR PANEL (Always #0B1220 Dark) --- */}
      <aside id="admin-navigation" aria-label="Admin navigation" className={`fixed md:sticky top-0 z-40 w-72 h-screen bg-[#0B1220] text-slate-300 border-r border-slate-800/60 p-6 flex flex-col justify-between transition-transform duration-300 ${isMobileMenuOpen ? 'visible translate-x-0' : 'invisible -translate-x-full md:visible md:translate-x-0'}`}>
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
            <button ref={mobileMenuCloseRef} type="button" onClick={() => setIsMobileMenuOpen(false)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-800 hover:text-white md:hidden" aria-label="Close Admin navigation">
              <X className="h-5 w-5" aria-hidden="true" />
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
              { id: 'supplierHubFiveStars', label: 'Supplier Hub', icon: Award }
            ].map(tab => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  type="button"
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id as any); setIsMobileMenuOpen(false); }}
                  aria-current={active ? 'page' : undefined}
                  className={`w-full flex items-center space-x-3.5 px-4 py-3 rounded-xl font-medium text-xs transition-all cursor-pointer ${active ? 'bg-blue-600 text-white font-bold shadow-lg shadow-blue-500/25' : 'hover:bg-slate-800/55 hover:text-white text-slate-400'}`}
                >
                  <Icon className={`h-4.5 w-4.5 ${active ? 'text-white' : 'text-slate-400 group-hover:text-white'}`} aria-hidden="true" />
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
          <button type="button" onClick={() => auth.signOut()} className="flex min-h-11 w-full items-center justify-center space-x-1.5 rounded-lg bg-slate-800 text-[11px] font-bold text-slate-400 transition-all hover:bg-slate-700 hover:text-white">
            <Power className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
            <span>Sign Out Session</span>
          </button>
        </div>
      </aside>

      {/* --- MAIN CORE WRAPPER --- */}
      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        
        {/* TOP COMPACT HEADER */}
        <header className={`sticky top-0 z-30 flex items-center justify-between border-b px-3 py-3 backdrop-blur-md sm:px-6 sm:py-4 ${isDarkMode ? 'bg-[#080E1A]/85 border-slate-800/50' : 'bg-white/85 border-slate-200/50'}`}>
          <div className="flex items-center space-x-4">
            <button ref={mobileMenuButtonRef} type="button" onClick={() => setIsMobileMenuOpen(true)} className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-white md:hidden" aria-label="Open Admin navigation" aria-expanded={isMobileMenuOpen} aria-controls="admin-navigation">
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>
            <div className="hidden sm:flex items-center space-x-2 text-xs font-semibold text-slate-400">
              <span>Overview</span>
              <ChevronRight className="h-3 w-3" />
              <span className={isDarkMode ? 'text-white' : 'text-slate-800'}>{activeTab.toUpperCase()}</span>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            {/* Theme Toggle */}
            <button type="button" onClick={() => setIsDarkMode(!isDarkMode)} className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700" aria-label={isDarkMode ? 'Use light Admin theme' : 'Use dark Admin theme'}>
              {isDarkMode ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
            </button>

            {/* Notification bell */}
            <div className="relative">
              <button type="button" onClick={() => setShowNotifications(!showNotifications)} className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700" aria-label={`Admin notifications${notificationsList.length ? `, ${notificationsList.length} active` : ''}`} aria-expanded={showNotifications} aria-controls="admin-notifications">
                <Bell className="h-4 w-4" aria-hidden="true" />
                {notificationsList.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full text-[9px] font-black flex items-center justify-center animate-bounce">
                    {notificationsList.length}
                  </span>
                )}
              </button>

              <AnimatePresence>
                {showNotifications && (
                  <motion.div id="admin-notifications" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className={`absolute right-0 mt-3 w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl shadow-2xl p-4 border text-left ${isDarkMode ? 'bg-[#121A2E] border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-800'}`}>
                    <div className="flex items-center justify-between border-b pb-2 mb-3">
                      <span className="text-xs font-bold uppercase tracking-wider text-blue-500">Alert Center</span>
                      <button type="button" onClick={() => setShowNotifications(false)} className="min-h-11 rounded-lg px-2 text-[10px] text-slate-400 hover:underline">Close</button>
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
          {Object.keys(adminDataIssues).length > 0 && (
            <section className="flex flex-col gap-3 rounded-2xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300 sm:flex-row sm:items-center sm:justify-between" role="alert" aria-labelledby="admin-data-issue-title">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                <div>
                  <h2 id="admin-data-issue-title" className="font-extrabold">Some live administration data is unavailable</h2>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                    {Object.entries(adminDataIssues).map(([key, message]) => <li key={key}>{message}</li>)}
                  </ul>
                </div>
              </div>
              <button type="button" onClick={() => window.location.reload()} className="min-h-11 shrink-0 rounded-xl bg-red-600 px-4 text-xs font-bold text-white hover:bg-red-500">
                Retry dashboard
              </button>
            </section>
          )}
          
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

                <section className={`rounded-3xl border p-5 text-left ${
                  isDarkMode ? 'border-slate-800/70 bg-[#101827]/75' : 'border-slate-200/80 bg-white'
                }`} aria-labelledby="admin-operations-readiness-title">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-blue-500">Production operations</p>
                      <h3 id="admin-operations-readiness-title" className="mt-1 text-base font-extrabold text-slate-900 dark:text-white">Operational readiness</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => void loadOperationsSummary()}
                      disabled={loadingOperationsSummary}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-slate-100 px-4 text-xs font-bold text-slate-700 transition hover:bg-slate-200 disabled:cursor-wait disabled:opacity-60 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                    >
                      <RefreshCw className={`h-4 w-4 ${loadingOperationsSummary ? 'animate-spin' : ''}`} aria-hidden="true" />
                      {loadingOperationsSummary ? 'Refreshing' : 'Refresh operations'}
                    </button>
                  </div>
                  {operationsSummaryError && (
                    <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300" role="alert">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <span>{operationsSummaryError}</span>
                    </div>
                  )}
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-live="polite">
                    <div className="rounded-2xl border border-slate-200/70 p-4 dark:border-slate-800">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Email delivery</span>
                      <strong className={`mt-2 block text-lg ${operationsSummary?.emailNotifications.failed ? 'text-red-500' : operationsSummary?.emailNotifications.retry_pending ? 'text-amber-500' : 'text-emerald-500'}`}>
                        {operationsSummary ? operationsSummary.emailNotifications.failed > 0
                          ? `${operationsSummary.emailNotifications.failed} failed`
                          : operationsSummary.emailNotifications.retry_pending > 0
                            ? `${operationsSummary.emailNotifications.retry_pending} retrying`
                            : 'Healthy' : 'Checking…'}
                      </strong>
                      <small className="mt-1 block text-slate-400">{operationsSummary ? `${operationsSummary.emailNotifications.delivered} delivered · ${operationsSummary.emailNotifications.inProgress} processing` : 'Loading delivery status'}</small>
                    </div>
                    <div className="rounded-2xl border border-slate-200/70 p-4 dark:border-slate-800">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Supplier alerts</span>
                      <strong className={`mt-2 block text-lg ${operationsSummary?.supplierAlerts.active ? 'text-amber-500' : 'text-emerald-500'}`}>
                        {operationsSummary ? `${operationsSummary.supplierAlerts.active} active` : 'Checking…'}
                      </strong>
                      <small className="mt-1 block text-slate-400">Open or acknowledged incidents</small>
                    </div>
                    <div className="rounded-2xl border border-slate-200/70 p-4 dark:border-slate-800">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Coupons</span>
                      <strong className="mt-2 block text-lg text-slate-900 dark:text-white">
                        {operationsSummary ? `${operationsSummary.coupons.active} active` : 'Checking…'}
                      </strong>
                      <small className="mt-1 block text-slate-400">{operationsSummary ? `${operationsSummary.coupons.total} configured` : 'Loading private definitions'}</small>
                    </div>
                    <div className="rounded-2xl border border-slate-200/70 p-4 dark:border-slate-800">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">Supplier audit</span>
                      <strong className="mt-2 block text-sm text-slate-900 dark:text-white">
                        {operationsSummary ? formatOperationsTimestamp(operationsSummary.audit.latestSupplierEventAt) : 'Checking…'}
                      </strong>
                      <small className="mt-1 block text-slate-400">Latest immutable supplier event</small>
                    </div>
                  </div>
                  {operationsSummary?.emailNotifications.lastFailure && (
                    <p className="mt-3 text-xs text-red-500" role="status">
                      Latest email failure: {operationsSummary.emailNotifications.lastFailure.message}
                    </p>
                  )}
                </section>

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
                        <AnimatedCounter value={adminSummaryCounts.orders || orders.length} />
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
                        <AnimatedCounter value={adminSummaryCounts.users || customers.length} />
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
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                  <button
                    type="button"
                    onClick={openCreateBrand}
                    className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-blue-500/25 bg-blue-500/10 px-4 py-2.5 text-xs font-bold text-blue-500 transition-colors hover:bg-blue-500/15 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25"
                  >
                    <Award className="h-4 w-4" aria-hidden="true" />
                    <span>Add Brand</span>
                  </button>
                  <button
                  type="button"
                  onClick={() => {
                    setEditingProduct(null);
                    setManualProductRequestId(globalThis.crypto.randomUUID());
                    const categoryId = categories.find((category) => category.isActive !== false)?.id || categories[0]?.id || '';
                    const category = getSelectedCategory(categories, categoryId);
                    setNewProduct({
                      ...createProductDraft(categoryId, ''),
                      specs: applySpecificationTemplate({}, category?.specificationTemplate),
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
              </div>

              <section className={`rounded-2xl border p-4 ${isDarkMode ? 'border-slate-800/60 bg-[#101827]/75' : 'border-slate-200/80 bg-white shadow-xs'}`} aria-labelledby="brand-registry-title">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 id="brand-registry-title" className="text-sm font-extrabold">Brand Registry</h3>
                    <p className="mt-1 text-[11px] text-slate-400">Products can only select brands registered here.</p>
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{brands.length} brands</span>
                </div>
                {brands.length === 0 ? (
                  <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700">
                    No brands registered. Create a brand before publishing a new product.
                  </div>
                ) : (
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {brands.map((brand) => {
                      const productCount = countProductsForBrand(products, brand);
                      return (
                        <div key={brand.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200/70 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/50">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-xs font-bold">{brand.name}</span>
                              <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${brand.isActive !== false ? 'bg-emerald-500/10 text-emerald-500' : 'bg-slate-500/10 text-slate-400'}`}>{brand.isActive !== false ? 'Active' : 'Inactive'}</span>
                            </div>
                            <p className="mt-1 text-[10px] text-slate-400">{brand.id} · {productCount} products</p>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <button type="button" onClick={() => toggleBrandActive(brand)} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-500/20" aria-label={`${brand.isActive !== false ? 'Deactivate' : 'Activate'} ${brand.name}`}><Power className="h-4 w-4" aria-hidden="true" /></button>
                            <button type="button" onClick={() => openEditBrand(brand)} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-blue-500/10 hover:text-blue-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20" aria-label={`Edit ${brand.name}`}><Edit3 className="h-4 w-4" aria-hidden="true" /></button>
                            <button type="button" disabled={productCount > 0} onClick={() => setBrandToDelete(brand)} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/20 disabled:cursor-not-allowed disabled:opacity-30" aria-label={`Delete ${brand.name}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

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
              {hasMoreAdminProducts && (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    onClick={() => { void loadMoreAdminProducts(); }}
                    disabled={loadingMoreAdminProducts}
                    className="min-h-11 rounded-xl bg-blue-600 px-6 text-xs font-bold text-white transition-colors hover:bg-blue-500 disabled:cursor-wait disabled:opacity-60"
                  >
                    {loadingMoreAdminProducts ? 'Loading products...' : 'Load more products'}
                  </button>
                </div>
              )}

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
                          <p className="mt-2 text-[10px] text-slate-400">{normalizeSubcategories(c.subcategories).length} sub categories · {normalizeSpecificationTemplate(c.specificationTemplate).length} specification fields</p>
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
                      {['all', 'pending', 'confirmed', 'processing', 'packed', 'shipped', 'delivered', 'cancelled'].map(status => {
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
                            disabled={loadingMoreAdminOrders || (orderPage === totalPages && !hasMoreAdminOrders)}
                            onClick={() => {
                              if (orderPage < totalPages) {
                                setOrderPage((previous) => previous + 1);
                                return;
                              }
                              void loadMoreAdminOrders().then((loaded) => {
                                if (loaded > 0) setOrderPage((previous) => previous + 1);
                              });
                            }}
                            className="px-3.5 py-1.5 bg-white dark:bg-[#111928] border border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-400 text-[10px] font-bold rounded-xl disabled:opacity-40 transition-colors cursor-pointer"
                          >
                            {loadingMoreAdminOrders ? 'Loading...' : orderPage === totalPages && hasMoreAdminOrders ? 'Load older' : 'Next'}
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
                            <div className="flex flex-wrap items-center justify-end gap-2.5">
                              <div className="text-left">
                                <span className="block text-[9px] text-slate-400 font-bold uppercase tracking-wider">Supplier routing</span>
                                <span className="mt-1 block text-[10px] font-semibold text-slate-500">Managed per fulfilment group below</span>
                              </div>
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
                                  <option value="processing" disabled={Boolean(selectedOrderFulfilment?.groups.length)}>Processing (supplier-derived)</option>
                                  <option value="packed" disabled={Boolean(selectedOrderFulfilment?.groups.length)}>Packed (supplier-derived)</option>
                                  <option value="shipped" disabled={Boolean(selectedOrderFulfilment?.groups.length)}>Shipped (supplier-derived)</option>
                                  <option value="delivered" disabled={Boolean(selectedOrderFulfilment?.groups.length && !selectedOrderFulfilment.groups.every((group) => group.status === 'shipped'))}>Delivered</option>
                                  <option value="cancelled" disabled={Boolean(selectedOrderFulfilment?.groups.some((group) => ['accepted', 'processing', 'packed', 'shipped', 'delivered'].includes(group.status)))}>Cancelled</option>
                                </select>
                                {updatingOrderStatus[selectedOrder.id] && (
                                  <div className="absolute right-3.5 top-2">
                                    <RefreshCw className="h-3.5 w-3.5 animate-spin text-blue-500" />
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>

                          <section aria-labelledby="order-fulfilment-groups-title" className="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/30">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <h4 id="order-fulfilment-groups-title" className="text-xs font-black uppercase tracking-wider text-slate-700 dark:text-slate-200">Fulfilment groups</h4>
                                <p className="mt-1 text-[10px] text-slate-500">Routing is fixed to purchase-time supplier attribution.</p>
                              </div>
                              {loadingOrderFulfilment && <RefreshCw className="h-4 w-4 animate-spin text-blue-500" aria-label="Loading fulfilment groups" />}
                            </div>
                            {orderFulfilmentError && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{orderFulfilmentError}</p>}
                            {selectedOrderFulfilment && !selectedOrderFulfilment.attributionAvailable && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">{selectedOrderFulfilment.message || 'Fulfilment attribution unavailable for this legacy order.'}</p>}
                            {selectedOrderFulfilment?.attributionAvailable && <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              {selectedOrderFulfilment.groups.length ? selectedOrderFulfilment.groups.map((group) => {
                                const operationKey = `supplier-${selectedOrder.id}-${group.groupId}`;
                                const canAssign = group.status === 'unassigned'
                                  && !['pending', 'cancelled', 'delivered'].includes(selectedOrder.status)
                                  && !updatingOrderStatus[operationKey];
                                return <article key={group.groupId} className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-[#111928]">
                                  <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black text-slate-800 dark:text-white">{group.supplierName}</p><p className="mt-1 text-[10px] text-slate-500">{group.lineIds.length} line{group.lineIds.length === 1 ? '' : 's'} · {group.supplierSourceIds.length} source{group.supplierSourceIds.length === 1 ? '' : 's'}</p></div><span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-black uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300">{group.status}</span></div>
                                  <p className="mt-2 break-all text-[9px] text-slate-400">Account: {group.supplierAccountId}</p>
                                  {group.declineReason && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-[10px] text-amber-800">{group.declineReason}</p>}
                                  {group.tracking && <div className="mt-3 rounded-lg border border-emerald-100 bg-emerald-50 p-2 text-[10px] text-slate-700"><p className="font-black uppercase text-emerald-700">Shipment tracking</p><p className="mt-1 font-semibold">{group.tracking.courierName}</p><p className="break-all font-mono">{group.tracking.trackingNumber}</p>{group.tracking.trackingUrl && <a href={group.tracking.trackingUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex font-bold text-blue-700">Track package</a>}{group.status === 'shipped' && <button type="button" onClick={() => void handleCorrectOrderTracking(selectedOrder.id, group)} disabled={Boolean(updatingOrderStatus[`tracking-${selectedOrder.id}-${group.groupId}`])} className="mt-2 block min-h-9 rounded-lg border border-emerald-200 bg-white px-3 font-black text-emerald-800 disabled:opacity-50">Correct tracking</button>}</div>}
                                  {group.status === 'unassigned' && <button type="button" onClick={() => void handleAssignOrderSupplier(selectedOrder.id, group)} disabled={!canAssign} className="mt-3 min-h-10 rounded-xl bg-blue-600 px-3 text-[10px] font-black text-white disabled:opacity-50">{group.declineReason ? 'Reassign purchase supplier' : 'Assign purchase supplier'}</button>}
                                </article>;
                              }) : <p className="text-xs text-slate-500">This order contains internal-fulfilment lines only.</p>}
                            </div>}
                          </section>

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
                              <div className="grid grid-cols-6 gap-1.5 pt-2">
                                {['pending', 'confirmed', 'processing', 'packed', 'shipped', 'delivered'].map((step, idx, arr) => {
                                  const stepsOrder = ['pending', 'confirmed', 'processing', 'packed', 'shipped', 'delivered'];
                                  const currentIdx = stepsOrder.indexOf(selectedOrder.status || 'pending');
                                  const stepIdx = stepsOrder.indexOf(step);
                                  const isCompleted = stepIdx < currentIdx;
                                  const isActive = stepIdx === currentIdx;

                                  // Labels & styling mapping
                                  const stepLabelMap: Record<string, string> = {
                                    pending: 'Pending',
                                    confirmed: 'Confirmed',
                                    processing: 'Processing',
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
                            disabled={loadingMoreAdminUsers || (customerPage === totalPages && !hasMoreAdminUsers)}
                            onClick={() => {
                              if (customerPage < totalPages) {
                                setCustomerPage((previous) => previous + 1);
                                return;
                              }
                              void loadMoreAdminUsers().then((loaded) => {
                                if (loaded > 0) setCustomerPage((previous) => previous + 1);
                              });
                            }}
                            className="px-3.5 py-1.5 bg-white dark:bg-[#111928] border border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-400 text-[10px] font-bold rounded-xl disabled:opacity-40 transition-colors cursor-pointer"
                          >
                            {loadingMoreAdminUsers ? 'Loading...' : customerPage === totalPages && hasMoreAdminUsers ? 'Load more' : 'Next'}
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
                      { id: 'warranty-policy', title: 'Warranty Policy', desc: 'Product-specific coverage and claims guidance.' },
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
                  <BusinessConfigurationEditor settings={settingsForm} setSettings={setSettingsForm} />
                  <PaymentConfigurationPanel />
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-xs sm:p-4">
          <div ref={productModalRef} className="flex max-h-[calc(100dvh-1rem)] w-full max-w-3xl flex-col space-y-4 overflow-y-auto rounded-3xl border border-slate-200/50 bg-white p-4 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928] sm:max-h-[90vh] sm:p-6" role="dialog" aria-modal="true" aria-labelledby="admin-product-modal-title" aria-busy={savingProduct}>

            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center space-x-2">
                <div className="p-2 bg-blue-500/10 text-blue-500 rounded-xl">
                  <Package className="h-5 w-5" />
                </div>
                <div>
                  <h3 id="admin-product-modal-title" className="text-sm font-extrabold font-display text-slate-900 dark:text-white">
                    {editingProduct ? "Modify Listing Details" : "Create Stock Item Record"}
                  </h3>
                  <p className="text-[10px] text-slate-400">Ensure catalog attributes are correct and optimized</p>
                </div>
              </div>
              <button
                ref={productModalCloseRef}
                type="button"
                onClick={() => setShowProductModal(false)}
                disabled={savingProduct}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400 transition-colors hover:text-slate-900 disabled:opacity-50 dark:bg-slate-800 dark:hover:text-white"
                aria-label="Close product editor"
              >
                <X className="h-4.5 w-4.5" aria-hidden="true" />
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
                        onChange={(e) => setNewProduct((previous) => ({ ...previous, name: e.target.value }))}
                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs"
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label className="flex items-center font-bold text-slate-400">
                          Brand <span className="ml-0.5 text-red-500">*</span>
                        </label>
                        <select
                          required
                          value={newProduct.brand || ''}
                          onChange={(event) => setNewProduct((previous) => ({ ...previous, brand: event.target.value }))}
                          className="w-full cursor-pointer rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs transition-colors focus:border-blue-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="">Select a registered brand</option>
                          {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}{brand.isActive === false ? ' (Inactive)' : ''}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="font-bold text-slate-400">Model</label>
                        <input type="text" value={newProduct.model || ''} onChange={(event) => setNewProduct((previous) => ({ ...previous, model: event.target.value }))} placeholder="e.g. WH-1000XM5" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs transition-colors focus:border-blue-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-900" />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label className="font-bold text-slate-400">Barcode</label>
                        <input type="text" inputMode="numeric" value={newProduct.barcode || ''} onChange={(event) => setNewProduct((previous) => ({ ...previous, barcode: event.target.value.replace(/\s/gu, '') }))} placeholder="8–14 digit GTIN" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs transition-colors focus:border-blue-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-900" />
                      </div>
                      <div className="space-y-1">
                        <label className="font-bold text-slate-400">Product Type</label>
                        <input type="text" value={newProduct.productType || ''} onChange={(event) => setNewProduct((previous) => ({ ...previous, productType: event.target.value }))} placeholder="e.g. Wireless Headphones" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs transition-colors focus:border-blue-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-900" />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="font-bold text-slate-400">Short Description</label>
                      <textarea rows={2} value={newProduct.shortDescription || ''} onChange={(event) => setNewProduct((previous) => ({ ...previous, shortDescription: event.target.value }))} placeholder="Concise customer-facing product summary..." className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs transition-colors focus:border-blue-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-900" />
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
                        onChange={(event) => {
                          const category = getSelectedCategory(categories, event.target.value);
                          setNewProduct((previous) => ({
                            ...previous,
                            category: event.target.value,
                            subcategory: '',
                            specs: applySpecificationTemplate(previous.specs, category?.specificationTemplate),
                          }));
                        }}
                        className="w-full px-3 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 transition-colors text-xs cursor-pointer"
                      >
                        {categories.length === 0 && <option value="">No categories available</option>}
                        {categories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}{cat.isActive === false ? ' (Inactive)' : ''}</option>)}
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="flex items-center font-bold text-slate-400">
                        Sub Category {selectedProductSubcategories.length > 0 && <span className="ml-0.5 text-red-500">*</span>}
                      </label>
                      <select
                        value={newProduct.subcategory || ''}
                        disabled={selectedProductSubcategories.length === 0}
                        onChange={(event) => setNewProduct((previous) => ({ ...previous, subcategory: event.target.value }))}
                        className="w-full cursor-pointer rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs transition-colors focus:border-blue-500 focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
                      >
                        <option value="">{selectedProductSubcategories.length === 0 ? 'No sub categories configured' : 'Select a sub category'}</option>
                        {selectedProductSubcategories.map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="font-bold text-slate-400">Tags</label>
                      <input type="text" value={(newProduct.tags || []).join(', ')} onChange={(event) => setNewProduct((previous) => ({ ...previous, tags: event.target.value.split(',') }))} placeholder="audio, wireless, premium" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs transition-colors focus:border-blue-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-900" />
                      <p className="text-[10px] text-slate-400">Separate tags with commas.</p>
                    </div>

                    <div className="space-y-1">
                      <label className="font-bold text-slate-400">Key Features</label>
                      <textarea rows={2} value={(newProduct.keyFeatures || []).join(', ')} onChange={(event) => setNewProduct((previous) => ({ ...previous, keyFeatures: event.target.value.split(',') }))} placeholder="Active noise cancelling, 30-hour battery" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs transition-colors focus:border-blue-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-900" />
                      <p className="text-[10px] text-slate-400">Separate features with commas.</p>
                    </div>

                    <div className="space-y-1">
                      <label className="font-bold text-slate-400">What's Included</label>
                      <textarea rows={2} value={(newProduct.whatsIncluded || []).join(', ')} onChange={(event) => setNewProduct((previous) => ({ ...previous, whatsIncluded: event.target.value.split(',') }))} placeholder="Headphones, carry case, charging cable" className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs transition-colors focus:border-blue-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-900" />
                      <p className="text-[10px] text-slate-400">Separate package items with commas.</p>
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
                          Selling Price (LKR) <span className="font-normal text-slate-400">(Customer Visible)</span> <span className="text-red-500 ml-0.5">*</span>
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
                        <label className="text-slate-400 font-bold">Compare Price <span className="font-normal">(Customer Visible · Optional)</span></label>
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
                      * If the Compare Price is greater than the Selling Price, a discount badge is automatically applied.
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
                          Product ID <span className="text-slate-400 ml-1 font-normal">(Admin Only · Read-Only)</span>
                        </label>
                        <input
                          type="text"
                          readOnly
                          placeholder="Auto-assigned securely on save"
                          value={newProduct.id || ""}
                          disabled
                          className="w-full cursor-not-allowed rounded-xl border border-slate-200 bg-slate-100 px-3 py-2 text-xs font-mono text-slate-500 opacity-75 dark:border-slate-700 dark:bg-slate-900/60"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold flex items-center">
                          Product SKU <span className="text-slate-400 ml-1 font-normal">(Admin Only · Read-Only)</span>
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
                          <span>A secure unique SKU will be assigned by the server on save.</span>
                        </span>
                      )}
                    </div>

                    {editingProduct && (
                      <div className="rounded-lg border border-slate-200 bg-slate-100/70 p-2 text-[10px] text-slate-500 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-400">
                        <span className="font-bold uppercase">Last updated:</span>{' '}
                        {formatAdminTimestamp(editingProduct.updatedAt)}
                      </div>
                    )}

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
                    <p className="text-[10px] text-slate-400">Manual products are fulfilled internally. Supplier routing is established only through an approved Supplier Product Review offer.</p>
                    <div className="grid grid-cols-3 gap-2.5">
                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold">Cost (LKR) <span className="font-normal">(Admin Only)</span></label>
                        <input
                          type="number"
                          value={newProduct.costPrice || ""}
                          onChange={(e) => setNewProduct(prev => ({ ...prev, costPrice: e.target.value ? Number(e.target.value) : undefined }))}
                          className="w-full text-xs px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold">Market (LKR) <span className="font-normal">(Admin Only)</span></label>
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
                    {selectedProductSpecificationTemplate.length > 0 && (
                      <div className="space-y-3 rounded-xl border border-blue-500/15 bg-blue-500/5 p-3">
                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-blue-500">Category Template</span>
                          <p className="mt-1 text-[10px] text-slate-400">These fields are generated from the selected category.</p>
                        </div>
                        {selectedProductSpecificationTemplate.map((field) => (
                          <div key={field.name} className="space-y-1">
                            <label className="flex items-center font-bold text-slate-500 dark:text-slate-300">
                              {field.name}{field.required && <span className="ml-0.5 text-red-500">*</span>}
                            </label>
                            <input
                              type="text"
                              required={field.required}
                              value={newProduct.specs?.[field.name] || ''}
                              onChange={(event) => setNewProduct((previous) => ({
                                ...previous,
                                specs: { ...(previous.specs || {}), [field.name]: event.target.value },
                              }))}
                              className="w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs focus:border-blue-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-900"
                            />
                          </div>
                        ))}
                      </div>
                    )}
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
                    {newProduct.specs && Object.keys(newProduct.specs).some((key) => !selectedProductSpecificationTemplate.some((field) => field.name === key)) && (
                      <div className="pt-2 divide-y divide-slate-100 dark:divide-slate-800/60 text-[10px]">
                        {Object.entries(newProduct.specs).filter(([key]) => !selectedProductSpecificationTemplate.some((field) => field.name === key)).map(([k, v]) => (
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

      {/* --- BRAND REGISTRY MODALS --- */}
      {showBrandModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowBrandModal(false); }}>
          <div className="w-full max-w-md rounded-3xl border border-slate-200/50 bg-white p-6 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928]" role="dialog" aria-modal="true" aria-labelledby="brand-modal-title">
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
              <div>
                <h3 id="brand-modal-title" className="text-sm font-bold text-slate-900 dark:text-white">{editingBrand ? 'Edit Brand' : 'Create Brand'}</h3>
                <p className="mt-1 text-[10px] text-slate-400">Products select brands from this controlled registry.</p>
              </div>
              <button type="button" onClick={() => setShowBrandModal(false)} className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400 hover:text-slate-900 dark:bg-slate-800 dark:hover:text-white" aria-label="Close brand dialog"><X className="h-4 w-4" aria-hidden="true" /></button>
            </div>
            <form onSubmit={handleSaveBrand} className="space-y-4 text-xs">
              <div>
                <label htmlFor="brand-name" className="mb-1 block font-bold uppercase text-slate-400">Brand Name *</label>
                <input id="brand-name" required value={brandDraft.name} onChange={(event) => setBrandDraft((previous) => ({ ...previous, name: event.target.value, id: editingBrand ? previous.id : normalizeBrandId(event.target.value) }))} placeholder="e.g. Sony" className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25 dark:border-slate-700 dark:bg-slate-800" />
              </div>
              <div>
                <label htmlFor="brand-id" className="mb-1 block font-bold uppercase text-slate-400">Brand ID *</label>
                <input id="brand-id" required disabled={Boolean(editingBrand)} value={brandDraft.id} onChange={(event) => setBrandDraft((previous) => ({ ...previous, id: normalizeBrandId(event.target.value) }))} className="min-h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 font-mono disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800" />
              </div>
              <label className="flex min-h-11 items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 dark:border-slate-700 dark:bg-slate-800"><span className="font-bold uppercase text-slate-400">Active</span><input type="checkbox" checked={brandDraft.isActive} onChange={(event) => setBrandDraft((previous) => ({ ...previous, isActive: event.target.checked }))} className="h-4 w-4 accent-blue-600" /></label>
              <button type="submit" disabled={savingBrand} className="min-h-11 w-full rounded-xl bg-blue-600 px-4 font-bold text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60">{savingBrand ? 'Saving...' : editingBrand ? 'Update Brand' : 'Create Brand'}</button>
            </form>
          </div>
        </div>
      )}

      {brandToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs" role="presentation">
          <div className="w-full max-w-sm rounded-3xl border border-slate-200/50 bg-white p-6 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928]" role="alertdialog" aria-modal="true" aria-labelledby="delete-brand-title" aria-describedby="delete-brand-description">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-500"><Trash2 className="h-5 w-5" aria-hidden="true" /></div>
            <h3 id="delete-brand-title" className="mt-4 text-base font-bold text-slate-900 dark:text-white">Delete {brandToDelete.name}?</h3>
            <p id="delete-brand-description" className="mt-2 text-xs leading-relaxed text-slate-500">Only brands that are not referenced by products can be deleted.</p>
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setBrandToDelete(null)} className="min-h-11 rounded-xl border border-slate-200 px-4 text-xs font-bold dark:border-slate-700">Cancel</button>
              <button type="button" onClick={confirmDeleteBrand} disabled={savingBrand} className="min-h-11 rounded-xl bg-red-600 px-4 text-xs font-bold text-white hover:bg-red-700 disabled:cursor-wait disabled:opacity-60">{savingBrand ? 'Deleting...' : 'Delete Brand'}</button>
            </div>
          </div>
        </div>
      )}

      {/* --- ADD CATEGORY MODAL --- */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCategoryModal(); }}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-slate-200/50 bg-white p-6 text-left shadow-2xl dark:border-slate-800 dark:bg-[#111928]" role="dialog" aria-modal="true" aria-labelledby="category-modal-title">
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

              <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700" aria-labelledby="subcategory-editor-title">
                <div>
                  <h4 id="subcategory-editor-title" className="font-bold uppercase text-slate-500">Sub Categories</h4>
                  <p className="mt-1 text-[10px] text-slate-400">Product sub categories remain scoped to this parent category.</p>
                </div>
                <div className="mt-3 space-y-2">
                  {newCategory.subcategories.map((subcategory, index) => (
                    <div key={subcategory.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-xl bg-slate-50 p-2 dark:bg-slate-800/70">
                      <div>
                        <input
                          aria-label={`Sub category name ${index + 1}`}
                          value={subcategory.name}
                          onChange={(event) => setNewCategory((previous) => ({
                            ...previous,
                            subcategories: previous.subcategories.map((item) => item.id === subcategory.id ? { ...item, name: event.target.value } : item),
                          }))}
                          className="min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900"
                        />
                        <span className="mt-1 block font-mono text-[9px] text-slate-400">{subcategory.id}</span>
                      </div>
                      <label className="flex min-h-10 items-center gap-2 text-[10px] font-bold text-slate-500">
                        <input type="checkbox" checked={subcategory.isActive !== false} onChange={(event) => setNewCategory((previous) => ({ ...previous, subcategories: previous.subcategories.map((item) => item.id === subcategory.id ? { ...item, isActive: event.target.checked } : item) }))} className="h-4 w-4 accent-blue-600" />
                        Active
                      </label>
                      <button type="button" onClick={() => removeSubcategoryFromDraft(subcategory.id)} className="flex h-10 w-10 items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/20" aria-label={`Remove ${subcategory.name}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                    </div>
                  ))}
                  {newCategory.subcategories.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 p-3 text-center text-[10px] text-slate-400 dark:border-slate-700">No sub categories configured.</p>}
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input value={subcategoryName} onChange={(event) => setSubcategoryName(event.target.value)} placeholder="e.g. Smartphones" className="min-h-11 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 dark:border-slate-700 dark:bg-slate-800" />
                  <button type="button" onClick={addSubcategoryToDraft} className="min-h-11 rounded-xl bg-slate-900 px-4 font-bold text-white dark:bg-slate-700">Add Sub Category</button>
                </div>
              </section>

              <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700" aria-labelledby="specification-template-title">
                <div>
                  <h4 id="specification-template-title" className="font-bold uppercase text-slate-500">Specification Template</h4>
                  <p className="mt-1 text-[10px] text-slate-400">These fields are generated automatically in the Product Editor.</p>
                </div>
                <div className="mt-3 space-y-2">
                  {newCategory.specificationTemplate.map((field, index) => (
                    <div key={`${field.name}-${index}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-xl bg-slate-50 p-2 dark:bg-slate-800/70">
                      <input aria-label={`Specification name ${index + 1}`} value={field.name} onChange={(event) => setNewCategory((previous) => ({ ...previous, specificationTemplate: previous.specificationTemplate.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) }))} className="min-h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900" />
                      <label className="flex min-h-10 items-center gap-2 text-[10px] font-bold text-slate-500"><input type="checkbox" checked={field.required === true} onChange={(event) => setNewCategory((previous) => ({ ...previous, specificationTemplate: previous.specificationTemplate.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item) }))} className="h-4 w-4 accent-blue-600" />Required</label>
                      <button type="button" onClick={() => setNewCategory((previous) => ({ ...previous, specificationTemplate: previous.specificationTemplate.filter((_, itemIndex) => itemIndex !== index) }))} className="flex h-10 w-10 items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/20" aria-label={`Remove ${field.name}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                    </div>
                  ))}
                  {newCategory.specificationTemplate.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 p-3 text-center text-[10px] text-slate-400 dark:border-slate-700">No specification fields configured.</p>}
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-center">
                  <input value={specificationTemplateName} onChange={(event) => setSpecificationTemplateName(event.target.value)} placeholder="e.g. Battery" className="min-h-11 rounded-lg border border-slate-200 bg-slate-50 px-3 dark:border-slate-700 dark:bg-slate-800" />
                  <label className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 font-bold text-slate-500 dark:border-slate-700"><input type="checkbox" checked={specificationTemplateRequired} onChange={(event) => setSpecificationTemplateRequired(event.target.checked)} className="h-4 w-4 accent-blue-600" />Required</label>
                  <button type="button" onClick={addSpecificationTemplateField} className="min-h-11 rounded-xl bg-slate-900 px-4 font-bold text-white dark:bg-slate-700">Add Field</button>
                </div>
              </section>

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

      {/* --- ARCHIVE CONFIRMATION MODAL --- */}
      {productToDelete && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-100 dark:border-slate-800 rounded-3xl max-w-sm w-full p-6 text-left shadow-2xl space-y-6">
            <div className="mx-auto w-12 h-12 bg-red-50 text-red-600 rounded-2xl flex items-center justify-center border border-red-100 dark:bg-red-500/10 dark:text-red-500 dark:border-red-500/20">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div className="text-center space-y-2">
              <h3 className="font-bold text-slate-900 dark:text-white">Archive stock product?</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                Archive <span className="font-semibold">"{productToDelete.name}"</span>? It will be removed from the active storefront while its Product ID, SKU, and historical references are retained.
              </p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setProductToDelete(null)} className="flex-1 py-2.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-xl cursor-pointer">Cancel</button>
              <button onClick={confirmDeleteProduct} disabled={savingProduct} className="flex-1 rounded-xl bg-red-600 py-2.5 text-xs font-bold text-white hover:bg-red-700 disabled:cursor-wait disabled:opacity-60">{savingProduct ? 'Archiving...' : 'Archive'}</button>
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

    </div>
  );
}
