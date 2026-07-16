import React, { useEffect, useRef, useState } from 'react';
import { 
  Home, ShoppingBag, Heart, ShoppingCart, Menu, X, 
  LayoutDashboard, LogIn, LogOut, Phone, MapPin, 
  ChevronRight, SlidersHorizontal, UserRound, ShieldCheck, MessageCircle,
  Mail, HelpCircle, LockKeyhole, Info
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
        <div className="zy-mobile-dock bg-white/95 backdrop-blur-xl border border-slate-200/80 rounded-2xl px-1.5 py-1.5 flex justify-around items-stretch">
          
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
          <div className="zy-mobile-sheet absolute bottom-0 left-0 right-0 max-h-[88dvh] bg-white rounded-t-[2rem] sm:rounded-t-[2.5rem] shadow-2xl border-t border-slate-100 flex flex-col overflow-hidden pb-[calc(6.75rem+env(safe-area-inset-bottom))] animate-slideUp">
            
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
              
              {/* Premium profile card */}
              <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-700 via-brand-blue to-blue-500 p-5 text-white shadow-xl shadow-blue-950/20">
                <div className="relative z-10 flex items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/25 bg-white/15 text-lg font-black">
                    {user ? (user.displayName || user.email || 'Z').slice(0, 1).toUpperCase() : <UserRound className="h-5 w-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="block text-[10px] font-black uppercase tracking-[0.16em] text-blue-100">{user ? 'Welcome back' : 'Welcome to Zyro.lk'}</span>
                    <span className="block truncate text-base font-black font-display">{user ? user.displayName || 'Zyro.lk Customer' : 'Guest shopper'}</span>
                    <span className="block truncate text-[11px] text-blue-100">{user?.email || 'Sign in for a personalized shopping experience'}</span>
                  </div>
                  {user && <ShieldCheck className="h-5 w-5 shrink-0 text-blue-100" aria-label="Signed in account" />}
                </div>
                <div className="relative z-10 mt-4 grid grid-cols-2 gap-2 border-t border-white/15 pt-4">
                  <div className="rounded-xl bg-white/10 px-3 py-2"><span className="block text-lg font-black">{wishlistCount}</span><span className="text-[9px] font-bold uppercase tracking-wider text-blue-100">Saved items</span></div>
                  <div className="rounded-xl bg-white/10 px-3 py-2"><span className="block text-lg font-black">{cartCount}</span><span className="text-[9px] font-bold uppercase tracking-wider text-blue-100">Cart items</span></div>
                </div>
                {!user && (
                  <button 
                    onClick={() => {
                      setIsMoreMenuOpen(false);
                      onOpenAuthModal();
                    }}
                    className="relative z-10 mt-4 min-h-11 w-full rounded-xl border border-white bg-white px-4 text-xs font-black text-brand-blue shadow-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30"
                  >
                    <LogIn className="mr-1 inline h-3.5 w-3.5" />
                    Sign In
                  </button>
                )}
              </div>

              <div className="space-y-2.5">
                <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-400">Quick Actions</span>
                <div className="grid grid-cols-2 gap-2.5">
                  <button onClick={() => handleTabClick('products')} className="zy-account-action"><ShoppingBag className="h-4.5 w-4.5 text-brand-blue" /><span>Shop products</span></button>
                  <button onClick={() => handleTabClick('wishlist')} className="zy-account-action"><Heart className="h-4.5 w-4.5 text-red-500" /><span>Wishlist</span></button>
                  <button onClick={() => { setIsMoreMenuOpen(false); onOpenCart(); }} className="zy-account-action"><ShoppingCart className="h-4.5 w-4.5 text-brand-blue" /><span>Cart</span></button>
                  <button onClick={() => handleTabClick('categories')} className="zy-account-action"><SlidersHorizontal className="h-4.5 w-4.5 text-brand-blue" /><span>Categories</span></button>
                </div>
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
                    <span className="text-[11px] font-bold text-slate-800 block">All Products</span>
                    <span className="text-[9px] text-slate-400 font-light">View the live catalog</span>
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
                  {settings?.whatsappNumber && (
                    <a href={`https://wa.me/${settings.whatsappNumber.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer" className="flex items-center rounded-2xl border border-emerald-100 bg-emerald-50/70 p-3.5 text-slate-700">
                      <div className="mr-3 rounded-lg bg-white p-1.5 text-emerald-600"><MessageCircle className="h-4 w-4" /></div>
                      <div><span className="block text-xs font-bold">WhatsApp Support</span><span className="text-[10px] text-slate-500">Chat before or after ordering</span></div>
                    </a>
                  )}
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
                  ) : null}

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
                      <span className="text-xs font-bold block">Contact &amp; Support</span>
                      <span className="text-[10px] text-slate-500 font-light truncate block max-w-[230px]">
                        View available support options
                      </span>
                    </div>
                  </button>
                  {settings?.contactEmail && (
                    <a href={`mailto:${settings.contactEmail}`} className="flex items-center rounded-2xl border border-slate-100 bg-slate-50 p-3.5 text-slate-700">
                      <div className="mr-3 rounded-lg bg-blue-50 p-1.5 text-brand-blue"><Mail className="h-4 w-4" /></div>
                      <div className="min-w-0"><span className="block text-xs font-bold">Email Support</span><span className="block truncate text-[10px] text-slate-500">{settings.contactEmail}</span></div>
                    </a>
                  )}
                  <button onClick={() => handleTabClick('faq')} className="flex w-full items-center rounded-2xl border border-slate-100 bg-slate-50 p-3.5 text-left text-slate-700">
                    <div className="mr-3 rounded-lg bg-blue-50 p-1.5 text-brand-blue"><HelpCircle className="h-4 w-4" /></div>
                    <div><span className="block text-xs font-bold">Frequently Asked Questions</span><span className="text-[10px] text-slate-500">Shopping and delivery guidance</span></div>
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                <span className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-400">Information</span>
                <div className="grid grid-cols-2 gap-2.5">
                  <button onClick={() => handleTabClick('privacy-policy')} className="zy-account-action"><LockKeyhole className="h-4.5 w-4.5 text-slate-500" /><span>Privacy</span></button>
                  <button onClick={() => handleTabClick('about-us')} className="zy-account-action"><Info className="h-4.5 w-4.5 text-slate-500" /><span>About</span></button>
                </div>
              </div>

              {user && (
                <button onClick={handleLogout} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-red-100 bg-red-50 text-sm font-black text-red-600 transition-colors hover:bg-red-100 focus-visible:ring-4 focus-visible:ring-red-500/15">
                  <LogOut className="h-4.5 w-4.5" /> Sign Out
                </button>
              )}

              {/* Copyright/Footer Info */}
              <div className="pt-4 text-center border-t border-slate-100">
                <p className="text-[10px] text-slate-400 font-light">
                  &copy; {new Date().getFullYear()} {settings?.storeName || "Zyro.lk"} &middot; Your trusted Sri Lankan marketplace
                </p>
              </div>

            </div>
          </div>
        </div>
      )}
    </>
  );
}
