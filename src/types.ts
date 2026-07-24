export interface Product {
  id: string;
  name: string;
  description: string;
  price: number; // in LKR (this is the sale price if discount is present, or the default price)
  originalPrice?: number; // in LKR (this is the regular/original price)
  discount?: number; // percentage
  imageUrl: string;
  imageUrls?: string[];
  category: string; // e.g. 'electronics'
  subcategory?: string;
  brand?: string; // registered brand document ID
  model?: string;
  barcode?: string;
  productType?: string;
  tags?: string[];
  shortDescription?: string;
  keyFeatures?: string[];
  whatsIncluded?: string[];
  rating: number; // 0 when unrated; otherwise 1-5
  reviewsCount: number;
  isNew?: boolean;
  isFeatured?: boolean;
  isBestSeller?: boolean;
  isActive?: boolean; // active/inactive
  sku?: string;
  stock: number;
  specs: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
  supplierItemCode?: string;
  supplierId?: string;
  lowStockLimit?: number;
  costPrice?: number;
  marketPrice?: number;
}

export interface Brand {
  id: string;
  name: string;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface SubCategory {
  id: string;
  name: string;
  isActive?: boolean;
}

export interface SpecificationTemplateField {
  name: string;
  required?: boolean;
}

/** Customer-search-safe view of a product. Keep this explicit and allowlisted. */
export interface CustomerProduct {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly sellingPrice: number;
  readonly salePrice?: number;
  readonly category: string;
  readonly brand: string;
  readonly model: string;
  readonly stock: number;
  readonly rating: number;
  readonly reviewCount: number;
  readonly isNew: boolean;
  readonly isFeatured: boolean;
  readonly isBestSeller: boolean;
}

export interface Category {
  id: string; // e.g., 'electronics'
  name: string;
  icon: string; // lucide icon name
  imageUrl?: string;
  isActive?: boolean;
  count?: number;
  subcategories?: SubCategory[];
  specificationTemplate?: SpecificationTemplateField[];
  updatedAt?: string;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface Order {
  id: string;
  orderNumber?: string; // ZY100001, ZY100002...
  customerUid: string; // 'guest' or uid
  customerName: string;
  customerPhone: string;
  customerPhone2?: string;
  customerEmail: string;
  customerAddress: string;
  district: string;
  city?: string;
  items: {
    productId: string;
    name: string;
    price: number;
    quantity: number;
    imageUrl: string;
  }[];
  totalPrice: number;
  itemsSubtotal?: number;
  deliveryFee?: number;
  discountAmount?: number;
  couponCode?: string;
  status: 'pending' | 'confirmed' | 'processing' | 'packed' | 'shipped' | 'delivered' | 'cancelled';
  paymentMethod: 'cod' | 'whatsapp_confirm' | 'payhere';
  paymentStatus?: 'not_required' | 'awaiting_payment' | 'pending' | 'paid' | 'cancelled' | 'failed' | 'chargedback' | 'expired';
  paymentReference?: string;
  paymentAttempt?: number;
  paymentTimeline?: Array<{ id: string; status: string; label: string; source: string; at: string }>;
  supplierId?: string;
  supplierIds?: string[];
  supplierFulfilmentStatus?: 'pending' | 'processing' | 'packed' | 'shipped';
  supplierAssignedAt?: string;
  supplierFulfilmentUpdatedAt?: string;
  createdAt: string;
}

export interface HeroBannerSettings {
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  description: string;
  image: string;
  bgGradient?: string;
  buttonText?: string;
  buttonUrl?: string;
  enabled?: boolean;
}

export interface HomepageSectionSettings {
  enabled: boolean;
  title: string;
  subtitle: string;
}

export interface DeliveryAreaSettings {
  id: string;
  name: string;
  districts: string[];
  charge: number;
  estimatedDelivery: string;
  isActive: boolean;
}

export interface BusinessHoursSettings {
  weekdays: string;
  saturday: string;
  sunday: string;
}

export interface WebsiteSettings {
  storeName: string;
  storeTagline?: string;
  logoUrl?: string;
  faviconUrl?: string;
  contactPhone?: string; // Contact Number 1
  contactPhone2?: string; // Contact Number 2
  whatsappNumber: string;
  contactEmail?: string;
  contactAddress?: string;

  // Homepage / Slider
  heroBanners: HeroBannerSettings[];
  autoSlideSpeed?: number; // Seconds
  enableSlider?: boolean;
  homepageSections?: {
    flashDeals: HomepageSectionSettings;
    featured: HomepageSectionSettings;
    newArrivals: HomepageSectionSettings;
    bestSellers: HomepageSectionSettings;
    recommended: HomepageSectionSettings;
  };

  // Branding
  primaryColor?: string;
  secondaryColor?: string;
  footerLogoUrl?: string;

  // Footer
  aboutText?: string;
  copyrightText?: string;

  // Social Media
  facebookUrl?: string;
  instagramUrl?: string;
  tiktokUrl?: string;
  youtubeUrl?: string;

  // SEO
  seoTitle?: string;
  seoDescription?: string;
  seoKeywords?: string;
  ogImageUrl?: string;

  // Shipping
  deliveryCharge: number;
  freeDeliveryMin: number;
  deliveryAreas?: DeliveryAreaSettings[];
  currency?: 'LKR';
  businessHours?: BusinessHoursSettings;
  storeStatus?: 'open' | 'closed';
  storeStatusMessage?: string;

  // Store Options
  enableCOD?: boolean;
  enableWishlist?: boolean;
  enableReviews?: boolean;
  enableFeaturedProducts?: boolean;
  maintenanceMode?: boolean;
  maintenanceMessage?: string;
  registrationEnabled?: boolean;
  supplierRegistrationEnabled?: boolean;
  emailNotificationsEnabled?: boolean;
  orderNotificationsEnabled?: boolean;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: 'customer' | 'admin' | 'supplier';
  createdAt: string;
}

export interface Review {
  id: string;
  productId: string;
  userName: string;
  rating: number;
  comment: string;
  createdAt: string;
}

export interface SupplierReviewQueueItem {
  id: string;
  supplierCode: string;
  supplierName: string;
  productName: string;
  source: 'Website' | 'WhatsApp' | 'Supplier Portal';
  changeType: 'NEW_PRODUCT' | 'PRICE_CHANGED' | 'STOCK_CHANGED' | 'IMAGE_CHANGED' | 'DESCRIPTION_CHANGED';
  oldValue: string;
  newValue: string;
  status: 'Pending' | 'CONFLICT' | 'Approved' | 'Rejected';
  queueState?: string;
  approvalConflict?: {
    reason?: string;
    changedFields?: string[];
    previousVersion?: string;
    currentVersion?: string;
  };
  createdAt: string; // or any string-based timestamp/ISO string
  reviewedAt?: string;
  reviewedBy?: string;
  productPayload?: Product & Record<string, unknown>;
  matchedProductId?: string | null;
  reviewQueueItemId?: string;
  sourceId?: string;
  batchId?: string;
}
