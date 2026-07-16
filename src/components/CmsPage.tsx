import React, { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { 
  Calendar, Clock, ArrowLeft, FileText, Check, Edit3, 
  ShieldCheck, Award, Activity, Compass, Truck, Sun, 
  Info, Lock, CreditCard, ShoppingBag, RefreshCw, HelpCircle, 
  Sparkles, AlertCircle, Sliders, Phone
} from 'lucide-react';
import { motion } from 'motion/react';

interface CmsPageProps {
  pageId: string;
  onBackToHome: () => void;
  isAdmin?: boolean;
  onEdit?: (pageId: string) => void;
}

const DEFAULT_PAGES = [
  {
    id: "about-us",
    title: "About Us",
    content: `Welcome to Zyro.lk, Sri Lanka's premier destination for high-end digital solutions, smart energy solar systems, kitchen appliances, and lifestyle audio components.

Our Journey
Established with a vision to bring cutting-edge global technology to local consumers, Zyro.lk has grown to become a trusted brand synonym with authenticity and unparalleled customer service. We direct-import genuine products from world-renowned manufacturers, ensuring that every purchase you make meets international quality standards.

Our Promise
• 100% Genuine Products: No refurbished or counterfeit units. Only authentic global hardware.
• Islandwide Safe Shipping: Secure courier delivery with live tracking straight to your doorstep.
• Customer-First Philosophy: A dedicated 7-day direct product replacement policy for manufacturing faults, backed by active local service centers across Sri Lanka.
• Future-Ready Solar Solutions: Empowering Sri Lankan homes and businesses with clean, sustainable, and highly efficient solar and backup power.

Thank you for choosing Zyro.lk. We are committed to powering your lifestyle and engineering your digital future.`
  },
  {
    id: "privacy-policy",
    title: "Privacy Policy",
    content: `At Zyro.lk, we value your privacy and are committed to protecting your personal data. This privacy policy explains how we collect, use, and safeguard your information when you visit our website or make a purchase.

1. Information We Collect
• Personal Details: Name, email address, physical shipping address, phone number, and district.
• Order Details: Records of products purchased, transactions, and preferences.
• Technical Data: IP address, browser type, device details, and cookie data to optimize your shopping experience.

2. How We Use Your Information
• To process and fulfill your orders, including islandwide shipping and order confirmation.
• To communicate with you via WhatsApp, email, or phone regarding your transactions.
• To personalize your browsing experience and keep the store's performance at its peak.
• To send optional newsletters and exclusive club discounts (only with your explicit consent).

3. Data Security & Storage
Your data is securely stored in cloud infrastructure backed by Google Firebase Authentication and Firestore databases. We do not sell, rent, or lease your personal information to third parties.

4. Your Rights
You have the right to request access to your stored personal data, request corrections, or request deletion of your customer profile. Please reach out to support@zyro.lk for any data requests.`
  },
  {
    id: "terms-conditions",
    title: "Terms & Conditions",
    content: `Welcome to Zyro.lk. By browsing our store, registering an account, or placing an order, you agree to comply with and be bound by the following terms and conditions.

1. General
• Zyro.lk is an e-commerce platform offering premium digital devices, kitchenware, lifestyle accessories, and solar systems in Sri Lanka.
• We reserve the right to modify these terms or update website pricing at any time without prior notice.

2. Ordering & Payment
• Orders placed through the website represent an offer to purchase.
• We offer secure payment methods including Cash on Delivery (COD) and direct WhatsApp payment confirmations.
• For high-value orders, we may request a partial advance payment to secure shipping and dispatch.

3. Deliveries & Shipments
• Islandwide shipping charges and free delivery thresholds are dynamically calculated at checkout.
• Delivery times typically range from 1 to 3 business days in Colombo/suburbs, and 3 to 5 business days for outstation districts.
• While we make every effort to meet estimated delivery times, external factors such as weather or courier delays are beyond our control.

4. Electronic Specifications & Product Information
• We attempt to provide accurate pictures and technical specifications for every product.
• Please review technical details such as voltage, dimensions, and compatibility before placing your order.`
  },
  {
    id: "return-policy",
    title: "Return Policy",
    content: `We want you to be entirely satisfied with your purchase from Zyro.lk. If something isn't right, we are here to help.

1. 7-Day Priority Replacement
• If you discover any manufacturing defect or functional fault within 7 days of receiving your item, you are eligible for an immediate direct replacement.
• To claim a priority replacement, please contact us with proof of purchase and a short description/video of the issue via our Hotline or WhatsApp.

2. Return Conditions
• The item must be unused, in the same brand-new condition that you received it, and in its original, undamaged retail packaging.
• All accessories, user manuals, warranty cards, and promotional gifts included in the box must be returned.

3. Warranty Claims
• Beyond the initial 7-day replacement period, products are covered by their respective manufacturer or store warranties as specified on the product page.
• Warranty repairs and servicing will be handled through authorized local service centers in Sri Lanka.`
  },
  {
    id: "faq",
    title: "Frequently Asked Questions",
    content: `Find answers to some of our customers' most common questions regarding shipping, warranties, and orders.

Q: Do you deliver islandwide in Sri Lanka?
A: Yes! We deliver to any address across all 25 districts in Sri Lanka. Packages are handled by professional courier networks to ensure secure handling.

Q: What are your shipping rates?
A: Shipping costs vary based on your district and the items in your cart. You can see the exact delivery charge during checkout. We offer free delivery on orders that exceed our minimum threshold.

Q: Can I pay with Cash on Delivery (COD)?
A: Yes, Cash on Delivery is supported for most locations and standard items. You can select COD at checkout and pay the courier when your package is delivered.

Q: Are your products genuine and covered by warranty?
A: Absolutely. We only source direct-import genuine items from original brands. All products come with local or international warranties which are honored at active service centers in Sri Lanka.

Q: How can I track my order or request custom support?
A: Once your order is dispatched, we can share tracking details with you. You can also click the WhatsApp button on your order confirmation page to chat with us in real-time.`
  },
  {
    id: "contact-us",
    title: "Contact Us",
    content: `Get In Touch

Have questions about brand warranties, solar solutions, or custom product ordering? Our professional sales team is standing by to assist you.

Customer Support
Our back-office representative will respond with pricing, quotation invoices, or warranty details within 2 hours.

Operating Hours
• Weekdays: 9:00 AM - 7:00 PM
• Saturday: 9:00 AM - 5:00 PM
• Sunday & Poya Days: Closed

Instant Help
Want the fastest response? Skip forms entirely and talk to our support team on WhatsApp right now.

Inquiry Feedback
Thank you for contacting us. One of our specialists will reach out to you via phone or email very shortly.`
  }
];

interface ContentItem {
  type: 'paragraph' | 'list' | 'qa';
  text?: string;
  items?: string[];
  q?: string;
  a?: string;
}

interface ContentSection {
  title?: string;
  items: ContentItem[];
}

const parseContent = (text: string): ContentSection[] => {
  if (!text) return [];

  const paragraphs = text.split('\n\n');
  const sections: ContentSection[] = [];
  let currentSection: ContentSection = { items: [] };

  const isHeader = (trimmed: string): boolean => {
    const clean = trimmed.replace(/^[0-9]+\.\s+/, '').trim();
    const headersList = [
      'Journey', 'Promise', 'Rights', 'Collect', 'Use Your', 'Security',
      'General', 'Ordering', 'Deliveries', 'Specifications', 'Replacement',
      'Conditions', 'Claims', 'About Us', 'Privacy Policy', 'Terms & Conditions',
      'Return Policy', 'Frequently Asked Questions'
    ];
    
    if (/^[0-9]+\.\s+[A-Za-z\s&]+/i.test(trimmed)) {
      return true;
    }
    
    if (trimmed.length < 50 && headersList.some(h => clean.toLowerCase().includes(h.toLowerCase()))) {
      return true;
    }

    return false;
  };

  paragraphs.forEach((p) => {
    const trimmed = p.trim();
    if (!trimmed) return;

    if (isHeader(trimmed) && trimmed.split('\n').length === 1) {
      if (currentSection.title || currentSection.items.length > 0) {
        sections.push(currentSection);
      }
      currentSection = { title: trimmed, items: [] };
      return;
    }

    if (trimmed.startsWith('•') || trimmed.startsWith('-') || trimmed.startsWith('*')) {
      const listLines = trimmed.split('\n').map(li => li.replace(/^[•\-*]\s*/, '').trim());
      currentSection.items.push({
        type: 'list',
        items: listLines
      });
      return;
    }

    if (trimmed.includes('Q:') && trimmed.includes('A:')) {
      const lines = trimmed.split('\n').map(l => l.trim());
      let qText = '';
      let aText = '';
      lines.forEach(line => {
        if (line.startsWith('Q:')) {
          qText = line.replace(/^Q:\s*/, '').trim();
        } else if (line.startsWith('A:')) {
          aText = line.replace(/^A:\s*/, '').trim();
        } else if (aText) {
          aText += '\n' + line;
        } else if (qText) {
          qText += '\n' + line;
        }
      });
      if (qText || aText) {
        currentSection.items.push({
          type: 'qa',
          q: qText,
          a: aText
        });
        return;
      }
    }

    currentSection.items.push({
      type: 'paragraph',
      text: trimmed
    });
  });

  if (currentSection.title || currentSection.items.length > 0) {
    sections.push(currentSection);
  }

  return sections;
};

const getSectionIcon = (title: string, pageId: string) => {
  const t = title.toLowerCase();
  
  if (t.includes('journey') || t.includes('history') || t.includes('our story')) {
    return <Compass className="h-5 w-5 text-blue-500" />;
  }
  if (t.includes('promise') || t.includes('philosophy') || t.includes('genuine') || t.includes('authentic')) {
    return <Award className="h-5 w-5 text-amber-500" />;
  }
  if (t.includes('collect') || t.includes('information we')) {
    return <Info className="h-5 w-5 text-teal-500" />;
  }
  if (t.includes('how we use') || t.includes('use your')) {
    return <Activity className="h-5 w-5 text-emerald-500" />;
  }
  if (t.includes('security') || t.includes('storage') || t.includes('safeguard')) {
    return <Lock className="h-5 w-5 text-rose-500" />;
  }
  if (t.includes('rights') || t.includes('your rights')) {
    return <ShieldCheck className="h-5 w-5 text-emerald-500" />;
  }
  if (t.includes('general') || t.includes('terms') || t.includes('rules')) {
    return <FileText className="h-5 w-5 text-slate-500" />;
  }
  if (t.includes('payment') || t.includes('ordering') || t.includes('pricing')) {
    return <CreditCard className="h-5 w-5 text-cyan-500" />;
  }
  if (t.includes('deliver') || t.includes('shipment') || t.includes('dispatch')) {
    return <Truck className="h-5 w-5 text-orange-500" />;
  }
  if (t.includes('specification') || t.includes('technical') || t.includes('voltage')) {
    return <Sliders className="h-5 w-5 text-indigo-500" />;
  }
  if (t.includes('replacement') || t.includes('priority')) {
    return <Sparkles className="h-5 w-5 text-amber-500" />;
  }
  if (t.includes('conditions') || t.includes('refund')) {
    return <AlertCircle className="h-5 w-5 text-red-500" />;
  }
  if (t.includes('warranty') || t.includes('claims') || t.includes('repair')) {
    return <ShieldCheck className="h-5 w-5 text-emerald-500" />;
  }

  if (pageId === 'faq') return <HelpCircle className="h-5 w-5 text-blue-500" />;
  if (pageId === 'about-us') return <Sparkles className="h-5 w-5 text-yellow-500" />;
  if (pageId === 'privacy-policy') return <Lock className="h-5 w-5 text-emerald-500" />;
  if (pageId === 'terms-conditions') return <FileText className="h-5 w-5 text-indigo-500" />;
  if (pageId === 'return-policy') return <RefreshCw className="h-5 w-5 text-purple-500" />;
  if (pageId === 'contact-us') return <Phone className="h-5 w-5 text-blue-500" />;

  return <FileText className="h-5 w-5 text-slate-400" />;
};

export default function CmsPage({ pageId, onBackToHome, isAdmin, onEdit }: CmsPageProps) {
  const [page, setPage] = useState<{ title: string; content: string; lastUpdated?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPageContent = async () => {
      setLoading(true);
      try {
        const docSnap = await getDoc(doc(db, "pages", pageId));
        if (docSnap.exists()) {
          const data = docSnap.data();
          setPage({
            title: data.title || "",
            content: data.content || "",
            lastUpdated: data.lastUpdated || undefined
          });
        } else {
          const fallback = DEFAULT_PAGES.find(p => p.id === pageId);
          if (fallback) {
            setPage({
              title: fallback.title,
              content: fallback.content,
              lastUpdated: new Date().toLocaleDateString()
            });
          } else {
            setPage({
              title: "Page Not Found",
              content: "The requested page is currently unavailable or has been removed."
            });
          }
        }
      } catch (err) {
        console.error("Error fetching static page:", err);
        const fallback = DEFAULT_PAGES.find(p => p.id === pageId);
        if (fallback) {
          setPage({
            title: fallback.title,
            content: fallback.content
          });
        }
      } finally {
        setLoading(false);
      }
    };

    fetchPageContent();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [pageId]);

  const parsedSections = page ? parseContent(page.content) : [];
  const introSection = parsedSections.find(s => !s.title);
  const detailedSections = parsedSections.filter(s => s.title);

  return (
    <div className="zy-storefront-page zy-cms-page relative min-h-screen pb-20">
      {/* Premium subtle glow background */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-[450px] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-500/5 via-transparent to-transparent pointer-events-none blur-3xl opacity-75" />

      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10 animate-fadeIn text-left">
        {/* Navigation Action Row */}
        <div className="flex items-center justify-between mb-8 sm:mb-10 flex-wrap gap-4">
          <button
            onClick={onBackToHome}
            className="-ml-3 inline-flex min-h-11 items-center space-x-2 rounded-xl px-3 text-xs font-semibold text-slate-600 hover:text-blue-600 transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/20"
          >
            <ArrowLeft className="h-4 w-4 group-hover:-translate-x-1 transition-transform" />
            <span>Return to Homepage</span>
          </button>

          {isAdmin && onEdit && (
            <button
              onClick={() => onEdit(pageId)}
              className="inline-flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-sm hover:shadow-md"
            >
              <Edit3 className="h-3.5 w-3.5 text-white" />
              <span>Edit Page</span>
            </button>
          )}
        </div>

        {loading ? (
          <div className="space-y-6">
            <div className="h-4 w-1/4 bg-slate-200 rounded animate-pulse" />
            <div className="h-10 bg-slate-200 rounded-lg w-2/3 animate-pulse" />
            <div className="space-y-3 pt-6">
              <div className="h-4 bg-slate-200 rounded w-full animate-pulse" />
              <div className="h-4 bg-slate-200 rounded w-5/6 animate-pulse" />
              <div className="h-4 bg-slate-200 rounded w-4/5 animate-pulse" />
            </div>
          </div>
        ) : (
          <div className="space-y-12">
            {/* Header / Intro section */}
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              {/* Metadata Badges */}
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400 uppercase tracking-widest font-bold">
                <span className="flex items-center gap-1.5 bg-slate-100 px-3 py-1 rounded-full text-slate-500 border border-slate-200/40">
                  <FileText className="h-3 w-3 text-blue-500" />
                  Corporate Specifications
                </span>
                {page?.lastUpdated && (
                  <span className="flex items-center gap-1.5 bg-slate-100 px-3 py-1 rounded-full text-slate-500 border border-slate-200/40">
                    <Calendar className="h-3 w-3" />
                    Updated: {page.lastUpdated}
                  </span>
                )}
                <span className="flex items-center gap-1.5 bg-emerald-50 border border-emerald-100/50 px-3 py-1 rounded-full text-emerald-600 font-bold">
                  <Check className="h-3 w-3 text-emerald-500" />
                  Official Zyro Spec
                </span>
              </div>

              <h1 className="text-3xl sm:text-5xl font-black font-display text-slate-900 mb-4 tracking-tight leading-none">
                {page?.title}
              </h1>

              {introSection && introSection.items.length > 0 && (
                <div className="space-y-4 text-slate-600 text-sm sm:text-base leading-relaxed">
                  {introSection.items.map((item, idx) => {
                    if (item.type === 'paragraph') {
                      return (
                        <p key={idx} className="whitespace-pre-line text-left text-slate-600">
                          {item.text}
                        </p>
                      );
                    }
                    if (item.type === 'list' && item.items) {
                      return (
                        <div key={idx} className="grid grid-cols-1 md:grid-cols-2 gap-4 my-6">
                          {item.items.map((li, liIdx) => (
                            <div key={liIdx} className="flex items-start space-x-3 p-4 bg-slate-50 border border-slate-100 rounded-2xl">
                              <div className="mt-0.5 flex-shrink-0 flex items-center justify-center h-5 w-5 rounded-full bg-emerald-50 border border-emerald-100/50">
                                <Check className="h-3 w-3 text-emerald-500" />
                              </div>
                              <span className="text-xs sm:text-sm font-medium text-slate-700">{li}</span>
                            </div>
                          ))}
                        </div>
                      );
                    }
                    if (item.type === 'qa') {
                      return (
                        <div key={idx} className="bg-slate-50/60 border border-slate-100 p-5 rounded-2xl space-y-3 shadow-sm">
                          <div className="flex items-start space-x-3">
                            <span className="flex-shrink-0 px-2 py-0.5 text-[9px] tracking-wider font-extrabold uppercase rounded bg-blue-50 text-blue-600 border border-blue-100/30">
                              Question
                            </span>
                            <h4 className="text-sm font-bold text-slate-900 leading-snug">
                              {item.q}
                            </h4>
                          </div>
                          <div className="flex items-start space-x-3 border-t border-slate-100 pt-3">
                            <span className="flex-shrink-0 px-2 py-0.5 text-[9px] tracking-wider font-extrabold uppercase rounded bg-emerald-50 text-emerald-600 border border-emerald-100/30">
                              Answer
                            </span>
                            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed whitespace-pre-line">
                              {item.a}
                            </p>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              )}
            </motion.div>

            {/* Detailed Cards Grid */}
            {detailedSections.length > 0 && (
              <div className="grid grid-cols-1 gap-6 sm:gap-8">
                {detailedSections.map((section, sectionIdx) => {
                  const sectionIcon = section.title ? getSectionIcon(section.title, pageId) : null;
                  
                  return (
                    <motion.section
                      key={sectionIdx}
                      initial={{ opacity: 0, y: 15 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: sectionIdx * 0.05 }}
                      className="bg-white border border-slate-100 rounded-3xl p-6 sm:p-8 shadow-[0_2px_8px_-3px_rgba(0,0,0,0.02)] hover:shadow-md hover:border-slate-200/60 transition-all duration-300"
                    >
                      {section.title && (
                        <div className="flex items-center mb-6 border-b border-slate-100/80 pb-4">
                          {sectionIcon && (
                            <div className="flex items-center justify-center h-10 w-10 rounded-2xl bg-slate-50 border border-slate-100/80 shadow-sm mr-4 shrink-0">
                              {sectionIcon}
                            </div>
                          )}
                          <h2 className="text-lg sm:text-xl font-bold font-display text-slate-900 tracking-tight">
                            {section.title}
                          </h2>
                        </div>
                      )}
                      
                      <div className="space-y-4">
                        {section.items.map((item, itemIdx) => {
                          if (item.type === 'paragraph') {
                            return (
                              <p key={itemIdx} className="text-sm sm:text-base text-slate-600 leading-relaxed text-justify whitespace-pre-line">
                                {item.text}
                              </p>
                            );
                          }
                          if (item.type === 'list' && item.items) {
                            return (
                              <div key={itemIdx} className="grid grid-cols-1 md:grid-cols-2 gap-4 my-4">
                                {item.items.map((li, liIdx) => (
                                  <div key={liIdx} className="flex items-start space-x-3 p-4 bg-slate-50/50 border border-slate-100/50 rounded-2xl">
                                    <div className="mt-0.5 flex-shrink-0 flex items-center justify-center h-5 w-5 rounded-full bg-emerald-50 border border-emerald-100/50">
                                      <Check className="h-3 w-3 text-emerald-500" />
                                    </div>
                                    <span className="text-xs sm:text-sm font-medium text-slate-700">{li}</span>
                                  </div>
                                ))}
                              </div>
                            );
                          }
                          if (item.type === 'qa') {
                            return (
                              <div key={itemIdx} className="bg-slate-50/60 border border-slate-100 p-5 rounded-2xl space-y-3 shadow-sm">
                                <div className="flex items-start space-x-3">
                                  <span className="flex-shrink-0 px-2 py-0.5 text-[9px] tracking-wider font-extrabold uppercase rounded bg-blue-50 text-blue-600 border border-blue-100/30">
                                    Question
                                  </span>
                                  <h4 className="text-sm font-bold text-slate-900 leading-snug">
                                    {item.q}
                                  </h4>
                                </div>
                                <div className="flex items-start space-x-3 border-t border-slate-100 pt-3">
                                  <span className="flex-shrink-0 px-2 py-0.5 text-[9px] tracking-wider font-extrabold uppercase rounded bg-emerald-50 text-emerald-600 border border-emerald-100/30">
                                    Answer
                                  </span>
                                  <p className="text-xs sm:text-sm text-slate-600 leading-relaxed whitespace-pre-line">
                                    {item.a}
                                  </p>
                                </div>
                              </div>
                            );
                          }
                          return null;
                        })}
                      </div>
                    </motion.section>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
