import React, { useEffect, useRef, useState } from 'react';
import { 
  Home, ShoppingBag, Heart, ShoppingCart, Menu, X, 
  LayoutDashboard, LogIn, LogOut, Phone, MapPin, 
  ChevronRight, SlidersHorizontal
} from 'lucide-react';
import { auth } from '../firebase';
import { signOut } from 'firebase/auth';
import { WebsiteSettings, Category } from '../types';

interface MobileBottomNavProps {
  currentPage: string;
  setCurrentPage: (page: string) => void;
  cartCount: number;
  wishlistCount: number;
  onOpenCart: () => void;
  onOpenAuthModal: () => void;
  user: any;
  isAdminUser: boolean;
  isAdminMode: boolean;
  setIsAdminMode: (val: boolean) => void;
  settings: WebsiteSettings | null;
  categories: Category[];
  setSelectedCategory: (catId: string) => void;
}

export default function MobileBottomNav({
  currentPage,
  setCurrentPage,
  cartCount,
  wishlistCount,
  onOpenCart,
  onOpenAuthModal,
  user,
  isAdminUser,
  isAdminMode,
  setIsAdminMode,
  settings,
  categories,
  setSelectedCategory
}: MobileBottomNavProps) {
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const menuCloseButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isMoreMenuOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => menuCloseButtonRef.current?.focus(), 0);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMoreMenuOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleEscape);
      previousFocusRef.current?.focus();
    };
  }, [isMoreMenuOpen]);

  const handleLogout = async () => {
    await signOut(auth);
    setIsAdminMode(false);
    setIsMoreMenuOpen(false);
    setCurrentPage('home');
  };

  const handleTabClick = (pageId: string) => {
    setIsMoreMenuOpen(false);
    setIsAdminMode(false);
    setCurrentPage(pageId);
  };

  const handleCategoryClick = (catId: string) => {
    setSelectedCategory(catId);
    setCurrentPage('products');
    setIsMoreMenuOpen(false);
    setIsAdminMode(false);
  };

  const activeTabClass = "text-brand-blue scale-110";
  const inactiveTabClass = "text-slate-500 hover:text-slate-700";

  return (
    <>
      {/* ==================== FLOATING BOTTOM NAV DOCK ==================== */}
      <nav className="zy-bottom-dock fixed left-3 right-3 z-40 md:hidden" aria-label="Mobile storefront navigation">
        <div className="bg-white/95 backdrop-blur-xl border border-slate-200/80 rounded-2xl shadow-2xl px-1.5 py-1.5 flex justify-around items-stretch">
          
          {/* Tab 1: Home */}
          <button 
            onClick={() => handleTabClick('home')}
            className={`flex min-h-12 flex-col items-center justify-center flex-1 transition-all relative py-1 cursor-pointer rounded-xl active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
              currentPage === 'home' && !isAdminMode ? activeTabClass : inactiveTabClass
            }`}
            aria-label="Go to home"
            aria-current={currentPage === 'home' && !isAdminMode ? 'page' : undefined}
          >
            <Home className="h-5 w-5" />
            <span className="text-[9px] font-bold mt-1 tracking-tight">Home</span>
            {currentPage === 'home' && !isAdminMode && (
              <span className="absolute bottom-0 w-1 h-1 bg-brand-blue rounded-full"></span>
            )}
          </button>

          {/* Tab 2: Shop / Products */}
          <button 
            onClick={() => handleTabClick('products')}
            className={`flex min-h-12 flex-col items-center justify-center flex-1 transition-all relative py-1 cursor-pointer rounded-xl active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
              currentPage === 'products' && !isAdminMode ? activeTabClass : inactiveTabClass
            }`}
            aria-label="Browse products"
            aria-current={currentPage === 'products' && !isAdminMode ? 'page' : undefined}
          >
            <ShoppingBag className="h-5 w-5" />
            <span className="text-[9px] font-bold mt-1 tracking-tight">Shop</span>
            {currentPage === 'products' && !isAdminMode && (
              <span className="absolute bottom-0 w-1 h-1 bg-brand-blue rounded-full"></span>
            )}
          </button>

          {/* Tab 3: Cart (Action Button) */}
          <button 
            onClick={() => {
              setIsMoreMenuOpen(false);
              onOpenCart();
            }}
            className="flex min-h-12 flex-col items-center justify-center flex-1 transition-all relative py-1 cursor-pointer rounded-xl text-slate-500 hover:text-slate-700 active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
            aria-label={`Open cart with ${cartCount} ${cartCount === 1 ? 'item' : 'items'}`}
          >
            <div className="relative">
              <ShoppingCart className="h-5 w-5" />
              {cartCount > 0 && (
                <span className="absolute -top-1.5 -right-2 inline-flex items-center justify-center px-1.5 py-0.5 text-[8px] font-black leading-none text-white bg-brand-blue rounded-full">
                  {cartCount}
                </span>
              )}
            </div>
            <span className="text-[9px] font-bold mt-1 tracking-tight">Cart</span>
          </button>

          {/* Tab 4: Wishlist */}
          <button 
            onClick={() => handleTabClick('wishlist')}
            className={`flex min-h-12 flex-col items-center justify-center flex-1 transition-all relative py-1 cursor-pointer rounded-xl active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
              currentPage === 'wishlist' && !isAdminMode ? activeTabClass : inactiveTabClass
            }`}
            aria-label={`Open wishlist with ${wishlistCount} saved ${wishlistCount === 1 ? 'product' : 'products'}`}
            aria-current={currentPage === 'wishlist' && !isAdminMode ? 'page' : undefined}
          >
            <div className="relative">
              <Heart className="h-5 w-5" />
              {wishlistCount > 0 && (
                <span className="absolute -top-1.5 -right-2 inline-flex items-center justify-center px-1.5 py-0.5 text-[8px] font-black leading-none text-white bg-red-500 rounded-full">
                  {wishlistCount}
                </span>
              )}
            </div>
            <span className="text-[9px] font-bold mt-1 tracking-tight">Wishlist</span>
            {currentPage === 'wishlist' && !isAdminMode && (
              <span className="absolute bottom-0 w-1 h-1 bg-brand-blue rounded-full"></span>
            )}
          </button>

          {/* Tab 5: More Menu Bottom Sheet Toggle */}
          <button 
            onClick={() => setIsMoreMenuOpen(!isMoreMenuOpen)}
            className={`flex min-h-12 flex-col items-center justify-center flex-1 transition-all relative py-1 cursor-pointer rounded-xl active:scale-95 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
              isMoreMenuOpen ? 'text-brand-blue scale-110' : 'text-slate-500 hover:text-slate-700'
            }`}
            aria-label={isMoreMenuOpen ? 'Close more menu' : 'Open more menu'}
            aria-expanded={isMoreMenuOpen}
            aria-controls="mobile-more-menu"
          >
            {isMoreMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            <span className="text-[9px] font-bold mt-1 tracking-tight">Menu</span>
          </button>

        </div>
      </nav>

      {/* ==================== BOTTOM DRAWER SHEET ==================== */}
      {isMoreMenuOpen && (
        <div id="mobile-more-menu" className="fixed inset-0 z-30 md:hidden" role="dialog" aria-modal="true" aria-labelledby="mobile-more-menu-title">
          {/* Backdrop glass click closer */}
          <button
            type="button"
            onClick={() => setIsMoreMenuOpen(false)}
            className="absolute inset-0 bg-slate-950/40 backdrop-blur-xs transition-opacity"
            aria-label="Close more menu"
          />

          {/* Drawer content board */}
          <div className="absolute bottom-0 left-0 right-0 max-h-[88dvh] bg-white rounded-t-[2rem] sm:rounded-t-[2.5rem] shadow-2xl border-t border-slate-100 flex flex-col overflow-hidden pb-[calc(6.75rem+env(safe-area-inset-bottom))] animate-slideUp">
            
            {/* Grab handle indicator for touch feel */}
            <div className="w-12 h-1 bg-slate-200 rounded-full mx-auto my-3.5 flex-shrink-0"></div>

            <div className="flex items-center justify-between px-5 pb-3">
              <h2 id="mobile-more-menu-title" className="text-lg font-black font-display text-slate-950">More options</h2>
              <button
                ref={menuCloseButtonRef}
                type="button"
                onClick={() => setIsMoreMenuOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 text-slate-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                aria-label="Close more menu"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {/* Inner scroll container */}
            <div className="flex-1 overflow-y-auto overscroll-contain px-5 sm:px-6 space-y-6 text-left">
              
              {/* Header Greeting panel */}
              <div className="bg-slate-50 border border-slate-100 rounded-3xl p-4 flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Logged in as</span>
                  <span className="text-sm font-bold text-slate-800 font-display block truncate max-w-[180px]">
                    {user ? user.displayName || user.email : "Guest Visitor"}
                  </span>
                </div>
                {user ? (
                  <button 
                    onClick={handleLogout}
                    className="min-h-11 px-3.5 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/15"
                  >
                    <LogOut className="h-3.5 w-3.5 mr-1" />
                    Sign Out
                  </button>
                ) : (
                  <button 
                    onClick={() => {
                      setIsMoreMenuOpen(false);
                      onOpenAuthModal();
                    }}
                    className="min-h-11 px-3.5 py-1.5 bg-brand-blue text-white rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center shadow-xs focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                  >
                    <LogIn className="h-3.5 w-3.5 mr-1" />
                    Sign In
                  </button>
                )}
              </div>

              {/* Admin Dashboard shortcut */}
              {isAdminUser && (
                <div className="space-y-2">
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Administration</span>
                  <button
                    onClick={() => {
                      setIsAdminMode(true);
                      setCurrentPage('admin');
                      setIsMoreMenuOpen(false);
                    }}
                    className={`w-full flex items-center justify-between p-4 rounded-2xl border transition-all text-left ${
                      isAdminMode 
                        ? 'bg-blue-50 border-blue-200 text-brand-blue font-bold' 
                        : 'bg-white border-slate-100 hover:border-slate-200 text-slate-700'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <div className="p-2 bg-blue-500/10 text-brand-blue rounded-xl">
                        <LayoutDashboard className="h-4.5 w-4.5" />
                      </div>
                      <div>
                        <span className="text-xs font-bold font-display block">Management Console</span>
                        <span className="text-[10px] text-slate-400 font-light block">Orders, inventory, and metrics</span>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </button>
                </div>
              )}

              {/* Browse Categories Slider segment */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Explore Categories</span>
                  <SlidersHorizontal className="h-3.5 w-3.5 text-slate-400" />
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    onClick={() => handleCategoryClick('all')}
                    className="p-3 rounded-2xl border border-slate-100 hover:border-slate-200 text-left cursor-pointer transition-colors"
                  >
                    <span className="text-[11px] font-bold text-slate-800 block">All Electronics</span>
                    <span className="text-[9px] text-slate-400 font-light">View complete list</span>
                  </button>
                  {categories.map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => handleCategoryClick(cat.id)}
                      className="p-3 rounded-2xl border border-slate-100 hover:border-slate-200 text-left cursor-pointer transition-colors"
                    >
                      <span className="text-[11px] font-bold text-slate-800 block truncate">{cat.name}</span>
                      <span className="text-[9px] text-slate-400 font-light">Browse collection</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Showroom Contacts & Quick Actions */}
              <div className="space-y-3 pt-2">
                <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest block">Customer Support</span>
                
                <div className="grid grid-cols-1 gap-2">
                  {settings?.contactPhone ? (
                    <a 
                      href={`tel:${settings.contactPhone}`}
                      className="flex items-center p-3.5 bg-slate-50 rounded-2xl border border-slate-100 text-slate-700"
                    >
                      <div className="p-1.5 bg-blue-50 text-brand-blue rounded-lg mr-3">
                        <Phone className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="text-xs font-bold block">Hotline Call Support</span>
                        <span className="text-[10px] text-slate-500 font-mono">{settings.contactPhone}</span>
                      </div>
                    </a>
                  ) : (
                    <div className="flex items-center p-3.5 bg-slate-50 rounded-2xl border border-slate-100 text-slate-400">
                      <div className="p-1.5 bg-slate-100 text-slate-300 rounded-lg mr-3">
                        <Phone className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="text-xs font-bold block">Hotline Call Support</span>
                        <span className="text-[10px] text-slate-400 font-mono">Hotline pending setup</span>
                      </div>
                    </div>
                  )}

                  <button 
                    onClick={() => {
                      setCurrentPage('contact');
                      setIsMoreMenuOpen(false);
                    }}
                    className="flex items-center p-3.5 bg-slate-50 rounded-2xl border border-slate-100 text-slate-700 text-left w-full"
                  >
                    <div className="p-1.5 bg-blue-50 text-brand-blue rounded-lg mr-3">
                      <MapPin className="h-4 w-4" />
                    </div>
                    <div>
                      <span className="text-xs font-bold block">Showroom Location</span>
                      <span className="text-[10px] text-slate-500 font-light truncate block max-w-[230px]">
                        Colombo, Sri Lanka
                      </span>
                    </div>
                  </button>
                </div>
              </div>

              {/* Copyright/Footer Info */}
              <div className="pt-4 text-center border-t border-slate-100">
                <p className="text-[10px] text-slate-400 font-light">
                  &copy; {new Date().getFullYear()} {settings?.storeName || "Zyro.lk"} &middot; High-Fidelity Electronics Imports
                </p>
              </div>

            </div>
          </div>
        </div>
      )}
    </>
  );
}
