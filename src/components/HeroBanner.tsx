import { TouchEvent, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'motion/react';
import { ShoppingBag, ArrowRight, Banknote, ChevronLeft, ChevronRight, Headphones, ShieldCheck, Sparkles, Truck } from 'lucide-react';
import { Category, Product, WebsiteSettings } from '../types';
import { normalizeSlideSpeed } from '../services/hero-slider/heroSlider';

interface HeroBannerProps {
  onExploreProducts: () => void;
  onBrowseCategories?: () => void;
  settings?: WebsiteSettings | null;
  products?: readonly Product[];
  categories?: readonly Category[];
}

const campaignTone = (value?: string) => {
  if (value?.includes('orange')) return 'from-orange-50 via-white to-amber-100';
  if (value?.includes('emerald')) return 'from-emerald-50 via-white to-cyan-100';
  if (value?.includes('purple')) return 'from-violet-50 via-white to-blue-100';
  return 'from-white via-blue-50 to-blue-200';
};

const isPromotionalBadge = (badge: string): boolean =>
  /\b(?:deal|discount|limited|offer|off|sale|save)\b/iu.test(badge);

const MARKETPLACE_MESSAGE = 'Shop fashion, home, beauty, electronics, lifestyle, accessories and thousands of products in one trusted Sri Lankan marketplace.';
const PREMIUM_ELECTRONICS_PATTERN = /premium\s+electronics/giu;

const replacePremiumElectronics = (value: string, replacement: string): string =>
  value.replace(PREMIUM_ELECTRONICS_PATTERN, replacement).trim();

const marketplaceSafeSubtitle = (value: string): string =>
  /\belectronics?\b/iu.test(value) ? MARKETPLACE_MESSAGE : replacePremiumElectronics(value, 'marketplace');

const isElectronicsCategory = (value: string): boolean => /\belectronics?\b/iu.test(value);

export default function HeroBanner({
  onExploreProducts,
  onBrowseCategories,
  settings,
  products = [],
  categories = [],
}: HeroBannerProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const touchStartX = useRef<number | null>(null);
  const shouldReduceMotion = useReducedMotion();

  const liveCatalogVisuals = useMemo(() => {
    const seenCategories = new Set<string>();
    const marketplaceFirstProducts = [
      ...products.filter(product => !isElectronicsCategory(product.category)),
      ...products.filter(product => isElectronicsCategory(product.category)),
    ];
    return marketplaceFirstProducts.filter((product) => {
      if (product.isActive === false || !product.imageUrl?.trim() || seenCategories.has(product.category)) return false;
      seenCategories.add(product.category);
      return true;
    }).slice(0, 4);
  }, [products]);
  const liveCategoryVisuals = useMemo(
    () => categories.filter(category => Boolean(category.imageUrl?.trim())).slice(0, 2),
    [categories],
  );

  const configuredSlides = settings?.heroBanners?.filter((banner) => banner.enabled !== false) || [];
  const cmsSlides = configuredSlides.map((banner, index) => ({
    id: banner.id || `banner-${index}`,
    badge: banner.badge?.trim() || '',
    title: banner.title,
    subtitle: banner.subtitle,
    description: banner.description,
    image: banner.image,
    bgGradient: banner.bgGradient,
    cta: banner.buttonText?.trim() || '',
    ctaUrl: banner.buttonUrl?.trim() || '',
  }));
  const slides = cmsSlides.length > 0 ? cmsSlides : [{
    id: 'live-catalog',
    badge: '',
    title: '',
    subtitle: '',
    description: '',
    image: liveCatalogVisuals[0]?.imageUrl || liveCategoryVisuals[0]?.imageUrl || '',
    bgGradient: 'blue',
    cta: 'Shop Now',
    ctaUrl: '/products',
  }];
  const activeSlide = slides[currentSlide];
  const displayBadge = replacePremiumElectronics(activeSlide.badge, 'Marketplace offer');
  const displayTitle = replacePremiumElectronics(activeSlide.title, 'Marketplace Collection');
  const displayCta = replacePremiumElectronics(activeSlide.cta, 'Shop Marketplace');
  const displaySubtitle = activeSlide.subtitle?.trim()
    ? marketplaceSafeSubtitle(activeSlide.subtitle)
    : MARKETPLACE_MESSAGE;
  const displayDescription = /\belectronics?\b/iu.test(activeSlide.description)
    ? ''
    : replacePremiumElectronics(activeSlide.description, 'marketplace products');

  // Slide Duration
  const slideDuration = normalizeSlideSpeed(settings?.autoSlideSpeed) * 1000;
  const intervalTime = 50; // update every 50ms for buttery smooth bar filling
  const isSliderActive = settings?.enableSlider !== false;

  useEffect(() => {
    if (!isPlaying || !isSliderActive || slides.length < 2 || shouldReduceMotion) return;

    const step = (intervalTime / slideDuration) * 100;
    const timer = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          setCurrentSlide((curr) => (curr + 1) % slides.length);
          return 0;
        }
        return prev + step;
      });
    }, intervalTime);

    return () => clearInterval(timer);
  }, [isPlaying, slides.length, isSliderActive, slideDuration, shouldReduceMotion]);

  useEffect(() => {
    setCurrentSlide((current) => Math.min(current, Math.max(0, slides.length - 1)));
    setProgress(0);
  }, [slides.length]);

  const handlePrimaryAction = () => {
    const target = slides[currentSlide].ctaUrl;
    if (!target || target === '/products') {
      onExploreProducts();
      return;
    }
    if (target === '/categories' && onBrowseCategories) {
      onBrowseCategories();
      return;
    }
    if (target.startsWith('/')) {
      window.location.assign(target);
      return;
    }
    window.open(target, '_blank', 'noopener,noreferrer');
  };

  const handleSlideSelect = (idx: number) => {
    setCurrentSlide(idx);
    setProgress(0);
  };

  const handlePrev = () => {
    setCurrentSlide((curr) => (curr - 1 + slides.length) % slides.length);
    setProgress(0);
  };

  const handleNext = () => {
    setCurrentSlide((curr) => (curr + 1) % slides.length);
    setProgress(0);
  };

  const handleTouchStart = (event: TouchEvent) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
    setIsPlaying(false);
  };

  const handleTouchEnd = (event: TouchEvent) => {
    const startX = touchStartX.current;
    const endX = event.changedTouches[0]?.clientX;
    touchStartX.current = null;
    setIsPlaying(!shouldReduceMotion);
    if (startX === null || endX === undefined || Math.abs(startX - endX) < 48 || slides.length < 2) return;
    if (startX > endX) handleNext();
    else handlePrev();
  };

  return (
    <MotionConfig reducedMotion="user">
    <div
      className="zy-hero group relative mx-auto w-full max-w-7xl px-4 text-slate-900 sm:px-6 lg:px-8"
      onMouseEnter={() => setIsPlaying(false)}
      onMouseLeave={() => setIsPlaying(!shouldReduceMotion)}
      onFocusCapture={() => setIsPlaying(false)}
      onBlurCapture={() => setIsPlaying(!shouldReduceMotion)}
      role="region"
      aria-roledescription="carousel"
      aria-label="Featured products"
    >
      <div className="zy-hero-stage relative min-h-[380px] touch-pan-y overflow-hidden rounded-[2rem] sm:min-h-[440px] sm:rounded-[2.75rem] lg:min-h-[530px]" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        <div className={`absolute inset-0 bg-gradient-to-br ${campaignTone(isPromotionalBadge(slides[currentSlide].badge) ? slides[currentSlide].bgGradient : undefined)}`} />
        <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-blue-500/20 blur-3xl" />
        <div className="absolute -bottom-28 left-1/3 h-72 w-72 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="absolute right-[8%] top-[12%] hidden h-[76%] w-[42%] rotate-[-4deg] rounded-[3rem] border border-white/60 bg-gradient-to-br from-blue-600 to-blue-800 shadow-2xl shadow-blue-950/25 lg:block" />

        <AnimatePresence mode="wait">
          <motion.div
            key={currentSlide}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.45 }}
            className="relative z-10 grid min-h-[380px] grid-cols-12 items-center gap-3 px-5 py-6 sm:min-h-[440px] sm:gap-6 sm:px-8 sm:py-9 lg:min-h-[530px] lg:px-12"
          role="group"
          aria-roledescription="slide"
          aria-label={`${currentSlide + 1} of ${slides.length}: ${displayTitle || 'Marketplace campaign'}`}
        >
            <div className="col-span-8 flex min-w-0 flex-col items-start text-left sm:col-span-7 lg:col-span-6 lg:pr-8">
              {displayBadge && (
              <motion.span
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15, duration: 0.5 }}
                className={`mb-3 inline-flex items-center gap-2 rounded-full border px-3 py-2 text-[11px] font-black uppercase tracking-[0.12em] shadow-sm backdrop-blur-md sm:mb-4 ${isPromotionalBadge(displayBadge) ? 'border-orange-200 bg-orange-50/90 text-orange-700' : 'border-blue-200 bg-white/85 text-brand-blue'}`}
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                {displayBadge}
              </motion.span>
              )}
              <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25, duration: 0.6 }}
                className="max-w-3xl text-[1.85rem] font-black leading-[0.98] tracking-[-0.04em] text-[#111827] font-display sm:text-4xl lg:text-[3.5rem]"
              >
                Everything You Need
                <span className="block text-brand-blue">Across Every Category</span>
              </motion.h1>
              {displayTitle && <motion.p
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.55 }}
                className="mt-3 max-w-xl text-sm font-black text-slate-800 sm:text-base"
              >
                {displayTitle}
              </motion.p>}
              <motion.p
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35, duration: 0.6 }}
                className="mt-3 max-w-xl text-[13px] font-semibold leading-relaxed text-slate-700 sm:mt-4 sm:text-sm lg:text-base"
              >
                {displaySubtitle}
              </motion.p>
              {displayDescription && <motion.p
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.45, duration: 0.6 }}
                className="mt-2 hidden max-w-lg text-sm leading-relaxed text-slate-600 sm:block"
              >
                {displayDescription}
              </motion.p>}
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.55, duration: 0.6 }}
                className="mt-5 flex w-full flex-col gap-2.5 sm:w-auto sm:flex-row"
              >
                {displayCta && <button
                  onClick={handlePrimaryAction}
                  className="zy-button zy-button-primary min-h-12 w-full rounded-2xl px-7 text-sm sm:w-auto"
                >
                  <ShoppingBag className="h-4.5 w-4.5" />
                  {displayCta}
                </button>}
                <button
                  onClick={onBrowseCategories || onExploreProducts}
                  className="zy-button min-h-12 w-full rounded-2xl border border-blue-200 bg-white px-7 text-sm font-black text-slate-800 shadow-lg shadow-blue-950/5 sm:w-auto"
                >
                  Browse Categories
                  <ArrowRight className="h-4.5 w-4.5 text-brand-blue" />
                </button>
              </motion.div>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.7, duration: 0.5 }}
                className="mt-4 grid w-full grid-cols-2 gap-2 text-[10px] font-black text-slate-700 sm:text-xs lg:mt-5 lg:flex lg:w-auto lg:flex-wrap"
                aria-label="Store benefits"
              >
                {[
                  { label: 'Cash on Delivery', icon: Banknote },
                  { label: 'Islandwide Delivery', icon: Truck },
                  { label: 'Secure Checkout', icon: ShieldCheck },
                  { label: 'Customer Support', icon: Headphones },
                ].map(({ label, icon: Icon }) => (
                  <span key={label} className="inline-flex min-h-12 items-center gap-1.5 rounded-xl border border-white bg-white/80 px-2.5 py-2 shadow-sm backdrop-blur-md">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                  </span>
                ))}
              </motion.div>
            </div>

            <div className="relative col-span-4 min-h-[230px] self-stretch sm:col-span-5 sm:min-h-[340px] lg:col-span-6 lg:min-h-[470px]" aria-label="Live catalog product showcase">
              <div className="absolute inset-[8%] rounded-full bg-blue-500/18 blur-3xl" />
              <motion.div initial={{ opacity: 0, scale: 0.94, x: 20 }} animate={{ opacity: 1, scale: 1, x: 0 }} transition={{ duration: 0.55, delay: 0.15 }} className="absolute inset-2 flex items-center justify-center sm:inset-6 lg:inset-8">
                <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[1.75rem] border border-white/70 bg-white/55 p-2 shadow-2xl shadow-blue-950/15 backdrop-blur-md sm:rounded-[2.5rem] sm:p-5">
                  <ShoppingBag className="absolute h-16 w-16 text-blue-200" aria-hidden="true" />
                  {slides[currentSlide].image && <img
                    src={slides[currentSlide].image}
                    alt={displayTitle || 'Live catalog product'}
                    className="relative z-10 h-full w-full object-contain drop-shadow-[0_24px_30px_rgba(15,23,42,0.18)]"
                    loading={currentSlide === 0 ? 'eager' : 'lazy'}
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={(event) => { event.currentTarget.style.display = 'none'; }}
                  />}
                </div>
              </motion.div>
              {liveCatalogVisuals.slice(0, 2).map((product, index) => (
                <motion.div
                  key={product.id}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.45 + (index * 0.1) }}
                  className={`absolute z-20 hidden h-24 w-24 overflow-hidden rounded-3xl border border-white/80 bg-white/90 p-2 shadow-xl backdrop-blur-md lg:block ${index === 0 ? 'bottom-9 left-0 -rotate-6' : 'right-0 top-20 rotate-6'}`}
                >
                  <img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                </motion.div>
              ))}
              {displayBadge && isPromotionalBadge(displayBadge) && (
                <motion.div initial={{ opacity: 0, scale: 0.8, rotate: -8 }} animate={{ opacity: 1, scale: 1, rotate: 6 }} transition={{ delay: 0.55 }} className="absolute right-0 top-3 z-20 hidden max-w-28 rounded-2xl border-4 border-white bg-brand-orange px-4 py-3 text-center text-[10px] font-black uppercase leading-tight text-white shadow-2xl shadow-orange-900/20 sm:block lg:right-2 lg:top-10">
                  {displayBadge}
                </motion.div>
              )}
            </div>
          </motion.div>
        </AnimatePresence>

        {isSliderActive && slides.length > 1 && (
          <>
          <button
            onClick={handlePrev}
            className="absolute bottom-5 right-20 z-20 hidden h-11 w-11 items-center justify-center rounded-full border border-blue-100 bg-white text-brand-blue shadow-lg transition-all hover:-translate-y-0.5 hover:bg-blue-50 focus-visible:ring-4 focus-visible:ring-brand-blue/20 sm:flex"
            aria-label="Previous slide"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={handleNext}
            className="absolute bottom-5 right-6 z-20 hidden h-11 w-11 items-center justify-center rounded-full bg-brand-blue text-white shadow-lg transition-all hover:-translate-y-0.5 hover:bg-blue-700 focus-visible:ring-4 focus-visible:ring-brand-blue/20 sm:flex"
            aria-label="Next slide"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          </>
        )}

        {isSliderActive && slides.length > 1 && (
        <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/70 bg-white/80 px-3 py-2 shadow-lg backdrop-blur-md sm:bottom-6 sm:left-8 sm:translate-x-0">
          {slides.map((slide, idx) => (
            <button
              key={slide.id}
              onClick={() => handleSlideSelect(idx)}
              className="flex min-h-8 items-center rounded-full px-1 focus-visible:ring-4 focus-visible:ring-brand-blue/20"
              title={`Go to slide ${idx + 1}`}
              aria-label={`Show slide ${idx + 1} of ${slides.length}: ${replacePremiumElectronics(slide.title, 'Marketplace Collection')}`}
              aria-current={currentSlide === idx ? 'true' : undefined}
            >
              <div className={`relative h-2 overflow-hidden rounded-full bg-blue-100 transition-all ${currentSlide === idx ? 'w-14' : 'w-2'}`}>
                <div className="absolute inset-y-0 left-0 rounded-full bg-brand-blue" style={{ width: currentSlide === idx ? `${progress}%` : '0%', transition: currentSlide === idx && progress > 0 ? 'width 50ms linear' : 'none' }} />
              </div>
            </button>
          ))}
        </div>
        )}
      </div>
    </div>
    </MotionConfig>
  );
}
