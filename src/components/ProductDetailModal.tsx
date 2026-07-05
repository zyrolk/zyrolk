import React, { useState, useEffect, useRef } from 'react';
import { 
  X, Star, Heart, ShoppingCart, Check, Phone, 
  ShieldCheck, Truck, RefreshCw, MessageSquare, ArrowRight, Plus, Minus, ShoppingBag,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2, Sparkles, Award, CheckCircle2, HelpCircle
} from 'lucide-react';
import { collection, query, where, getDocs, addDoc, doc, getDoc, updateDoc } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { db, auth } from '../firebase';
import { Product } from '../types';
import { motion, AnimatePresence } from 'motion/react';

interface ProductDetailModalProps {
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
  isWishlisted: boolean;
  onAddToCart: (product: Product, quantity?: number) => void;
  onToggleWishlist: (product: Product) => void;
  allProducts: Product[];
  onSelectProduct: (product: Product) => void;
  onBuyNow: (product: Product, quantity: number) => void;
  settings?: any;
}

export default function ProductDetailModal({
  product,
  isOpen,
  onClose,
  isWishlisted,
  onAddToCart,
  onToggleWishlist,
  allProducts = [],
  onSelectProduct,
  onBuyNow,
  settings
}: ProductDetailModalProps) {
  const isWishlistEnabled = settings?.enableWishlist !== false;
  const isReviewsEnabled = settings?.enableReviews !== false;

  // Swipeable image gallery states
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [touchStartX, setTouchStartX] = useState(0);
  const [touchEndX, setTouchEndX] = useState(0);

  // Layout states
  const [quantity, setQuantity] = useState(1);
  const [addedMessage, setAddedMessage] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [showStickyBar, setShowStickyBar] = useState(false);
  
  // Hover zoom states (Desktop)
  const [zoomPos, setZoomPos] = useState({ x: 0, y: 0 });
  const [isZooming, setIsZooming] = useState(false);

  // Full-screen zoom lightbox states (Tap/Click)
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [lightboxPan, setLightboxPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Reviews & settings states
  const [reviews, setReviews] = useState<any[]>([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [newRating, setNewRating] = useState(5);
  const [newComment, setNewComment] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [reviewSuccess, setReviewSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentUser, setCurrentUser] = useState<any>(null);

  // Refs
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const relatedScrollRef = useRef<HTMLDivElement>(null);

  // Listen to Auth State
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      if (user) {
        setNewCustomerName(user.displayName || user.email?.split('@')[0] || "");
      } else {
        setNewCustomerName("");
      }
    });
    return () => unsubscribe();
  }, []);

  // Fetch product reviews from Firestore
  const fetchReviews = async () => {
    if (!product) return;
    setLoadingReviews(true);
    try {
      const q = query(collection(db, "reviews"), where("productId", "==", product.id));
      const snap = await getDocs(q);
      const list: any[] = [];
      snap.forEach(d => {
        const data = d.data();
        if (data.approved !== false) {
          list.push({ id: d.id, ...data });
        }
      });
      list.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeB - timeA;
      });
      setReviews(list);
      
      // Auto-heal reviewsCount in DB if no reviews are found in Firestore
      if (list.length === 0 && product.reviewsCount !== 0) {
        try {
          await updateDoc(doc(db, "products", product.id), {
            reviewsCount: 0
          });
        } catch (dbErr) {
          console.warn("Could not auto-heal reviewsCount in Firestore:", dbErr);
        }
      }
    } catch (err) {
      console.error("Error loading reviews:", err);
    } finally {
      setLoadingReviews(false);
    }
  };

  // Reset page states when switching active products
  useEffect(() => {
    if (product) {
      setActiveImageIndex(0);
      setQuantity(1);
      setAddedMessage(false);
      setNewComment("");
      setNewRating(5);
      setShowStickyBar(false);
      
      // Short transition to trigger dynamic loading shimmer skeletons
      setIsTransitioning(true);
      const timer = setTimeout(() => setIsTransitioning(false), 450);
      
      fetchReviews();
      return () => clearTimeout(timer);
    }
  }, [product]);

  if (!isOpen || !product) return null;

  // LKR formatting
  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('en-LK', {
      style: 'currency',
      currency: 'LKR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  };

  const galleryImages = Array.from(new Set([product.imageUrl, ...(product.imageUrls || [])])).filter(Boolean);

  // Swipe gesture handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchStartX(e.targetTouches[0].clientX);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    setTouchEndX(e.targetTouches[0].clientX);
  };

  const handleTouchEnd = () => {
    if (galleryImages.length <= 1) return;
    const swipeDistance = touchStartX - touchEndX;
    if (swipeDistance > 60) {
      // Swipe left -> Next image
      setActiveImageIndex((prev) => (prev + 1) % galleryImages.length);
    } else if (swipeDistance < -60) {
      // Swipe right -> Prev image
      setActiveImageIndex((prev) => (prev - 1 + galleryImages.length) % galleryImages.length);
    }
  };

  const handleAddToCart = () => {
    onAddToCart(product, quantity);
    setAddedMessage(true);
    setTimeout(() => setAddedMessage(false), 2000);
  };

  const handleWhatsAppCheckout = () => {
    const totalPrice = formatPrice(product.price * quantity);
    const skuLine = product.sku ? `\n*SKU:* ${product.sku}` : "";
    const message = encodeURIComponent(
      `Hello Zyro.lk! I want to order the following genuine device:\n\n*Product:* ${product.name}${skuLine}\n*Quantity:* ${quantity}\n*Unit Price:* ${formatPrice(product.price)}\n*Total Price:* ${totalPrice}\n\nPlease proceed with my COD islandwide delivery confirmation details.`
    );
    const whatsappNum = settings?.whatsappNumber 
      ? settings.whatsappNumber.replace(/[^0-9+]/g, "") 
      : "";
    if (!whatsappNum) {
      alert("WhatsApp checkout is currently being configured by the store administrator. Please try again soon or contact support!");
      return;
    }
    window.open(`https://wa.me/${whatsappNum.replace("+", "")}?text=${message}`, '_blank');
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product) return;

    const trimmedComment = newComment.trim();
    const trimmedName = newCustomerName.trim() || currentUser?.displayName || currentUser?.email?.split('@')[0] || "Verified Buyer";

    if (!trimmedComment) {
      alert("Please write a comment for your review.");
      return;
    }

    if (!trimmedName) {
      alert("Please provide your name.");
      return;
    }

    setIsSubmitting(true);
    setReviewSuccess(false);
    try {
      const payload = {
        productId: product.id,
        customerName: trimmedName,
        userName: trimmedName, // backwards compatibility
        rating: newRating,
        comment: trimmedComment,
        createdAt: new Date().toISOString()
      };

      // 1. Save review to Firestore in collection "reviews"
      await addDoc(collection(db, "reviews"), payload);

      // 2. Fetch all reviews for this product to compute updated stats
      const q = query(collection(db, "reviews"), where("productId", "==", product.id));
      const snap = await getDocs(q);
      const list: any[] = [];
      snap.forEach(d => {
        const data = d.data();
        if (data.approved !== false) {
          list.push({ id: d.id, ...data });
        }
      });

      const totalReviewsCount = list.length;
      const avgRating = totalReviewsCount > 0 
        ? Number((list.reduce((acc, curr) => acc + curr.rating, 0) / totalReviewsCount).toFixed(1)) 
        : 5;

      // 3. Immediately update the product rating & reviewsCount in Firestore
      const productRef = doc(db, "products", product.id);
      await updateDoc(productRef, {
        rating: avgRating,
        reviewsCount: totalReviewsCount
      });

      // Clear the form
      setNewComment("");
      setNewRating(5);
      setReviewSuccess(true);

      // Fetch reviews again locally
      setReviews(list.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeB - timeA;
      }));

      // Hide success message after 4 seconds
      setTimeout(() => setReviewSuccess(false), 4000);
    } catch (err) {
      console.error("Error saving review:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Hover zoom handler (Desktop)
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const { left, top, width, height } = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - left) / width) * 100;
    const y = ((e.clientY - top) / height) * 100;
    setZoomPos({ x, y });
  };

  // Lightbox navigation
  const nextLightboxImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveImageIndex((prev) => (prev + 1) % galleryImages.length);
    setLightboxZoom(1);
    setLightboxPan({ x: 0, y: 0 });
  };

  const prevLightboxImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveImageIndex((prev) => (prev - 1 + galleryImages.length) % galleryImages.length);
    setLightboxZoom(1);
    setLightboxPan({ x: 0, y: 0 });
  };

  // Lightbox Pan / Drag logic
  const handleLightboxMouseDown = (e: React.MouseEvent) => {
    if (lightboxZoom > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - lightboxPan.x, y: e.clientY - lightboxPan.y });
    }
  };

  const handleLightboxMouseMove = (e: React.MouseEvent) => {
    if (isDragging && lightboxZoom > 1) {
      setLightboxPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  const handleLightboxMouseUp = () => {
    setIsDragging(false);
  };

  const handleLightboxClose = () => {
    setIsLightboxOpen(false);
    setLightboxZoom(1);
    setLightboxPan({ x: 0, y: 0 });
  };

  const handleZoomIn = () => {
    setLightboxZoom(prev => Math.min(prev + 0.5, 4));
  };

  const handleZoomOut = () => {
    setLightboxZoom(prev => {
      const next = Math.max(prev - 0.5, 1);
      if (next === 1) setLightboxPan({ x: 0, y: 0 });
      return next;
    });
  };

  const handleScrollModal = () => {
    if (scrollContainerRef.current) {
      const scrolled = scrollContainerRef.current.scrollTop;
      // Show mobile sticky bar if user scrolled past 480px and we are on mobile
      setShowStickyBar(scrolled > 480);
    }
  };

  // Related products scroll
  const scrollRelated = (direction: 'left' | 'right') => {
    if (relatedScrollRef.current) {
      const { scrollLeft, clientWidth } = relatedScrollRef.current;
      const scrollAmount = clientWidth * 0.8;
      relatedScrollRef.current.scrollTo({
        left: direction === 'left' ? scrollLeft - scrollAmount : scrollLeft + scrollAmount,
        behavior: 'smooth'
      });
    }
  };

  // Reviews visual statistics helper
  const totalReviews = reviews.length;
  const averageRating = totalReviews > 0 
    ? (reviews.reduce((acc, curr) => acc + curr.rating, 0) / totalReviews).toFixed(1)
    : product.rating.toFixed(1);

  // Dynamic review distribution
  const ratingDistribution = [0, 0, 0, 0, 0];
  reviews.forEach(r => {
    if (r.rating >= 1 && r.rating <= 5) {
      ratingDistribution[r.rating - 1]++;
    }
  });

  // Specifications list construction
  const brandName = product.specs?.Brand || product.specs?.brand || "Authorized Import";
  const activeImageUrl = galleryImages[activeImageIndex] || product.imageUrl;

  // Filter out current product for related items
  let relatedItems = allProducts
    .filter(p => p.category?.toLowerCase().trim() === product.category?.toLowerCase().trim() && p.id !== product.id && p.isActive !== false)
    .slice(0, 8);

  if (relatedItems.length === 0) {
    relatedItems = allProducts
      .filter(p => p.id !== product.id && p.isActive !== false)
      .slice(0, 8);
  }

  // Delivery Threshold values
  const freeDeliveryThreshold = settings?.freeDeliveryMin || 5000;
  const isEligibleForFreeDelivery = product.price >= freeDeliveryThreshold;

  // Smooth scroll to reviews panel
  const scrollToReviews = () => {
    const reviewsElement = document.getElementById('customer-reviews-section');
    if (reviewsElement && scrollContainerRef.current) {
      reviewsElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/70 backdrop-blur-xl flex items-center justify-center p-0 sm:p-4 md:p-6 animate-fadeIn">
      
      {/* Immersive Apple/Samsung-style Premium Modal Layout */}
      <div className="relative w-full max-w-6xl bg-white sm:rounded-[2.5rem] overflow-hidden shadow-[0_25px_60px_-15px_rgba(0,0,0,0.25)] border border-slate-100 flex flex-col min-h-screen sm:min-h-0 sm:h-[94vh]">
        
        {/* Top Header Sticky Rail */}
        <div className="absolute top-0 left-0 right-0 z-40 p-4 sm:p-6 flex justify-between items-center bg-gradient-to-b from-white/95 via-white/80 to-transparent pointer-events-none">
          <div className="pointer-events-auto bg-white/90 backdrop-blur-md border border-slate-100 px-4 py-2 rounded-full shadow-xs flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-brand-blue animate-pulse" />
            <span className="text-[10px] font-black text-slate-800 uppercase tracking-widest">
              Live Showcase
            </span>
          </div>
          
          <button
            onClick={onClose}
            className="pointer-events-auto p-3 text-slate-500 hover:text-slate-900 bg-white/95 hover:bg-slate-100 border border-slate-100 rounded-full transition-all cursor-pointer shadow-md active:scale-90"
            id="product-modal-close-btn"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Container with Observer */}
        <div 
          id="modal-scrollable-container" 
          ref={scrollContainerRef}
          onScroll={handleScrollModal}
          className="flex-1 overflow-y-auto pt-24 p-5 sm:p-8 md:p-12 space-y-16 scroll-smooth"
        >
          {isTransitioning ? (
            /* Premium Micro Loading Skeleton Screen */
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 animate-pulse pt-4">
              <div className="lg:col-span-6 space-y-6">
                <div className="aspect-square w-full rounded-3xl bg-slate-100" />
                <div className="flex space-x-3">
                  <div className="w-20 h-20 bg-slate-100 rounded-2xl" />
                  <div className="w-20 h-20 bg-slate-100 rounded-2xl" />
                  <div className="w-20 h-20 bg-slate-100 rounded-2xl" />
                </div>
              </div>
              <div className="lg:col-span-6 space-y-6 text-left">
                <div className="h-4 bg-slate-100 rounded-md w-1/4" />
                <div className="h-10 bg-slate-100 rounded-xl w-3/4" />
                <div className="h-6 bg-slate-100 rounded-md w-1/3" />
                <div className="h-28 bg-slate-100 rounded-3xl w-full" />
                <div className="h-14 bg-slate-100 rounded-2xl w-full" />
                <div className="h-14 bg-slate-100 rounded-2xl w-full" />
              </div>
            </div>
          ) : (
            <>
              {/* UPPER MAIN LAYOUT SECTION */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 items-start">
                
                {/* LEFT SIDE: MULTI-IMAGE CAROUSEL, THUMBNAILS, SPECIFICATIONS & TRUST RAILS */}
                <div className="lg:col-span-6 space-y-8">
                  
                  {/* Premium Slider Container */}
                  <div className="space-y-4">
                    <div 
                      className="relative aspect-square w-full rounded-3xl bg-slate-50 border border-slate-100 overflow-hidden select-none group/zoom shadow-sm cursor-zoom-in"
                      onTouchStart={handleTouchStart}
                      onTouchMove={handleTouchMove}
                      onTouchEnd={handleTouchEnd}
                      onClick={() => setIsLightboxOpen(true)}
                    >
                      {/* Swipe instructions helper */}
                      {galleryImages.length > 1 && (
                        <div className="absolute top-4 right-4 z-10 bg-slate-900/60 backdrop-blur-md text-white text-[9px] font-extrabold uppercase tracking-widest px-3 py-1.5 rounded-full pointer-events-none">
                          Swipe to view {activeImageIndex + 1}/{galleryImages.length}
                        </div>
                      )}

                      {/* Frame Zoom on Hover (Desktop) */}
                      <div 
                        className="w-full h-full flex items-center justify-center p-6 sm:p-10"
                        onMouseEnter={() => setIsZooming(true)}
                        onMouseLeave={() => setIsZooming(false)}
                        onMouseMove={handleMouseMove}
                      >
                        <motion.img
                          key={activeImageIndex}
                          initial={{ opacity: 0.6, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.3 }}
                          src={activeImageUrl}
                          alt={product.name}
                          referrerPolicy="no-referrer"
                          className="max-h-full max-w-full object-contain transition-transform duration-75 ease-out"
                          style={
                            isZooming 
                              ? {
                                  transform: 'scale(2.4)',
                                  transformOrigin: `${zoomPos.x}% ${zoomPos.y}%`
                                }
                              : undefined
                          }
                        />
                      </div>

                      {/* Direct Save Discount Float */}
                      {product.discount && product.discount > 0 && (
                        <div className="absolute bottom-4 left-4 z-10 bg-brand-blue text-white text-[10px] font-black uppercase tracking-widest px-3.5 py-2 rounded-xl shadow-lg shadow-brand-blue/20">
                          -{product.discount}% INTRODUCTORY OFFER
                        </div>
                      )}

                      {/* Left and Right Nav Chevrons */}
                      {galleryImages.length > 1 && (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveImageIndex((prev) => (prev - 1 + galleryImages.length) % galleryImages.length);
                            }}
                            className="absolute left-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/95 text-slate-800 hover:bg-white border border-slate-100 shadow-md transition-all opacity-0 group-hover/zoom:opacity-100 cursor-pointer hover:scale-110 active:scale-95"
                          >
                            <ChevronLeft className="h-5 w-5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveImageIndex((prev) => (prev + 1) % galleryImages.length);
                            }}
                            className="absolute right-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/95 text-slate-800 hover:bg-white border border-slate-100 shadow-md transition-all opacity-0 group-hover/zoom:opacity-100 cursor-pointer hover:scale-110 active:scale-95"
                          >
                            <ChevronRight className="h-5 w-5" />
                          </button>
                        </>
                      )}

                      {/* Magnifier Tip overlay */}
                      <div className="absolute bottom-4 right-4 bg-slate-950/70 backdrop-blur-md text-white text-[10px] font-bold px-3 py-1.5 rounded-full opacity-100 sm:opacity-0 group-hover/zoom:opacity-100 transition-opacity flex items-center gap-1.5 shadow-md">
                        <Maximize2 className="h-3 w-3" />
                        <span>Tap to zoom</span>
                      </div>
                    </div>

                    {/* Thumbnails visual row indicator */}
                    {galleryImages.length > 1 && (
                      <div className="flex items-center space-x-2.5 overflow-x-auto py-1 scrollbar-none justify-start">
                        {galleryImages.map((url, idx) => (
                          <button
                            key={idx}
                            onClick={() => setActiveImageIndex(idx)}
                            className={`w-20 h-20 rounded-2xl border bg-slate-50 p-1.5 flex-shrink-0 cursor-pointer transition-all ${
                              activeImageIndex === idx 
                                ? 'border-brand-blue ring-4 ring-brand-blue/5 scale-102 bg-white shadow-xs' 
                                : 'border-slate-100 hover:border-slate-300'
                            }`}
                          >
                            <img src={url} alt="" className="w-full h-full object-contain rounded-xl" referrerPolicy="no-referrer" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Trust badge strip row */}
                  <div className="grid grid-cols-3 gap-3.5 bg-slate-50/50 p-5 rounded-2xl border border-slate-100 text-left">
                    <div className="space-y-1">
                      <div className="p-2 bg-blue-50/80 text-brand-blue rounded-xl w-fit">
                        <ShieldCheck className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold text-slate-800 block">Genuine Stock</span>
                      <span className="text-[10px] text-slate-400 font-light block leading-tight">100% official brand authorization</span>
                    </div>
                    <div className="space-y-1">
                      <div className="p-2 bg-blue-50/80 text-brand-blue rounded-xl w-fit">
                        <Truck className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold text-slate-800 block">Fast Dispatch</span>
                      <span className="text-[10px] text-slate-400 font-light block leading-tight">Islandwide tracked courier to doorstep</span>
                    </div>
                    <div className="space-y-1">
                      <div className="p-2 bg-blue-50/80 text-brand-blue rounded-xl w-fit">
                        <RefreshCw className="h-5 w-5" />
                      </div>
                      <span className="text-xs font-bold text-slate-800 block">COD Supported</span>
                      <span className="text-[10px] text-slate-400 font-light block leading-tight">Verify items before cash handover</span>
                    </div>
                  </div>

                  {/* Technical specifications - Premium Bento-Style card */}
                  {product.specs && Object.keys(product.specs).length > 0 && (
                    <div className="text-left space-y-4">
                      <div className="flex items-center space-x-2">
                        <Award className="h-4.5 w-4.5 text-brand-blue" />
                        <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest">
                          Certified Device Specifications
                        </h4>
                      </div>
                      <div className="bg-white border border-slate-100 rounded-3xl overflow-hidden shadow-xs divide-y divide-slate-100">
                        {Object.entries(product.specs).map(([key, val]) => (
                          <div key={key} className="grid grid-cols-3 p-4 text-xs transition-all hover:bg-slate-50/50 items-center">
                            <span className="font-bold text-slate-500 capitalize">{key}</span>
                            <span className="col-span-2 text-slate-800 text-left pl-4 font-normal">{val}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                </div>

                {/* RIGHT SIDE: CORE CONVERSIONS ENGINE (TITLES, PRICES, BADGES, AND ACTION CTAs) */}
                <div className="lg:col-span-6 space-y-8 text-left lg:sticky lg:top-2">
                  
                  {/* Category Pill + Stock Status Row */}
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[10px] font-extrabold uppercase tracking-widest text-brand-blue bg-blue-50 border border-blue-100/50 px-3.5 py-1.5 rounded-full flex items-center gap-1.5">
                      <Sparkles className="h-3 w-3" />
                      {product.category.replace('-', ' ')}
                    </span>
                    
                    {product.stock > 0 ? (
                      <span className={`text-[10px] font-extrabold uppercase tracking-widest px-3.5 py-1.5 rounded-full flex items-center gap-2 border ${
                        product.stock <= 5 
                          ? 'text-amber-700 bg-amber-50 border-amber-100' 
                          : 'text-emerald-700 bg-emerald-50 border-emerald-100'
                      }`}>
                        <span className={`w-2 h-2 rounded-full animate-ping ${product.stock <= 5 ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                        {product.stock <= 5 ? `Limited Stock: Only ${product.stock} left` : 'In Stock & Ready'}
                      </span>
                    ) : (
                      <span className="text-[10px] font-extrabold uppercase tracking-widest text-red-700 bg-red-50 border border-red-100 px-3.5 py-1.5 rounded-full flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-500" />
                        Out of Stock
                      </span>
                    )}
                  </div>

                  {/* Title & Brand Badging block */}
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-widest text-slate-400 bg-slate-100 px-2.5 py-1 rounded-md">
                        Brand: {brandName}
                      </span>
                      <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-widest text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-md gap-1">
                        <CheckCircle2 className="h-3 w-3" />
                        Genuine Product
                      </span>
                    </div>

                    <h1 className="text-3xl sm:text-4.5xl font-black text-slate-900 tracking-tight leading-none font-display">
                      {product.name}
                    </h1>

                    {/* Star Rating summary click list */}
                    {totalReviews > 0 && (
                      <button 
                        onClick={scrollToReviews}
                        className="flex items-center space-x-3 mt-1.5 group cursor-pointer text-left focus:outline-hidden"
                      >
                        <div className="flex text-amber-400">
                          {[...Array(5)].map((_, i) => (
                            <Star 
                              key={i} 
                              className={`h-4 w-4 ${i < Math.round(product.rating) ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} 
                            />
                          ))}
                        </div>
                        <span className="text-sm font-black text-slate-800">{averageRating}</span>
                        <span className="text-slate-300">|</span>
                        <span className="text-xs font-bold text-slate-500 underline group-hover:text-brand-blue transition-colors">
                          {totalReviews > 0 ? `${totalReviews} Customer Review${totalReviews > 1 ? 's' : ''}` : `${product.reviewsCount} verified reviews`}
                        </span>
                      </button>
                    )}
                  </div>

                  {/* Price Conversions Box (Strikethrough, absolute savings, free delivery) */}
                  <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100/80 text-left space-y-4">
                    <div className="space-y-1">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
                        Direct Import Promotion
                      </span>
                      <div className="flex items-baseline gap-3.5">
                        <span className="text-4xl font-black text-slate-950 tracking-tight font-display">
                          {formatPrice(product.price)}
                        </span>
                        {product.originalPrice && product.originalPrice > product.price && (
                          <span className="text-lg text-slate-400 line-through font-light">
                            {formatPrice(product.originalPrice)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Absolute and percentage savings calculation */}
                    {product.originalPrice && product.originalPrice > product.price && (
                      <div className="text-xs font-bold text-white bg-brand-blue/90 w-fit px-3 py-1.5 rounded-xl flex items-center gap-1 shadow-md shadow-brand-blue/10 animate-pulse">
                        <span>Save {formatPrice(product.originalPrice - product.price)} ({product.discount}% OFF)</span>
                      </div>
                    )}

                    {/* Real-time Free Delivery Eligibility Indicator */}
                    <div className="border-t border-slate-200/50 pt-4 flex items-center space-x-3 text-slate-700">
                      <div className="p-2 bg-emerald-500/10 text-emerald-600 rounded-xl">
                        <Truck className="h-5 w-5" />
                      </div>
                      <div>
                        {isEligibleForFreeDelivery ? (
                          <>
                            <span className="text-xs font-black text-emerald-600 block">Eligible for FREE Shipping</span>
                            <span className="text-[10px] text-slate-400 block font-light">Direct prompt dispatch from center</span>
                          </>
                        ) : (
                          <>
                            <span className="text-xs font-bold text-slate-800 block">Standard Courier Delivery</span>
                            <span className="text-[10px] text-slate-400 block font-light">Add {formatPrice(freeDeliveryThreshold - product.price)} more for islandwide Free Delivery</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Core Description */}
                  <div className="space-y-2.5">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                      Product Overview
                    </h4>
                    <p className="text-sm text-slate-600 leading-relaxed font-light whitespace-pre-line border-l-3 border-brand-blue/35 pl-4">
                      {product.description}
                    </p>
                  </div>

                  {/* Quantity selector input element */}
                  <div className="flex items-center justify-between bg-slate-50 p-4.5 rounded-2xl border border-slate-100">
                    <div>
                      <span className="text-xs font-black text-slate-800 block">Quantity Selection</span>
                      <span className="text-[10px] text-slate-400 font-light block mt-0.5">Adjust units for dispatch</span>
                    </div>
                    <div className="flex items-center space-x-2 bg-white border border-slate-200/80 p-2 rounded-xl shadow-3xs">
                      <button
                        onClick={() => setQuantity(Math.max(1, quantity - 1))}
                        className="w-9 h-9 rounded-lg text-slate-800 hover:bg-slate-100 flex items-center justify-center font-black cursor-pointer transition-all active:scale-90"
                        disabled={product.stock <= 0}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <span className="w-8 text-center text-sm font-black text-slate-900">{quantity}</span>
                      <button
                        onClick={() => setQuantity(Math.min(product.stock, quantity + 1))}
                        className="w-9 h-9 rounded-lg text-slate-800 hover:bg-slate-100 flex items-center justify-center font-black cursor-pointer transition-all active:scale-90"
                        disabled={product.stock <= 0 || quantity >= product.stock}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Action CTAs Cluster */}
                  <div className="space-y-4 pt-2">
                    
                    {/* Add to Cart (large royal blue) & Buy Now (black) buttons side-by-side */}
                    <div className="grid grid-cols-2 gap-3.5">
                      
                      {/* Royal Blue Add to Cart Button */}
                      <motion.button
                        whileTap={{ scale: 0.96 }}
                        onClick={handleAddToCart}
                        disabled={product.stock <= 0}
                        className={`flex items-center justify-center py-4 px-6 rounded-2xl text-xs sm:text-sm font-black cursor-pointer transition-all border shadow-lg ${
                          product.stock > 0
                            ? 'bg-brand-blue border-transparent text-white hover:bg-blue-700 shadow-brand-blue/15 hover:shadow-brand-blue/25'
                            : 'bg-slate-100 text-slate-400 border-slate-100 cursor-not-allowed shadow-none'
                        }`}
                      >
                        {addedMessage ? (
                          <>
                            <Check className="h-4.5 w-4.5 mr-2 text-emerald-300" />
                            Added to Cart
                          </>
                        ) : (
                          <>
                            <ShoppingCart className="h-4.5 w-4.5 mr-2" />
                            Add to Cart
                          </>
                        )}
                      </motion.button>

                      {/* Black Buy Now Button */}
                      <motion.button
                        whileTap={{ scale: 0.96 }}
                        onClick={() => onBuyNow(product, quantity)}
                        disabled={product.stock <= 0}
                        className={`flex items-center justify-center py-4 px-6 rounded-2xl text-xs sm:text-sm font-black cursor-pointer transition-all border shadow-md ${
                          product.stock > 0
                            ? 'bg-slate-950 border-transparent text-white hover:bg-slate-850 shadow-slate-950/10'
                            : 'bg-slate-100 text-slate-400 border-slate-100 cursor-not-allowed shadow-none'
                        }`}
                      >
                        <ShoppingBag className="h-4.5 w-4.5 mr-2" />
                        Buy Now
                      </motion.button>

                    </div>

                    {/* WhatsApp Quick Checkout Order Action */}
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      onClick={handleWhatsAppCheckout}
                      disabled={product.stock <= 0}
                      className="w-full flex items-center justify-center py-4 px-6 bg-emerald-500 hover:bg-emerald-600 text-white rounded-2xl text-sm font-black cursor-pointer transition-all shadow-md shadow-emerald-500/15 gap-2.5"
                    >
                      <Phone className="h-4 w-4 fill-white text-white" />
                      Order Instantly on WhatsApp
                    </motion.button>

                    {/* Trust assurances check labels row */}
                    <div className="flex justify-center items-center gap-6 text-[10px] text-slate-400 font-bold uppercase tracking-wider py-1.5 bg-slate-50/50 rounded-xl">
                      <span className="flex items-center gap-1.5">
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                        Cash on Delivery Eligible
                      </span>
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-200" />
                      <span className="flex items-center gap-1.5">
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                        7-Day Exchange Policy
                      </span>
                    </div>

                    {/* Wishlist Heart action button */}
                    {isWishlistEnabled && (
                      <button
                        onClick={() => onToggleWishlist(product)}
                        className="flex items-center justify-center text-xs font-bold text-slate-500 hover:text-red-500 mx-auto transition-colors cursor-pointer py-1.5 gap-2"
                      >
                        <Heart className={`h-4.5 w-4.5 transition-colors ${isWishlisted ? 'fill-red-500 text-red-500 animate-pulse' : 'text-slate-400'}`} />
                        <span>{isWishlisted ? 'Saved in Wishlist' : 'Add to Wishlist'}</span>
                      </button>
                    )}
                  </div>

                </div>

              </div>

              {/* SECTION: PREMIUM CUSTOMER REVIEWS & FEEDBACK ENGINE */}
              {isReviewsEnabled && (
                <div id="customer-reviews-section" className="border-t border-slate-100 pt-14 text-left space-y-8">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h3 className="text-xl font-black text-slate-900 font-display flex items-center gap-2.5">
                      <MessageSquare className="h-5 w-5 text-brand-blue" />
                      Verified Customer Feedback ({reviews.length})
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">Real experience reports and ratings posted by authorized buyers.</p>
                  </div>
                </div>

                {/* Review Overview Rating Bento Panel */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
                  
                  {/* Rating stats visual breakdown */}
                  <div className="md:col-span-4 bg-slate-50/70 border border-slate-100 p-6 rounded-3xl space-y-5 text-left">
                    <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">
                      Feedback Summary
                    </span>
                    <div className="flex items-center gap-4">
                      <span className="text-5xl font-black text-slate-900 font-display">
                        {averageRating}
                      </span>
                      <div>
                        <div className="flex text-amber-400">
                          {[...Array(5)].map((_, i) => (
                            <Star 
                              key={i} 
                              className={`h-4 w-4 ${i < Math.round(Number(averageRating)) ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} 
                            />
                          ))}
                        </div>
                        <span className="text-[10px] text-slate-400 font-bold block mt-1 uppercase tracking-wider">
                          {totalReviews} Certified reviews
                        </span>
                      </div>
                    </div>

                    {/* Progress rating ratio distribution lines */}
                    <div className="space-y-2 pt-2">
                      {[5, 4, 3, 2, 1].map((stars) => {
                        const count = ratingDistribution[stars - 1] || 0;
                        const percentage = totalReviews > 0 ? (count / totalReviews) * 100 : 0;
                        return (
                          <div key={stars} className="flex items-center text-xs text-slate-500 gap-3">
                            <span className="w-3 text-right font-bold text-slate-700">{stars}</span>
                            <Star className="h-3 w-3 fill-amber-400 text-amber-400 flex-shrink-0" />
                            <div className="flex-1 h-2 bg-slate-200/60 rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-brand-blue/90 rounded-full" 
                                style={{ width: `${percentage}%` }} 
                              />
                            </div>
                            <span className="w-8 text-right text-[10px] font-bold text-slate-400">
                              {percentage.toFixed(0)}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Submission review Form input panel */}
                  <div className="md:col-span-8 bg-slate-50/50 border border-slate-100 p-6 rounded-3xl space-y-5">
                    {currentUser ? (
                      <form onSubmit={handleSubmitReview} className="space-y-4">
                        <span className="block text-xs font-black text-slate-800 uppercase tracking-widest">
                          Leave Your Store Review
                        </span>
                        
                        {reviewSuccess && (
                          <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-2xl flex items-center gap-3 text-emerald-800 text-xs font-medium animate-fadeIn">
                            <CheckCircle2 className="h-5 w-5 text-emerald-500 flex-shrink-0" />
                            <div>
                              <p className="font-bold">Review Published Successfully!</p>
                              <p className="text-[11px] text-emerald-600/90 font-normal">Your ratings have been synchronized and updated on the product detail showcase.</p>
                            </div>
                          </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-wider">Your Name</label>
                            <input
                              type="text"
                              required
                              placeholder="e.g. John Doe"
                              value={newCustomerName}
                              onChange={(e) => setNewCustomerName(e.target.value)}
                              className="w-full text-xs px-4 py-3 bg-white border border-slate-200 rounded-2xl focus:outline-hidden focus:ring-2 focus:ring-brand-blue/10 focus:border-brand-blue/60 transition-all text-slate-700"
                            />
                          </div>

                          <div className="space-y-1.5">
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-wider">Select Star Rating</label>
                            <div className="flex space-x-1 py-1">
                              {[1, 2, 3, 4, 5].map((val) => (
                                <button
                                  key={val}
                                  type="button"
                                  onClick={() => setNewRating(val)}
                                  className="p-1 hover:scale-115 transition-transform cursor-pointer"
                                >
                                  <Star className={`h-6 w-6 ${val <= newRating ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} />
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <label className="block text-[10px] font-black text-slate-400 uppercase tracking-wider">Write Review Comments</label>
                          <textarea
                            required
                            rows={3}
                            placeholder="Share details regarding product authenticity, performance, packaging, warranty, or delivery dispatch time..."
                            value={newComment}
                            onChange={(e) => setNewComment(e.target.value)}
                            className="w-full text-xs px-4 py-3 bg-white border border-slate-200 rounded-2xl focus:outline-hidden focus:ring-2 focus:ring-brand-blue/10 focus:border-brand-blue/60 transition-all text-slate-700"
                          />
                        </div>

                        <button
                          type="submit"
                          disabled={isSubmitting}
                          className="w-full sm:w-fit px-8 py-3 bg-slate-950 hover:bg-slate-850 text-white font-black rounded-xl text-[10px] uppercase tracking-widest transition-all cursor-pointer disabled:opacity-50 shadow-md shadow-slate-950/10"
                        >
                          {isSubmitting ? 'Submitting Details...' : 'Submit Verified Review'}
                        </button>
                      </form>
                    ) : (
                      <div className="text-center py-8 px-4 border border-dashed border-slate-200 rounded-3xl bg-white/70 space-y-3">
                        <div className="p-3 bg-slate-100 text-slate-400 rounded-2xl w-fit mx-auto">
                          <HelpCircle className="h-6 w-6" />
                        </div>
                        <p className="text-xs text-slate-500 font-bold">Authorized Account Required</p>
                        <p className="text-[11px] text-slate-400 font-light max-w-sm mx-auto">
                          Please log in or register with your email in the store navbar to write and publish verified reviews for products.
                        </p>
                      </div>
                    )}
                  </div>

                </div>

                {/* Submited Reviews list cards container */}
                <div className="space-y-4 pt-4">
                  {loadingReviews ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {[...Array(2)].map((_, idx) => (
                        <div key={idx} className="bg-white border border-slate-100/60 p-5 rounded-2xl flex items-start gap-4 animate-pulse">
                          <div className="w-10 h-10 rounded-full bg-slate-100 flex-shrink-0" />
                          <div className="flex-1 space-y-3">
                            <div className="flex justify-between items-center">
                              <div className="space-y-1.5 flex-1">
                                <div className="h-3 bg-slate-100 rounded-md w-1/3" />
                                <div className="h-2 bg-slate-100 rounded-md w-1/4" />
                              </div>
                              <div className="h-2 bg-slate-100 rounded-md w-1/5" />
                            </div>
                            <div className="flex space-x-1">
                              {[...Array(5)].map((_, s) => (
                                <div key={s} className="h-3 w-3 bg-slate-100 rounded-full" />
                              ))}
                            </div>
                            <div className="space-y-1.5">
                              <div className="h-3 bg-slate-100 rounded-md w-full" />
                              <div className="h-3 bg-slate-100 rounded-md w-5/6" />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : reviews.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {reviews.map((rev, idx) => {
                        const nameToUse = rev.customerName || rev.userName || 'Verified Buyer';
                        const initials = nameToUse.substring(0, 2).toUpperCase() || 'VB';
                        return (
                          <div key={rev.id || idx} className="bg-white border border-slate-100/80 p-5 rounded-2xl flex items-start gap-4 shadow-3xs transition-all hover:border-slate-200 hover:shadow-2xs">
                            <div className="w-10 h-10 rounded-full bg-blue-50 text-brand-blue font-black text-xs flex items-center justify-center flex-shrink-0 border border-blue-100/50">
                              {initials}
                            </div>
                            <div className="flex-1 space-y-2 text-left">
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="text-xs font-black text-slate-800 block">{nameToUse}</span>
                                  <span className="text-[9px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-sm font-bold uppercase tracking-wider inline-block mt-0.5">Verified Purchaser</span>
                                </div>
                                <span className="text-[10px] text-slate-400 font-light">
                                  {rev.createdAt && !isNaN(new Date(rev.createdAt).getTime()) 
                                    ? new Date(rev.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) 
                                    : 'Just now'}
                                </span>
                              </div>
                              <div className="flex text-amber-400">
                                {[...Array(5)].map((_, s) => (
                                  <Star key={s} className={`h-3 w-3 ${s < rev.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} />
                                ))}
                              </div>
                              <p className="text-xs text-slate-500 font-light leading-relaxed whitespace-pre-line">{rev.comment}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-center py-12 text-xs text-slate-400 font-light bg-slate-50/50 rounded-3xl border border-dashed border-slate-200 flex flex-col items-center justify-center gap-1">
                      <span className="font-bold text-slate-700">No active reviews published</span>
                      <span>Certified buyers haven't posted comments on this device yet. Be the first!</span>
                    </div>
                  )}
                </div>
              </div>
              )}

              {/* SECTION: CAROUSEL SLIDER OF RELATED PRODUCTS */}
              <div className="border-t border-slate-100 pt-14 text-left space-y-6">
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="text-xl font-black text-slate-900 font-display">
                      Related Products & Direct Imports
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">Explore alternative high-grade electronics matching this category.</p>
                  </div>
                  
                  {/* Slider controls arrow buttons */}
                  {relatedItems.length > 4 && (
                    <div className="flex space-x-2">
                      <button
                        onClick={() => scrollRelated('left')}
                        className="p-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full cursor-pointer transition-all active:scale-90 border border-slate-200/50"
                      >
                        <ChevronLeft className="h-4.5 w-4.5" />
                      </button>
                      <button
                        onClick={() => scrollRelated('right')}
                        className="p-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full cursor-pointer transition-all active:scale-90 border border-slate-200/50"
                      >
                        <ChevronRight className="h-4.5 w-4.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Horizontal slider container */}
                <div 
                  ref={relatedScrollRef}
                  className="flex overflow-x-auto gap-4 py-3 scrollbar-none snap-x snap-mandatory"
                >
                  {relatedItems.map((item) => (
                    <motion.div 
                      key={item.id}
                      whileHover={{ y: -5 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => {
                        onSelectProduct(item);
                        // Reset modal scroll container back to top
                        if (scrollContainerRef.current) {
                          scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                        }
                      }}
                      className="w-[185px] sm:w-[230px] flex-shrink-0 snap-start group cursor-pointer bg-white border border-slate-100 rounded-2xl p-4 flex flex-col h-full hover:shadow-lg hover:border-slate-200 transition-all duration-300 text-left"
                    >
                      <div className="aspect-square w-full rounded-xl overflow-hidden bg-slate-50 relative mb-4 p-3 flex items-center justify-center select-none">
                        <img 
                          src={item.imageUrl} 
                          alt={item.name} 
                          className="max-h-full max-w-full object-contain group-hover:scale-106 transition-transform duration-500 ease-out"
                          referrerPolicy="no-referrer"
                        />
                        {item.discount && item.discount > 0 && (
                          <div className="absolute top-2.5 left-2.5 bg-brand-blue text-white font-black text-[9px] px-2.5 py-1 rounded-lg uppercase tracking-wider shadow-sm">
                            -{item.discount}%
                          </div>
                        )}
                      </div>
                      
                      <div className="flex-grow flex flex-col justify-between space-y-2">
                        <div>
                          <span className="text-[9px] text-slate-400 font-black uppercase tracking-widest block mb-0.5">
                            {item.category}
                          </span>
                          <h5 className="text-xs sm:text-sm font-bold text-slate-800 line-clamp-2 font-display group-hover:text-brand-blue transition-colors leading-tight">
                            {item.name}
                          </h5>
                        </div>
                        <div className="flex items-center justify-between pt-1">
                          <span className="text-sm font-black text-slate-900">
                            {formatPrice(item.price)}
                          </span>
                          <span className="text-[10px] font-bold text-brand-blue opacity-0 group-hover:opacity-100 translate-x-1.5 group-hover:translate-x-0 transition-all flex items-center gap-0.5">
                            Details <ArrowRight className="h-3 w-3" />
                          </span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            </>
          )}

        </div>

      </div>

      {/* DETAILED ACCESSIBLE LIGHTBOX ZOOM OVERLAY (Tap/Click to zoom image) */}
      <AnimatePresence>
        {isLightboxOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleLightboxClose}
            className="fixed inset-0 z-50 bg-black/95 backdrop-blur-2xl flex flex-col justify-between p-4 cursor-zoom-out select-none"
          >
            {/* Top Close Control rail */}
            <div className="flex justify-between items-center w-full max-w-6xl mx-auto py-2">
              <div className="text-white/60 text-xs font-bold uppercase tracking-wider flex items-center gap-2">
                <Maximize2 className="h-4 w-4" />
                <span>Device Inspector Mode</span>
              </div>
              <button
                onClick={handleLightboxClose}
                className="p-3 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors cursor-pointer border border-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Main Interactive Zoom Box Area */}
            <div 
              className="relative flex-1 w-full max-w-5xl mx-auto flex items-center justify-center overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Image pan scale holder */}
              <div
                className="w-full h-full flex items-center justify-center overflow-hidden relative cursor-grab active:cursor-grabbing"
                onMouseDown={handleLightboxMouseDown}
                onMouseMove={handleLightboxMouseMove}
                onMouseUp={handleLightboxMouseUp}
                onMouseLeave={handleLightboxMouseUp}
              >
                <motion.img
                  animate={{ 
                    scale: lightboxZoom,
                    x: lightboxPan.x,
                    y: lightboxPan.y
                  }}
                  transition={isDragging ? { type: 'tween', duration: 0 } : { type: 'spring', damping: 25 }}
                  src={activeImageUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="max-h-[80vh] max-w-full object-contain pointer-events-none"
                />
              </div>

              {/* Lightbox Side Arrows */}
              {galleryImages.length > 1 && (
                <>
                  <button
                    onClick={prevLightboxImage}
                    className="absolute left-2 p-3 bg-white/10 hover:bg-white/20 border border-white/10 text-white rounded-full transition-colors cursor-pointer active:scale-90"
                  >
                    <ChevronLeft className="h-6 w-6" />
                  </button>
                  <button
                    onClick={nextLightboxImage}
                    className="absolute right-2 p-3 bg-white/10 hover:bg-white/20 border border-white/10 text-white rounded-full transition-colors cursor-pointer active:scale-90"
                  >
                    <ChevronRight className="h-6 w-6" />
                  </button>
                </>
              )}
            </div>

            {/* Bottom Controls / Zoom levels indicator */}
            <div className="w-full max-w-xl mx-auto bg-white/5 border border-white/10 backdrop-blur-md p-4 rounded-3xl flex items-center justify-between gap-4 mb-2" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleZoomOut}
                  disabled={lightboxZoom <= 1}
                  className="p-2 text-white/80 hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
                >
                  <ZoomOut className="h-5 w-5" />
                </button>
                
                <span className="text-xs font-black text-white px-3 min-w-[50px] text-center bg-white/10 py-1 rounded-lg">
                  {lightboxZoom.toFixed(1)}x
                </span>

                <button
                  onClick={handleZoomIn}
                  disabled={lightboxZoom >= 4}
                  className="p-2 text-white/80 hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
                >
                  <ZoomIn className="h-5 w-5" />
                </button>
              </div>

              <span className="text-[10px] text-white/40 uppercase tracking-widest font-bold">
                {lightboxZoom > 1 ? 'Drag to pan around' : 'Double tap to zoom'}
              </span>

              {/* Pagination Dots */}
              {galleryImages.length > 1 && (
                <div className="flex items-center space-x-1.5">
                  {galleryImages.map((_, i) => (
                    <div 
                      key={i} 
                      className={`h-1.5 rounded-full transition-all ${
                        activeImageIndex === i ? 'w-4 bg-brand-blue' : 'w-1.5 bg-white/40'
                      }`} 
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* MOBILE SCROLL ACCESSIBILITY: STICKY FLOOR ADD TO CART FOOTER BAR */}
      <AnimatePresence>
        {showStickyBar && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 border-t border-slate-200/60 p-4.5 pb-5 flex items-center justify-between shadow-[0_-15px_40px_rgba(0,0,0,0.12)] md:hidden backdrop-blur-md"
          >
            <div className="flex items-center space-x-3 text-left max-w-[55%]">
              <img 
                src={product.imageUrl} 
                alt="" 
                className="w-12 h-12 object-contain bg-slate-50 p-1.5 rounded-xl border border-slate-100" 
                referrerPolicy="no-referrer" 
              />
              <div>
                <span className="text-[9px] text-slate-400 block font-bold uppercase tracking-widest truncate">{brandName}</span>
                <span className="text-xs font-black text-slate-900 truncate block leading-tight">{product.name}</span>
                <span className="text-xs font-black text-brand-blue block mt-0.5">{formatPrice(product.price)}</span>
              </div>
            </div>
            
            <div className="flex items-center space-x-2">
              <button
                onClick={handleAddToCart}
                disabled={product.stock <= 0}
                className="py-3 px-5 bg-brand-blue hover:bg-blue-700 text-white rounded-xl text-xs font-black flex items-center gap-1.5 active:scale-95 transition-all shadow-md shadow-brand-blue/15 cursor-pointer disabled:opacity-50"
              >
                {addedMessage ? <Check className="h-4 w-4 text-emerald-300" /> : <ShoppingCart className="h-4 w-4" />}
                <span>{addedMessage ? 'Added' : 'Add to Cart'}</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
