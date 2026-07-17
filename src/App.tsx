import React, { Suspense, lazy, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { 
  collection, onSnapshot, doc, getDoc, updateDoc, setDoc 
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { db, auth, handleFirestoreError, OperationType } from './firebase';
import { Product, Category, CartItem, CustomerProduct, WebsiteSettings } from './types';
import { isProductionAdminEmail } from './config/admin';
import { motion } from 'motion/react';
import { projectCustomerProducts } from './services/product-search/customerProjection';
import { searchCustomerProducts } from './services/product-search/customerProductSearch';
import {
  buildCategoryProductCounts,
  categoryMatches,
  getActiveCategories,
  sortCategoriesAlphabetically,
} from './services/categories/categoryUtils';

// Components
import Navbar from './components/Navbar';
import MobileBottomNav from './components/MobileBottomNav';
import HeroBanner from './components/HeroBanner';
import ProductCard from './components/ProductCard';
import ProductFilters from './components/ProductFilters';
import Footer from './components/Footer';
import FloatingWhatsApp from './components/FloatingWhatsApp';
import ProductDetailModal from './components/ProductDetailModal';
import ContactPage from './components/ContactPage';
import MarketplaceHomePhase1 from './components/MarketplaceHomePhase1';

const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const CartDrawer = lazy(() => import('./components/CartDrawer'));
const AuthModal = lazy(() => import('./components/AuthModal'));
const CmsPage = lazy(() => import('./components/CmsPage'));

// Lucide Icons
import { 
  ShieldCheck, Truck, RefreshCw, Star, ArrowRight,
  SlidersHorizontal, ShoppingBag, Phone, Heart, X, Grid3X3
} from 'lucide-react';

const formatPrice = (amount: number) => new Intl.NumberFormat('en-LK', {
  style: 'currency',
  currency: 'LKR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
}).format(amount);

const LazyBlockFallback = ({ className = "" }: { className?: string }) => (
  <div className={`animate-pulse rounded-2xl border border-slate-100 bg-white/80 ${className}`}>
    <div className="h-full min-h-32 w-full rounded-2xl bg-slate-100/70" />
  </div>
);

export default function App() {
  // Page Navigation State
  const [currentPage, setCurrentPage] = useState<string>('home'); // home, products, categories, wishlist, contact, admin
  const [isAdminMode, setIsAdminMode] = useState<boolean>(false);

  // Website Settings
  const [settings, setSettings] = useState<WebsiteSettings | null>(null);

  useEffect(() => {
    if (settings?.storeName?.trim()) document.title = settings.storeName.trim();
    const faviconUrl = settings?.faviconUrl?.trim() || '/favicon.png';
    let favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!favicon) {
      favicon = document.createElement('link');
      favicon.rel = 'icon';
      document.head.appendChild(favicon);
    }
    favicon.href = faviconUrl;
    const appleTouchIcon = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (appleTouchIcon) appleTouchIcon.href = faviconUrl;
  }, [settings?.faviconUrl, settings?.storeName]);

  // Firestore Data States
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [homepageReviews, setHomepageReviews] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Shopping Cart & Wishlist States (Backed by LocalStorage)
  const [cart, setCart] = useState<CartItem[]>(() => {
    const saved = localStorage.getItem('zyro_cart');
    return saved ? JSON.parse(saved) : [];
  });
  const [wishlist, setWishlist] = useState<Product[]>(() => {
    const saved = localStorage.getItem('zyro_wishlist');
    return saved ? JSON.parse(saved) : [];
  });

  // Filtering / Sorting / Search States
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [priceRange, setPriceRange] = useState<number>(1000000); // Slider up to 1M LKR
  const [sortBy, setSortBy] = useState<string>("featured"); // featured, price-asc, price-desc, rating

  // Modal / Drawer Toggles
  const [isCartOpen, setIsCartOpen] = useState<boolean>(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [hasOpenedCart, setHasOpenedCart] = useState<boolean>(false);
  const [hasOpenedAuth, setHasOpenedAuth] = useState<boolean>(false);
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState<boolean>(false);
  const [wishlistFeedback, setWishlistFeedback] = useState<{ productName: string; action: 'added' | 'removed' } | null>(null);
  const wishlistFeedbackTimerRef = useRef<number | null>(null);

  // Auth User State
  const [user, setUser] = useState<User | null>(null);
  const [wishlistLoadedForUser, setWishlistLoadedForUser] = useState<string | null>(null);
  const [cartLoadedForUser, setCartLoadedForUser] = useState<string | null>(null);
  const [isAdminUser, setIsAdminUser] = useState<boolean>(false);
  const [adminInitialTab, setAdminInitialTab] = useState<'stats' | 'products' | 'categories' | 'orders' | 'customers' | 'pages' | 'settings'>('stats');
  const [adminInitialCmsPageId, setAdminInitialCmsPageId] = useState<string>('about-us');

  useEffect(() => () => {
    if (wishlistFeedbackTimerRef.current !== null) {
      window.clearTimeout(wishlistFeedbackTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!isFilterDrawerOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsFilterDrawerOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isFilterDrawerOpen]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        try {
          let loadedWishlist = wishlist;
          let loadedCart = cart;
          if (isProductionAdminEmail(currentUser.email)) {
            setIsAdminMode(true);
            setIsAdminUser(true);
          } else {
            const userDoc = await getDoc(doc(db, "users", currentUser.uid));
            if (userDoc.exists()) {
              setIsAdminMode(false);
              setIsAdminUser(false);
              // Sync user's wishlist from firestore and merge with current guest wishlist
              const userData = userDoc.data();
              if (userData && userData.wishlist && Array.isArray(userData.wishlist)) {
                const cloudWishlist = userData.wishlist as Product[];
                const merged = [...cloudWishlist];
                wishlist.forEach(localItem => {
                  if (!merged.some(cloudItem => cloudItem.id === localItem.id)) {
                    merged.push(localItem);
                  }
                });
                loadedWishlist = merged;
              } else {
                loadedWishlist = wishlist;
              }
              // Sync user's cart from firestore and merge with current guest cart
              if (userData && userData.cart && Array.isArray(userData.cart)) {
                const cloudCart = userData.cart as CartItem[];
                const merged = [...cloudCart];
                cart.forEach(localItem => {
                  const existing = merged.find(cloudItem => cloudItem.product.id === localItem.product.id);
                  if (existing) {
                    existing.quantity = Math.max(existing.quantity, localItem.quantity);
                  } else {
                    merged.push(localItem);
                  }
                });
                loadedCart = merged;
              } else {
                loadedCart = cart;
              }
            } else {
              setIsAdminMode(false);
              setIsAdminUser(false);
            }
          }
          setWishlist(loadedWishlist);
          setCart(loadedCart);
          setWishlistLoadedForUser(currentUser.uid);
          setCartLoadedForUser(currentUser.uid);
          setUser(currentUser);
        } catch (e: any) {
          if (e && (e.message?.includes('offline') || e.message?.includes('network') || e.code === 'unavailable')) {
            console.warn("Information checking admin role offline:", e.message || e);
          } else {
            console.error("Error fetching admin role:", e);
          }
          setIsAdminMode(false);
          setIsAdminUser(false);
          setWishlistLoadedForUser(currentUser.uid);
          setCartLoadedForUser(currentUser.uid);
          setUser(currentUser);
        }
      } else {
        setIsAdminMode(false);
        setIsAdminUser(false);
        setWishlistLoadedForUser(null);
        setCartLoadedForUser(null);
        setUser(null);
      }
    });
    return () => unsubscribe();
  }, []);

  // Sync state changes with localStorage and Firestore
  useEffect(() => {
    // TODO(security): persist minimal cart references after a dedicated checkout compatibility review.
    localStorage.setItem('zyro_cart', JSON.stringify(cart));
    
    const syncCartToFirestore = async () => {
      if (user && cartLoadedForUser === user.uid) {
        try {
          const userRef = doc(db, "users", user.uid);
          const userDoc = await getDoc(userRef);
          if (userDoc.exists()) {
            await updateDoc(userRef, { cart });
          } else {
            await setDoc(userRef, {
              uid: user.uid,
              email: user.email || '',
              displayName: user.displayName || user.email?.split('@')[0] || '',
              role: 'customer',
              createdAt: new Date().toISOString(),
              cart
            });
          }
        } catch (e: any) {
          console.warn("Failed to persist cart online:", e.message || e);
        }
      }
    };
    syncCartToFirestore();
  }, [cart, user, cartLoadedForUser]);

  useEffect(() => {
    localStorage.setItem('zyro_wishlist', JSON.stringify(wishlist));
    
    // Sync to Firestore for authenticated users
    const syncWishlistToFirestore = async () => {
      if (user && wishlistLoadedForUser === user.uid) {
        try {
          const userRef = doc(db, "users", user.uid);
          const userDoc = await getDoc(userRef);
          if (userDoc.exists()) {
            await updateDoc(userRef, { wishlist });
          } else {
            await setDoc(userRef, {
              uid: user.uid,
              email: user.email || '',
              displayName: user.displayName || user.email?.split('@')[0] || '',
              role: 'customer',
              createdAt: new Date().toISOString(),
              wishlist
            });
          }
        } catch (e: any) {
          console.warn("Failed to persist wishlist online:", e.message || e);
        }
      }
    };
    
    syncWishlistToFirestore();
  }, [wishlist, user, wishlistLoadedForUser]);

  // Seeding & Firestore Live Sync
  useEffect(() => {
    let isMounted = true;
    let unsubSettings: (() => void) | null = null;
    let unsubProds: (() => void) | null = null;
    let unsubCats: (() => void) | null = null;
    let unsubReviews: (() => void) | null = null;

    const initApp = async () => {
      if (!isMounted) return;
      
      // Live listener on website settings
      const sUnsub = onSnapshot(doc(db, "settings", "website"), (snap) => {
        if (!isMounted) return;
        if (snap.exists()) {
          const data = snap.data() as WebsiteSettings;
          if (!data.logoUrl || data.logoUrl.trim() === "") {
            data.logoUrl = "/logo.png";
          }
          
          // Sanitize old demo values in local state if they still exist in the Firestore database (no writing back to DB on startup)
          const cleanData = { ...data };
          if (cleanData.contactPhone === "+94 11 234 5678") {
            cleanData.contactPhone = "";
          }
          if (cleanData.contactPhone2 === "+94 77 123 4567") {
            cleanData.contactPhone2 = "";
          }
          if (cleanData.whatsappNumber === "+94771234567") {
            cleanData.whatsappNumber = "";
          }
          if (cleanData.contactAddress === "No. 458, Galle Road, Colombo 03, Sri Lanka") {
            cleanData.contactAddress = "";
          }
          if (cleanData.contactEmail === "support@zyro.lk") {
            cleanData.contactEmail = "";
          }
          setSettings(cleanData);
        }
      });
      if (!isMounted) {
        sUnsub();
      } else {
        unsubSettings = sUnsub;
      }

      // Live listener on products
      const pUnsub = onSnapshot(collection(db, "products"), (snap) => {
        // TODO(security): introduce a customer-safe product DTO in a dedicated data-boundary sprint.
        if (!isMounted) return;
        const prodList: Product[] = [];
        snap.forEach(doc => {
          prodList.push({ id: doc.id, ...doc.data() } as Product);
        });
        setProducts(prodList);
        setLoading(false);
      });
      if (!isMounted) {
        pUnsub();
      } else {
        unsubProds = pUnsub;
      }

      // Live listener on categories
      const cUnsub = onSnapshot(collection(db, "categories"), (snap) => {
        if (!isMounted) return;
        const catList: Category[] = [];
        snap.forEach(doc => {
          catList.push({ id: doc.id, ...doc.data() } as Category);
        });
        setCategories(getActiveCategories(sortCategoriesAlphabetically(catList)));
      });
      if (!isMounted) {
        cUnsub();
      } else {
        unsubCats = cUnsub;
      }

      // Live listener on reviews
      const rUnsub = onSnapshot(collection(db, "reviews"), (snap) => {
        if (!isMounted) return;
        const revList: any[] = [];
        snap.forEach(doc => {
          const d = doc.data();
          if (d.approved !== false) {
            revList.push({ id: doc.id, ...d });
          }
        });
        // sort by createdAt desc
        revList.sort((a, b) => {
          const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return timeB - timeA;
        });
        setHomepageReviews(revList);
      });
      if (!isMounted) {
        rUnsub();
      } else {
        unsubReviews = rUnsub;
      }
    };

    initApp();

    return () => {
      isMounted = false;
      if (unsubSettings) unsubSettings();
      if (unsubProds) unsubProds();
      if (unsubCats) unsubCats();
      if (unsubReviews) unsubReviews();
    };
  }, []);

  // Scroll to top on page change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentPage]);

  useEffect(() => {
    if (isCartOpen) {
      setHasOpenedCart(true);
    }
  }, [isCartOpen]);

  useEffect(() => {
    if (isAuthModalOpen) {
      setHasOpenedAuth(true);
    }
  }, [isAuthModalOpen]);

  // --- CART FUNCTIONS ---
  const handleAddToCart = useCallback((product: Product, qty: number = 1) => {
    if (product.stock <= 0) return;
    setCart(prev => {
      const existing = prev.find(item => item.product.id === product.id);
      if (existing) {
        return prev.map(item => 
          item.product.id === product.id 
            ? { ...item, quantity: Math.min(product.stock, item.quantity + qty) } 
            : item
        );
      }
      return [...prev, { product, quantity: Math.min(product.stock, qty) }];
    });
  }, []);

  const handleBuyNow = (product: Product, quantity: number) => {
    if (product.stock <= 0) return;
    const qtyToUse = Math.min(product.stock, quantity);
    setCart(prev => {
      const existing = prev.find(item => item.product.id === product.id);
      if (existing) {
        return prev.map(item => 
          item.product.id === product.id 
            ? { ...item, quantity: Math.min(product.stock, qtyToUse) } 
            : item
        );
      }
      return [...prev, { product, quantity: qtyToUse }];
    });
    setSelectedProduct(null);
    setIsCartOpen(true);
  };

  const handleUpdateCartQuantity = (productId: string, quantity: number) => {
    setCart(prev => prev.map(item => 
      item.product.id === productId ? { ...item, quantity: Math.min(item.product.stock, quantity) } : item
    ));
  };

  const handleRemoveFromCart = (productId: string) => {
    setCart(prev => prev.filter(item => item.product.id !== productId));
  };

  const handleClearCart = () => {
    setCart([]);
  };

  // --- WISHLIST FUNCTIONS ---
  const handleToggleWishlist = useCallback((product: Product) => {
    const isRemoving = wishlist.some(item => item.id === product.id);
    setWishlist(prev => {
      const isExist = prev.some(item => item.id === product.id);
      if (isExist) {
        return prev.filter(item => item.id !== product.id);
      }
      return [...prev, product];
    });

    setWishlistFeedback({ productName: product.name, action: isRemoving ? 'removed' : 'added' });
    if (wishlistFeedbackTimerRef.current !== null) {
      window.clearTimeout(wishlistFeedbackTimerRef.current);
    }
    wishlistFeedbackTimerRef.current = window.setTimeout(() => setWishlistFeedback(null), 2400);
  }, [wishlist]);

  const handleViewProduct = useCallback((product: Product) => {
    setSelectedProduct(product);
  }, []);

  const customerProducts = useMemo(
    () => projectCustomerProducts(products.filter((product) => product.isActive !== false)),
    [products],
  );

  const handleCustomerSearchSelection = useCallback((product: CustomerProduct) => {
    const sourceProduct = products.find((candidate) => candidate.id === product.id);
    if (sourceProduct) handleViewProduct(sourceProduct);
  }, [handleViewProduct, products]);

  const wishlistProductIds = useMemo(
    () => new Set(wishlist.map(product => product.id)),
    [wishlist]
  );

  // --- FILTERING LOGIC ---
  const filteredProducts = useMemo(() => {
    const matchingCustomerIds = new Set(
      searchCustomerProducts(customerProducts, searchQuery).map((product) => product.id),
    );
    return products.filter(prod => {
      const matchesActive = prod.isActive !== false;
      const matchesSearch = matchingCustomerIds.has(prod.id);
      const matchesCategory = selectedCategory === "all" || categoryMatches(prod.category, selectedCategory);
      const matchesPrice = prod.price <= priceRange;
      return matchesActive && matchesSearch && matchesCategory && matchesPrice;
    }).sort((a, b) => {
      if (sortBy === "price-asc") return a.price - b.price;
      if (sortBy === "price-desc") return b.price - a.price;
      if (sortBy === "rating") return b.rating - a.rating;
      return (b.isFeatured ? 1 : 0) - (a.isFeatured ? 1 : 0); // Featured defaults
    });
  }, [customerProducts, priceRange, products, searchQuery, selectedCategory, sortBy]);

  const activeProducts = useMemo(
    () => products.filter(product => product.isActive !== false),
    [products]
  );
  const activeProductCount = activeProducts.length;

  const featuredProducts = useMemo(
    () => activeProducts.filter(product => product.isFeatured),
    [activeProducts]
  );
  const newArrivalProducts = useMemo(
    () => activeProducts.filter(product => product.isNew).slice(0, 8),
    [activeProducts]
  );
  const bestSellerProducts = useMemo(
    () => activeProducts.filter(product => product.isBestSeller).slice(0, 8),
    [activeProducts]
  );
  const latestProducts = useMemo(() => [...activeProducts].sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (dateB !== dateA) return dateB - dateA;
    return b.id.localeCompare(a.id);
  }), [activeProducts]);
  const discountedProducts = useMemo(
    () => activeProducts.filter(product => (
      Boolean(product.discount && product.discount > 0) &&
      typeof product.originalPrice === 'number' &&
      product.originalPrice > product.price
    )).slice(0, 8),
    [activeProducts]
  );
  const trendingProducts = useMemo(() => {
    const dealIds = new Set(discountedProducts.map(product => product.id));
    return featuredProducts.filter(product => !dealIds.has(product.id)).slice(0, 8);
  }, [discountedProducts, featuredProducts]);
  const recommendedProducts = useMemo(() => {
    const usedIds = new Set([
      ...discountedProducts.map(product => product.id),
      ...trendingProducts.map(product => product.id),
    ]);
    return activeProducts.filter(product => !usedIds.has(product.id)).slice(0, 8);
  }, [activeProducts, discountedProducts, trendingProducts]);
  const homepageLatestProducts = useMemo(() => {
    const usedIds = new Set([
      ...discountedProducts.map(product => product.id),
      ...trendingProducts.map(product => product.id),
      ...recommendedProducts.map(product => product.id),
    ]);
    return latestProducts.filter(product => !usedIds.has(product.id)).slice(0, 8);
  }, [discountedProducts, latestProducts, recommendedProducts, trendingProducts]);
  const discountedProductCount = discountedProducts.length;
  const categoryProductCounts = useMemo(
    () => buildCategoryProductCounts(categories, products),
    [categories, products],
  );
  const categoryCounts = useMemo(
    () => Object.fromEntries(categories.map((category) => [category.id, categoryProductCounts[category.id]?.active ?? 0])),
    [categories, categoryProductCounts],
  );
  const storefrontCategories = useMemo(
    () => categories.filter((category) => (categoryCounts[category.id] || 0) > 0),
    [categories, categoryCounts],
  );
  const isCategoriesPageLoading = loading;
  const homepageCategories = useMemo(() => categories.flatMap((category) => {
    const itemsCount = categoryCounts[category.id] || 0;
    if (itemsCount === 0) return [];

    const storedImage = category.imageUrl?.trim();
    const productImage = activeProducts.find(
      product => categoryMatches(product.category, category.id) && Boolean(product.imageUrl?.trim()),
    )?.imageUrl?.trim();
    const image = storedImage || productImage;
    return image ? [{ category, image, itemsCount }] : [];
  }).slice(0, 8), [activeProducts, categories, categoryCounts]);

  const activeFilterCount = Number(Boolean(searchQuery.trim())) +
    Number(selectedCategory !== 'all') +
    Number(priceRange < 1000000) +
    Number(sortBy !== 'featured');

  const clearAllFilters = useCallback(() => {
    setSelectedCategory('all');
    setPriceRange(1000000);
    setSearchQuery('');
    setSortBy('featured');
  }, []);

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 text-slate-800">
      
      {/* Dynamic Header / Navbar */}
      <Navbar 
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        cartCount={cart.reduce((acc, item) => acc + item.quantity, 0)}
        wishlistCount={wishlist.length}
        onOpenCart={() => setIsCartOpen(true)}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        products={customerProducts}
        categories={storefrontCategories}
        isLoading={loading}
        onSelectCategory={setSelectedCategory}
        onSelectProduct={handleCustomerSearchSelection}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
        isAdminMode={isAdminMode}
        setIsAdminMode={setIsAdminMode}
        settings={settings}
        isAdminUser={isAdminUser}
      />

      {/* --- PAGE COMPILING WRAPPER --- */}
      {isAdminMode ? (
        /* Full-screen admin module with internal layouts */
        <Suspense fallback={<LazyBlockFallback className="min-h-screen rounded-none border-0 bg-slate-950" />}>
          <AdminDashboard
            initialTab={adminInitialTab}
            initialCmsPageId={adminInitialCmsPageId}
          />
        </Suspense>
      ) : (
        <div className="flex-1 pb-[calc(7rem+env(safe-area-inset-bottom))] md:pb-0">
          {/* Main Content Pages */}

          {/* PAGE 1: STOREFRONT V2 PHASE 1 */}
          {currentPage === 'home' && (
            <MarketplaceHomePhase1
              settings={settings}
              products={activeProducts}
              categories={storefrontCategories}
              categoryVisuals={homepageCategories}
              discountedProducts={discountedProducts}
              featuredProducts={trendingProducts}
              newArrivalProducts={newArrivalProducts}
              bestSellerProducts={bestSellerProducts}
              recommendedProducts={recommendedProducts}
              reviews={homepageReviews}
              wishlistProductIds={wishlistProductIds}
              loading={loading}
              onExploreProducts={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
              onBrowseCategories={() => setCurrentPage('categories')}
              onSelectCategory={(categoryId) => { setSelectedCategory(categoryId); setCurrentPage('products'); }}
              onAddToCart={handleAddToCart}
              onToggleWishlist={handleToggleWishlist}
              onViewDetail={handleViewProduct}
            />
          )}

          {/* Legacy homepage retained temporarily outside every customer route during Phase 1 validation. */}
          {currentPage === 'legacy-home' && (
            <div className="zy-homepage flex flex-col gap-8 pb-16 animate-fadeIn sm:gap-10">

              {/* Premium Hero Slider Banner */}
              <section className="order-[1] pt-5 sm:pt-7">
                <HeroBanner
                  settings={settings}
                  products={activeProducts}
                  categories={storefrontCategories}
                  onExploreProducts={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                  onBrowseCategories={() => { setCurrentPage('categories'); }}
                />
              </section>

              {!loading && activeProductCount === 0 && (
                <section className="order-[2] mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8" aria-labelledby="catalog-refresh-title">
                  <div className="zy-home-empty-catalog relative overflow-hidden rounded-[2rem] border border-blue-100 bg-white px-6 py-8 text-left shadow-lg sm:px-9 sm:py-10">
                    <div className="relative z-10 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex max-w-2xl items-start gap-4">
                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-brand-blue">
                          <RefreshCw className="h-6 w-6" aria-hidden="true" />
                        </div>
                        <div>
                          <span className="zy-section-eyebrow">Live marketplace update</span>
                          <h2 id="catalog-refresh-title" className="mt-1.5 text-2xl font-black font-display text-slate-950">The catalog is being refreshed</h2>
                          <p className="mt-2 text-sm leading-relaxed text-slate-600">Published products and collections will appear here automatically as soon as they are available.</p>
                        </div>
                      </div>
                      <button type="button" onClick={() => setCurrentPage('contact')} className="zy-button zy-button-primary min-h-12 shrink-0 rounded-2xl px-6 text-sm">
                        Contact customer support
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </section>
              )}

              {/* Categories segment list */}
              {homepageCategories.length > 0 && <section className="zy-market-shelf zy-market-shelf-categories order-[3] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end sm:mb-9">
                  <div className="text-left">
                    <span className="zy-section-eyebrow block mb-2">Curated collections</span>
                    <h2 className="text-2xl sm:text-4xl font-black tracking-tight text-slate-900 font-display">
                      Shop by category
                    </h2>
                    <p className="text-sm text-slate-500 mt-2 max-w-xl">
                      Explore live collections built around how customers shop, from everyday essentials to the latest arrivals.
                    </p>
                  </div>
                  <button 
                    onClick={() => { setCurrentPage('categories'); }}
                    className="zy-button zy-button-outline text-xs px-4 py-2 rounded-full w-fit cursor-pointer"
                  >
                    Browse Categories
                    <ArrowRight className="h-3 w-3" />
                  </button>
                </div>

                <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 pr-5 scrollbar-none sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0 sm:pr-0 md:grid-cols-4 sm:gap-5 md:gap-6">
                  {homepageCategories.map(({ category: cat, image: catImage, itemsCount }, categoryIndex) => {
                    return (
                      <motion.button
                        type="button"
                        key={cat.id}
                        onClick={() => {
                          setSelectedCategory(cat.id);
                          setCurrentPage('products');
                        }}
                        className={`zy-category-card zy-category-collection zy-category-tone-${categoryIndex % 4} group flex h-full w-[76vw] max-w-[280px] flex-none snap-start cursor-pointer flex-col overflow-hidden text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 sm:w-auto sm:max-w-none`}
                        aria-label={`Browse ${cat.name}, ${itemsCount} ${itemsCount === 1 ? 'product' : 'products'}`}
                      >
                        {/* Compact Top Image */}
                        <div className="relative aspect-square w-full overflow-hidden select-none">
                          <img 
                            src={catImage} 
                            alt={cat.name} 
                            className="h-full w-full object-contain p-3 mix-blend-multiply transition-transform duration-500 ease-out group-hover:scale-[1.06] sm:p-4"
                            referrerPolicy="no-referrer"
                            loading="lazy"
                            decoding="async"
                            width="600"
                            height="450"
                          />
                          {/* Soft bottom vignette for image blending */}
                          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/18 via-transparent to-white/20" />
                          <div className="absolute left-3 top-3 zy-badge border-white/70 bg-white/92 text-slate-800 shadow-sm backdrop-blur-sm">
                            {itemsCount} {itemsCount === 1 ? 'product' : 'products'}
                          </div>
                        </div>

                        {/* Text and Count Container */}
                        <div className="flex flex-grow flex-col p-4 text-left sm:p-5">
                          <h4 className="line-clamp-1 font-display text-base font-black text-slate-900 transition-colors duration-200 group-hover:text-brand-blue sm:text-lg">
                            {cat.name}
                          </h4>
                          <p className="mt-1.5 hidden line-clamp-2 text-sm leading-relaxed text-slate-600 sm:block">Explore products available in this collection.</p>
                          <div className="mt-3 flex items-center justify-between">
                            <span className="text-sm text-slate-600 font-semibold">
                              Explore collection
                            </span>
                            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-base font-black text-brand-blue transition-all duration-200 group-hover:translate-x-0.5 group-hover:bg-brand-blue group-hover:text-white">
                              →
                            </span>
                          </div>
                        </div>
                      </motion.button>
                    );
                  })}
                </div>
              </section>}

              {/* Homepage Content Sections */}
              {loading ? (
                <div className="order-[4] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
                  <div className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-4">
                    {[...Array(4)].map((_, idx) => (
                      <div key={idx} className="bg-white border border-slate-100 rounded-2xl p-4 space-y-4 animate-pulse flex flex-col justify-between h-full">
                        <div className="space-y-4">
                          <div className="aspect-square w-full bg-slate-100/70 rounded-xl" />
                          <div className="h-3 bg-slate-100/70 rounded-md w-1/3" />
                          <div className="space-y-2">
                            <div className="h-4 bg-slate-100/70 rounded-md w-full" />
                            <div className="h-4 bg-slate-100/70 rounded-md w-3/4" />
                          </div>
                          <div className="h-3 bg-slate-100/70 rounded-md w-1/4" />
                        </div>
                        <div className="space-y-3 pt-3 border-t border-slate-50">
                          <div className="flex justify-between items-center">
                            <div className="h-5 bg-slate-100/70 rounded-md w-1/2" />
                            <div className="h-3 bg-slate-100/70 rounded-md w-1/4" />
                          </div>
                          <div className="grid grid-cols-2 gap-2 pt-1">
                            <div className="h-9 bg-slate-100/70 rounded-xl w-full" />
                            <div className="h-9 bg-slate-100/70 rounded-xl w-full" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {/* Featured Products Grid */}
                  {trendingProducts.length > 0 && (
                    <section className="zy-market-shelf zy-market-shelf-featured order-[4] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                      <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-8 gap-4">
                        <div className="text-left max-w-2xl">
                          <span className="zy-section-eyebrow zy-section-eyebrow-pill block w-fit">Recommended for you</span>
                          <h2 className="text-2xl sm:text-4xl font-black tracking-tight text-slate-900 font-display mt-2">
                            Trending Products
                          </h2>
                          <p className="text-sm text-slate-500 mt-2">
                            Highlights from the live catalog with clear pricing and convenient shopping actions.
                          </p>
                        </div>
                        <button 
                          onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                          className="zy-button zy-button-outline text-xs px-4 py-2 rounded-full flex items-center cursor-pointer"
                        >
                          View All Products
                          <ArrowRight className="h-4 w-4 ml-1.5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-4 lg:gap-7">
                        {trendingProducts.map((prod) => (
                          <ProductCard 
                            key={prod.id}
                            product={prod}
                            isWishlisted={wishlistProductIds.has(prod.id)}
                            onAddToCart={handleAddToCart}
                            onToggleWishlist={handleToggleWishlist}
                            onViewDetail={handleViewProduct}
                            showWishlist={settings?.enableWishlist !== false}
                            settings={settings}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {/* Premium promotional section */}
                  {discountedProducts.length > 0 && <section className="zy-market-promo-zone zy-flash-deals order-[2] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="mb-5 flex items-end justify-between gap-4 text-left">
                      <div>
                        <span className="inline-flex rounded-full border border-white/25 bg-white/15 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white">Flash Deals</span>
                        <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-900 font-display sm:text-3xl">Shop what’s happening now</h2>
                      </div>
                      <span className="hidden text-xs font-bold text-orange-50 sm:block">Offers from the live catalog</span>
                    </div>
                    {discountedProducts.length > 0 && <div className="grid grid-cols-1 gap-4 sm:gap-5">
                      {[
                        {
                          label: "Hot Deals",
                          title: "Limited-time prices from the live catalog",
                          text: `${discountedProductCount} discounted products available`,
                          icon: RefreshCw,
                          tone: "orange"
                        }
                      ].map((promo) => {
                        const Icon = promo.icon;
                        const toneClasses = promo.tone === "orange"
                          ? "from-orange-500 to-amber-500 text-white"
                          : promo.tone === "slate"
                            ? "from-slate-950 to-slate-800 text-white"
                            : "from-brand-blue to-blue-700 text-white";
                        return (
                          <button
                            key={promo.label}
                            onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                            className={`group relative overflow-hidden rounded-3xl p-6 sm:p-8 text-left shadow-xl transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl cursor-pointer bg-gradient-to-br ${toneClasses}`}
                          >
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.22),transparent_52%)]" />
                            <div className="relative z-10 flex items-start justify-between gap-6">
                              <div className="space-y-3">
                                <span className="inline-flex rounded-full bg-white/15 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white/90 border border-white/20">
                                  {promo.label}
                                </span>
                                <div>
                                  <h3 className="text-xl sm:text-2xl font-black font-display leading-tight">{promo.title}</h3>
                                  <p className="text-sm text-white/75 mt-2 leading-relaxed">{promo.text}</p>
                                </div>
                                <span className="inline-flex items-center text-xs font-black text-white">
                                  Explore now
                                  <ArrowRight className="h-3.5 w-3.5 ml-1.5 transition-transform group-hover:translate-x-1" />
                                </span>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-3">
                                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 border border-white/20">
                                  <Icon className="h-5.5 w-5.5" />
                                </div>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>}
                    <div className="relative z-10 mt-5 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-3 scrollbar-none" aria-label="Discounted products">
                      {discountedProducts.map((prod) => (
                        <div key={prod.id} className="w-[76vw] max-w-[275px] flex-none snap-start sm:w-[275px]">
                          <ProductCard
                            product={prod}
                            isWishlisted={wishlistProductIds.has(prod.id)}
                            onAddToCart={handleAddToCart}
                            onToggleWishlist={handleToggleWishlist}
                            onViewDetail={handleViewProduct}
                            showWishlist={settings?.enableWishlist !== false}
                            settings={settings}
                          />
                        </div>
                      ))}
                    </div>
                  </section>}

                  {/* Brand Why Choose Us Section - Luxury Grid */}
                  <section className="order-[7] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="zy-market-assurance text-white rounded-[2rem] sm:rounded-[2.5rem] p-6 sm:p-8 md:p-12 relative overflow-hidden text-left shadow-2xl">
                      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(29,78,216,0.28)_0,transparent_58%)]"></div>
                      
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center relative z-10">
                        <div className="lg:col-span-4 space-y-4">
                          <span className="text-xs font-extrabold text-blue-300 uppercase tracking-widest">Why choose {settings?.storeName || "Zyro.lk"}?</span>
                          <h3 className="text-2xl sm:text-4xl font-black font-display leading-tight text-white">
                            Why Shop With {settings?.storeName || "Zyro.lk"}?
                          </h3>
                          <p className="text-sm text-slate-300 font-light leading-relaxed">
                            Browse carefully selected products with clear pricing, secure checkout, islandwide delivery, and support before and after ordering.
                          </p>
                          <button 
                            onClick={() => setCurrentPage('contact')}
                            className="zy-button zy-button-primary px-5 py-2.5 text-xs rounded-full cursor-pointer"
                          >
                            Contact Support
                            <ArrowRight className="h-3.5 w-3.5 ml-2" />
                          </button>
                        </div>

                        <div className="lg:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {[
                            { icon: ShieldCheck, title: "Cash on Delivery", text: "Pay when your order arrives." },
                            { icon: Truck, title: "Islandwide Delivery", text: "Fast delivery across Sri Lanka." },
                            { icon: ShoppingBag, title: "Quality Checked Products", text: "Carefully selected supplier products." },
                            { icon: Phone, title: "Friendly Customer Support", text: "WhatsApp assistance before and after purchase." }
                          ].map((item) => {
                            const Icon = item.icon;
                            return (
                              <div key={item.title} className="bg-white/10 p-5 sm:p-6 rounded-3xl border border-white/10 backdrop-blur-xs flex items-start gap-4">
                                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-500/15 text-blue-200 border border-blue-300/10">
                                  <Icon className="h-5 w-5" />
                                </div>
                                <div>
                                  <h4 className="text-sm font-black text-white font-display mb-1">{item.title}</h4>
                                  <p className="text-xs text-slate-300 font-light leading-relaxed">{item.text}</p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* Recommended products use the existing active catalog order. */}
                  {recommendedProducts.length > 0 && (
                    <section className="zy-market-shelf zy-market-shelf-recommended order-[5] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                      <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-8 gap-4">
                        <div className="text-left max-w-2xl">
                          <span className="zy-section-eyebrow zy-section-eyebrow-pill block w-fit">Selected from the live catalog</span>
                          <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900 font-display mt-2">Recommended Picks</h2>
                          <p className="text-sm text-slate-500 mt-2">A quick starting point from products currently available in the marketplace.</p>
                        </div>
                        <button
                          onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                          className="zy-button zy-button-outline text-xs px-4 py-2 rounded-full flex items-center cursor-pointer"
                        >
                          Browse All Products
                          <ArrowRight className="h-4 w-4 ml-1.5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-4 lg:gap-7">
                        {recommendedProducts.map((prod) => (
                          <ProductCard
                            key={prod.id}
                            product={prod}
                            isWishlisted={wishlistProductIds.has(prod.id)}
                            onAddToCart={handleAddToCart}
                            onToggleWishlist={handleToggleWishlist}
                            onViewDetail={handleViewProduct}
                            showWishlist={settings?.enableWishlist !== false}
                            settings={settings}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {/* Latest Products segment */}
                  {homepageLatestProducts.length > 0 && (
                    <section className="zy-market-shelf zy-market-shelf-latest order-[6] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                      <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-8 gap-4">
                        <div className="text-left max-w-2xl">
                          <span className="zy-section-eyebrow zy-section-eyebrow-pill block w-fit">Recently added</span>
                          <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900 font-display mt-2">
                            Latest Products
                          </h2>
                          <p className="text-sm text-slate-500 mt-2">The newest active products available in the storefront.</p>
                        </div>
                        <button 
                          onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                          className="zy-button zy-button-outline text-xs px-4 py-2 rounded-full flex items-center cursor-pointer"
                        >
                          See Full Catalog
                          <ArrowRight className="h-4 w-4 ml-1.5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-4 lg:gap-7">
                        {homepageLatestProducts
                          .map((prod) => (
                            <ProductCard 
                              key={prod.id}
                              product={prod}
                              isWishlisted={wishlistProductIds.has(prod.id)}
                              onAddToCart={handleAddToCart}
                              onToggleWishlist={handleToggleWishlist}
                              onViewDetail={handleViewProduct}
                              showWishlist={settings?.enableWishlist !== false}
                              settings={settings}
                            />
                          ))}
                      </div>
                    </section>
                  )}
                </>
              )}

              {/* Beautiful customer testimonials segment */}
              {homepageReviews.length > 0 && (
                <section className="zy-market-testimonials order-[8] py-16 sm:py-20 text-left border-y border-slate-200/70">
                  <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="text-center space-y-2 mb-12">
                      <span className="zy-section-eyebrow block">Testimonials</span>
                      <h2 className="text-2xl sm:text-4xl font-black tracking-tight text-slate-900 font-display">
                        Verified Customer Feedback
                      </h2>
                      <p className="text-sm text-slate-500 max-w-xl mx-auto">
                        Real storefront reviews help customers choose confidently before ordering.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5 lg:gap-7">
                      {homepageReviews.slice(0, 6).map((rev, idx) => {
                        const nameToUse = rev.customerName || rev.userName || "Verified Buyer";
                        const initials = nameToUse.substring(0, 2).toUpperCase() || "VB";
                        const productName = products.find(p => p.id === rev.productId)?.name || "Verified Purchase";

                        return (
                          <div key={rev.id || idx} className="zy-card zy-card-hover p-6 space-y-4 flex flex-col justify-between">
                            <div className="space-y-4">
                              <div className="flex text-amber-400">
                                {[...Array(5)].map((_, i) => (
                                  <Star 
                                    key={i} 
                                    className={`h-4 w-4 ${i < rev.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} 
                                  />
                                ))}
                              </div>
                              <p className="text-sm text-slate-600 font-light leading-relaxed">
                                "{rev.comment}"
                              </p>
                            </div>
                            <div className="flex items-center space-x-3 pt-4 border-t border-slate-50">
                              <div className="w-10 h-10 bg-blue-50 text-brand-blue rounded-full flex items-center justify-center font-black text-xs font-display flex-shrink-0">
                                {initials}
                              </div>
                              <div className="min-w-0">
                                <span className="text-xs font-bold block text-slate-800 truncate">{nameToUse}</span>
                                <span className="text-[10px] text-slate-400 block truncate">{productName}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              )}

            </div>
          )}

          {/* PAGE 2: PRODUCTS BROWSER */}
          {currentPage === 'products' && (
            <div className="zy-storefront-page zy-catalog-page max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 animate-fadeIn text-left">
              <header className="zy-page-banner mb-8 overflow-hidden rounded-[2rem] px-6 py-8 text-white sm:px-9 sm:py-10">
                <div className="relative z-10 max-w-2xl">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-blue-200">Zyro.lk marketplace</span>
                  <h1 className="mt-2 text-3xl font-black tracking-tight font-display sm:text-5xl">Find your next favourite</h1>
                  <p className="mt-3 text-sm leading-relaxed text-blue-100 sm:text-base">
                    Search, compare and shop across {activeProductCount} currently published {activeProductCount === 1 ? 'product' : 'products'} with live pricing and stock visibility.
                  </p>
                </div>
              </header>
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                
                {/* Left Side Filters Sidebar */}
                <div className="hidden lg:col-span-3 lg:block">
                  <div className="zy-surface zy-filter-panel sticky top-24 p-5">
                    <ProductFilters
                      categories={storefrontCategories}
                      categoryCounts={categoryCounts}
                      activeProductCount={activeProductCount}
                      selectedCategory={selectedCategory}
                      onSelectCategory={setSelectedCategory}
                      priceRange={priceRange}
                      onPriceRangeChange={setPriceRange}
                      sortBy={sortBy}
                      onSortChange={setSortBy}
                      activeFilterCount={activeFilterCount}
                      onClearAll={clearAllFilters}
                      formatPrice={formatPrice}
                      idPrefix="desktop-products"
                    />
                  </div>
                </div>

                {/* Right Side Products Grid listing */}
                <div className="lg:col-span-9 space-y-6">
                  
                  {/* Results summary header */}
                  <div className="zy-surface zy-results-toolbar space-y-4 p-5">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h2 className="text-lg font-black font-display text-slate-950">
                          {selectedCategory === 'all' ? 'Explore All Products' : categories.find(category => category.id === selectedCategory)?.name || selectedCategory.toUpperCase().replace('-', ' ')}
                        </h2>
                        <span className="mt-1 block text-xs font-medium text-slate-500" aria-live="polite">
                          {filteredProducts.length} {filteredProducts.length === 1 ? 'product' : 'products'} available
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsFilterDrawerOpen(true)}
                        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-xs font-black text-slate-800 transition-colors hover:border-brand-blue/30 hover:text-brand-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 lg:hidden"
                        aria-label={`Open product filters${activeFilterCount ? `, ${activeFilterCount} active` : ''}`}
                      >
                        <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                        Filters
                        {activeFilterCount > 0 && <span className="rounded-full bg-brand-blue px-1.5 py-0.5 text-[10px] text-white">{activeFilterCount}</span>}
                      </button>
                    </div>

                    {activeFilterCount > 0 && (
                      <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
                        {searchQuery && (
                          <button type="button" onClick={() => setSearchQuery('')} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-3 text-[11px] font-bold text-brand-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
                            Search: “{searchQuery}” <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                        {selectedCategory !== 'all' && (
                          <button type="button" onClick={() => setSelectedCategory('all')} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-3 text-[11px] font-bold text-brand-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
                            {categories.find(category => category.id === selectedCategory)?.name || selectedCategory.replace('-', ' ')} <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                        {priceRange < 1000000 && (
                          <button type="button" onClick={() => setPriceRange(1000000)} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-3 text-[11px] font-bold text-brand-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
                            Up to {formatPrice(priceRange)} <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                        {sortBy !== 'featured' && (
                          <button type="button" onClick={() => setSortBy('featured')} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-3 text-[11px] font-bold text-brand-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
                            Custom sort <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                        <button type="button" onClick={clearAllFilters} className="min-h-11 rounded-full px-3 text-[11px] font-black text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">Clear all</button>
                      </div>
                    )}
                  </div>

                  {/* Products list or empty state */}
                  {filteredProducts.length === 0 ? (
                    <div className="zy-surface zy-empty-state px-6 py-16 text-center space-y-4">
                      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-50">
                        <SlidersHorizontal className="h-8 w-8 text-slate-400" aria-hidden="true" />
                      </div>
                      <div>
                        <p className="text-base font-black text-slate-900">{activeProductCount === 0 ? 'The catalog is currently empty' : 'No products match your selection'}</p>
                        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-500">
                          {activeProductCount === 0
                            ? 'Published products will appear here as soon as they are available.'
                            : 'Try clearing a filter or searching by product name, brand, model, or category.'}
                        </p>
                      </div>
                      {activeProductCount > 0 && <button
                        type="button"
                        onClick={clearAllFilters}
                        className="zy-button zy-button-primary mx-auto min-h-11 px-5 text-xs focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                      >
                        Clear Filters and View All
                      </button>}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 min-[480px]:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
                      {filteredProducts.map((prod) => (
                        <ProductCard 
                          key={prod.id}
                          product={prod}
                          isWishlisted={wishlistProductIds.has(prod.id)}
                          onAddToCart={handleAddToCart}
                          onToggleWishlist={handleToggleWishlist}
                          onViewDetail={handleViewProduct}
                          showWishlist={settings?.enableWishlist !== false}
                          settings={settings}
                        />
                      ))}
                    </div>
                  )}

                </div>

              </div>
            </div>
          )}

          {currentPage === 'products' && isFilterDrawerOpen && (
            <div className="fixed inset-0 z-[80] lg:hidden" role="dialog" aria-modal="true" aria-labelledby="mobile-filter-title">
              <button
                type="button"
                className="absolute inset-0 bg-slate-950/55 backdrop-blur-sm"
                onClick={() => setIsFilterDrawerOpen(false)}
                aria-label="Close product filters"
              />
              <aside className="zy-mobile-panel absolute inset-y-0 right-0 flex w-[min(92vw,390px)] flex-col bg-white shadow-2xl animate-slideInRight">
                <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                  <div>
                    <h2 id="mobile-filter-title" className="text-lg font-black font-display text-slate-950">Refine Products</h2>
                    <p className="mt-0.5 text-[11px] font-medium text-slate-500">{filteredProducts.length} matching products</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsFilterDrawerOpen(false)}
                    className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 text-slate-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                    aria-label="Close product filters"
                  >
                    <X className="h-5 w-5" aria-hidden="true" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto px-5 py-5">
                  <ProductFilters
                    categories={storefrontCategories}
                    categoryCounts={categoryCounts}
                    activeProductCount={activeProductCount}
                    selectedCategory={selectedCategory}
                    onSelectCategory={setSelectedCategory}
                    priceRange={priceRange}
                    onPriceRangeChange={setPriceRange}
                    sortBy={sortBy}
                    onSortChange={setSortBy}
                    activeFilterCount={activeFilterCount}
                    onClearAll={clearAllFilters}
                    formatPrice={formatPrice}
                    idPrefix="mobile-products"
                  />
                </div>
                <div className="border-t border-slate-200 bg-white px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
                  <button
                    type="button"
                    onClick={() => setIsFilterDrawerOpen(false)}
                    className="zy-button zy-button-primary min-h-12 w-full text-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                  >
                    View {filteredProducts.length} {filteredProducts.length === 1 ? 'Product' : 'Products'}
                  </button>
                </div>
              </aside>
            </div>
          )}

          {/* PAGE 3: CATEGORIES OVERVIEW PAGE */}
          {currentPage === 'categories' && (
            <section
              className="zy-storefront-page zy-categories-page animate-fadeIn text-left"
              aria-labelledby="categories-page-title"
            >
              <div className="zy-categories-shell">
                <header className="zy-categories-intro">
                  <div className="zy-categories-intro-copy">
                    <span className="zy-section-eyebrow zy-categories-eyebrow">Premium collections</span>
                    <h1 id="categories-page-title" className="zy-categories-title">
                      Shop by collection
                    </h1>
                    <p className="zy-categories-description">
                      Discover every live marketplace collection, then explore available products with one simple selection.
                    </p>
                  </div>
                  {!isCategoriesPageLoading && storefrontCategories.length > 0 && (
                    <div className="zy-categories-summary" aria-label={`${storefrontCategories.length} live collections`}>
                      <span className="zy-categories-summary-value">{storefrontCategories.length}</span>
                      <span className="zy-categories-summary-label">
                        Live {storefrontCategories.length === 1 ? 'collection' : 'collections'}
                      </span>
                    </div>
                  )}
                </header>

                {isCategoriesPageLoading ? (
                  <div className="zy-categories-grid" aria-label="Loading shopping collections" aria-busy="true">
                    {Array.from({ length: 6 }, (_, index) => (
                      <div className="zy-category-collection-item" key={`category-skeleton-${index}`} aria-hidden="true">
                        <div className="zy-category-collection-card zy-category-skeleton">
                          <div className="zy-category-skeleton-media" />
                          <div className="zy-category-skeleton-copy">
                            <span className="zy-category-skeleton-line zy-category-skeleton-line-short" />
                            <span className="zy-category-skeleton-line zy-category-skeleton-line-title" />
                            <span className="zy-category-skeleton-line" />
                            <span className="zy-category-skeleton-line zy-category-skeleton-line-cta" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : storefrontCategories.length === 0 ? (
                  <div className="zy-categories-empty" role="status">
                    <div className="zy-categories-empty-icon">
                      <Grid3X3 className="h-7 w-7" aria-hidden="true" />
                    </div>
                    <div>
                      <h2>Collections are being refreshed</h2>
                      <p>Browse all products while new marketplace collections are prepared.</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                      className="zy-button zy-button-primary min-h-12 px-5 text-xs focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                    >
                      Explore All Products
                      <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <div className="zy-categories-grid" role="list" aria-label="Shopping collections">
                    {storefrontCategories.map((cat) => {
                      const itemsCount = categoryCounts[cat.id] || 0;
                      const catImage = cat.imageUrl?.trim() || activeProducts.find(
                        product => categoryMatches(product.category, cat.id) && Boolean(product.imageUrl?.trim()),
                      )?.imageUrl?.trim();

                      return (
                        <div className="zy-category-collection-item" role="listitem" key={cat.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCategory(cat.id);
                              setCurrentPage('products');
                            }}
                            className="zy-category-collection-card group"
                            aria-label={`Explore ${cat.name}, ${itemsCount} ${itemsCount === 1 ? 'product' : 'products'}`}
                          >
                            <div className="zy-category-collection-media">
                              {catImage ? (
                                <img
                                  src={catImage}
                                  alt=""
                                  className="zy-category-collection-image"
                                  referrerPolicy="no-referrer"
                                  loading="lazy"
                                  decoding="async"
                                  width="720"
                                  height="540"
                                />
                              ) : (
                                <div className="zy-category-image-placeholder" aria-hidden="true">
                                  <span className="zy-category-image-placeholder-icon">
                                    <Grid3X3 className="h-8 w-8" />
                                  </span>
                                  <span>Collection image coming soon</span>
                                </div>
                              )}
                              <div className="zy-category-media-shade" aria-hidden="true" />
                              <span className="zy-category-live-badge">Live collection</span>
                            </div>

                            <div className="zy-category-collection-copy">
                              <div className="zy-category-collection-heading">
                                <h2 title={cat.name}>{cat.name}</h2>
                                <span className="zy-category-product-count">
                                  {itemsCount} {itemsCount === 1 ? 'product' : 'products'}
                                </span>
                              </div>
                              <p>Explore live products selected for this marketplace collection.</p>
                              <span className="zy-category-collection-cta" aria-hidden="true">
                                Explore Collection
                                <ArrowRight className="h-4 w-4" />
                              </span>
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* PAGE 4: WISHLIST */}
          {currentPage === 'wishlist' && (
            <div className="zy-storefront-page zy-wishlist-page max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12 animate-fadeIn text-left space-y-8">
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-200 pb-5">
                <div>
                  <span className="zy-section-eyebrow">Saved for later</span>
                  <div className="mt-1.5 flex items-center gap-3">
                    <h1 className="text-2xl sm:text-3xl font-black font-display text-slate-950">Your Wishlist</h1>
                    <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-red-50 px-2 text-xs font-black text-red-600">{wishlist.length}</span>
                  </div>
                  <p className="text-xs text-slate-500 font-medium mt-1.5">Compare saved products and revisit them whenever you are ready.</p>
                </div>
                {wishlist.length > 0 && (
                  <button type="button" onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }} className="zy-button zy-button-outline min-h-11 px-4 text-xs focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
                    Continue Shopping
                    <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>

              {wishlist.length === 0 ? (
                <div className="zy-surface zy-empty-state px-6 py-16 sm:py-20 text-center space-y-5">
                  <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-red-50 text-red-500">
                    <Heart className="h-9 w-9" aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-lg font-black text-slate-950 font-display">Your wishlist is ready for favourites</p>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-500">Tap the heart on any product to keep it here while you compare options.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                    className="zy-button zy-button-primary mx-auto min-h-11 px-5 text-xs focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                  >
                    Explore Products
                    <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 min-[480px]:grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-6">
                  {wishlist.map((prod) => (
                    <ProductCard 
                      key={prod.id}
                      product={prod}
                      isWishlisted={true}
                      onAddToCart={handleAddToCart}
                      onToggleWishlist={handleToggleWishlist}
                      onViewDetail={handleViewProduct}
                      settings={settings}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* PAGE 5: CONTACT PAGE */}
          {currentPage === 'contact' && (
            <ContactPage
              settings={settings}
              isAdmin={isAdminUser}
              onEdit={(pageId) => {
                setAdminInitialTab('pages');
                setAdminInitialCmsPageId(pageId);
                setIsAdminMode(true);
                setCurrentPage('admin');
              }}
            />
          )}

          {/* PAGE 6: CMS DYNAMIC PAGES */}
          {['about-us', 'privacy-policy', 'terms-conditions', 'return-policy', 'faq'].includes(currentPage) && (
            <Suspense fallback={<LazyBlockFallback className="mx-auto my-12 min-h-96 max-w-5xl" />}>
              <CmsPage
                pageId={currentPage}
                onBackToHome={() => setCurrentPage('home')}
                isAdmin={isAdminUser}
                onEdit={(pageId) => {
                  setAdminInitialTab('pages');
                  setAdminInitialCmsPageId(pageId);
                  setIsAdminMode(true);
                  setCurrentPage('admin');
                }}
              />
            </Suspense>
          )}

          {/* Dynamic Footer Block */}
          <Footer settings={settings} setCurrentPage={setCurrentPage} onSelectCategory={setSelectedCategory} categories={storefrontCategories} categoryCounts={categoryCounts} />

        </div>
      )}

      {/* --- FLOATING OVERLAYS & MODALS --- */}

      {/* Floating WhatsApp Chat Button */}
      <FloatingWhatsApp settings={settings} isAdminMode={isAdminMode} />

      {wishlistFeedback && (
        <div className="fixed right-4 top-20 z-[75] max-w-[calc(100vw-2rem)] animate-fadeIn" role="status" aria-live="polite">
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-xl shadow-slate-950/10">
            <div className={`flex h-10 w-10 flex-none items-center justify-center rounded-full ${wishlistFeedback.action === 'added' ? 'bg-red-50 text-red-500' : 'bg-slate-100 text-slate-600'}`}>
              <Heart className={`h-5 w-5 ${wishlistFeedback.action === 'added' ? 'fill-red-500' : ''}`} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-black text-slate-900">{wishlistFeedback.action === 'added' ? 'Saved to wishlist' : 'Removed from wishlist'}</p>
              <p className="mt-0.5 truncate text-[11px] text-slate-500">{wishlistFeedback.productName}</p>
            </div>
          </div>
        </div>
      )}

      {/* Modern Mobile Bottom Navigation Dock & Drawer (Hidden on Desktop) */}
      {!isAdminMode && (
        <MobileBottomNav 
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
          cartCount={cart.reduce((acc, item) => acc + item.quantity, 0)}
          wishlistCount={wishlist.length}
          onOpenCart={() => setIsCartOpen(true)}
          onOpenAuthModal={() => setIsAuthModalOpen(true)}
          user={user}
          isAdminUser={isAdminUser}
          isAdminMode={isAdminMode}
          setIsAdminMode={setIsAdminMode}
          settings={settings}
          categories={storefrontCategories}
          setSelectedCategory={setSelectedCategory}
        />
      )}

      {/* Detail Showcase Modal */}
      {(() => {
        const liveSelectedProduct = selectedProduct ? (products.find(p => p.id === selectedProduct.id) || selectedProduct) : null;
        return liveSelectedProduct ? (
          <ProductDetailModal 
            product={liveSelectedProduct}
            isOpen={!!selectedProduct}
            onClose={() => setSelectedProduct(null)}
            isWishlisted={liveSelectedProduct ? wishlistProductIds.has(liveSelectedProduct.id) : false}
            onAddToCart={handleAddToCart}
            onToggleWishlist={handleToggleWishlist}
            allProducts={products}
            onSelectProduct={setSelectedProduct}
            onBuyNow={handleBuyNow}
            settings={settings}
          />
        ) : null;
      })()}

      {/* Cart Drawer Sliding panel */}
      {hasOpenedCart && (
        <Suspense fallback={null}>
          <CartDrawer
            isOpen={isCartOpen}
            onClose={() => setIsCartOpen(false)}
            cartItems={cart}
            onUpdateQuantity={handleUpdateCartQuantity}
            onRemoveItem={handleRemoveFromCart}
            onClearCart={handleClearCart}
            settings={settings}
            setCurrentPage={setCurrentPage}
          />
        </Suspense>
      )}

      {/* Authentication Gateway */}
      {hasOpenedAuth && (
        <Suspense fallback={null}>
          <AuthModal
            isOpen={isAuthModalOpen}
            onClose={() => setIsAuthModalOpen(false)}
          />
        </Suspense>
      )}

    </div>
  );
}
