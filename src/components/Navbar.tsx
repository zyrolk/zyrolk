import React, { useState, useEffect, useMemo } from 'react';
import { 
  Menu, X, Search, Heart, ShoppingBag, User, 
  LayoutDashboard, LogIn, LogOut, ChevronDown,
  ArrowUpRight, Clock3, LoaderCircle, PackageSearch, Tag,
  ShieldCheck, Grid3X3, MessageCircle, MapPin, Bell,
  Ticket, Settings, Headphones, ReceiptText, Home, Sparkles, BarChart3
} from 'lucide-react';
import { auth } from '../firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { Category, CustomerProduct, WebsiteSettings } from '../types';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { searchCustomerProducts } from '../services/product-search/customerProductSearch';
import { normalizeSearchText } from '../services/product-search/productSearchMetadata';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

const RECENT_SEARCHES_KEY = 'zyro_recent_searches';

interface NavbarProps {
  currentPage: string;
  setCurrentPage: (page: string) => void;
  cartCount: number;
  wishlistCount: number;
  onOpenCart: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  products: readonly CustomerProduct[];
  categories: Category[];
  isLoading: boolean;
  onSelectCategory: (categoryId: string) => void;
  onSelectProduct: (product: CustomerProduct) => void;
  onOpenAuthModal: () => void;
  isAdminMode: boolean;
  setIsAdminMode: (admin: boolean) => void;
  settings?: WebsiteSettings | null;
  isAdminUser: boolean;
}

export default function Navbar({
  currentPage,
  setCurrentPage,
  cartCount,
  wishlistCount,
  onOpenCart,
  searchQuery,
  setSearchQuery,
  products,
  categories,
  isLoading,
  onSelectCategory,
  onSelectProduct,
  onOpenAuthModal,
  isAdminMode,
  setIsAdminMode,
  settings,
  isAdminUser
}: NavbarProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [tempSearch, setTempSearch] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const prefersReducedMotion = useReducedMotion();
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const stored = sessionStorage.getItem(RECENT_SEARCHES_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    setTempSearch(searchQuery || "");
  }, [searchQuery]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const updateHeaderState = () => setIsScrolled(window.scrollY > 12);
    updateHeaderState();
    window.addEventListener('scroll', updateHeaderState, { passive: true });
    return () => window.removeEventListener('scroll', updateHeaderState);
  }, []);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-product-search]')) {
        setIsSearchOpen(false);
        setActiveSuggestionIndex(-1);
      }
      if (!target?.closest('[data-account-menu]')) setIsProfileOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsProfileOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const debouncedSearch = useDebouncedValue(tempSearch, 150);
  const normalizedTempSearch = normalizeSearchText(debouncedSearch);
  const matchingProducts = useMemo(() => {
    if (!normalizedTempSearch) return [];
    return searchCustomerProducts(products, normalizedTempSearch).slice(0, 5);
  }, [normalizedTempSearch, products]);

  const matchingCategories = useMemo(() => {
    if (!normalizedTempSearch) return categories.slice(0, 5);
    return categories.filter((category) =>
      category.name.toLowerCase().includes(normalizedTempSearch) ||
      category.id.toLowerCase().includes(normalizedTempSearch)
    ).slice(0, 5);
  }, [categories, normalizedTempSearch]);
  const popularSearches = useMemo(() => Array.from(new Set(
    products.filter((product) => product.isBestSeller).map((product) => product.name),
  )).slice(0, 5), [products]);

  const saveRecentSearch = (query: string) => {
    if (!query) return;
    setRecentSearches((current) => {
      const next = [query, ...current.filter((item) => item.toLowerCase() !== query.toLowerCase())].slice(0, 5);
      try {
        sessionStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
      } catch {
        // Search remains fully functional when session storage is unavailable.
      }
      return next;
    });
  };

  const commitSearch = (query: string) => {
    const normalizedQuery = query.trim();
    setTempSearch(normalizedQuery);
    setSearchQuery(normalizedQuery);
    saveRecentSearch(normalizedQuery);
    setCurrentPage('products');
    setIsAdminMode(false);
    setIsMobileMenuOpen(false);
    setIsSearchOpen(false);
    setActiveSuggestionIndex(-1);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    commitSearch(tempSearch);
  };

  const selectProduct = (product: CustomerProduct) => {
    saveRecentSearch(tempSearch.trim() || product.name);
    onSelectProduct(product);
    setIsMobileMenuOpen(false);
    setIsSearchOpen(false);
    setActiveSuggestionIndex(-1);
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setIsSearchOpen(false);
      setActiveSuggestionIndex(-1);
      return;
    }
    if (matchingProducts.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIsSearchOpen(true);
      setActiveSuggestionIndex((current) => (current + 1) % matchingProducts.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIsSearchOpen(true);
      setActiveSuggestionIndex((current) => current <= 0 ? matchingProducts.length - 1 : current - 1);
    } else if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
      event.preventDefault();
      selectProduct(matchingProducts[activeSuggestionIndex]);
    }
  };

  const handleCategorySuggestion = (categoryId: string) => {
    onSelectCategory(categoryId);
    setSearchQuery('');
    setTempSearch('');
    setCurrentPage('products');
    setIsAdminMode(false);
    setIsMobileMenuOpen(false);
    setIsSearchOpen(false);
  };

  const clearSearch = () => {
    setTempSearch('');
    setSearchQuery('');
    setActiveSuggestionIndex(-1);
    setIsSearchOpen(true);
  };

  const clearRecentSearches = () => {
    try {
      sessionStorage.removeItem(RECENT_SEARCHES_KEY);
    } catch {
      // Keep the in-memory experience functional when storage is unavailable.
    }
    setRecentSearches([]);
  };

  const highlightMatch = (value: string) => {
    if (!normalizedTempSearch) return value;
    const index = value.toLowerCase().indexOf(normalizedTempSearch);
    if (index < 0) return value;
    return (
      <>
        {value.slice(0, index)}
        <mark className="rounded-sm bg-blue-100 px-0.5 text-brand-blue">{value.slice(index, index + normalizedTempSearch.length)}</mark>
        {value.slice(index + normalizedTempSearch.length)}
      </>
    );
  };

  const handleLogout = async () => {
    await signOut(auth);
    setUser(null);
    setIsAdminMode(false);
    setIsProfileOpen(false);
    setCurrentPage('home');
  };

  const isWishlistEnabled = settings?.enableWishlist !== false;

  const navigateToPage = (page: string) => {
    setCurrentPage(page);
    setIsAdminMode(false);
    setIsMobileMenuOpen(false);
    setIsProfileOpen(false);
  };

  const navigateToDeals = () => {
    navigateToPage('home');
    window.setTimeout(() => {
      document.getElementById('phase-one-deals-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
  };

  const navLinks = [
    { id: 'home', label: 'Home', icon: Home, action: () => navigateToPage('home') },
    { id: 'categories', label: 'Categories', icon: Grid3X3, action: () => navigateToPage('categories') },
    { id: 'deals', label: 'Deals', icon: Tag, action: navigateToDeals },
    { id: 'new-arrivals', label: 'New Arrivals', icon: Sparkles, action: () => navigateToPage('products') },
    { id: 'contact', label: 'Contact', icon: MessageCircle, action: () => navigateToPage('contact') }
  ];

  const accountItems = [
    { label: 'My Account', icon: User, action: user ? () => navigateToPage('account') : () => { onOpenAuthModal(); setIsProfileOpen(false); }, pending: false },
    { label: 'Orders', icon: ReceiptText, action: user ? () => navigateToPage('account-orders') : () => { onOpenAuthModal(); setIsProfileOpen(false); }, pending: false },
    ...(isWishlistEnabled ? [{ label: 'Wishlist', icon: Heart, action: () => navigateToPage('wishlist'), pending: false }] : []),
    { label: 'Recently Viewed', icon: Clock3, action: () => navigateToPage('recently-viewed'), pending: false },
    { label: 'Compare Products', icon: BarChart3, action: () => navigateToPage('compare'), pending: false },
    { label: 'Addresses', icon: MapPin, action: user ? () => navigateToPage('account-addresses') : () => { onOpenAuthModal(); setIsProfileOpen(false); }, pending: false },
    { label: 'Notifications', icon: Bell, action: user ? () => navigateToPage('account-settings') : () => { onOpenAuthModal(); setIsProfileOpen(false); }, pending: false },
    { label: 'Coupons', icon: Ticket, action: undefined, pending: true },
    { label: 'Support', icon: Headphones, action: () => navigateToPage('contact'), pending: false },
    { label: 'Settings', icon: Settings, action: user ? () => navigateToPage('account-settings') : () => { onOpenAuthModal(); setIsProfileOpen(false); }, pending: false }
  ];

  const renderSearchBox = (idPrefix: string) => {
    const inputId = `${idPrefix}-product-search`;
    const panelId = `${idPrefix}-search-suggestions`;
    const hasQuery = normalizedTempSearch.length > 0;

    return (
      <form onSubmit={handleSearchSubmit} className="zy-search-shell relative min-w-0 max-w-full w-full" role="search" data-product-search>
        <label htmlFor={inputId} className="sr-only">Search products</label>
        <Search className="pointer-events-none absolute left-4 top-1/2 z-10 h-4.5 w-4.5 -translate-y-1/2 text-slate-500" aria-hidden="true" />
        <input
          id={inputId}
          type="search"
          placeholder="Search products, brands & categories"
          value={tempSearch}
          onChange={(event) => {
            setTempSearch(event.target.value);
            setIsSearchOpen(true);
            setActiveSuggestionIndex(-1);
          }}
          onFocus={() => setIsSearchOpen(true)}
          onKeyDown={handleSearchKeyDown}
          className="zy-input zy-market-search min-h-14 min-w-0 max-w-full w-full rounded-2xl pl-11 pr-32 text-base text-slate-900 transition-all placeholder:text-slate-500 focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isSearchOpen}
          aria-controls={panelId}
          aria-activedescendant={activeSuggestionIndex >= 0 ? `${idPrefix}-product-option-${activeSuggestionIndex}` : undefined}
          autoComplete="off"
        />
        {tempSearch && (
          <button
            type="button"
            onClick={clearSearch}
            className="zy-search-clear absolute right-[5.75rem] top-1/2 z-10 flex h-12 w-10 -translate-y-1/2 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
            aria-label="Clear product search"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <button
          type="submit"
          className="zy-search-submit absolute right-0.5 top-1/2 z-10 flex h-12 min-w-[5.25rem] -translate-y-1/2 items-center justify-center gap-1.5 rounded-xl bg-brand-blue px-3 text-xs font-black text-white shadow-sm transition-all hover:bg-blue-700 active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
          aria-label="Submit product search"
        >
          <span>Search</span>
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </button>

        <AnimatePresence initial={false}>
          {isSearchOpen && (
          <motion.div
            id={panelId}
            className="zy-search-suggestions absolute left-0 right-0 top-[calc(100%+0.65rem)] z-[70] overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_24px_60px_-20px_rgba(15,23,42,0.35)]"
            initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -5, scale: 0.99 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.18, ease: [0.2, 0.75, 0.25, 1] }}
            role="listbox"
            aria-label="Product search suggestions"
          >
            {hasQuery ? (
              <div className="p-2">
                {isLoading ? (
                  <div className="flex items-center gap-3 px-4 py-6 text-sm font-semibold text-slate-600" role="status">
                    <LoaderCircle className="h-5 w-5 animate-spin text-brand-blue" aria-hidden="true" />
                    Loading available products...
                  </div>
                ) : matchingProducts.length > 0 ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between px-3 pb-1 pt-2">
                      <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Matching products</span>
                      <span className="text-[10px] font-bold text-slate-500">Use ↑ ↓ and Enter</span>
                    </div>
                    {matchingProducts.map((product, index) => (
                      <button
                        key={product.id}
                        id={`${idPrefix}-product-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={activeSuggestionIndex === index}
                        onMouseEnter={() => setActiveSuggestionIndex(index)}
                        onClick={() => selectProduct(product)}
                        className={`zy-search-result flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${activeSuggestionIndex === index ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                      >
                        <div className="flex h-11 w-11 flex-none items-center justify-center overflow-hidden rounded-xl border border-slate-100 bg-slate-50 p-1.5">
                          {product.image ? (
                            <img src={product.image} alt="" className="h-full w-full object-contain" referrerPolicy="no-referrer" loading="lazy" decoding="async" width="44" height="44" />
                          ) : (
                            <PackageSearch className="h-5 w-5 text-slate-400" aria-hidden="true" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-black text-slate-900">{highlightMatch(product.name)}</span>
                          {(product.brand || product.model) && (
                            <span className="mt-0.5 block truncate text-[10px] font-semibold text-slate-500">
                              {[product.brand, product.model].filter(Boolean).join(' / ')}
                            </span>
                          )}
                        </div>
                        <div className="flex-none text-right">
                          <span className="block text-xs font-black text-slate-900">LKR {product.sellingPrice.toLocaleString()}</span>
                          <span className={`mt-0.5 block text-[10px] font-bold ${product.stock > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                            {product.stock > 0 ? 'In stock' : 'Out of stock'}
                          </span>
                        </div>
                      </button>
                    ))}
                    <button
                      type="submit"
                      className="mt-1 flex min-h-11 w-full items-center justify-center rounded-2xl bg-slate-950 px-4 text-xs font-black text-white transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                    >
                      View all results for “{tempSearch.trim()}”
                    </button>
                  </div>
                ) : (
                  <div className="px-4 py-7 text-center" role="status">
                    <PackageSearch className="mx-auto h-8 w-8 text-slate-300" aria-hidden="true" />
                    <p className="mt-3 text-sm font-black text-slate-800">No matching products found</p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-500">Try a product name, brand, model, or category.</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4 p-4">
                {recentSearches.length > 0 && (
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
                        <Clock3 className="h-3.5 w-3.5" aria-hidden="true" /> Recent searches
                      </span>
                      <button type="button" onClick={clearRecentSearches} className="min-h-11 rounded-lg px-2 text-[10px] font-black text-brand-blue hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">Clear</button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {recentSearches.map((query) => (
                        <button key={query} type="button" onClick={() => commitSearch(query)} className="min-h-11 rounded-full border border-slate-200 bg-slate-50 px-3 text-xs font-bold text-slate-700 transition-colors hover:border-brand-blue/30 hover:bg-blue-50 hover:text-brand-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
                          {query}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {popularSearches.length > 0 && (
                  <div>
                    <span className="mb-2 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
                      <PackageSearch className="h-3.5 w-3.5" aria-hidden="true" /> Popular searches
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {popularSearches.map((query) => (
                        <button key={query} type="button" onClick={() => commitSearch(query)} className="min-h-12 rounded-full border border-blue-100 bg-blue-50 px-3 text-xs font-bold text-blue-700 transition-colors hover:border-blue-200 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
                          {query}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <span className="mb-2 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
                    <Tag className="h-3.5 w-3.5" aria-hidden="true" /> Browse categories
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {matchingCategories.map((category) => (
                      <button key={category.id} type="button" onClick={() => handleCategorySuggestion(category.id)} className="min-h-11 rounded-full border border-blue-100 bg-blue-50 px-3 text-xs font-black text-brand-blue transition-colors hover:bg-brand-blue hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
                        {category.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {hasQuery && matchingCategories.length > 0 && (
              <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3">
                <span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-slate-500">Browse a category instead</span>
                <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
                  {matchingCategories.map((category) => (
                    <button key={category.id} type="button" onClick={() => handleCategorySuggestion(category.id)} className="min-h-11 flex-none rounded-full border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 hover:border-brand-blue/30 hover:text-brand-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
                      {category.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
          )}
        </AnimatePresence>
      </form>
    );
  };

  return (
    <header className={`zy-market-header sticky top-0 z-50 w-full ${isScrolled ? 'is-scrolled' : ''}`}>
      <div className="zy-market-header-shell mx-auto w-full max-w-[1480px] px-4 sm:px-6 lg:px-8">
        <div className="zy-market-header-row flex h-16 items-center justify-between gap-2 md:h-20 md:gap-3">
          
          {/* Logo */}
          <button type="button" className="zy-brand-button flex min-h-12 flex-shrink-0 items-center rounded-xl cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20" onClick={() => navigateToPage('home')} aria-label="Go to homepage">
            {settings?.logoUrl ? (
              <img 
                src={settings.logoUrl} 
                alt={settings.storeName || "Zyro.lk"} 
                className="h-8 max-w-[150px] object-contain" 
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="text-2xl font-bold tracking-tight text-slate-900 font-display flex items-center">
                {settings?.storeName ? (
                  <>
                    {settings.storeName.split('.')[0]}
                    {settings.storeName.includes('.') && <span className="text-brand-blue">.{settings.storeName.split('.').slice(1).join('.')}</span>}
                  </>
                ) : (
                  <>Zyro<span className="text-brand-blue">.lk</span></>
                )}
              </span>
            )}
          </button>

          {/* Desktop Search Bar */}
          <div className="mx-3 hidden min-w-[18rem] max-w-2xl flex-1 md:flex lg:mx-5">
            {renderSearchBox('desktop')}
          </div>

          {/* Desktop Navigation Links */}
          <nav className="hidden shrink-0 items-center gap-0.5 xl:flex" aria-label="Primary storefront navigation">
            {navLinks.map((link) => (
              <button
                key={link.id}
                onClick={link.action}
                className={`zy-navbar-link min-h-12 rounded-xl px-3 text-xs font-black transition-all cursor-pointer ${
                  currentPage === link.id && !isAdminMode
                    ? 'is-active text-brand-blue'
                    : 'text-slate-600 hover:text-brand-blue'
                }`}
              >
                {link.label}
              </button>
            ))}
          </nav>

          {/* Action Icons */}
          <div className="flex shrink-0 items-center gap-1.5 md:gap-2">

            {/* Wishlist Button */}
            {isWishlistEnabled && (
              <button 
                onClick={() => { setCurrentPage('wishlist'); setIsAdminMode(false); }}
                className="zy-navbar-action relative hidden h-12 w-12 items-center justify-center rounded-2xl text-slate-600 hover:text-red-500 md:flex"
                title="Wishlist"
                aria-label={`Open wishlist with ${wishlistCount} saved ${wishlistCount === 1 ? 'product' : 'products'}`}
                aria-current={currentPage === 'wishlist' ? 'page' : undefined}
              >
                <Heart className={`h-5 w-5 ${currentPage === 'wishlist' ? 'fill-red-500 text-red-500' : ''}`} />
                {wishlistCount > 0 && (
                  <span className="absolute top-0 right-0 inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-bold leading-none text-white bg-red-500 rounded-full shadow-sm">
                    {wishlistCount}
                  </span>
                )}
              </button>
            )}

            {/* Cart Button */}
            <button 
              onClick={onOpenCart}
              className="zy-navbar-action relative flex h-12 w-12 items-center justify-center rounded-2xl text-slate-600 hover:text-brand-blue"
              title="Shopping Cart"
              aria-label={`Open shopping cart with ${cartCount} ${cartCount === 1 ? 'item' : 'items'}`}
            >
              <ShoppingBag className="h-5 w-5" />
              {cartCount > 0 && (
                <span className="absolute top-0 right-0 inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-bold leading-none text-white bg-brand-blue rounded-full shadow-sm">
                  {cartCount}
                </span>
              )}
            </button>

            {/* User Dropdown */}
            <div className="relative hidden md:block" data-account-menu>
              <button
                onClick={() => setIsProfileOpen(!isProfileOpen)}
                className="zy-navbar-action flex h-12 min-w-12 items-center justify-center gap-1 rounded-2xl text-slate-600 hover:text-brand-blue"
                aria-label={user ? 'Open account menu' : 'Open sign in menu'}
                aria-expanded={isProfileOpen}
                aria-controls="desktop-account-menu"
              >
                <User className="h-5 w-5" />
                <ChevronDown className="h-3.5 w-3.5 hidden sm:block" />
              </button>

              {isProfileOpen && (
                <div id="desktop-account-menu" className="zy-account-menu absolute right-0 z-[100] mt-3 w-[min(23rem,calc(100vw-2rem))] overflow-hidden rounded-[1.75rem] border border-white/80 bg-white/95 shadow-2xl shadow-slate-950/20 backdrop-blur-2xl">
                  <div className="bg-gradient-to-br from-blue-800 via-brand-blue to-blue-500 px-5 py-5 text-white">
                    <div className="flex items-center gap-3">
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/25 bg-white/15 text-xl font-black shadow-inner" aria-hidden="true">
                        {(user?.displayName || user?.email || 'G').slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1 text-left">
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-100">{user ? 'Your marketplace account' : 'Welcome to Zyro.lk'}</p>
                        <p className="mt-0.5 truncate text-base font-black font-display">{user ? user.displayName || 'Zyro.lk Customer' : 'Guest shopper'}</p>
                        <p className="mt-0.5 truncate text-xs text-blue-100">{user?.email || 'Sign in to manage your shopping'}</p>
                      </div>
                      {user && <ShieldCheck className="h-5 w-5 shrink-0 text-blue-100" aria-label="Signed in account" />}
                    </div>
                  </div>

                  <div className="max-h-[min(34rem,calc(100vh-7rem))] overflow-y-auto p-3 text-left">
                    <span className="mb-2 block px-2 pt-1 text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Account</span>
                    <div className="space-y-1">
                      {accountItems.map(({ label, icon: Icon, action, pending }) => (
                        <button
                          key={label}
                          type="button"
                          onClick={action}
                          disabled={pending}
                          className="zy-account-row"
                          aria-disabled={pending || undefined}
                        >
                          <span className="zy-account-row-icon"><Icon className="h-4.5 w-4.5" aria-hidden="true" /></span>
                          <span className="min-w-0 flex-1">{label}</span>
                          {pending ? <span className="text-[9px] font-black uppercase tracking-wider text-slate-400">Coming soon</span> : <ArrowUpRight className="h-4 w-4 text-slate-400" aria-hidden="true" />}
                        </button>
                      ))}
                    </div>

                    {isAdminUser && (
                      <button
                        onClick={() => { setIsAdminMode(true); setCurrentPage('admin'); setIsProfileOpen(false); }}
                        className={`mt-2 flex min-h-12 w-full items-center justify-between rounded-2xl border px-4 text-sm font-black transition-colors ${isAdminMode ? 'border-blue-200 bg-blue-50 text-brand-blue' : 'border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50'}`}
                      >
                        <span className="flex items-center gap-2"><LayoutDashboard className="h-4.5 w-4.5" /> Administration</span>
                        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}

                    {user ? (
                      <button onClick={handleLogout} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-red-100 bg-red-50 text-sm font-black text-red-600 transition-colors hover:border-red-200 hover:bg-red-100">
                        <LogOut className="h-4.5 w-4.5" /> Logout
                      </button>
                    ) : (
                      <button onClick={() => { onOpenAuthModal(); setIsProfileOpen(false); }} className="zy-button zy-button-primary mt-3 min-h-12 w-full rounded-2xl text-sm">
                        <LogIn className="h-4.5 w-4.5" /> Sign In / Register
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Mobile Hamburger Menu Button */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="zy-navbar-action flex h-12 w-12 items-center justify-center rounded-2xl text-slate-600 hover:text-brand-blue xl:hidden"
              aria-label={isMobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={isMobileMenuOpen}
            >
              {isMobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>

          </div>
        </div>
      </div>

      <div className="zy-navbar-mobile-search min-w-0 max-w-full px-4 pb-3 md:hidden">
        <div className="mx-auto min-w-0 max-w-7xl">
          {renderSearchBox('mobile')}
        </div>
      </div>

      {/* Mobile Menu Panel */}
      {isMobileMenuOpen && (
        <div className="zy-mobile-market-menu px-4 pb-5 pt-2 xl:hidden">
          <div className="mx-auto max-w-2xl overflow-hidden rounded-[1.75rem] border border-white/80 bg-white/95 shadow-2xl shadow-blue-950/15 backdrop-blur-2xl">
            <div className="bg-gradient-to-br from-blue-800 via-brand-blue to-blue-500 p-4 text-white">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/25 bg-white/15 text-lg font-black" aria-hidden="true">
                  {(user?.displayName || user?.email || 'G').slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-black">{user ? user.displayName || 'Zyro.lk Customer' : 'Welcome to Zyro.lk'}</p>
                  <p className="mt-0.5 truncate text-xs text-blue-100">{user?.email || 'Sign in to manage your shopping'}</p>
                </div>
                {!user && (
                  <button type="button" onClick={() => { onOpenAuthModal(); setIsMobileMenuOpen(false); }} className="min-h-12 rounded-xl border border-white/25 bg-white/15 px-3 text-xs font-black hover:bg-white/25">
                    Sign in
                  </button>
                )}
              </div>
            </div>

            <nav className="grid grid-cols-2 gap-2 p-3" aria-label="Mobile storefront navigation">
              {navLinks.map(({ id, label, icon: Icon, action }) => (
                <button
                  key={id}
                  onClick={action}
                  className={`zy-mobile-nav-card min-h-14 ${currentPage === id && !isAdminMode ? 'is-active' : ''}`}
                  aria-current={currentPage === id && !isAdminMode ? 'page' : undefined}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>

            <div className="border-t border-slate-100 p-3">
              <span className="mb-2 block px-1 text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Shopping account</span>
              <div className="grid grid-cols-2 gap-2">
                {user && (
                  <button type="button" onClick={() => navigateToPage('account')} className="zy-mobile-account-card"><User className="h-5 w-5" aria-hidden="true" /><span>My Account</span></button>
                )}
                {user && (
                  <button type="button" onClick={() => navigateToPage('account-orders')} className="zy-mobile-account-card"><ReceiptText className="h-5 w-5" aria-hidden="true" /><span>My Orders</span></button>
                )}
                {user && (
                  <button type="button" onClick={() => navigateToPage('account-addresses')} className="zy-mobile-account-card"><MapPin className="h-5 w-5" aria-hidden="true" /><span>Addresses</span></button>
                )}
                {isWishlistEnabled && (
                  <button type="button" onClick={() => navigateToPage('wishlist')} className="zy-mobile-account-card"><Heart className="h-5 w-5" aria-hidden="true" /><span>Wishlist</span>{wishlistCount > 0 && <b>{wishlistCount}</b>}</button>
                )}
                <button type="button" onClick={() => navigateToPage('recently-viewed')} className="zy-mobile-account-card"><Clock3 className="h-5 w-5" aria-hidden="true" /><span>Recently Viewed</span></button>
                <button type="button" onClick={() => navigateToPage('compare')} className="zy-mobile-account-card"><BarChart3 className="h-5 w-5" aria-hidden="true" /><span>Compare</span></button>
                {user && (
                  <button type="button" onClick={() => navigateToPage('account-settings')} className="zy-mobile-account-card"><Settings className="h-5 w-5" aria-hidden="true" /><span>Settings</span></button>
                )}
                <button type="button" onClick={() => navigateToPage('contact')} className="zy-mobile-account-card"><Headphones className="h-5 w-5" aria-hidden="true" /><span>Support</span></button>
              </div>
            </div>

            {isAdminUser && (
              <button
                onClick={() => {
                  setIsAdminMode(true);
                  setCurrentPage('admin');
                  setIsMobileMenuOpen(false);
                }}
                className={`mx-3 mb-3 flex min-h-12 w-[calc(100%-1.5rem)] items-center rounded-2xl border px-3 text-left text-sm font-black transition-all ${
                  isAdminMode
                    ? 'border-blue-200 bg-brand-blue text-white'
                    : 'border-slate-100 bg-white text-slate-700 hover:bg-blue-50'
                }`}
              >
                <LayoutDashboard className="h-4 w-4 mr-2" />
                Admin Dashboard
              </button>
            )}

            {user && (
              <div className="border-t border-slate-100 p-3">
                <button type="button" onClick={handleLogout} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-red-50 text-sm font-black text-red-600 hover:bg-red-100">
                  <LogOut className="h-4.5 w-4.5" aria-hidden="true" /> Logout
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
