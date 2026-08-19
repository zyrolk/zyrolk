import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Menu, X, Search, Heart, ShoppingBag, User, 
  LayoutDashboard, LogIn, LogOut, ChevronDown,
  ArrowUpRight, Clock3, LoaderCircle, PackageSearch, Tag,
  ShieldCheck, Grid3X3, MessageCircle, MapPin, Bell,
  Ticket, Settings, Headphones, ReceiptText, Home, Sparkles, BarChart3,
  Camera, Languages, LockKeyhole, Mic, RotateCcw, Truck
} from 'lucide-react';
import { auth } from '../firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { Category, CustomerProduct, WebsiteSettings } from '../types';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { searchCustomerProducts } from '../services/product-search/customerProductSearch';
import { normalizeSearchText } from '../services/product-search/productSearchMetadata';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import MarketplaceMegaMenu from './MarketplaceMegaMenu';

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
  const [isMegaMenuOpen, setIsMegaMenuOpen] = useState(false);
  const [tempSearch, setTempSearch] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const searchInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
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
      if (!target?.closest('[data-mega-menu]')) setIsMegaMenuOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsProfileOpen(false);
        setIsMegaMenuOpen(false);
        setIsMobileMenuOpen(false);
      }
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
    setIsMegaMenuOpen(false);
  };

  const focusSearch = () => {
    const input = searchInputRefs.current.desktop ?? searchInputRefs.current.mobile;
    input?.focus();
    setIsSearchOpen(true);
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
    { id: 'deals', label: 'Deals', icon: Tag, action: navigateToDeals },
    { id: 'new-arrivals', label: 'New Arrivals', icon: Sparkles, action: () => navigateToPage('products') },
    { id: 'best-sellers', label: 'Best Sellers', icon: BarChart3, action: () => navigateToPage('products') },
    { id: 'brands', label: 'Brands', icon: ShieldCheck, action: () => navigateToPage('products') },
    { id: 'today-offers', label: "Today's Offers", icon: Tag, action: navigateToDeals },
    { id: 'support', label: 'Support', icon: MessageCircle, action: () => navigateToPage('contact') }
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
          ref={(element) => { searchInputRefs.current[idPrefix] = element; }}
          id={inputId}
          type="search"
          placeholder="Search products, brands and categories..."
          aria-label="Search products, brands & categories"
          value={tempSearch}
          onChange={(event) => {
            setTempSearch(event.target.value);
            setIsSearchOpen(true);
            setActiveSuggestionIndex(-1);
          }}
          onFocus={() => setIsSearchOpen(true)}
          onKeyDown={handleSearchKeyDown}
          className="zy-input zy-market-search min-h-14 min-w-0 max-w-full w-full rounded-2xl pl-11 pr-[12.75rem] text-base text-slate-900 transition-all placeholder:text-slate-500 focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isSearchOpen}
          aria-controls={panelId}
          aria-activedescendant={activeSuggestionIndex >= 0 ? `${idPrefix}-product-option-${activeSuggestionIndex}` : undefined}
          autoComplete="off"
        />
        <div className="zy-search-tools absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5">
          {tempSearch && (
            <button type="button" onClick={clearSearch} className="zy-search-tool" aria-label="Clear product search">
              <X aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="zy-search-tool"
            aria-label="Voice search is unavailable in this launch version"
            title="Voice search is unavailable in this launch version"
            disabled
          >
            <Mic aria-hidden="true" />
          </button>
          <button
            type="button"
            className="zy-search-tool"
            aria-label="Image search is not available yet"
            title="Image search is coming soon"
            disabled
          >
            <Camera aria-hidden="true" />
          </button>
          <button type="button" onClick={focusSearch} className="zy-search-ai" aria-label="Open product discovery search">
            <Sparkles aria-hidden="true" /><span>Find</span>
          </button>
          <button type="submit" className="zy-search-submit" aria-label="Submit product search">
            <Search aria-hidden="true" />
          </button>
        </div>

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
                  <div className="zy-search-loading" role="status">
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                    <p>Loading available products...</p>
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
                  <div className="zy-search-empty" role="status">
                    <span className="zy-search-empty-icon" aria-hidden="true">
                      <PackageSearch />
                    </span>
                    <p className="zy-search-empty-title">No matching products found</p>
                    <p className="zy-search-empty-copy">Try a product name, brand, model, or category.</p>
                    <button type="button" onClick={clearSearch} className="zy-search-empty-clear">
                      <X aria-hidden="true" />
                      Clear search
                    </button>
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
    <header className={`zy-market-header sticky top-0 z-50 w-full bg-white ${isScrolled ? 'is-scrolled' : ''}`}>
      <div className="zy-announcement-bar">
        <div className="zy-header-container">
          <div className="zy-announcement-benefits" aria-label="Store benefits">
            <span><Truck aria-hidden="true" />Islandwide Delivery</span>
            <span><RotateCcw aria-hidden="true" />Easy Returns</span>
            <span><LockKeyhole aria-hidden="true" />Secure Payments</span>
            <button type="button" onClick={focusSearch}><Search aria-hidden="true" />Product Search</button>
          </div>
          <div className="zy-announcement-contact">
            {settings?.contactPhone && <a href={`tel:${settings.contactPhone}`}>{settings.contactPhone}</a>}
            <span aria-label="Available languages: English and Sinhala"><Languages aria-hidden="true" />EN / සිං</span>
          </div>
        </div>
      </div>

      <div className="zy-market-header-shell zy-header-container">
        <div className="zy-market-header-row">
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen((open) => !open)}
            className="zy-navbar-action zy-mobile-menu-trigger"
            aria-label={isMobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={isMobileMenuOpen}
            aria-controls="mobile-header-navigation"
          >
            {isMobileMenuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </button>

          <button type="button" className="zy-brand-button" onClick={() => navigateToPage('home')} aria-label="Go to Zyro.lk homepage">
            {settings?.logoUrl ? (
              <img src={settings.logoUrl} alt={settings.storeName || 'Zyro.lk'} referrerPolicy="no-referrer" />
            ) : (
              <span>{settings?.storeName ? settings.storeName.split('.')[0] : 'Zyro'}<b>.lk</b></span>
            )}
          </button>

          <div className="zy-header-categories" data-mega-menu>
            <button
              type="button"
              className={`zy-categories-trigger ${isMegaMenuOpen ? 'is-active' : ''}`}
              onClick={() => setIsMegaMenuOpen((open) => !open)}
              aria-expanded={isMegaMenuOpen}
              aria-controls="desktop-mega-menu"
            >
              <Grid3X3 aria-hidden="true" /><span>Categories</span><ChevronDown aria-hidden="true" />
            </button>
          </div>

          <div className="zy-desktop-search">{renderSearchBox('desktop')}</div>

          <div className="zy-header-actions">
            <button type="button" className="zy-header-action zy-orders-action" onClick={user ? () => navigateToPage('account-orders') : onOpenAuthModal}>
              <ReceiptText aria-hidden="true" /><span>Orders</span>
            </button>
            {isWishlistEnabled && (
              <button type="button" className="zy-header-action" onClick={() => navigateToPage('wishlist')} aria-label={`Wishlist with ${wishlistCount} items`} aria-current={currentPage === 'wishlist' ? 'page' : undefined}>
                <span className="zy-action-icon"><Heart aria-hidden="true" />{wishlistCount > 0 && <b>{wishlistCount}</b>}</span><span>Wishlist</span>
              </button>
            )}
            <button type="button" className="zy-header-action zy-notification-action" onClick={user ? () => navigateToPage('account-settings') : onOpenAuthModal}>
              <Bell aria-hidden="true" /><span>Notifications</span>
            </button>
            <button type="button" className="zy-header-action zy-cart-action" onClick={onOpenCart} aria-label={`Cart with ${cartCount} items`}>
              <span className="zy-action-icon"><ShoppingBag aria-hidden="true" />{cartCount > 0 && <b>{cartCount}</b>}</span><span>Cart</span>
            </button>

            <div className="zy-account-trigger-wrap" data-account-menu>
              <button
                type="button"
                className="zy-header-action"
                onClick={() => setIsProfileOpen((open) => !open)}
                aria-label={user ? 'Open account menu' : 'Open sign in menu'}
                aria-expanded={isProfileOpen}
                aria-controls="desktop-account-menu"
              >
                <User aria-hidden="true" /><span>Account</span><ChevronDown className="zy-action-chevron" aria-hidden="true" />
              </button>

              <AnimatePresence initial={false}>
                {isProfileOpen && (
                  <motion.div
                    id="desktop-account-menu"
                    className="zy-account-menu"
                    initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -5, scale: 0.99 }}
                    transition={{ duration: prefersReducedMotion ? 0 : 0.16 }}
                  >
                    <div className="zy-account-summary">
                      <span aria-hidden="true">{(user?.displayName || user?.email || 'G').slice(0, 1).toUpperCase()}</span>
                      <div><small>{user ? 'Your marketplace account' : 'Welcome to Zyro.lk'}</small><strong>{user ? user.displayName || 'Zyro.lk Customer' : 'Guest shopper'}</strong><p>{user?.email || 'Sign in to manage your shopping'}</p></div>
                    </div>
                    <div className="zy-account-menu-body">
                      {accountItems.map(({ label, icon: Icon, action, pending }) => (
                        <button key={label} type="button" onClick={action} disabled={pending} className="zy-account-row" aria-disabled={pending || undefined}>
                          <span className="zy-account-row-icon"><Icon aria-hidden="true" /></span><span>{label}</span>
                          {pending ? <small>Coming soon</small> : <ArrowUpRight aria-hidden="true" />}
                        </button>
                      ))}
                      {isAdminUser && (
                        <button type="button" onClick={() => { setIsAdminMode(true); setCurrentPage('admin'); setIsProfileOpen(false); }} className="zy-account-admin">
                          <LayoutDashboard aria-hidden="true" />Administration<ArrowUpRight aria-hidden="true" />
                        </button>
                      )}
                      {user ? (
                        <button type="button" onClick={handleLogout} className="zy-account-signout"><LogOut aria-hidden="true" /> Logout</button>
                      ) : (
                        <button type="button" onClick={() => { onOpenAuthModal(); setIsProfileOpen(false); }} className="zy-account-signin"><LogIn aria-hidden="true" /> Sign In / Register</button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="zy-mobile-delivery-context" aria-label="Delivery coverage">
            <MapPin aria-hidden="true" />
            <span>
              <small>Delivering across</small>
              <strong>Sri Lanka</strong>
            </span>
            <b>{settings?.deliveryCharge === 0 ? 'Free delivery' : 'Islandwide'}</b>
          </div>
        </div>
        <div className="zy-navbar-mobile-search">{renderSearchBox('mobile')}</div>
      </div>

      <div className="zy-desktop-navigation" data-mega-menu>
        <div className="zy-header-container">
          <button type="button" className={`zy-navbar-link zy-navigation-categories ${isMegaMenuOpen ? 'is-active' : ''}`} onClick={() => setIsMegaMenuOpen((open) => !open)} aria-expanded={isMegaMenuOpen} aria-controls="desktop-mega-menu">
            <Grid3X3 aria-hidden="true" />Categories<ChevronDown aria-hidden="true" />
          </button>
          <nav aria-label="Primary storefront navigation">
            {navLinks.map((link) => (
              <button key={link.id} type="button" onClick={link.action} className={`zy-navbar-link ${currentPage === link.id && !isAdminMode ? 'is-active' : ''}`}>{link.label}</button>
            ))}
          </nav>
          <button type="button" className="zy-navigation-ai" onClick={focusSearch}><Sparkles aria-hidden="true" />Find products</button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isMegaMenuOpen && (
          <motion.div
            id="desktop-mega-menu"
            className="zy-mega-menu"
            data-mega-menu
            initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -7 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.2, ease: [0.2, 0.75, 0.25, 1] }}
          >
            <div className="zy-header-container"><MarketplaceMegaMenu categories={categories} onSelectCategory={handleCategorySuggestion} /></div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {isMobileMenuOpen && (
          <motion.div
            id="mobile-header-navigation"
            className="zy-mobile-market-menu"
            initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.18 }}
          >
            <div className="zy-mobile-menu-account">
              <span aria-hidden="true">{(user?.displayName || user?.email || 'G').slice(0, 1).toUpperCase()}</span>
              <div><strong>{user ? user.displayName || 'Zyro.lk Customer' : 'Welcome to Zyro.lk'}</strong><small>{user?.email || 'Sign in for orders, saved items and more'}</small></div>
              <button type="button" onClick={user ? () => navigateToPage('account') : onOpenAuthModal}>{user ? 'Account' : 'Sign in'}</button>
            </div>
            <nav className="zy-mobile-primary-links" aria-label="Mobile storefront navigation">
              <button type="button" onClick={() => navigateToPage('home')}><Home aria-hidden="true" />Home</button>
              <button type="button" onClick={() => navigateToPage('categories')}><Grid3X3 aria-hidden="true" />Categories</button>
              {navLinks.map(({ id, label, icon: Icon, action }) => <button key={id} type="button" onClick={action}><Icon aria-hidden="true" />{label}</button>)}
            </nav>
            {categories.length > 0 && (
              <div className="zy-mobile-category-list">
                <span>Shop by category</span>
                <div>{categories.filter((category) => category.isActive !== false).slice(0, 10).map((category) => <button key={category.id} type="button" onClick={() => handleCategorySuggestion(category.id)}>{category.name}</button>)}</div>
              </div>
            )}
            <div className="zy-mobile-menu-footer">
              {settings?.contactPhone && <a href={`tel:${settings.contactPhone}`}><Headphones aria-hidden="true" />{settings.contactPhone}</a>}
              <span><Languages aria-hidden="true" />EN / සිං</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
