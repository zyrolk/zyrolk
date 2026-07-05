import { initializeApp, getApps, deleteApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { 
  initializeFirestore, 
  collection, 
  getDocs, 
  doc, 
  setDoc,
  deleteDoc,
  getDoc,
  getDocFromServer
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { Product, Category } from './types';
import appletConfig from '../firebase-applet-config.json';

// Construct config directly from the imported JSON, with absolutely no hardcoded values
const firebaseConfig = {
  apiKey: appletConfig.apiKey,
  authDomain: appletConfig.authDomain,
  projectId: appletConfig.projectId,
  storageBucket: appletConfig.storageBucket,
  messagingSenderId: appletConfig.messagingSenderId,
  appId: appletConfig.appId
};

// Clean up any existing/cached Firebase apps to ensure a completely clean state
const existingApps = getApps();
if (existingApps.length > 0) {
  existingApps.forEach(existingApp => {
    deleteApp(existingApp).catch(err => {
      console.warn("Failed to delete cached app instance:", err);
    });
  });
}

// Initialize Firebase only once
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Initialize Firestore with the default database
const db = initializeFirestore(app, {});

// Initialize Firebase Storage
const storage = getStorage(app);

// Liveness Connection test
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log("Firebase Connection verified.");
  } catch (error) {
    if (error instanceof Error && error.message.includes('offline')) {
      console.warn("Firebase client appears to be offline. Local persistence will buffer updates.");
    } else {
      console.log("Firebase initialization status checked.");
    }
  }
}
testConnection();

// Pre-seeded premium products (No Apple products!)
const DEFAULT_PRODUCTS: Product[] = [
  {
    id: "prod-odyssey-g9",
    name: "Samsung Odyssey Neo G9 49\" OLED Monitor",
    description: "The gaming screen that redefines the playing field. Featuring a 49-inch super ultra-wide 32:9 curved screen, Quantum Matrix Technology with Quantum Mini LEDs, and a blazing 240Hz refresh rate.",
    price: 495000,
    originalPrice: 550000,
    discount: 10,
    imageUrl: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?q=80&w=600&auto=format&fit=crop",
    imageUrls: [
      "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?q=80&w=600&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1547082299-de196ea013d6?q=80&w=600&auto=format&fit=crop"
    ],
    category: "electronics",
    rating: 4.9,
    reviewsCount: 18,
    isFeatured: true,
    isNew: false,
    isBestSeller: true,
    stock: 5,
    specs: {
      "Screen Size": "49 inches Curved (1000R)",
      "Resolution": "Dual QHD (5120 x 1440)",
      "Refresh Rate": "240Hz",
      "Response Time": "0.03ms (GtG)",
      "Panel Type": "Quantum OLED"
    }
  },
  {
    id: "prod-anker-eufy-cam",
    name: "Anker EufyCam 3 4K Security Camera System (2-Cam)",
    description: "Premium 4K wireless outdoor security camera system with integrated solar panel, face recognition AI, expandable local storage up to 16TB, and zero monthly fees.",
    price: 195000,
    originalPrice: 220000,
    discount: 11,
    imageUrl: "https://images.unsplash.com/photo-1557324218-8f38b36d75d7?q=80&w=600&auto=format&fit=crop",
    category: "electronics",
    rating: 4.7,
    reviewsCount: 22,
    isFeatured: false,
    isNew: false,
    isBestSeller: true,
    stock: 14,
    specs: {
      "Resolution": "4K Ultra HD (3840 x 2160)",
      "Battery Life": "Forever Power (Built-in solar panel)",
      "Storage": "HomeBase 3 with expandable 16TB HDD support",
      "AI Features": "BionicMind (Face, human, vehicle, pet detection)",
      "Weatherproof": "IP67 weatherproof rating"
    }
  },
  {
    id: "prod-solar-inverter",
    name: "Zyro Hybrid Smart Solar Inverter 5kW",
    description: "Power your Sri Lankan home with uninterrupted premium hybrid green solar energy. This 5kW smart inverter supports battery storage, solar panels, and grid input, with smart remote app monitoring and automatic power switching.",
    price: 680000,
    originalPrice: 750000,
    discount: 9,
    imageUrl: "https://images.unsplash.com/photo-1509391366360-2e959784a276?q=80&w=600&auto=format&fit=crop",
    imageUrls: [
      "https://images.unsplash.com/photo-1509391366360-2e959784a276?q=80&w=600&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1620038638136-2c13778a87b1?q=80&w=600&auto=format&fit=crop"
    ],
    category: "solar-lighting",
    rating: 4.7,
    reviewsCount: 22,
    isFeatured: true,
    isNew: true,
    isBestSeller: true,
    stock: 8,
    specs: {
      "Capacity": "5000W / 48V DC",
      "Efficiency": "Up to 97.6%",
      "WiFi App": "SmartLife Cloud Monitoring",
      "Battery Support": "Lithium Iron Phosphate (LiFePO4) & Lead-Acid",
      "Warranty": "5 Years Brand Warranty"
    }
  },
  {
    id: "prod-solar-street",
    name: "Zyro Premium Solar Street Light 300W",
    description: "Heavy-duty outdoor solar floodlight featuring high lumen LED chips, superior monocrystalline solar panel, built-in radar motion sensor, and continuous intelligent remote control illumination for garden, street, and yard.",
    price: 245000,
    originalPrice: 280000,
    discount: 13,
    imageUrl: "https://images.unsplash.com/photo-1565814329452-e1efa11c5b89?q=80&w=600&auto=format&fit=crop",
    category: "solar-lighting",
    rating: 4.6,
    reviewsCount: 45,
    isFeatured: false,
    isNew: false,
    isBestSeller: true,
    stock: 25,
    specs: {
      "Wattage": "300 Watts",
      "Luminous Flux": "24,000 Lumens",
      "Solar Panel": "6V/35W Monocrystalline",
      "Battery": "3.2V 36,000mAh LiFePO4",
      "Waterproof": "IP65 Weatherproof rating"
    }
  },
  {
    id: "prod-philips-airfryer",
    name: "Philips Premium Airfryer XXL HD9867/90",
    description: "The premium airfryer that does the thinking for you. Featuring Smart Sensing technology, high airflow for fat removal, and custom temperature controllers for perfectly crispy, healthy meals every single time.",
    price: 89000,
    originalPrice: 98000,
    discount: 9,
    imageUrl: "https://images.unsplash.com/photo-1621972750749-0fbb1abb7736?q=80&w=600&auto=format&fit=crop",
    category: "home-kitchen",
    rating: 4.9,
    reviewsCount: 56,
    isFeatured: true,
    isNew: false,
    isBestSeller: true,
    stock: 15,
    specs: {
      "Capacity": "7.3 Liters (1.4kg family size)",
      "Technology": "Smart Sensing & Fat Removal technology",
      "Power": "2200W High heating",
      "Dishwasher Safe": "Yes, with QuickClean basket",
      "Modes": "Airfry, Bake, Grill, Roast, Reheat"
    }
  },
  {
    id: "prod-ecovacs-x2",
    name: "Ecovacs DEEBOT X2 OMNI Robot Vacuum",
    description: "The ultimate square-shaped robotic vacuum and mop cleaner with auto-empty, auto-wash, hot water mop washing, and auto-refill station. Features powerful 8000Pa suction and precision LiDAR navigation.",
    price: 345000,
    originalPrice: 380000,
    discount: 9,
    imageUrl: "https://images.unsplash.com/photo-1558317374-067fb5f30001?q=80&w=600&auto=format&fit=crop",
    category: "home-kitchen",
    rating: 4.8,
    reviewsCount: 16,
    isFeatured: true,
    isNew: true,
    isBestSeller: false,
    stock: 6,
    specs: {
      "Suction Power": "8000Pa",
      "Navigation": "Dual-Laser LiDAR & AIVI 3D 2.0",
      "Mopping": "OZMO Turbo 2.0 Rotating Mops",
      "OMNI Station": "Auto-empty, 55°C Hot Water Mop Wash, Hot Air Dry",
      "Obstacle Avoidance": "AI-powered obstacle detection"
    }
  },
  {
    id: "prod-dyson-v15",
    name: "Dyson V15 Detect Cordless Vacuum Cleaner",
    description: "Dyson's most powerful, intelligent cordless vacuum. Features a laser that reveals invisible microscopic dust, counts and measures particles, and adapts suction power automatically based on floor type.",
    price: 285000,
    originalPrice: 320000,
    discount: 11,
    imageUrl: "https://images.unsplash.com/photo-1558317374-067fb5f30001?q=80&w=600&auto=format&fit=crop",
    category: "home-kitchen",
    rating: 4.8,
    reviewsCount: 14,
    isFeatured: false,
    isNew: true,
    isBestSeller: false,
    stock: 4,
    specs: {
      "Suction Power": "240 AW (Air Watts)",
      "Run Time": "Up to 60 minutes fade-free power",
      "Bin Volume": "0.76 Liters",
      "Filtration": "Fully-sealed 5-stage HEPA filtration",
      "Weight": "3.1 kg"
    }
  },
  {
    id: "prod-sony-xm5",
    name: "Sony WH-1000XM5 Wireless Headphones",
    description: "Industry-leading active noise canceling headphones with dual processors, 8 microphones, and an ultra-comfortable lightweight design. Premium audio quality with LDAC and smart auto-ambient features.",
    price: 118000,
    originalPrice: 130000,
    discount: 9,
    imageUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=600&auto=format&fit=crop",
    category: "accessories",
    rating: 4.8,
    reviewsCount: 89,
    isFeatured: true,
    isNew: false,
    isBestSeller: true,
    stock: 18,
    specs: {
      "Noise Canceling": "Industry-Leading ANC with Auto Optimizer",
      "Driver Unit": "30mm specially-developed dome",
      "Battery Life": "Up to 30 hours (ANC ON) | 38 hours (ANC OFF)",
      "Bluetooth": "Version 5.2 (SBC, AAC, LDAC)",
      "Quick Charge": "3 minutes gives up to 3 hours playback"
    }
  }
];

const DEFAULT_CATEGORIES: Category[] = [
  { id: "electronics", name: "Electronics", icon: "Smartphone", count: 2 },
  { id: "home-kitchen", name: "Home & Kitchen", icon: "Home", count: 3 },
  { id: "solar-lighting", name: "Solar & Lighting", icon: "Sun", count: 2 },
  { id: "accessories", name: "Accessories", icon: "Watch", count: 1 }
];

// Seed Firestore collections if empty, and remove legacy demo Apple products
export async function seedDatabase() {
  try {
    // Seed categories
    const categoriesSnap = await getDocs(collection(db, "categories"));
    const existingCategories = categoriesSnap.docs.map(doc => doc.id);
    for (const cat of DEFAULT_CATEGORIES) {
      if (!existingCategories.includes(cat.id)) {
        console.log(`Seeding category: ${cat.name}`);
        try {
          await setDoc(doc(db, "categories", cat.id), cat);
        } catch (err) {
          console.warn(`Could not seed category ${cat.id}:`, err);
        }
      }
    }

    // Seed website settings
    const settingsRef = doc(db, "settings", "website");
    const settingsSnap = await getDoc(settingsRef);
    if (!settingsSnap.exists()) {
      const defaultSettings = {
        storeName: "Zyro.lk",
        logoUrl: "/logo.png",
        heroBanners: [
          {
            id: "banner-1",
            badge: "Authorized Distributor",
            title: "Samsung Odyssey OLED G9",
            subtitle: "Redefine Your Gaming Experience",
            description: "The world's first 49\" OLED curved gaming monitor. Experience intense immersion, Quantum Matrix color accuracy, and supercharged 240Hz frame rates.",
            image: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?q=80&w=1200",
            bgGradient: "from-slate-950 via-slate-900 to-indigo-950",
            buttonText: "Order Now"
          },
          {
            id: "banner-2",
            badge: "Sustainable Living",
            title: "Zyro Smart Solar Inverter",
            subtitle: "Power Freedom for Sri Lankan Homes",
            description: "Say goodbye to load shedding with the intelligent 5kW hybrid green inverter. Includes smart app monitoring, seamless grid-tie bypass, and robust LiFePO4 battery support.",
            image: "https://images.unsplash.com/photo-1509391366360-2e959784a276?q=80&w=1200",
            bgGradient: "from-slate-950 via-slate-900 to-emerald-950",
            buttonText: "Explore Solar"
          }
        ],
        whatsappNumber: "",
        facebookUrl: "https://facebook.com/zyro.lk",
        tiktokUrl: "https://tiktok.com/@zyro.lk",
        instagramUrl: "https://instagram.com/zyro.lk",
        contactEmail: "",
        contactPhone: "",
        contactAddress: "",
        deliveryCharge: 500,
        freeDeliveryMin: 150000
      };
      console.log("Seeding default website settings...");
      await setDoc(settingsRef, defaultSettings);
    }
  } catch (error) {
    console.warn("Could not fully check or seed Firestore database:", error);
  }
}

export { db, auth, storage, firebaseConfig };

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export default app;
