import React, { useState, useEffect } from 'react';
import { 
  Menu, X, Search, Heart, ShoppingBag, User, 
  LayoutDashboard, LogIn, LogOut, ChevronDown, Phone 
} from 'lucide-react';
import { auth, db } from '../firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { WebsiteSettings } from '../types';

interface NavbarProps {
  currentPage: string;
  setCurrentPage: (page: string) => void;
  cartCount: number;
  wishlistCount: number;
  onOpenCart: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
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

  useEffect(() => {
    setTempSearch(searchQuery || "");
  }, [searchQuery]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchQuery(tempSearch);
    setCurrentPage('products');
    setIsMobileMenuOpen(false);
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

  return (
    <header className="sticky top-0 z-50 w-full bg-white/95 backdrop-blur-md border-b border-slate-100 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          
          {/* Logo */}
          <div className="flex-shrink-0 flex items-center cursor-pointer" onClick={() => { setCurrentPage('home'); setIsAdminMode(false); }}>
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
          </div>

          {/* Desktop Search Bar */}
          <div className="hidden md:flex flex-1 max-w-md mx-8">
            <form onSubmit={handleSearchSubmit} className="relative w-full">
              <input
                type="text"
                placeholder="Search premium electronics..."
                value={tempSearch}
                onChange={(e) => setTempSearch(e.target.value)}
                className="w-full pl-10 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 rounded-full focus:outline-hidden focus:ring-2 focus:ring-brand-blue/20 focus:border-brand-blue transition-all"
              />
              <Search className="absolute left-3.5 top-2.5 h-4.5 w-4.5 text-slate-400" />
            </form>
          </div>

          {/* Desktop Navigation Links */}
          <nav className="hidden lg:flex space-x-8">
            {navLinks.map((link) => (
              <button
                key={link.id}
                onClick={() => {
                  setCurrentPage(link.id);
                  setIsAdminMode(false);
                }}
                className={`text-sm font-medium transition-colors cursor-pointer py-1 ${
                  currentPage === link.id && !isAdminMode
                    ? 'text-brand-blue border-b-2 border-brand-blue'
                    : 'text-slate-600 hover:text-slate-900'
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
                className="hidden xl:flex items-center text-xs font-semibold text-slate-700 bg-slate-100 py-1.5 px-3 rounded-full hover:bg-slate-200 transition-colors"
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
                className="p-2 text-slate-600 hover:text-red-500 relative transition-colors cursor-pointer"
                title="Wishlist"
              >
                <Heart className={`h-5 w-5 ${currentPage === 'wishlist' ? 'fill-red-500 text-red-500' : ''}`} />
                {wishlistCount > 0 && (
                  <span className="absolute top-0 right-0 inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-bold leading-none text-white bg-red-500 rounded-full">
                    {wishlistCount}
                  </span>
                )}
              </button>
            )}

            {/* Cart Button */}
            <button 
              onClick={onOpenCart}
              className="p-2 text-slate-600 hover:text-brand-blue relative transition-colors cursor-pointer"
              title="Shopping Cart"
            >
              <ShoppingBag className="h-5 w-5" />
              {cartCount > 0 && (
                <span className="absolute top-0 right-0 inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-bold leading-none text-white bg-brand-blue rounded-full">
                  {cartCount}
                </span>
              )}
            </button>

            {/* User Dropdown */}
            <div className="relative">
              <button
                onClick={() => setIsProfileOpen(!isProfileOpen)}
                className="flex items-center space-x-1 p-2 text-slate-600 hover:text-slate-900 focus:outline-hidden cursor-pointer"
              >
                <User className="h-5 w-5" />
                <ChevronDown className="h-3.5 w-3.5 hidden sm:block" />
              </button>

              {isProfileOpen && (
                <div className="absolute right-0 mt-2 w-56 rounded-xl bg-white shadow-lg ring-1 ring-black/5 divide-y divide-slate-100 z-50">
                  <div className="px-4 py-3">
                    <p className="text-xs text-slate-400">Signed in as</p>
                    <p className="text-sm font-medium text-slate-800 truncate">
                      {user ? user.displayName || user.email : "Guest Session"}
                    </p>
                  </div>
                  {isAdminUser && (
                    <div className="py-1">
                      {/* Access Admin mode only for admins */}
                      <button
                        onClick={() => {
                          setIsAdminMode(true);
                          setCurrentPage('admin');
                          setIsProfileOpen(false);
                        }}
                        className={`flex w-full items-center px-4 py-2.5 text-sm text-left cursor-pointer transition-colors ${
                          isAdminMode ? 'bg-slate-50 text-brand-blue font-semibold' : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900'
                        }`}
                      >
                        <LayoutDashboard className="h-4 w-4 mr-2" />
                        Admin Dashboard
                      </button>
                    </div>
                  )}
                  <div className="py-1">
                    {user ? (
                      <button
                        onClick={handleLogout}
                        className="flex w-full items-center px-4 py-2.5 text-sm text-slate-700 hover:bg-red-50 hover:text-red-600 text-left cursor-pointer transition-colors"
                      >
                        <LogOut className="h-4 w-4 mr-2" />
                        Sign Out
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          onOpenAuthModal();
                          setIsProfileOpen(false);
                        }}
                        className="flex w-full items-center px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 hover:text-slate-900 text-left cursor-pointer transition-colors"
                      >
                        <LogIn className="h-4 w-4 mr-2" />
                        Sign In / Register
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Mobile Hamburger Menu Button */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="lg:hidden p-2 text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              {isMobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>

          </div>
        </div>
      </div>

      {/* Mobile Menu Panel */}
      {isMobileMenuOpen && (
        <div className="lg:hidden bg-white border-t border-slate-100 py-3 px-4 space-y-3 animate-fadeIn">
          {/* Mobile Search Bar */}
          <form onSubmit={handleSearchSubmit} className="relative w-full">
            <input
              type="text"
              placeholder="Search premium electronics..."
              value={tempSearch}
              onChange={(e) => setTempSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 rounded-full focus:outline-hidden"
            />
            <Search className="absolute left-3.5 top-2.5 h-4.5 w-4.5 text-slate-400" />
          </form>

          {/* Mobile Links */}
          <div className="flex flex-col space-y-2 pt-2">
            {navLinks.map((link) => (
              <button
                key={link.id}
                onClick={() => {
                  setCurrentPage(link.id);
                  setIsAdminMode(false);
                  setIsMobileMenuOpen(false);
                }}
                className={`text-left px-3 py-2 rounded-lg text-base font-medium transition-colors ${
                  currentPage === link.id && !isAdminMode
                    ? 'bg-brand-blue/10 text-brand-blue'
                    : 'text-slate-700 hover:bg-slate-50'
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
                className={`text-left px-3 py-2 rounded-lg text-base font-medium transition-colors flex items-center ${
                  isAdminMode
                    ? 'bg-brand-blue/10 text-brand-blue'
                    : 'text-slate-700 hover:bg-slate-50'
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
