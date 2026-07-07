import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ShoppingBag, ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { WebsiteSettings } from '../types';

interface HeroBannerProps {
  onExploreProducts: () => void;
  settings?: WebsiteSettings | null;
}

const PREMIUM_DEFAULT_SLIDES = [
  {
    id: "premium-slide-1",
    badge: "SMART LIVING",
    title: "Upgrade Your Lifestyle with Smart Technology",
    subtitle: "Premium Electronics • Islandwide Delivery • Cash on Delivery",
    description: "Experience next-generation performance with Zyro's curated collection of premium electronics, high-end gadgets, and smart solutions with rapid delivery.",
    image: "https://images.unsplash.com/photo-1546868871-7041f2a55e12?q=80&w=1600",
    bgGradient: "from-black via-zinc-950/90 to-blue-950/20",
    cta: "Shop Now"
  },
  {
    id: "premium-slide-2",
    badge: "NEW ARRIVALS",
    title: "Explore the Latest Gadgets",
    subtitle: "Discover the newest smart devices and accessories.",
    description: "Stay ahead of the curve with cutting-edge wearables, immersive sound accessories, and high-performance smart gadgets designed for modern life.",
    image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=1600",
    bgGradient: "from-black via-neutral-950/90 to-blue-950/20",
    cta: "Explore Collection"
  },
  {
    id: "premium-slide-3",
    badge: "THE ZYRO PROMISE",
    title: "Why Choose Zyro.lk?",
    subtitle: "Trusted products, fast delivery and excellent customer support.",
    description: "We are Sri Lanka's premium electronics hub, offering 100% authentic tech imports, secure cash on delivery islandwide, and unmatched 24/7 client care.",
    image: "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?q=80&w=1600",
    bgGradient: "from-black via-zinc-950/90 to-blue-950/20",
    cta: "Learn More"
  }
];

export default function HeroBanner({ onExploreProducts, settings }: HeroBannerProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);

  // Parse slides
  const slides = settings?.heroBanners && settings.heroBanners.length > 0 
    ? settings.heroBanners.map((b, idx) => {
        // If it is the default seeded database entries, automatically map them to our premium redesigned ones!
        const isOldDefault = b.title === "Samsung Odyssey OLED G9" || b.title === "Zyro Smart Solar Inverter";
        if (isOldDefault && idx < PREMIUM_DEFAULT_SLIDES.length) {
          return PREMIUM_DEFAULT_SLIDES[idx];
        }
        return {
          id: b.id || `banner-${idx}`,
          badge: b.badge || "FEATURED PRODUCT",
          title: b.title,
          subtitle: b.subtitle,
          description: b.description || "Explore fully guaranteed premium electronics with rapid islandwide shipping.",
          image: b.image || PREMIUM_DEFAULT_SLIDES[0].image,
          bgGradient: b.bgGradient || "from-black via-zinc-950/95 to-blue-950/25",
          cta: b.buttonText || "Shop Now"
        };
      })
    : PREMIUM_DEFAULT_SLIDES;

  // Slide Duration
  const slideDuration = (settings?.autoSlideSpeed || 6) * 1000; // default 6 seconds
  const intervalTime = 50; // update every 50ms for buttery smooth bar filling
  const isSliderActive = settings?.enableSlider !== false;

  useEffect(() => {
    if (!isPlaying || !isSliderActive) return;

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

  return (
    <div 
      className="relative h-[550px] sm:h-[620px] md:h-[680px] lg:h-[720px] w-full overflow-hidden bg-black text-white group"
      onMouseEnter={() => setIsPlaying(false)}
      onMouseLeave={() => setIsPlaying(true)}
    >
      {/* Background slide with AnimatePresence */}
      <AnimatePresence mode="wait">
        <motion.div
          key={currentSlide}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8 }}
          className="absolute inset-0 w-full h-full"
        >
          {/* Background Image */}
          <div className="absolute inset-0 select-none pointer-events-none">
            <motion.img
              initial={{ scale: 1.08 }}
              animate={{ scale: 1.02 }}
              transition={{ duration: 6, ease: "easeOut" }}
              src={slides[currentSlide].image}
              alt={slides[currentSlide].title}
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover object-center transform filter brightness-[0.75] contrast-[1.05]"
            />
            {/* Cinematic Gradient Masking for absolute legibility */}
            {/* Desktop Side Vignette */}
            <div className="absolute inset-0 bg-gradient-to-r from-black via-black/85 to-transparent md:block hidden" />
            {/* Mobile Bottom Vignette */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/85 via-black/95 to-black md:hidden block" />
            {/* Ambient Royal Blue Backlight */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_25%_50%,rgba(0,82,254,0.18),transparent_65%)]" />
          </div>

          {/* Slide Content */}
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full h-full flex flex-col justify-center relative z-10">
            <div className="w-full md:w-3/5 lg:w-1/2 flex flex-col justify-center text-center md:text-left items-center md:items-start py-8 mt-4 md:mt-0">
              
              {/* Badge */}
              <motion.span
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15, duration: 0.5 }}
                className="inline-flex items-center px-3.5 py-1 rounded-full text-[10px] sm:text-xs font-mono font-bold tracking-widest bg-blue-500/10 text-blue-400 border border-blue-500/20 mb-4 uppercase"
              >
                {slides[currentSlide].badge}
              </motion.span>

              {/* Title */}
              <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25, duration: 0.6 }}
                className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-extrabold tracking-tight font-display text-white mb-4 leading-tight"
              >
                {slides[currentSlide].title}
              </motion.h1>

              {/* Subtitle */}
              <motion.p
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35, duration: 0.6 }}
                className="text-base sm:text-lg md:text-xl font-medium text-blue-100 mb-4 max-w-xl"
              >
                {slides[currentSlide].subtitle}
              </motion.p>

              {/* Description */}
              <motion.p
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.45, duration: 0.6 }}
                className="text-xs sm:text-sm md:text-base text-zinc-400 max-w-lg mb-8 leading-relaxed font-light"
              >
                {slides[currentSlide].description}
              </motion.p>

              {/* Actions */}
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.55, duration: 0.6 }}
                className="flex flex-col sm:flex-row items-center space-y-3 sm:space-y-0 sm:space-x-4 w-full sm:w-auto"
              >
                <button
                  onClick={onExploreProducts}
                  className="w-full sm:w-auto flex items-center justify-center px-7 py-3.5 text-sm font-bold rounded-full text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 transition-all shadow-lg shadow-blue-600/35 border border-blue-500/30 transform active:scale-[0.98] cursor-pointer"
                >
                  <ShoppingBag className="h-4.5 w-4.5 mr-2" />
                  {slides[currentSlide].cta}
                </button>
                <button
                  onClick={onExploreProducts}
                  className="w-full sm:w-auto flex items-center justify-center px-7 py-3.5 text-sm font-bold rounded-full text-white bg-zinc-900/40 hover:bg-zinc-900/80 active:bg-zinc-950 border border-zinc-700/50 hover:border-zinc-500 transition-all backdrop-blur-md transform active:scale-[0.98] cursor-pointer"
                >
                  Explore Catalog
                  <ArrowRight className="h-4.5 w-4.5 ml-2 text-zinc-400" />
                </button>
              </motion.div>

            </div>
          </div>
        </motion.div>
      </AnimatePresence>

      {/* Manual Slide Controls (Arrow buttons, styled premiumly) */}
      {isSliderActive && (
        <>
          <button
            onClick={handlePrev}
            className="absolute left-6 top-1/2 -translate-y-1/2 z-20 md:flex hidden items-center justify-center w-12 h-12 rounded-full bg-black/20 hover:bg-blue-600 border border-white/10 hover:border-blue-500 text-white hover:scale-105 transition-all duration-300 opacity-0 group-hover:opacity-100 cursor-pointer shadow-lg shadow-black/40"
            aria-label="Previous slide"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={handleNext}
            className="absolute right-6 top-1/2 -translate-y-1/2 z-20 md:flex hidden items-center justify-center w-12 h-12 rounded-full bg-black/20 hover:bg-blue-600 border border-white/10 hover:border-blue-500 text-white hover:scale-105 transition-all duration-300 opacity-0 group-hover:opacity-100 cursor-pointer shadow-lg shadow-black/40"
            aria-label="Next slide"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </>
      )}

      {/* Bottom Progress Pill Indicators */}
      {isSliderActive && slides.length > 1 && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 flex items-center space-x-3 bg-black/45 backdrop-blur-md px-5 py-3 rounded-full border border-white/10 shadow-xl shadow-black/50 select-none">
          {slides.map((slide, idx) => (
            <button
              key={slide.id}
              onClick={() => handleSlideSelect(idx)}
              className="group flex flex-col items-start focus:outline-none cursor-pointer"
              title={`Go to slide ${idx + 1}`}
            >
              <div className="flex items-center space-x-2">
                {/* Slide Number */}
                <span className={`text-[10px] font-mono font-semibold transition-colors duration-300 ${currentSlide === idx ? 'text-blue-400' : 'text-zinc-500 group-hover:text-zinc-300'}`}>
                  0{idx + 1}
                </span>
                {/* Progress bar channel */}
                <div className="w-12 sm:w-16 h-1 rounded-full bg-zinc-800 overflow-hidden relative">
                  {/* Dynamic loader */}
                  <div 
                    className="absolute top-0 left-0 h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400"
                    style={{ 
                      width: currentSlide === idx ? `${progress}%` : '0%',
                      transition: currentSlide === idx && progress > 0 ? 'width 50ms linear' : 'none'
                    }}
                  />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
