import { TouchEvent, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ShoppingBag, ArrowRight, Banknote, ChevronLeft, ChevronRight, Headphones, ShieldCheck, Sparkles, Truck } from 'lucide-react';
import { WebsiteSettings } from '../types';
import { normalizeSlideSpeed } from '../services/hero-slider/heroSlider';

interface HeroBannerProps {
  onExploreProducts: () => void;
  onBrowseCategories?: () => void;
  settings?: WebsiteSettings | null;
}

const campaignTone = (value?: string) => {
  if (value?.includes('orange')) return 'from-orange-50 via-white to-amber-100';
  if (value?.includes('emerald')) return 'from-emerald-50 via-white to-cyan-100';
  if (value?.includes('purple')) return 'from-violet-50 via-white to-blue-100';
  return 'from-white via-blue-50 to-blue-200';
};

export default function HeroBanner({ onExploreProducts, onBrowseCategories, settings }: HeroBannerProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const touchStartX = useRef<number | null>(null);

  const configuredSlides = settings?.heroBanners?.filter((banner) => banner.enabled !== false) || [];
  const slides = configuredSlides.map((banner, index) => ({
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

  // Slide Duration
  const slideDuration = normalizeSlideSpeed(settings?.autoSlideSpeed) * 1000;
  const intervalTime = 50; // update every 50ms for buttery smooth bar filling
  const isSliderActive = settings?.enableSlider !== false;

  useEffect(() => {
    if (!isPlaying || !isSliderActive || slides.length < 2) return;

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
  }, [isPlaying, slides.length, isSliderActive, slideDuration]);

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
    setIsPlaying(true);
    if (startX === null || endX === undefined || Math.abs(startX - endX) < 48 || slides.length < 2) return;
    if (startX > endX) handleNext();
    else handlePrev();
  };

  if (slides.length === 0) return null;

  return (
    <div
      className="zy-hero group relative mx-auto w-full max-w-7xl px-4 text-slate-900 sm:px-6 lg:px-8"
      onMouseEnter={() => setIsPlaying(false)}
      onMouseLeave={() => setIsPlaying(true)}
      role="region"
      aria-roledescription="carousel"
      aria-label="Featured products"
    >
      <div className="zy-hero-stage relative min-h-[340px] touch-pan-y overflow-hidden rounded-[2rem] sm:min-h-[420px] sm:rounded-[2.75rem] lg:min-h-[570px]" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        <div className={`absolute inset-0 bg-gradient-to-br ${campaignTone(slides[currentSlide].bgGradient)}`} />
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
            className="relative z-10 grid min-h-[340px] grid-cols-12 items-center gap-3 px-5 py-7 sm:min-h-[420px] sm:gap-6 sm:px-8 sm:py-10 lg:min-h-[570px] lg:px-12"
          role="group"
          aria-roledescription="slide"
          aria-label={`${currentSlide + 1} of ${slides.length}: ${slides[currentSlide].title}`}
        >
            <div className="col-span-7 flex min-w-0 flex-col items-start text-left lg:col-span-6 lg:pr-8">
              {slides[currentSlide].badge && (
              <motion.span
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15, duration: 0.5 }}
                className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white/85 px-3.5 py-2 text-[10px] font-black uppercase tracking-[0.16em] text-brand-blue shadow-sm backdrop-blur-md"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                {slides[currentSlide].badge}
              </motion.span>
              )}
              <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25, duration: 0.6 }}
                className="max-w-3xl text-[1.7rem] font-black leading-[0.98] tracking-[-0.04em] text-[#111827] font-display sm:text-4xl lg:text-6xl"
              >
                Everything You Need,
                <span className="block text-brand-blue">All In One Marketplace</span>
              </motion.h1>
              <motion.p
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.55 }}
                className="mt-3 max-w-xl text-xs font-black uppercase tracking-[0.12em] text-slate-700 sm:text-sm"
              >
                {slides[currentSlide].title}
              </motion.p>
              <motion.p
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35, duration: 0.6 }}
                className="mt-3 max-w-xl text-[11px] font-bold leading-relaxed text-brand-blue sm:mt-5 sm:text-sm lg:text-lg"
              >
                Shop electronics, home essentials, kitchen products, beauty items, accessories and thousands of everyday products from one trusted Sri Lankan marketplace.
              </motion.p>
              {slides[currentSlide].description && <motion.p
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.45, duration: 0.6 }}
                className="mt-2 hidden max-w-lg text-sm leading-relaxed text-slate-600 sm:block"
              >
                {slides[currentSlide].description}
              </motion.p>}
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.55, duration: 0.6 }}
                className="mt-6 flex w-full flex-col gap-3 sm:w-auto sm:flex-row"
              >
                {slides[currentSlide].cta && <button
                  onClick={handlePrimaryAction}
                  className="zy-button zy-button-primary min-h-13 w-full rounded-2xl px-7 text-sm sm:w-auto"
                >
                  <ShoppingBag className="h-4.5 w-4.5" />
                  {slides[currentSlide].cta}
                </button>}
                <button
                  onClick={onBrowseCategories || onExploreProducts}
                  className="zy-button min-h-13 w-full rounded-2xl border border-blue-200 bg-white px-7 text-sm font-black text-slate-800 shadow-lg shadow-blue-950/5 sm:w-auto"
                >
                  Browse Categories
                  <ArrowRight className="h-4.5 w-4.5 text-brand-blue" />
                </button>
              </motion.div>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.7, duration: 0.5 }}
                className="mt-4 hidden w-full grid-cols-2 gap-2 text-[9px] font-black text-slate-700 sm:grid lg:mt-6 lg:flex lg:w-auto lg:flex-wrap sm:text-[10px]"
                aria-label="Store benefits"
              >
                {[
                  { label: 'Cash on Delivery', icon: Banknote },
                  { label: 'Islandwide Delivery', icon: Truck },
                  { label: 'Secure Payments', icon: ShieldCheck },
                  { label: 'Customer Support', icon: Headphones },
                ].map(({ label, icon: Icon }) => (
                  <span key={label} className="inline-flex items-center gap-1.5 rounded-xl border border-white bg-white/75 px-2.5 py-2 shadow-sm backdrop-blur-md">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                  </span>
                ))}
              </motion.div>
            </div>

            <div className="relative col-span-5 min-h-[220px] self-stretch sm:min-h-[330px] lg:col-span-6 lg:min-h-[490px]" aria-label="Promotional product image">
              <div className="absolute inset-[8%] rounded-full bg-blue-500/18 blur-3xl" />
              <motion.div initial={{ opacity: 0, scale: 0.94, x: 20 }} animate={{ opacity: 1, scale: 1, x: 0 }} transition={{ duration: 0.55, delay: 0.15 }} className="absolute inset-2 flex items-center justify-center sm:inset-6 lg:inset-8">
                <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[1.75rem] border border-white/70 bg-white/55 p-2 shadow-2xl shadow-blue-950/15 backdrop-blur-md sm:rounded-[2.5rem] sm:p-5">
                  <ShoppingBag className="absolute h-16 w-16 text-blue-200" aria-hidden="true" />
                  <img
                    src={slides[currentSlide].image}
                    alt={slides[currentSlide].title}
                    className="relative z-10 h-full w-full object-contain drop-shadow-[0_24px_30px_rgba(15,23,42,0.18)]"
                    loading={currentSlide === 0 ? 'eager' : 'lazy'}
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={(event) => { event.currentTarget.style.display = 'none'; }}
                  />
                </div>
              </motion.div>
              {slides[currentSlide].badge && (
                <motion.div initial={{ opacity: 0, scale: 0.8, rotate: -8 }} animate={{ opacity: 1, scale: 1, rotate: 6 }} transition={{ delay: 0.55 }} className="absolute right-0 top-3 z-20 hidden max-w-28 rounded-2xl border-4 border-white bg-brand-orange px-4 py-3 text-center text-[10px] font-black uppercase leading-tight text-white shadow-2xl shadow-orange-900/20 sm:block lg:right-2 lg:top-10">
                  {slides[currentSlide].badge}
                </motion.div>
              )}
              <div className="absolute bottom-4 left-0 z-20 hidden rounded-2xl border border-white/70 bg-white/85 px-3 py-2 text-[10px] font-black text-slate-700 shadow-xl backdrop-blur-md sm:flex sm:items-center sm:gap-2 lg:bottom-10">
                <Truck className="h-4 w-4 shrink-0 text-brand-blue" aria-hidden="true" />
                <span className="max-w-52 line-clamp-2">{slides[currentSlide].subtitle || 'Islandwide Delivery'}</span>
              </div>
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
              aria-label={`Show slide ${idx + 1} of ${slides.length}: ${slide.title}`}
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
  );
}
