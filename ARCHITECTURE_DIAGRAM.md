# Zyro.lk Architecture Diagram

## High-Level Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        A[User Browser]
        B[React SPA<br/>App.tsx]
        C[Components<br/>Navbar, ProductCard, CartDrawer, etc.]
    end
    
    subgraph "Server Layer"
        D[Express Server<br/>server.ts]
        E[Vite Dev Server<br/>Development Mode]
        F[Static Files<br/>Production Mode]
    end
    
    subgraph "Firebase Backend"
        G[Firestore Database]
        H[Firebase Auth]
        I[Firebase Storage]
    end
    
    subgraph "External Services"
        J[A2Z Supplier API]
        K[Other Supplier APIs]
    end
    
    subgraph "Supplier Integration Layer"
        L[A2Z Connector Service]
        M[Sync Engine]
        N[Integration Pipelines]
        O[Image Management]
    end
    
    A -->|HTTP/HTTPS| D
    D -->|Vite Middleware| E
    D -->|Static Assets| F
    D -->|API Calls| G
    D -->|API Calls| L
    
    B -->|Real-time Listeners| G
    B -->|Auth State| H
    B -->|Image Uploads| I
    C -->|User Interactions| B
    
    L -->|Fetch Products| J
    L -->|Fetch Products| K
    L -->|Raw Data| M
    M -->|Compare & Validate| N
    N -->|Queue for Review| G
    N -->|Download Images| O
    O -->|Optimized Images| I
    
    style A fill:#e1f5ff
    style B fill:#fff4e1
    style D fill:#f0e1ff
    style G fill:#ffe1f0
    style L fill:#e1ffe1
```

## Component Architecture

```mermaid
graph TB
    subgraph "Main Application"
        APP[App.tsx<br/>Main Container]
    end
    
    subgraph "UI Components"
        NAV[Navbar]
        MBN[MobileBottomNav]
        HERO[HeroBanner]
        PC[ProductCard]
        PDM[ProductDetailModal]
        CD[CartDrawer]
        FOOTER[Footer]
        AUTH[AuthModal]
        ADMIN[AdminDashboard]
        CMS[CmsPage]
        CONTACT[ContactPage]
        FW[FloatingWhatsApp]
    end
    
    subgraph "Admin Components"
        ADMIN_DASH[AdminDashboard]
        SUPPLIER_HUB[SupplierHubFiveStars]
    end
    
    APP --> NAV
    APP --> MBN
    APP --> HERO
    APP --> PC
    APP --> PDM
    APP --> CD
    APP --> FOOTER
    APP --> AUTH
    APP --> ADMIN
    APP --> CMS
    APP --> CONTACT
    APP --> FW
    
    ADMIN --> ADMIN_DASH
    ADMIN --> SUPPLIER_HUB
    
    style APP fill:#ff6b6b
    style NAV fill:#4ecdc4
    style ADMIN fill:#ffe66d
```

## Data Flow Architecture

```mermaid
graph LR
    subgraph "Supplier Sync Flow"
        S1[Supplier API] --> S2[A2Z Connector]
        S2 --> S3[Product Parser]
        S3 --> S4[Product Mapper]
        S4 --> S5[Product Validator]
        S5 --> S6[Product Comparator]
        S6 --> S7{Has Changes?}
        S7 -->|Yes| S8[Queue Manager]
        S7 -->|No| S9[Skip]
        S8 --> S10[Review Manager]
        S10 --> S11[Admin Approval]
        S11 --> S12[Update Firestore]
        S6 --> S12
    end
    
    subgraph "Image Processing Flow"
        I1[Supplier Images] --> I2[Image Downloader]
        I2 --> I3[Image Validator]
        I3 --> I4[Image Optimizer]
        I4 --> I5[Image Selector]
        I5 --> I6[Firebase Storage]
    end
    
    subgraph "User Shopping Flow"
        U1[User Browse] --> U2[Add to Cart]
        U2 --> U3[LocalStorage Cart]
        U3 --> U4[Checkout API]
        U4 --> U5[Firebase Transaction]
        U5 --> U6[Order Created]
        U6 --> U7[Stock Updated]
    end
    
    style S1 fill:#e1f5ff
    style S12 fill:#ffe1f0
    style U6 fill:#e1ffe1
```

## Service Layer Architecture

```mermaid
graph TB
    subgraph "Connectors"
        C1[A2ZConnectorService]
        C2[ProductFetcher]
        C3[ProductParser]
        C4[ProductMapper]
        C5[ProductValidator]
        C6[ImageDownloader]
    end
    
    subgraph "Sync Engine"
        SE1[SyncManager]
        SE2[ProductComparator]
        SE3[PriceComparator]
        SE4[StockComparator]
        SE5[ImageComparator]
        SE6[QueueManager]
        SE7[ReviewManager]
        SE8[HistoryLogger]
        SE9[SourceRegistry]
    end
    
    subgraph "Integration Pipelines"
        IP1[IntegrationManager]
        IP2[SyncPipeline]
        IP3[MappingPipeline]
        IP4[ValidationPipeline]
        IP5[ComparisonPipeline]
        IP6[QueuePipeline]
        IP7[ReviewPipeline]
        IP8[HistoryPipeline]
    end
    
    subgraph "Image Management"
        IM1[ImageManager]
        IM2[ImageOptimizer]
        IM3[ImageValidator]
        IM4[ImageSelector]
        IM5[ImageQueueBuilder]
    end
    
    C1 --> C2
    C1 --> C3
    C1 --> C4
    C1 --> C5
    C1 --> C6
    
    SE1 --> SE2
    SE1 --> SE3
    SE1 --> SE4
    SE1 --> SE5
    SE1 --> SE6
    SE1 --> SE7
    SE1 --> SE8
    SE1 --> SE9
    
    IP1 --> IP2
    IP1 --> IP3
    IP1 --> IP4
    IP1 --> IP5
    IP1 --> IP6
    IP1 --> IP7
    IP1 --> IP8
    
    IM1 --> IM2
    IM1 --> IM3
    IM1 --> IM4
    IM1 --> IM5
    
    style C1 fill:#e1f5ff
    style SE1 fill:#fff4e1
    style IP1 fill:#f0e1ff
    style IM1 fill:#e1ffe1
```

## Database Schema

```mermaid
graph TB
    subgraph "Firestore Collections"
        PRODUCTS[products<br/>id, name, price, stock, supplierItemCode, etc.]
        CATEGORIES[categories<br/>id, name, icon, count]
        ORDERS[orders<br/>orderNumber, customerInfo, items, totalPrice, status]
        USERS[users<br/>uid, email, role, createdAt]
        SETTINGS[settings/website<br/>storeName, deliveryCharge, heroBanners, etc.]
        SUPPLIER_SOURCES[supplierSources<br/>name, type, config, lastSync]
        SUPPLIER_SETTINGS[supplier_settings/config<br/>syncEnabled, autoImageDownload, etc.]
        REVIEW_QUEUE[supplierReviewQueue<br/>changeType, oldValue, newValue, status]
        IMAGE_QUEUE[imageQueue<br/>productId, imageUrls, status]
        SYNC_HISTORY[syncHistory<br/>supplierId, status, metrics, timestamp]
        COUNTERS[counters/orders<br/>currentSeq for order numbers]
    end
    
    style PRODUCTS fill:#e1f5ff
    style ORDERS fill:#ffe1f0
    style REVIEW_QUEUE fill:#fff4e1
```

## API Endpoints

```mermaid
graph TB
    subgraph "Express Server API"
        API1[POST /api/checkout<br/>Process orders with transaction]
        API2[POST /api/test-supplier<br/>Test supplier connection]
        API3[POST /api/fetch-supplier<br/>Fetch supplier products]
    end
    
    subgraph "Firebase Client SDK"
        FB1[Firestore Real-time Listeners]
        FB2[Auth State Changes]
        FB3[Storage Uploads/Downloads]
    end
    
    API1 -->|Transaction| ORDERS
    API1 -->|Stock Update| PRODUCTS
    API2 -->|A2Z Connector| C1
    API3 -->|A2Z Connector| C1
    
    style API1 fill:#ff6b6b
    style API2 fill:#4ecdc4
    style API3 fill:#ffe66d
```

## Technology Stack

### Frontend
- **React 19** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **TailwindCSS** - Styling
- **Motion** - Animations
- **Lucide React** - Icons
- **Recharts** - Charts (for admin dashboard)

### Backend
- **Express.js** - Server framework
- **Firebase Admin SDK** - Server-side Firebase operations
- **Sharp** - Image processing

### Database & Services
- **Firestore** - NoSQL database
- **Firebase Auth** - Authentication
- **Firebase Storage** - File storage
- **A2Z Supplier API** - External product source

### Build Tools
- **esbuild** - Fast bundler
- **tsx** - TypeScript execution
- **TypeScript** - Compiler

## Key Features

1. **Multi-Supplier Integration**
   - A2Z website connector with authentication
   - Extensible connector architecture for other suppliers
   - Product parsing, mapping, and validation

2. **Sync Engine**
   - Automated product synchronization
   - Change detection (price, stock, images, descriptions)
   - Human-in-the-loop review queue
   - Sync history and metrics

3. **Image Management**
   - Automatic image downloading
   - Image optimization and validation
   - Smart image selection
   - Firebase Storage integration

4. **E-commerce Features**
   - Product catalog with categories
   - Shopping cart with localStorage persistence
   - Secure checkout with Firebase transactions
   - Order management and tracking
   - District-based delivery pricing

5. **Admin Dashboard**
   - Product management
   - Order management
   - Supplier hub for integration management
   - CMS for pages
   - Website settings configuration
   - Analytics and reporting

6. **User Experience**
   - Responsive design (mobile-first)
   - Real-time updates via Firestore
   - WhatsApp integration for customer support
   - Wishlist functionality
   - Advanced filtering and search

## Security Features

- Firebase Authentication for admin access
- Firestore security rules
- Transaction-based checkout to prevent race conditions
- Server-side API proxy to bypass CORS
- Environment-based configuration
