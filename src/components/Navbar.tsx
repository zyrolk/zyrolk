import React, { useState, useEffect, useMemo } from 'react';
import { 
  Menu, X, Search, Heart, ShoppingBag, User, 
  LayoutDashboard, LogIn, LogOut, ChevronDown, Phone,
  ArrowUpRight, Clock3, LoaderCircle, Mic, PackageSearch, Tag,
  ShieldCheck, ShoppingCart, Grid3X3, MessageCircle, Mail, HelpCircle, Info, LockKeyhole
} from 'lucide-react';
import { auth, db } from '../firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { Category, CustomerProduct, WebsiteSettings } from '../types';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { searchCustomerProducts } from '../services/product-search/customerProductSearch';
import { normalizeSearchText } from '../services/product-search/productSearchMetadata';

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
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
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

  const navLinks = [
    { id: 'home', label: 'Home' },
    { id: 'products', label: 'Products' },
    { id: 'categories', label: 'Categories' },
    ...(isWishlistEnabled ? [{ id: 'wishlist', label: 'Wishlist' }] : []),
    { id: 'contact', label: 'Contact Us' }
  ];

  const renderSearchBox = (idPrefix: string) => {
    const inputId = `${idPrefix}-product-search`;
    const panelId = `${idPrefix}-search-suggestions`;
    const hasQuery = normalizedTempSearch.length > 0;

    return (
      <form onSubmit={handleSearchSubmit} className="relative min-w-0 max-w-full w-full" role="search" data-product-search>
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
          className="zy-input zy-market-search min-h-14 min-w-0 max-w-full w-full rounded-2xl pl-11 pr-36 text-base text-slate-900 transition-all placeholder:text-slate-500 focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
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
            className="absolute right-24 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
            aria-label="Clear product search"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <button type="button" disabled className="absolute right-12 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-xl text-slate-400 disabled:cursor-not-allowed disabled:opacity-70" aria-label="Voice search is not enabled" title="Voice search is not enabled">
          <Mic className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="submit"
          className="absolute right-0.5 top-1/2 z-10 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-xl bg-brand-blue text-white shadow-sm transition-all hover:bg-blue-700 active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
          aria-label="Submit product search"
        >
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </button>

        {isSearchOpen && (
          <div
            id={panelId}
            className="absolute left-0 right-0 top-[calc(100%+0.65rem)] z-[70] overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_24px_60px_-20px_rgba(15,23,42,0.35)]"
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
                        className={`flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${activeSuggestionIndex === index ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
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
          </div>
        )}
      </form>
    );
  };

  return (
    <header className="zy-market-header sticky top-0 z-50 w-full border-b border-white/70 bg-white/80 backdrop-blur-2xl">
      <div className="h-1 w-full bg-gradient-to-r from-blue-800 via-brand-blue to-blue-300" aria-hidden="true" />
      <div className="zy-market-header-shell mx-auto w-[calc(100%-1rem)] max-w-7xl px-4 sm:w-[calc(100%-2rem)] sm:px-6 lg:px-8">
        <div className="flex h-[4.25rem] items-center justify-between">
          
          {/* Logo */}
          <button type="button" className="flex min-h-11 flex-shrink-0 items-center rounded-xl cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20" onClick={() => { setCurrentPage('home'); setIsAdminMode(false); }} aria-label="Go to homepage">
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
          <div className="hidden md:flex flex-1 max-w-xl mx-6 xl:mx-8">
            {renderSearchBox('desktop')}
          </div>

          {/* Desktop Navigation Links */}
          <nav className="hidden items-center gap-1 rounded-2xl border border-slate-200/70 bg-slate-50/75 p-1 lg:flex">
            {navLinks.map((link) => (
              <button
                key={link.id}
                onClick={() => {
                  setCurrentPage(link.id);
                  setIsAdminMode(false);
                }}
                className={`min-h-10 rounded-xl px-3 text-xs font-black transition-all cursor-pointer ${
                  currentPage === link.id && !isAdminMode
                    ? 'bg-white text-brand-blue shadow-sm'
                    : 'text-slate-600 hover:bg-white hover:text-slate-900'
                }`}
              >
                {link.label}
              </button>
            ))}
          </nav>

          {/* Action Icons */}
          <div className="flex items-center space-x-2 sm:space-x-4">
            
            {/* Sri Lankan Customer Hot-Line */}
            {settings?.contactPhone ? (
              <a 
                href={`tel:${settings.contactPhone}`} 
                className="hidden xl:flex items-center text-xs font-bold text-slate-700 bg-slate-100/80 border border-slate-200/60 py-1.5 px-3 rounded-full hover:bg-white hover:text-brand-blue transition-colors"
              >
                <Phone className="h-3.5 w-3.5 mr-1 text-brand-blue" />
                <span>{settings.contactPhone}</span>
              </a>
            ) : (
              <div className="hidden xl:flex items-center text-xs font-semibold text-slate-400 bg-slate-100/50 py-1.5 px-3 rounded-full">
                <Phone className="h-3.5 w-3.5 mr-1 text-slate-300" />
                <span>Hotline pending setup</span>
              </div>
            )}

            {/* Wishlist Button */}
            {isWishlistEnabled && (
              <button 
                onClick={() => { setCurrentPage('wishlist'); setIsAdminMode(false); }}
                className="zy-button zy-button-ghost h-11 w-11 p-0 text-slate-600 hover:text-red-500 relative cursor-pointer rounded-full"
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
              className="zy-button zy-button-ghost h-11 w-11 p-0 text-slate-600 hover:text-brand-blue relative cursor-pointer rounded-full"
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
            <div className="relative hidden sm:block" data-account-menu>
              <button
                onClick={() => setIsProfileOpen(!isProfileOpen)}
                className="zy-button zy-button-ghost flex h-11 min-w-11 items-center justify-center space-x-1 p-0 text-slate-600 hover:text-slate-900 cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                aria-label={user ? 'Open account menu' : 'Open sign in menu'}
                aria-expanded={isProfileOpen}
                aria-controls="desktop-account-menu"
              >
                <User className="h-5 w-5" />
                <ChevronDown className="h-3.5 w-3.5 hidden sm:block" />
              </button>

              {isProfileOpen && (
                <div id="desktop-account-menu" className="zy-account-menu absolute right-0 z-50 mt-3 w-[min(25rem,calc(100vw-2rem))] overflow-hidden rounded-3xl border border-blue-100 bg-white shadow-2xl shadow-slate-950/20">
                  <div className="bg-gradient-to-br from-blue-700 via-brand-blue to-blue-500 px-5 py-5 text-white">
                    <div className="flex items-center gap-3">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/25 bg-white/15 text-lg font-black shadow-inner" aria-hidden="true">
                        {(user?.displayName || user?.email || 'G').slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1 text-left">
                        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-blue-100">{user ? 'Welcome back' : 'Welcome to Zyro.lk'}</p>
                        <p className="mt-0.5 truncate text-base font-black font-display">{user ? user.displayName || 'Zyro.lk Customer' : 'Guest shopper'}</p>
                        <p className="truncate text-xs text-blue-100">{user?.email || 'Sign in for a personalized shopping experience'}</p>
                      </div>
                      {user && <ShieldCheck className="h-5 w-5 shrink-0 text-blue-100" aria-label="Signed in account" />}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2 border-t border-white/15 pt-4">
                      <div className="rounded-xl bg-white/10 px-3 py-2"><span className="block text-lg font-black">{wishlistCount}</span><span className="text-[9px] font-bold uppercase tracking-wider text-blue-100">Saved items</span></div>
                      <div className="rounded-xl bg-white/10 px-3 py-2"><span className="block text-lg font-black">{cartCount}</span><span className="text-[9px] font-bold uppercase tracking-wider text-blue-100">Cart items</span></div>
                    </div>
                  </div>

                  <div className="max-h-[min(34rem,calc(100vh-7rem))] space-y-5 overflow-y-auto p-4 text-left">
                    <div>
                      <span className="mb-2 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Quick actions</span>
                      <div className="grid grid-cols-2 gap-2">
                        <button type="button" onClick={() => { setCurrentPage('products'); setIsAdminMode(false); setIsProfileOpen(false); }} className="zy-account-action">
                          <PackageSearch className="h-4.5 w-4.5 text-brand-blue" aria-hidden="true" /><span>Shop products</span>
                        </button>
                        {isWishlistEnabled && (
                          <button type="button" onClick={() => { setCurrentPage('wishlist'); setIsAdminMode(false); setIsProfileOpen(false); }} className="zy-account-action">
                            <Heart className="h-4.5 w-4.5 text-red-500" aria-hidden="true" /><span>Wishlist</span>
                          </button>
                        )}
                        <button type="button" onClick={() => { onOpenCart(); setIsProfileOpen(false); }} className="zy-account-action">
                          <ShoppingCart className="h-4.5 w-4.5 text-brand-blue" aria-hidden="true" /><span>Cart</span>
                        </button>
                        <button type="button" onClick={() => { setCurrentPage('categories'); setIsAdminMode(false); setIsProfileOpen(false); }} className="zy-account-action">
                          <Grid3X3 className="h-4.5 w-4.5 text-brand-blue" aria-hidden="true" /><span>Categories</span>
                        </button>
                      </div>
                    </div>

                    {isAdminUser && (
                      <button
                        onClick={() => { setIsAdminMode(true); setCurrentPage('admin'); setIsProfileOpen(false); }}
                        className={`flex min-h-12 w-full items-center justify-between rounded-2xl border px-4 text-sm font-black transition-colors ${isAdminMode ? 'border-blue-200 bg-blue-50 text-brand-blue' : 'border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-blue-50'}`}
                      >
                        <span className="flex items-center gap-2"><LayoutDashboard className="h-4.5 w-4.5" /> Administration</span>
                        <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}

                    <div>
                      <span className="mb-2 block text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Support</span>
                      <div className="grid grid-cols-2 gap-2">
                        {settings?.whatsappNumber && (
                          <a href={`https://wa.me/${settings.whatsappNumber.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" className="zy-account-action">
                            <MessageCircle className="h-4.5 w-4.5 text-emerald-600" aria-hidden="true" /><span>WhatsApp</span>
                          </a>
                        )}
                        {settings?.contactPhone && (
                          <a href={`tel:${settings.contactPhone}`} className="zy-account-action"><Phone className="h-4.5 w-4.5 text-brand-blue" aria-hidden="true" /><span>Hotline</span></a>
                        )}
                        {settings?.contactEmail && (
                          <a href={`mailto:${settings.contactEmail}`} className="zy-account-action"><Mail className="h-4.5 w-4.5 text-brand-blue" aria-hidden="true" /><span>Email</span></a>
                        )}
                        <button type="button" onClick={() => { setCurrentPage('faq'); setIsAdminMode(false); setIsProfileOpen(false); }} className="zy-account-action"><HelpCircle className="h-4.5 w-4.5 text-brand-blue" aria-hidden="true" /><span>FAQ</span></button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 border-t border-slate-100 pt-4">
                      <button type="button" onClick={() => { setCurrentPage('privacy-policy'); setIsAdminMode(false); setIsProfileOpen(false); }} className="zy-account-action"><LockKeyhole className="h-4.5 w-4.5 text-slate-500" aria-hidden="true" /><span>Privacy</span></button>
                      <button type="button" onClick={() => { setCurrentPage('about-us'); setIsAdminMode(false); setIsProfileOpen(false); }} className="zy-account-action"><Info className="h-4.5 w-4.5 text-slate-500" aria-hidden="true" /><span>About</span></button>
                    </div>

                    {user ? (
                      <button onClick={handleLogout} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-red-100 bg-red-50 text-sm font-black text-red-600 transition-colors hover:border-red-200 hover:bg-red-100">
                        <LogOut className="h-4.5 w-4.5" /> Sign Out
                      </button>
                    ) : (
                      <button onClick={() => { onOpenAuthModal(); setIsProfileOpen(false); }} className="zy-button zy-button-primary min-h-12 w-full rounded-2xl text-sm">
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
              className="zy-button zy-button-ghost flex h-11 w-11 items-center justify-center lg:hidden p-0 text-slate-600 hover:text-slate-900 cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
              aria-label={isMobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={isMobileMenuOpen}
            >
              {isMobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>

          </div>
        </div>
      </div>

      <div className="min-w-0 max-w-full border-t border-slate-100 px-4 pb-3 pt-2 md:hidden">
        <div className="mx-auto min-w-0 max-w-7xl">
          {renderSearchBox('mobile')}
        </div>
      </div>

      {/* Mobile Menu Panel */}
      {isMobileMenuOpen && (
        <div className="border-t border-blue-100 bg-gradient-to-br from-blue-50 via-white to-slate-50 px-4 py-4 shadow-2xl backdrop-blur-xl lg:hidden animate-fadeIn">
          {/* Mobile Links */}
          <div className="mx-auto grid max-w-2xl grid-cols-2 gap-2 rounded-3xl border border-white bg-white/70 p-3 shadow-xl shadow-blue-950/8">
            {navLinks.map((link) => (
              <button
                key={link.id}
                onClick={() => {
                  setCurrentPage(link.id);
                  setIsAdminMode(false);
                  setIsMobileMenuOpen(false);
                }}
                className={`min-h-12 rounded-2xl border px-3 text-left text-sm font-black transition-all ${
                  currentPage === link.id && !isAdminMode
                    ? 'border-blue-200 bg-brand-blue text-white shadow-lg shadow-blue-900/15'
                    : 'border-slate-100 bg-white text-slate-700 hover:border-blue-100 hover:bg-blue-50'
                }`}
              >
                {link.label}
              </button>
            ))}
            {isAdminUser && (
              <button
                onClick={() => {
                  setIsAdminMode(true);
                  setCurrentPage('admin');
                  setIsMobileMenuOpen(false);
                }}
                className={`col-span-2 flex min-h-12 items-center rounded-2xl border px-3 text-left text-sm font-black transition-all ${
                  isAdminMode
                    ? 'border-blue-200 bg-brand-blue text-white'
                    : 'border-slate-100 bg-white text-slate-700 hover:bg-blue-50'
                }`}
              >
                <LayoutDashboard className="h-4 w-4 mr-2" />
                Admin Dashboard
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
