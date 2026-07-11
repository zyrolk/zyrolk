import React, { useState } from 'react';
import { Mail, Phone, MapPin, ShieldCheck, Truck, RefreshCw, Send, Check, Facebook, Instagram, Youtube } from 'lucide-react';
import { WebsiteSettings } from '../types';

interface FooterProps {
  setCurrentPage: (page: string) => void;
  onSelectCategory: (category: string) => void;
  settings?: WebsiteSettings | null;
}

export default function Footer({ setCurrentPage, onSelectCategory, settings }: FooterProps) {
  const [email, setEmail] = useState("");
  const [subscribed, setSubscribed] = useState(false);

  const handleSubscribe = (e: React.FormEvent) => {
    e.preventDefault();
    if (email) {
      setSubscribed(true);
      setTimeout(() => {
        setSubscribed(false);
        setEmail("");
      }, 3000);
    }
  };

  const handleCategoryClick = (cat: string) => {
    onSelectCategory(cat);
    setCurrentPage('products');
  };

  const footerLogo = settings?.footerLogoUrl || settings?.logoUrl;

  return (
    <footer className="bg-slate-950 text-slate-300 pt-16 sm:pt-20 pb-8 border-t border-slate-800">
      
      {/* 1. Trust Pillars Segment */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12 border-b border-slate-800/80 grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
        
        <div className="flex items-start space-x-4 rounded-3xl border border-white/10 bg-white/5 p-5">
          <div className="p-3 bg-blue-500/12 rounded-2xl text-blue-300">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h4 className="text-white text-base font-bold font-display mb-1">Authorized Brand Warranty</h4>
            <p className="text-xs text-slate-400 font-light leading-relaxed">
              We source all devices directly from certified distributors. Every purchase includes official brand service support.
            </p>
          </div>
        </div>

        <div className="flex items-start space-x-4 rounded-3xl border border-white/10 bg-white/5 p-5">
          <div className="p-3 bg-blue-500/12 rounded-2xl text-blue-300">
            <Truck className="h-6 w-6" />
          </div>
          <div>
            <h4 className="text-white text-base font-bold font-display mb-1">Safe Islandwide Shipping</h4>
            <p className="text-xs text-slate-400 font-light leading-relaxed">
              Fast, secure courier tracking directly to your doorstep in Colombo, Gampaha, Kandy, Galle, and outstation districts.
            </p>
          </div>
        </div>

        <div className="flex items-start space-x-4 rounded-3xl border border-white/10 bg-white/5 p-5">
          <div className="p-3 bg-blue-500/12 rounded-2xl text-blue-300">
            <RefreshCw className="h-6 w-6" />
          </div>
          <div>
            <h4 className="text-white text-base font-bold font-display mb-1">Customer Priority Care</h4>
            <p className="text-xs text-slate-400 font-light leading-relaxed">
              7-day direct product replacement policy if you discover any manufacture faults. Outstanding customer ratings.
            </p>
          </div>
        </div>

      </div>

      {/* 2. Main Footer Grid */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-14 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-8 lg:gap-10">
        
        {/* About & Branding */}
        <div className="space-y-4 text-left">
          {footerLogo ? (
            <img 
              src={footerLogo} 
              alt={settings?.storeName || "Zyro.lk"} 
              className="h-10 max-w-[180px] object-contain" 
              referrerPolicy="no-referrer"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <span className="text-2xl font-bold font-display text-white">
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
          <p className="text-xs text-slate-400 font-light leading-relaxed">
            {settings?.aboutText || "Sri Lanka's premier destination for high-end digital solutions, smart energy solar, kitchen devices, and lifestyle audio components."}
          </p>

          {/* Social media links */}
          <div className="flex space-x-3 pt-2">
            {settings?.facebookUrl && (
              <a href={settings.facebookUrl} target="_blank" rel="noopener noreferrer" aria-label="Visit Zyro.lk on Facebook" className="flex h-11 w-11 items-center justify-center bg-slate-800 hover:bg-brand-blue text-white rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-400/40">
                <Facebook className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
            {settings?.instagramUrl && (
              <a href={settings.instagramUrl} target="_blank" rel="noopener noreferrer" aria-label="Visit Zyro.lk on Instagram" className="flex h-11 w-11 items-center justify-center bg-slate-800 hover:bg-pink-600 text-white rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-pink-400/40">
                <Instagram className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
            {settings?.tiktokUrl && (
              <a href={settings.tiktokUrl} target="_blank" rel="noopener noreferrer" aria-label="Visit Zyro.lk on TikTok" className="flex h-11 w-11 items-center justify-center bg-slate-800 hover:bg-zinc-800 text-white rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30 font-bold text-xs">
                <span aria-hidden="true">🎵</span>
              </a>
            )}
            {settings?.youtubeUrl && (
              <a href={settings.youtubeUrl} target="_blank" rel="noopener noreferrer" aria-label="Visit Zyro.lk on YouTube" className="flex h-11 w-11 items-center justify-center bg-slate-800 hover:bg-red-600 text-white rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-400/40">
                <Youtube className="h-4 w-4" aria-hidden="true" />
              </a>
            )}
          </div>

          <div className="pt-2 text-xs text-slate-500 font-light">
            {settings?.copyrightText || `© ${new Date().getFullYear()} ${settings?.storeName || "Zyro.lk"}. All rights reserved.`}
          </div>
        </div>

        {/* Quick Links */}
        <div className="space-y-4 text-left">
          <h4 className="text-sm font-black text-white uppercase tracking-wider">Explore Store</h4>
          <ul className="text-xs">
            <li><button onClick={() => setCurrentPage('home')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Homepage</button></li>
            <li><button onClick={() => setCurrentPage('products')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Browse All Products</button></li>
            <li><button onClick={() => setCurrentPage('categories')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Product Categories</button></li>
            <li><button onClick={() => setCurrentPage('wishlist')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">My Saved Wishlist</button></li>
            <li><button onClick={() => setCurrentPage('contact')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Support & Directions</button></li>
          </ul>
        </div>

        {/* Categorized Products */}
        <div className="space-y-4 text-left">
          <h4 className="text-sm font-black text-white uppercase tracking-wider">Top Categories</h4>
          <ul className="text-xs">
            <li><button onClick={() => handleCategoryClick('electronics')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Flagship Electronics</button></li>
            <li><button onClick={() => handleCategoryClick('solar-lighting')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Solar & Power Solutions</button></li>
            <li><button onClick={() => handleCategoryClick('home-kitchen')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Premium Home & Kitchen</button></li>
            <li><button onClick={() => handleCategoryClick('accessories')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Sleek Tech Accessories</button></li>
          </ul>
        </div>

        {/* Company & Support CMS Pages */}
        <div className="space-y-4 text-left">
          <h4 className="text-sm font-black text-white uppercase tracking-wider">Company & Legal</h4>
          <ul className="text-xs">
            <li><button onClick={() => setCurrentPage('about-us')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">About Us</button></li>
            <li><button onClick={() => setCurrentPage('faq')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">FAQs & Guides</button></li>
            <li><button onClick={() => setCurrentPage('return-policy')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Return & Warranty</button></li>
            <li><button onClick={() => setCurrentPage('terms-conditions')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Terms & Conditions</button></li>
            <li><button onClick={() => setCurrentPage('privacy-policy')} className="inline-flex min-h-11 items-center hover:text-white transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:text-white focus-visible:underline">Privacy Policy</button></li>
          </ul>
        </div>

        {/* Newsletter & Sub */}
        <div className="space-y-4 text-left">
          <h4 className="text-sm font-black text-white uppercase tracking-wider">Exclusive Club</h4>
          <p className="text-xs text-slate-400 font-light leading-relaxed">
            Subscribe to receive flash discount codes, tech arrival newsletters, and solar optimization tips.
          </p>
          
          <form onSubmit={handleSubscribe} className="relative mt-2">
            <label htmlFor="footer-newsletter-email" className="sr-only">Email address for newsletter</label>
            <input
              id="footer-newsletter-email"
              type="email"
              required
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="zy-input min-h-11 w-full bg-slate-900/80 text-slate-100 text-xs pl-3.5 pr-12 py-2.5 rounded-xl border-slate-700/70 focus-visible:outline-none focus-visible:border-brand-blue focus-visible:ring-4 focus-visible:ring-blue-400/20 transition-all"
            />
            <button
              type="submit"
              aria-label={subscribed ? 'Newsletter subscription confirmed' : 'Subscribe to newsletter'}
              className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center bg-brand-blue text-white rounded-xl hover:bg-blue-700 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-300/40"
            >
              {subscribed ? <Check className="h-4 w-4" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
            </button>
          </form>
          {subscribed && (
            <p className="text-xs text-emerald-400 font-semibold" role="status" aria-live="polite">
              Thank you! Welcome to the Zyro Elite Club.
            </p>
          )}
        </div>

      </div>

      {/* 3. Showroom & Contact details bottom */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 border-t border-slate-800/80 flex flex-col md:flex-row justify-between text-xs text-slate-500 font-light space-y-4 md:space-y-0 text-left">
        <div className="flex flex-col md:flex-row space-y-2 md:space-y-0 md:space-x-6">
          <span className="flex items-center">
            <MapPin className="h-4 w-4 mr-1.5 text-brand-blue animate-pulse" />
            {settings?.contactAddress || "Address pending setup"}
          </span>
          <span className="flex items-center">
            <Phone className="h-4 w-4 mr-1.5 text-brand-blue" />
            Hotline: {settings?.contactPhone || "Pending setup"}{settings?.contactPhone2 ? ` / ${settings.contactPhone2}` : ""}
          </span>
          <span className="flex items-center">
            <Mail className="h-4 w-4 mr-1.5 text-brand-blue" />
            {settings?.contactEmail || "Email pending setup"}
          </span>
        </div>
        <div>
          Designed for maximum speed & mobile-first efficiency.
        </div>
      </div>

    </footer>
  );
}
