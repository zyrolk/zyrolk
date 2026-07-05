import React, { useState, useEffect } from 'react';
import { 
  collection, onSnapshot, doc, getDoc, updateDoc, setDoc 
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { db, seedDatabase, auth, handleFirestoreError, OperationType } from './firebase';
import { Product, Category, CartItem, WebsiteSettings } from './types';
import { motion } from 'motion/react';

// Components
import Navbar from './components/Navbar';
import MobileBottomNav from './components/MobileBottomNav';
import HeroBanner from './components/HeroBanner';
import ProductCard from './components/ProductCard';
import ProductDetailModal from './components/ProductDetailModal';
import CartDrawer from './components/CartDrawer';
import Footer from './components/Footer';
import ContactPage from './components/ContactPage';
import AuthModal from './components/AuthModal';
import AdminDashboard from './components/AdminDashboard';
import CmsPage from './components/CmsPage';
import FloatingWhatsApp from './components/FloatingWhatsApp';

// Lucide Icons
import { 
  ShieldCheck, Truck, RefreshCw, Star, ArrowRight,
  Filter, SlidersHorizontal, ShoppingBag, Phone
} from 'lucide-react';

const CATEGORY_IMAGES: Record<string, string> = {
  electronics: "https://images.unsplash.com/photo-1546868871-7041f2a55e12?q=80&w=600&auto=format&fit=crop",
  "home-kitchen": "https://images.unsplash.com/photo-1556911220-e15b29be8c8f?q=80&w=600&auto=format&fit=crop",
  "solar-lighting": "https://images.unsplash.com/photo-1509391366360-2e959784a276?q=80&w=600&auto=format&fit=crop",
  accessories: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=600&auto=format&fit=crop"
};

const getCategoryImage = (catId: string, productsList: Product[]) => {
  if (CATEGORY_IMAGES[catId]) return CATEGORY_IMAGES[catId];
  const prodImg = productsList.find(p => p.category === catId && p.imageUrl)?.imageUrl;
  if (prodImg) return prodImg;
  return "https://images.unsplash.com/photo-1468495244123-6c6c332eeece?q=80&w=600&auto=format&fit=crop";
};

export default function App() {
  // Page Navigation State
  const [currentPage, setCurrentPage] = useState<string>('home'); // home, products, categories, wishlist, contact, admin
  const [isAdminMode, setIsAdminMode] = useState<boolean>(false);

  // Website Settings
  const [settings, setSettings] = useState<WebsiteSettings | null>(null);

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

  // Auth User State
  const [user, setUser] = useState<User | null>(null);
  const [wishlistLoadedForUser, setWishlistLoadedForUser] = useState<string | null>(null);
  const [cartLoadedForUser, setCartLoadedForUser] = useState<string | null>(null);
  const [isAdminUser, setIsAdminUser] = useState<boolean>(false);
  const [adminInitialTab, setAdminInitialTab] = useState<'stats' | 'products' | 'categories' | 'orders' | 'customers' | 'pages' | 'settings'>('stats');
  const [adminInitialCmsPageId, setAdminInitialCmsPageId] = useState<string>('about-us');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        try {
          let loadedWishlist = wishlist;
          let loadedCart = cart;
          if (currentUser.email === 'zyrolkofficial@gmail.com') {
            setIsAdminMode(true);
            setIsAdminUser(true);
          } else {
            const userDoc = await getDoc(doc(db, "users", currentUser.uid));
            if (userDoc.exists()) {
              if (userDoc.data().role === 'admin') {
                setIsAdminMode(true);
                setIsAdminUser(true);
              } else {
                setIsAdminMode(false);
                setIsAdminUser(false);
              }
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
      // Seed first
      await seedDatabase();
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
        setCategories(catList);
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

  // Format currency
  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('en-LK', {
      style: 'currency',
      currency: 'LKR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  };

  // --- CART FUNCTIONS ---
  const handleAddToCart = (product: Product, qty: number = 1) => {
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
  };

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
  const handleToggleWishlist = (product: Product) => {
    setWishlist(prev => {
      const isExist = prev.some(item => item.id === product.id);
      if (isExist) {
        return prev.filter(item => item.id !== product.id);
      }
      return [...prev, product];
    });
  };

  // --- FILTERING LOGIC ---
  const filteredProducts = products.filter(prod => {
    const matchesActive = prod.isActive !== false;
    const searchLower = searchQuery.toLowerCase().trim();
    const matchesSearch = !searchLower || 
                          (prod.name || "").toLowerCase().includes(searchLower) || 
                          (prod.description || "").toLowerCase().includes(searchLower) ||
                          (prod.sku || "").toLowerCase().includes(searchLower) ||
                          (prod.id || "").toLowerCase().includes(searchLower);
    const matchesCategory = selectedCategory === "all" || 
                            (prod.category && prod.category.toLowerCase().trim() === selectedCategory.toLowerCase().trim());
    const matchesPrice = prod.price <= priceRange;
    return matchesActive && matchesSearch && matchesCategory && matchesPrice;
  }).sort((a, b) => {
    if (sortBy === "price-asc") return a.price - b.price;
    if (sortBy === "price-desc") return b.price - a.price;
    if (sortBy === "rating") return b.rating - a.rating;
    return (b.isFeatured ? 1 : 0) - (a.isFeatured ? 1 : 0); // Featured defaults
  });

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
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
        isAdminMode={isAdminMode}
        setIsAdminMode={setIsAdminMode}
        settings={settings}
        isAdminUser={isAdminUser}
      />

      {/* --- PAGE COMPILING WRAPPER --- */}
      {isAdminMode ? (
        /* Full-screen admin module with internal layouts */
        <AdminDashboard 
          initialTab={adminInitialTab}
          initialCmsPageId={adminInitialCmsPageId}
        />
      ) : (
        <div className="flex-1 pb-24 md:pb-0">
          {/* Main Content Pages */}

          {/* PAGE 1: HOME PAGE */}
          {currentPage === 'home' && (
            <div className="space-y-16 pb-16 animate-fadeIn">
              
              {/* Premium Hero Slider Banner */}
              <HeroBanner settings={settings} onExploreProducts={() => { setCurrentPage('products'); setSelectedCategory('all'); }} />

              {/* Categories segment list */}
              <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 gap-4">
                  <div className="text-left">
                    <span className="text-xs font-extrabold text-brand-blue uppercase tracking-widest block mb-1">Curated collections</span>
                    <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900 font-display">
                      Shop by Electronics Categories
                    </h2>
                  </div>
                  <button 
                    onClick={() => { setCurrentPage('categories'); }}
                    className="text-xs font-bold text-brand-blue hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-4 py-2 rounded-full transition-all w-fit cursor-pointer flex items-center gap-1.5"
                  >
                    View Overview
                    <ArrowRight className="h-3 w-3" />
                  </button>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
                  {categories.slice(0, 4).map((cat) => {
                    const itemsCount = products.filter(p => p.category && p.category.toLowerCase().trim() === cat.id.toLowerCase().trim() && p.isActive !== false).length;
                    const catImage = getCategoryImage(cat.id, products);

                    return (
                      <motion.div 
                        key={cat.id}
                        whileHover={{ y: -4, scale: 1.02 }}
                        whileTap={{ scale: 0.96 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25 }}
                        onClick={() => {
                          setSelectedCategory(cat.id);
                          setCurrentPage('products');
                        }}
                        className="group cursor-pointer bg-white border border-slate-100/80 rounded-2xl md:rounded-3xl overflow-hidden shadow-xs hover:shadow-md hover:border-slate-200/60 transition-all duration-300 flex flex-col h-full"
                      >
                        {/* Compact Top Image */}
                        <div className="relative aspect-[4/3] w-full overflow-hidden bg-slate-900 select-none">
                          <img 
                            src={catImage} 
                            alt={cat.name} 
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ease-out"
                            referrerPolicy="no-referrer"
                          />
                          {/* Soft bottom vignette for image blending */}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent opacity-40" />
                        </div>

                        {/* Text and Count Container */}
                        <div className="p-3 sm:p-4.5 flex flex-col flex-grow text-left">
                          <h4 className="text-xs sm:text-sm md:text-base font-bold text-slate-800 font-display group-hover:text-brand-blue transition-colors duration-200 line-clamp-1">
                            {cat.name}
                          </h4>
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-[10px] sm:text-xs text-slate-400 font-light font-sans tracking-wide">
                              {itemsCount} {itemsCount === 1 ? 'Product' : 'Products'}
                            </span>
                            <span className="text-[10px] font-bold text-brand-blue/80 opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 -translate-x-1 transition-all duration-200 hidden sm:inline-block">
                              →
                            </span>
                          </div>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </section>

              {/* Homepage Content Sections */}
              {loading ? (
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
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
                  {products.filter(p => p.isFeatured && p.isActive !== false).length > 0 && (
                    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                      <div className="flex items-end justify-between mb-8 border-b border-slate-100 pb-4">
                        <div className="text-left">
                          <span className="text-xs font-extrabold text-brand-blue uppercase tracking-widest block">Zyro Exclusive Selection</span>
                          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 font-display mt-1">
                            Featured Electronics
                          </h2>
                        </div>
                        <button 
                          onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                          className="text-sm font-semibold text-brand-blue hover:underline flex items-center cursor-pointer"
                        >
                          View All Products
                          <ArrowRight className="h-4 w-4 ml-1.5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                        {products.filter(p => p.isFeatured && p.isActive !== false).slice(0, 8).map((prod) => (
                          <ProductCard 
                            key={prod.id}
                            product={prod}
                            isWishlisted={wishlist.some(w => w.id === prod.id)}
                            onAddToCart={handleAddToCart}
                            onToggleWishlist={handleToggleWishlist}
                            onViewDetail={(p) => setSelectedProduct(p)}
                            showWishlist={settings?.enableWishlist !== false}
                            settings={settings}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {/* Brand Why Choose Us Section - Luxury Grid */}
                  <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="bg-slate-900 text-white rounded-[2rem] p-8 md:p-12 relative overflow-hidden text-left border border-slate-800">
                      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(29,78,216,0.18)_0,transparent_70%)]"></div>
                      
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center relative z-10">
                        <div className="lg:col-span-5 space-y-4">
                          <span className="text-xs font-extrabold text-blue-400 uppercase tracking-widest">Why shop at {settings?.storeName || "Zyro.lk"}?</span>
                          <h3 className="text-2xl sm:text-3xl font-bold font-display leading-tight text-white">
                            Authorized Warranties & Instant Delivery Guaranteed
                          </h3>
                          <p className="text-sm text-slate-400 font-light leading-relaxed">
                            We pride ourselves on offering 100% genuine electronics products from global tech brands directly to the Sri Lankan consumer market. No hidden charges, pure trust.
                          </p>
                          <button 
                            onClick={() => setCurrentPage('contact')}
                            className="inline-flex items-center px-5 py-2.5 bg-brand-blue hover:bg-blue-700 text-white text-xs font-bold rounded-full transition-colors cursor-pointer"
                          >
                            Visit Showroom
                            <ArrowRight className="h-3.5 w-3.5 ml-2" />
                          </button>
                        </div>

                        <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-3 gap-6 text-center">
                          <div className="bg-slate-800/50 p-6 rounded-2xl border border-white/5 backdrop-blur-xs flex flex-col items-center justify-center">
                            <ShieldCheck className="h-8 w-8 text-blue-400 mb-3" />
                            <h4 className="text-sm font-bold text-white font-display mb-1">Genuine Brands</h4>
                            <p className="text-[11px] text-slate-400 font-light">Direct importer assurance.</p>
                          </div>
                          <div className="bg-slate-800/50 p-6 rounded-2xl border border-white/5 backdrop-blur-xs flex flex-col items-center justify-center">
                            <Truck className="h-8 w-8 text-blue-400 mb-3" />
                            <h4 className="text-sm font-bold text-white font-display mb-1">Fast Shipping</h4>
                            <p className="text-[11px] text-slate-400 font-light">Islandwide secure courier.</p>
                          </div>
                          <div className="bg-slate-800/50 p-6 rounded-2xl border border-white/5 backdrop-blur-xs flex flex-col items-center justify-center">
                            <RefreshCw className="h-8 w-8 text-blue-400 mb-3" />
                            <h4 className="text-sm font-bold text-white font-display mb-1">Easy Swap</h4>
                            <p className="text-[11px] text-slate-400 font-light">7 days exchange policy.</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* New Arrivals segment */}
                  {products.filter(p => p.isNew && p.isActive !== false).length > 0 && (
                    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                      <div className="flex items-end justify-between mb-8 border-b border-slate-100 pb-4">
                        <div className="text-left">
                          <span className="text-xs font-extrabold text-brand-blue uppercase tracking-widest block">Fresh Stock</span>
                          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 font-display mt-1">
                            New Arrivals
                          </h2>
                        </div>
                        <button 
                          onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                          className="text-sm font-semibold text-brand-blue hover:underline flex items-center cursor-pointer"
                        >
                          Browse New Arrivals
                          <ArrowRight className="h-4 w-4 ml-1.5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                        {products.filter(p => p.isNew && p.isActive !== false).slice(0, 8).map((prod) => (
                          <ProductCard 
                            key={prod.id}
                            product={prod}
                            isWishlisted={wishlist.some(w => w.id === prod.id)}
                            onAddToCart={handleAddToCart}
                            onToggleWishlist={handleToggleWishlist}
                            onViewDetail={(p) => setSelectedProduct(p)}
                            showWishlist={settings?.enableWishlist !== false}
                            settings={settings}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {/* Best Sellers Segment */}
                  {products.filter(p => p.isBestSeller && p.isActive !== false).length > 0 && (
                    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                      <div className="flex items-end justify-between mb-8 border-b border-slate-100 pb-4">
                        <div className="text-left">
                          <span className="text-xs font-extrabold text-brand-blue uppercase tracking-widest block">Top Volume Sales</span>
                          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 font-display mt-1">
                            Our Best Sellers
                          </h2>
                        </div>
                        <button 
                          onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                          className="text-sm font-semibold text-brand-blue hover:underline flex items-center cursor-pointer"
                        >
                          Explore Catalog
                          <ArrowRight className="h-4 w-4 ml-1.5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                        {products.filter(p => p.isBestSeller && p.isActive !== false).slice(0, 8).map((prod) => (
                          <ProductCard 
                            key={prod.id}
                            product={prod}
                            isWishlisted={wishlist.some(w => w.id === prod.id)}
                            onAddToCart={handleAddToCart}
                            onToggleWishlist={handleToggleWishlist}
                            onViewDetail={(p) => setSelectedProduct(p)}
                            showWishlist={settings?.enableWishlist !== false}
                            settings={settings}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {/* Latest Products segment */}
                  {products.filter(p => p.isActive !== false).length > 0 && (
                    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                      <div className="flex items-end justify-between mb-8 border-b border-slate-100 pb-4">
                        <div className="text-left">
                          <span className="text-xs font-extrabold text-brand-blue uppercase tracking-widest block">Recently Added</span>
                          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 font-display mt-1">
                            Latest Products
                          </h2>
                        </div>
                        <button 
                          onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                          className="text-sm font-semibold text-brand-blue hover:underline flex items-center cursor-pointer"
                        >
                          See Full Catalog
                          <ArrowRight className="h-4 w-4 ml-1.5" />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                        {[...products]
                          .filter(p => p.isActive !== false)
                          .sort((a, b) => {
                            const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                            const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                            if (dateB !== dateA) return dateB - dateA;
                            return b.id.localeCompare(a.id);
                          })
                          .slice(0, 8)
                          .map((prod) => (
                            <ProductCard 
                              key={prod.id}
                              product={prod}
                              isWishlisted={wishlist.some(w => w.id === prod.id)}
                              onAddToCart={handleAddToCart}
                              onToggleWishlist={handleToggleWishlist}
                              onViewDetail={(p) => setSelectedProduct(p)}
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
                <section className="bg-slate-900/5 py-16 text-left border-y border-slate-100">
                  <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="text-center space-y-2 mb-12">
                      <span className="text-xs font-extrabold text-brand-blue uppercase tracking-widest block">Testimonials</span>
                      <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 font-display">
                        Verified Customer Feedback
                      </h2>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                      {homepageReviews.slice(0, 6).map((rev, idx) => {
                        const nameToUse = rev.customerName || rev.userName || "Verified Buyer";
                        const initials = nameToUse.substring(0, 2).toUpperCase() || "VB";
                        const productName = products.find(p => p.id === rev.productId)?.name || "Verified Purchase";

                        return (
                          <div key={rev.id || idx} className="bg-white p-6 rounded-3xl border border-slate-100/80 shadow-xs space-y-4 flex flex-col justify-between">
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
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 animate-fadeIn text-left">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                
                {/* Left Side Filters Sidebar */}
                <div className="lg:col-span-3 space-y-6">
                  <div className="bg-white border border-slate-100 rounded-3xl p-5 shadow-2xs space-y-6">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                      <h3 className="text-sm font-bold font-display uppercase tracking-wider flex items-center">
                        <Filter className="h-4 w-4 mr-1.5 text-brand-blue" />
                        Filters
                      </h3>
                      <button 
                        onClick={() => {
                          setSelectedCategory("all");
                          setPriceRange(1000000);
                          setSearchQuery("");
                          setSortBy("featured");
                        }}
                        className="text-[10px] font-bold text-red-500 hover:underline"
                      >
                        Reset All
                      </button>
                    </div>

                    {/* Category Filter */}
                    <div className="space-y-2.5">
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest block">Categories</span>
                      <div className="space-y-1.5 text-xs font-medium text-slate-600">
                        <button
                          onClick={() => setSelectedCategory("all")}
                          className={`w-full text-left py-2 px-3 rounded-lg transition-colors cursor-pointer ${
                            selectedCategory === "all" ? 'bg-blue-50 text-brand-blue font-bold' : 'hover:bg-slate-50'
                          }`}
                        >
                          All Categories ({products.filter(p => p.isActive !== false).length})
                        </button>
                        {categories.map(cat => (
                          <button
                            key={cat.id}
                            onClick={() => setSelectedCategory(cat.id)}
                            className={`w-full text-left py-2 px-3 rounded-lg transition-colors cursor-pointer ${
                              selectedCategory === cat.id ? 'bg-blue-50 text-brand-blue font-bold' : 'hover:bg-slate-50'
                            }`}
                          >
                            {cat.name} ({products.filter(p => p.category && p.category.toLowerCase().trim() === cat.id.toLowerCase().trim() && p.isActive !== false).length})
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Price Slider Filter */}
                    <div className="space-y-3.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest block">Max Price</span>
                        <span className="text-xs font-bold text-slate-900">{formatPrice(priceRange)}</span>
                      </div>
                      <input
                        type="range"
                        min="5000"
                        max="1000000"
                        step="5000"
                        value={priceRange}
                        onChange={(e) => setPriceRange(Number(e.target.value))}
                        className="w-full accent-brand-blue h-1.5 bg-slate-100 rounded-lg cursor-pointer"
                      />
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>LKR 5K</span>
                        <span>LKR 1M</span>
                      </div>
                    </div>

                    {/* Quick Order Sorting */}
                    <div className="space-y-2.5">
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest block">Sort Products</span>
                      <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value)}
                        className="w-full text-xs border border-slate-200 bg-slate-50 py-2.5 px-3 rounded-xl focus:outline-hidden"
                      >
                        <option value="featured">Featured Index</option>
                        <option value="price-asc">Price: Low to High</option>
                        <option value="price-desc">Price: High to Low</option>
                        <option value="rating">Average Customer Rating</option>
                      </select>
                    </div>

                  </div>
                </div>

                {/* Right Side Products Grid listing */}
                <div className="lg:col-span-9 space-y-6">
                  
                  {/* Results summary header */}
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white border border-slate-100 rounded-3xl p-5 shadow-2xs">
                    <div>
                      <h2 className="text-lg font-bold font-display text-slate-900">
                        {selectedCategory === 'all' ? 'All Listed Electronics' : selectedCategory.toUpperCase().replace('-', ' ')}
                      </h2>
                      <span className="text-xs text-slate-400 font-light mt-0.5 block">
                        Found {filteredProducts.length} high-fidelity products match.
                      </span>
                    </div>

                    {/* Optional Quick search indicators */}
                    {searchQuery && (
                      <span className="text-xs bg-blue-50 border border-blue-100 px-3 py-1.5 rounded-full text-brand-blue">
                        Search: <span className="font-bold">"{searchQuery}"</span>
                        <button onClick={() => setSearchQuery("")} className="ml-2 font-black text-red-500">×</button>
                      </span>
                    )}
                  </div>

                  {/* Products list or empty state */}
                  {filteredProducts.length === 0 ? (
                    <div className="bg-white border border-slate-100 rounded-3xl p-16 text-center space-y-4">
                      <SlidersHorizontal className="h-12 w-12 text-slate-300 mx-auto" />
                      <p className="text-sm font-medium text-slate-600">No products match your active filter parameters.</p>
                      <button
                        onClick={() => {
                          setSelectedCategory("all");
                          setPriceRange(1000000);
                          setSearchQuery("");
                        }}
                        className="text-xs font-bold text-brand-blue hover:underline"
                      >
                        Clear Filters and View All Products
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                      {filteredProducts.map((prod) => (
                        <ProductCard 
                          key={prod.id}
                          product={prod}
                          isWishlisted={wishlist.some(w => w.id === prod.id)}
                          onAddToCart={handleAddToCart}
                          onToggleWishlist={handleToggleWishlist}
                          onViewDetail={(p) => setSelectedProduct(p)}
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

          {/* PAGE 3: CATEGORIES OVERVIEW PAGE */}
          {currentPage === 'categories' && (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 animate-fadeIn text-left space-y-12">
              <div className="text-center max-w-2xl mx-auto space-y-3">
                <span className="text-xs font-extrabold text-brand-blue uppercase tracking-widest bg-blue-50 px-3.5 py-1.5 rounded-full w-fit mx-auto">
                  Premium Categories
                </span>
                <h1 className="text-3xl sm:text-4xl font-black font-display tracking-tight text-slate-900">
                  Select A Curated Collection
                </h1>
                <p className="text-sm text-slate-500 font-light leading-relaxed max-w-xl mx-auto">
                  Browse high-end direct imports. Choose a category below to filter our high-performance electronic stock instantly.
                </p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {categories.map((cat) => {
                  const itemsCount = products.filter(p => p.category && p.category.toLowerCase().trim() === cat.id.toLowerCase().trim() && p.isActive !== false).length;
                  const catImage = getCategoryImage(cat.id, products);

                  return (
                    <motion.div 
                      key={cat.id}
                      whileHover={{ y: -8, scale: 1.01 }}
                      whileTap={{ scale: 0.99 }}
                      transition={{ type: "spring", stiffness: 300, damping: 22 }}
                      onClick={() => {
                        setSelectedCategory(cat.id);
                        setCurrentPage('products');
                      }}
                      className="group cursor-pointer bg-white border border-slate-100 rounded-[2.5rem] overflow-hidden shadow-sm hover:shadow-xl hover:border-slate-200 transition-all duration-500 grid grid-cols-1 md:grid-cols-12 min-h-[300px]"
                    >
                      {/* Left: Thumbnail card background */}
                      <div className="md:col-span-5 h-56 md:h-full bg-slate-950 overflow-hidden relative">
                        <img 
                          src={catImage} 
                          alt={cat.name} 
                          className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700 ease-out"
                          referrerPolicy="no-referrer"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t md:bg-gradient-to-r from-slate-950/80 via-slate-950/30 to-transparent"></div>
                        
                        {/* Overlay label */}
                        <div className="absolute bottom-4 left-4 md:bottom-6 md:left-6 bg-brand-blue text-white text-[9px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full shadow-md">
                          Direct Import
                        </div>
                      </div>

                      {/* Right: Info panel */}
                      <div className="md:col-span-7 p-6 md:p-8 flex flex-col justify-between text-left">
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold text-brand-blue uppercase tracking-widest bg-blue-50 px-2.5 py-1 rounded-full">
                              Curated Shelf
                            </span>
                            <span className="text-[11px] font-bold text-slate-400">
                              {itemsCount} {itemsCount === 1 ? 'Product' : 'Products'}
                            </span>
                          </div>
                          
                          <h3 className="text-2xl font-black text-slate-900 font-display group-hover:text-brand-blue transition-colors duration-300">
                            {cat.name}
                          </h3>
                          <p className="text-xs text-slate-500 font-light leading-relaxed">
                            Imported solutions with authorized global brand specifications and active local service centers in Sri Lanka.
                          </p>
                        </div>

                        <div className="flex items-center justify-between pt-6 border-t border-slate-100 mt-6 md:mt-0">
                          <span className="text-[11px] font-semibold text-slate-400">Warranty Included</span>
                          <span className="text-xs font-bold text-brand-blue flex items-center gap-1 bg-blue-50/50 group-hover:bg-brand-blue group-hover:text-white px-3.5 py-1.5 rounded-full transition-all duration-300">
                            Explore Collection
                            <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
                          </span>
                        </div>
                      </div>

                    </motion.div>
                  );
                })}
              </div>
            </div>
          )}

          {/* PAGE 4: WISHLIST */}
          {currentPage === 'wishlist' && (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 animate-fadeIn text-left space-y-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
                <div>
                  <h1 className="text-2xl sm:text-3xl font-black font-display text-slate-900">Your Saved Wishlist</h1>
                  <p className="text-xs text-slate-400 font-light mt-1">Review saved products, specifications, and fast dispatch options.</p>
                </div>
              </div>

              {wishlist.length === 0 ? (
                <div className="bg-white border border-slate-100 rounded-3xl p-16 text-center space-y-4">
                  <Star className="h-12 w-12 text-slate-300 mx-auto" />
                  <p className="text-sm font-medium text-slate-600 font-display">No wishlist items saved yet.</p>
                  <button
                    onClick={() => { setCurrentPage('products'); setSelectedCategory('all'); }}
                    className="text-xs font-bold text-brand-blue hover:underline"
                  >
                    Go back to shop premium products
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                  {wishlist.map((prod) => (
                    <ProductCard 
                      key={prod.id}
                      product={prod}
                      isWishlisted={true}
                      onAddToCart={handleAddToCart}
                      onToggleWishlist={handleToggleWishlist}
                      onViewDetail={(p) => setSelectedProduct(p)}
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
          )}

          {/* Dynamic Footer Block */}
          <Footer settings={settings} setCurrentPage={setCurrentPage} onSelectCategory={setSelectedCategory} />

        </div>
      )}

      {/* --- FLOATING OVERLAYS & MODALS --- */}

      {/* Floating WhatsApp Chat Button */}
      <FloatingWhatsApp settings={settings} isAdminMode={isAdminMode} />

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
          categories={categories}
          setSelectedCategory={setSelectedCategory}
        />
      )}

      {/* Detail Showcase Modal */}
      {(() => {
        const liveSelectedProduct = selectedProduct ? (products.find(p => p.id === selectedProduct.id) || selectedProduct) : null;
        return (
          <ProductDetailModal 
            product={liveSelectedProduct}
            isOpen={!!selectedProduct}
            onClose={() => setSelectedProduct(null)}
            isWishlisted={liveSelectedProduct ? wishlist.some(w => w.id === liveSelectedProduct.id) : false}
            onAddToCart={handleAddToCart}
            onToggleWishlist={handleToggleWishlist}
            allProducts={products}
            onSelectProduct={setSelectedProduct}
            onBuyNow={handleBuyNow}
            settings={settings}
          />
        );
      })()}

      {/* Cart Drawer Sliding panel */}
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

      {/* Authentication Gateway */}
      <AuthModal 
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />

    </div>
  );
}
