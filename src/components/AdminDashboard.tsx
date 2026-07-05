import React, { useState, useEffect } from 'react';
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
import { Product, Category, Order, WebsiteSettings } from '../types';
import { CloudinaryUpload } from './CloudinaryUpload';
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, 
  CartesianGrid, Tooltip, PieChart, Pie, Cell, BarChart, Bar, Legend
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';

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
  heroBanners: [
    {
      id: "banner-1",
      badge: "Authorized Distributor",
      title: "Samsung Odyssey OLED G9",
      subtitle: "Redefine Your Gaming Experience",
      description: "The world's first 49\" OLED curved gaming monitor. Experience intense immersion, Quantum Matrix color accuracy, and supercharged 240Hz frame rates.",
      image: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?q=80&w=1200",
      bgGradient: "from-slate-950 via-slate-900 to-indigo-950",
      buttonText: "Order Now"
    },
    {
      id: "banner-2",
      badge: "NEW ARRIVALS",
      title: "Explore Flagship Tech Gadgets",
      subtitle: "Discover High-End Innovations",
      description: "Stay ahead of the curve with cutting-edge wearables, immersive sound systems, and premium hardware imported direct to Sri Lanka.",
      image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=1200",
      bgGradient: "from-black via-zinc-900 to-slate-950",
      buttonText: "Explore Now"
    },
    {
      id: "banner-3",
      badge: "SMART ENERGY",
      title: "Premium Solar Inverters",
      subtitle: "Power Freedom for Your Home",
      description: "Harness clean unlimited solar energy with premium hybrid smart inverters and lifepo4 lithium storage units fully installed with local warranty.",
      image: "https://images.unsplash.com/photo-1509391366360-2e959784a276?q=80&w=1200",
      bgGradient: "from-slate-950 via-zinc-900 to-blue-950",
      buttonText: "Get Free Quote"
    },
    {
      id: "banner-4",
      badge: "PREMIUM AUDIO",
      title: "Immersive Studio Sound",
      subtitle: "Pure Uncompromising Fidelity",
      description: "Experience premium active noise cancelling headphones, high-definition true wireless earbuds, and professional reference monitors.",
      image: "https://images.unsplash.com/photo-1546868871-7041f2a55e12?q=80&w=1200",
      bgGradient: "from-black via-slate-900 to-zinc-950",
      buttonText: "Shop Audio"
    },
    {
      id: "banner-5",
      badge: "LIFESTYLE LIVING",
      title: "Modern Smart Kitchen Tech",
      subtitle: "Efficiency Meets Elegant Craft",
      description: "Discover intelligent digital air fryers, automatic espresso machines, and smart home appliances that streamline your daily culinary experience.",
      image: "https://images.unsplash.com/photo-1556911220-e15b29be8c8f?q=80&w=1200",
      bgGradient: "from-zinc-950 via-stone-900 to-slate-950",
      buttonText: "Browse Appliances"
    }
  ],
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

const isValidUrl = (url: string) => {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
};

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

interface AdminDashboardProps {
  initialTab?: 'stats' | 'products' | 'categories' | 'orders' | 'customers' | 'pages' | 'settings';
  initialCmsPageId?: string;
}

export default function AdminDashboard({ initialTab = 'stats', initialCmsPageId = 'about-us' }: AdminDashboardProps = {}) {
  const [activeTab, setActiveTab] = useState<'stats' | 'products' | 'categories' | 'orders' | 'customers' | 'pages' | 'settings'>(initialTab);
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
  
  const [newProduct, setNewProduct] = useState<Partial<Product>>({
    name: "", description: "", price: 0, originalPrice: 0, discount: 0,
    imageUrl: "", imageUrls: [], category: "electronics", stock: 10, specs: {},
    isNew: false, isFeatured: false, isBestSeller: false, isActive: true, sku: "",
    supplierItemCode: "", costPrice: undefined, marketPrice: undefined
  });

  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [newCategory, setNewCategory] = useState({ id: "", name: "", icon: "Smartphone", imageUrl: "" });
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
      setCategories(catList);
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
        await setDoc(doc(db, "settings", "website"), DEFAULT_WEBSITE_SETTINGS);
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
    } finally {
      setLoading(false);
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
        if (currentUser.email === 'zyrolkofficial@gmail.com') {
          setAuthorized(true);
        } else {
          const userDoc = await getDoc(doc(db, "users", currentUser.uid));
          if (userDoc.exists() && userDoc.data().role === 'admin') {
            setAuthorized(true);
          } else {
            setAuthorized(false);
            setLoading(false);
          }
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

    loadData();

    return () => {
      unsubscribeOrders();
      unsubscribeReviews();
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
    if (!newProduct.name) {
      showSettingsToast("error", "Product name is required.");
      return;
    }
    if (!newProduct.price || isNaN(Number(newProduct.price)) || Number(newProduct.price) <= 0) {
      showSettingsToast("error", "Please enter a valid sale price.");
      return;
    }
    if (!newProduct.sku) {
      showSettingsToast("error", "Product SKU is required.");
      return;
    }
    if (!newProduct.id) {
      showSettingsToast("error", "Product slug / ID is required.");
      return;
    }

    // Check duplicate SKU
    const isDuplicateSku = products.some(p => p.sku?.trim().toLowerCase() === newProduct.sku?.trim().toLowerCase() && p.id !== newProduct.id);
    if (isDuplicateSku) {
      showSettingsToast("error", `SKU "${newProduct.sku}" is already in use by another product.`);
      return;
    }

    setSavingProduct(true);
    try {
      let disc = 0;
      if (newProduct.originalPrice && newProduct.originalPrice > (newProduct.price || 0)) {
        disc = Math.round(((newProduct.originalPrice - (newProduct.price || 0)) / newProduct.originalPrice) * 100);
      }

      const payload = {
        ...newProduct,
        price: Number(newProduct.price),
        originalPrice: newProduct.originalPrice ? Number(newProduct.originalPrice) : undefined,
        discount: disc || undefined,
        stock: Number(newProduct.stock ?? 0),
        rating: editingProduct ? editingProduct.rating : 5,
        reviewsCount: editingProduct ? editingProduct.reviewsCount : 0,
        isActive: newProduct.isActive !== false,
        sku: newProduct.sku || `SKU-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
        supplierItemCode: newProduct.supplierItemCode || undefined,
        costPrice: newProduct.costPrice ? Number(newProduct.costPrice) : undefined,
        marketPrice: newProduct.marketPrice ? Number(newProduct.marketPrice) : undefined
      };

      if (editingProduct) {
        await updateDoc(doc(db, "products", editingProduct.id), payload);
        showSettingsToast("success", `Product "${newProduct.name}" updated successfully.`);
      } else {
        const pId = newProduct.id || `prod-${Math.random().toString(36).substring(2, 9)}`;
        await setDoc(doc(db, "products", pId), { ...payload, id: pId });
        showSettingsToast("success", `Product "${newProduct.name}" created successfully.`);
      }

      setShowProductModal(false);
      setEditingProduct(null);
      setNewProduct({
        name: "", description: "", price: 0, originalPrice: 0, discount: 0,
        imageUrl: "", imageUrls: [], category: "electronics", stock: 10, specs: {},
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
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    const duplicatedId = `prod-${prod.id.replace('prod-', '')}-${randomSuffix}`;
    const duplicatedSku = prod.sku ? `${prod.sku}-COPY` : `ZY-${randomSuffix.toUpperCase()}`;
    
    setEditingProduct(null);
    setNewProduct({
      ...prod,
      id: duplicatedId,
      sku: duplicatedSku,
      name: `${prod.name} (Copy)`,
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
    if (!authorized || !newCategory.id || !newCategory.name) return;
    try {
      await setDoc(doc(db, "categories", newCategory.id), newCategory);
      setShowCategoryModal(false);
      setNewCategory({ id: "", name: "", icon: "Smartphone", imageUrl: "" });
      loadData();
    } catch (err) {
      console.error("Save category failed:", err);
    }
  };

  const handleUpdateOrderStatus = async (orderId: string, newStatus: string) => {
    if (!authorized) return;
    setUpdatingOrderStatus(prev => ({ ...prev, [orderId]: true }));
    try {
      await updateDoc(doc(db, "orders", orderId), { status: newStatus });
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

  const generatePlaceholderImage = () => {
    const images = [
      "https://images.unsplash.com/photo-1542751371-adc38448a05e?q=80&w=600",
      "https://images.unsplash.com/photo-1546868871-7041f2a55e12?q=80&w=600",
      "https://images.unsplash.com/photo-1572635196237-14b3f281503f?q=80&w=600"
    ];
    setNewProduct(prev => ({ ...prev, imageUrl: images[Math.floor(Math.random() * images.length)] }));
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authorized || !settingsForm) return;

    if (
      (settingsForm.facebookUrl && !isValidUrl(settingsForm.facebookUrl)) ||
      (settingsForm.instagramUrl && !isValidUrl(settingsForm.instagramUrl)) ||
      (settingsForm.tiktokUrl && !isValidUrl(settingsForm.tiktokUrl)) ||
      (settingsForm.youtubeUrl && !isValidUrl(settingsForm.youtubeUrl))
    ) {
      alert("Please fix all invalid social media URLs before saving.");
      return;
    }

    const chargeNum = parseFloat(tempDeliveryCharge);
    const freeMinNum = parseFloat(tempFreeDeliveryMin);
    const updatedSettings: WebsiteSettings = {
      ...settingsForm,
      deliveryCharge: isNaN(chargeNum) ? 0 : chargeNum,
      freeDeliveryMin: isNaN(freeMinNum) ? 0 : freeMinNum
    };

    setSavingSettings(true);
    try {
      await setDoc(doc(db, "settings", "website"), updatedSettings);
      setSettings(updatedSettings);
      setSettingsForm(updatedSettings);
      showSettingsToast("success", "Website settings updated successfully.");
      loadData();
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
    } catch (err) {
      console.error("Banner upload error:", err);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !settingsForm) return;
    try {
      const fileName = `${Date.now()}_logo_${file.name.replace(/[^a-zA-Z0-9.]/g, "_")}`;
      const fileRef = storageRef(storage, `logos/${fileName}`);
      const snapshot = await uploadBytes(fileRef, file);
      const downloadUrl = await getDownloadURL(snapshot.ref);
      setSettingsForm(prev => {
        if (!prev) return prev;
        return { ...prev, logoUrl: downloadUrl };
      });
    } catch (err) {
      console.error("Logo upload error:", err);
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

  const filteredProducts = products.filter(p => {
    const sLower = productSearch.toLowerCase();
    const nameMatch = p.name.toLowerCase().includes(sLower) || (p.sku || "").toLowerCase().includes(sLower) || p.id.toLowerCase().includes(sLower);
    const matchesCategory = productCategoryFilter === "all" || p.category === productCategoryFilter;
    const matchesStock = productStockFilter === "all" || (productStockFilter === "instock" ? p.stock > 0 : p.stock <= 5);
    return nameMatch && matchesCategory && matchesStock;
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
            Please sign in with a registered corporate administrator account (zyrolkofficial@gmail.com) to access administrative transactions.
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
              { id: 'products', label: 'Products Catalog', icon: ShoppingBag },
              { id: 'categories', label: 'Categories', icon: Layers },
              { id: 'orders', label: 'Orders Feed', icon: Clock },
              { id: 'customers', label: 'Customers', icon: Users },
              { id: 'pages', label: 'Pages CMS', icon: FileText },
              { id: 'settings', label: 'Store Settings', icon: Settings }
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
              <p className="text-[10px] text-slate-500 truncate">zyrolkofficial@gmail.com</p>
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
                    setEditingProduct(null);
                    setNewProduct({
                      name: "", description: "", price: 0, originalPrice: 0, discount: 0,
                      imageUrl: "", imageUrls: [], category: "electronics", stock: 10, specs: {},
                      isNew: false, isFeatured: false, isBestSeller: false, isActive: true, sku: "",
                      supplierItemCode: "", costPrice: undefined, marketPrice: undefined
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
                    placeholder="Search name, SKU, or ID..."
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
                    <div key={p.id} className={`rounded-2xl border overflow-hidden flex flex-col justify-between p-5 transition-all hover:shadow-lg ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60' : 'bg-white border-slate-200/80 shadow-xs'}`}>
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
                          <button onClick={() => handleEditProductClick(p)} className="flex-1 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-[11px] font-bold rounded-xl transition-all flex items-center justify-center space-x-1 cursor-pointer">
                            <Edit3 className="h-3.5 w-3.5" />
                            <span>Edit</span>
                          </button>
                          <button onClick={() => handleDuplicateProduct(p)} className="px-2.5 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-blue-600 hover:text-white text-[11px] font-bold rounded-xl transition-all cursor-pointer flex items-center justify-center">
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => setProductToDelete(p)} className="px-2.5 py-2 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white rounded-xl transition-all cursor-pointer flex items-center justify-center">
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
                  onClick={() => {
                    setNewCategory({ id: "", name: "", icon: "Smartphone", imageUrl: "" });
                    setShowCategoryModal(true);
                  }}
                  className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center space-x-1 shadow-md shadow-blue-500/15"
                >
                  <Plus className="h-4 w-4" />
                  <span>Create Category</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {categories.map(c => {
                  const count = products.filter(p => p.category === c.id).length;
                  return (
                    <div key={c.id} className={`rounded-2xl p-5 border flex flex-col justify-between ${isDarkMode ? 'bg-[#101827]/75 border-slate-800/60 shadow-lg' : 'bg-white border-slate-200/80 shadow-xs'}`}>
                      <div className="text-left space-y-3">
                        <div className="w-10 h-10 rounded-xl bg-blue-500/10 text-blue-500 flex items-center justify-center">
                          <Layers className="h-5 w-5" />
                        </div>
                        <div>
                          <h3 className="font-bold text-sm text-slate-800 dark:text-white">{c.name}</h3>
                          <span className="text-[10px] text-slate-400 font-mono">Slug: {c.id}</span>
                        </div>
                      </div>

                      <div className="mt-6 pt-4 border-t border-slate-100 dark:border-slate-800/60 flex items-center justify-between text-xs font-semibold">
                        <span className="text-slate-400">{count} Active Items</span>
                        <span className="text-blue-500">Overview →</span>
                      </div>
                    </div>
                  );
                })}
              </div>

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
                      <button
                        type="button"
                        onClick={() => {
                          const fallback = DEFAULT_PAGES.find(p => p.id === selectedCmsPageId);
                          if (fallback && window.confirm("Are you sure you want to revert all changes and load default system templates for this page?")) {
                            setCmsPageTitle(fallback.title);
                            setCmsPageContent(fallback.content);
                          }
                        }}
                        className="px-4 py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-300 text-xs font-bold rounded-xl transition-all cursor-pointer"
                      >
                        Load Standard Default
                      </button>

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
                      </div>
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold block">Branding Logo Url</label>
                        <input
                          type="text"
                          value={settingsForm.logoUrl}
                          onChange={(e) => setSettingsForm(prev => prev ? ({ ...prev, logoUrl: e.target.value }) : null)}
                          className="w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden"
                        />
                        <div className="mt-1.5 flex items-center space-x-2">
                          <span className="text-[10px] font-bold text-slate-400 uppercase block">Upload File</span>
                          <input
                            type="file"
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
                          type="text"
                          value={tempDeliveryCharge}
                          onChange={(e) => setTempDeliveryCharge(e.target.value)}
                          className="w-full px-3 py-2 bg-slate-100/50 dark:bg-slate-800/60 border border-slate-200/60 dark:border-slate-800 rounded-xl focus:outline-hidden"
                        />
                      </div>
                      <div className="space-y-1 text-xs">
                        <label className="text-slate-400 font-bold block">Free Shipping Threshold Limit (LKR)</label>
                        <input
                          type="text"
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
                  <div className="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800">
                    <span className="block text-[10px] font-black uppercase tracking-widest text-blue-500">Promotional Slider Banners</span>
                    {settingsForm.heroBanners.map((banner, index) => (
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
                        onChange={(e) => setNewProduct(prev => ({ ...prev, name: e.target.value }))}
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
                        {categories.map(cat => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
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
                          onChange={(e) => setNewProduct(prev => ({ ...prev, id: e.target.value.toLowerCase().trim() }))}
                          disabled={!!editingProduct}
                          className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden disabled:opacity-50 text-xs"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-slate-400 font-bold flex items-center">
                          Product SKU <span className="text-red-500 ml-0.5">*</span>
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. ZY-SNY5-BLK"
                          value={newProduct.sku || ""}
                          onChange={(e) => setNewProduct(prev => ({ ...prev, sku: e.target.value.toUpperCase().trim() }))}
                          className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:outline-hidden focus:border-blue-500 text-xs"
                        />
                      </div>
                    </div>

                    {/* SKU Validation Check */}
                    {newProduct.sku && (
                      <div className="mt-1 pb-1">
                        {products.some(p => p.sku?.trim().toLowerCase() === newProduct.sku?.trim().toLowerCase() && p.id !== newProduct.id) ? (
                          <span className="text-[10px] text-red-500 font-semibold flex items-center gap-1 bg-red-500/10 p-2 rounded-lg border border-red-500/20">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span>Duplicate SKU detected! This SKU is already in use by another product.</span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1 bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20">
                            <Check className="h-3.5 w-3.5 shrink-0" />
                            <span>SKU is unique and available.</span>
                          </span>
                        )}
                      </div>
                    )}

                    <div className="space-y-1">
                      <label className="text-slate-400 font-bold flex items-center">
                        Stock Quantity <span className="text-red-500 ml-0.5">*</span>
                      </label>
                      <input
                        type="number"
                        required
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
                    <div className="flex items-center justify-between">
                      <label className="text-slate-400 font-bold flex items-center">
                        Primary Product Image <span className="text-red-500 ml-0.5">*</span>
                      </label>
                      <button 
                        type="button" 
                        onClick={generatePlaceholderImage} 
                        className="text-[10px] text-blue-500 hover:underline font-bold"
                      >
                        Use Random Stock Image
                      </button>
                    </div>

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
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1594322436404-5a0526db4d13?q=80&w=600';
                            }}
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
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111928] border border-slate-200/50 dark:border-slate-800 rounded-3xl max-w-sm w-full p-6 text-left shadow-2xl">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
              <h3 className="text-sm font-bold font-display text-slate-900 dark:text-white">Create Custom Category</h3>
              <button onClick={() => setShowCategoryModal(false)} className="p-1.5 text-slate-400 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 rounded-full">
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveCategory} className="space-y-4 text-xs dark:text-slate-300">
              <div>
                <label className="block text-slate-400 font-bold mb-1 uppercase">Category Slug / ID *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. smart-watches"
                  value={newCategory.id}
                  onChange={(e) => setNewCategory(prev => ({ ...prev, id: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-hidden"
                />
              </div>
              <div>
                <label className="block text-slate-400 font-bold mb-1 uppercase">Display Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Smart Watches"
                  value={newCategory.name}
                  onChange={(e) => setNewCategory(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-hidden"
                />
              </div>
              <button type="submit" className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl transition-all cursor-pointer">
                Save Category
              </button>
            </form>
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

    </div>
  );
}
