import React, { useState, useEffect } from 'react';
import { Mail, Phone, MapPin, Send, CheckCircle, Clock, MessageSquare, Edit3 } from 'lucide-react';
import { WebsiteSettings } from '../types';
import { db } from '../firebase';
import { addDoc, collection, doc, getDoc, serverTimestamp } from 'firebase/firestore';

interface ContactPageProps {
  settings?: WebsiteSettings | null;
  isAdmin?: boolean;
  onEdit?: (pageId: string) => void;
}

const DEFAULT_CONTACT_CONTENT = `Get In Touch

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
Thank you for contacting us. One of our specialists will reach out to you via phone or email very shortly.`;

function parseContactContent(content: string) {
  const result: {
    intro?: string;
    supportDesc?: string;
    hoursTitle?: string;
    hoursItems?: { label: string; value: string }[];
    helpTitle?: string;
    helpDesc?: string;
    closingMessage?: string;
  } = {};

  if (!content) return result;

  const blocks = content.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);

  let currentHeader = '';
  let introParagraphs: string[] = [];

  blocks.forEach((block, index) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const isSingleLine = lines.length === 1 && !lines[0].startsWith('•') && !lines[0].startsWith('-') && !lines[0].startsWith('*');
    
    if (isSingleLine) {
      currentHeader = lines[0].toLowerCase();
      return;
    }

    const isList = lines.every(l => l.startsWith('•') || l.startsWith('-') || l.startsWith('*'));

    if (!currentHeader) {
      introParagraphs.push(block);
    } else if (currentHeader.includes('support') || currentHeader.includes('customer') || currentHeader.includes('representative')) {
      result.supportDesc = block;
    } else if (currentHeader.includes('hour') || currentHeader.includes('operating') || currentHeader.includes('business')) {
      if (isList || block.includes(':')) {
        const items: { label: string; value: string }[] = [];
        lines.forEach(line => {
          const cleanLine = line.replace(/^[•\-*]\s*/, '').trim();
          const parts = cleanLine.split(':');
          if (parts.length >= 2) {
            items.push({
              label: parts[0].trim(),
              value: parts.slice(1).join(':').trim()
            });
          }
        });
        if (items.length > 0) {
          result.hoursItems = items;
        }
      } else {
        result.supportDesc = block;
      }
    } else if (currentHeader.includes('help') || currentHeader.includes('instant') || currentHeader.includes('whatsapp') || currentHeader.includes('reply')) {
      const prevBlock = blocks[index - 1];
      if (prevBlock && prevBlock.split('\n').length === 1) {
        result.helpTitle = prevBlock;
      }
      result.helpDesc = block;
    } else if (currentHeader.includes('feedback') || currentHeader.includes('closing') || currentHeader.includes('success') || index === blocks.length - 1) {
      result.closingMessage = block;
    }
  });

  if (introParagraphs.length > 0) {
    result.intro = introParagraphs.join('\n\n');
  }

  // Backup positional parsing if header matching is empty/incomplete
  let tempHeader = '';
  blocks.forEach((block) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const isSingleLine = lines.length === 1 && !lines[0].startsWith('•') && !lines[0].startsWith('-') && !lines[0].startsWith('*');
    
    if (isSingleLine) {
      tempHeader = block;
    } else {
      if (!tempHeader) {
        if (!result.intro) result.intro = block;
      } else {
        const lowerHeader = tempHeader.toLowerCase();
        if (lowerHeader.includes('support') || lowerHeader.includes('customer')) {
          if (!result.supportDesc) result.supportDesc = block;
        } else if (lowerHeader.includes('hour') || lowerHeader.includes('operating') || lowerHeader.includes('business')) {
          if (!result.hoursItems) {
            const items: { label: string; value: string }[] = [];
            lines.forEach(line => {
              const cleanLine = line.replace(/^[•\-*]\s*/, '').trim();
              const parts = cleanLine.split(':');
              if (parts.length >= 2) {
                items.push({
                  label: parts[0].trim(),
                  value: parts.slice(1).join(':').trim()
                });
              }
            });
            if (items.length > 0) result.hoursItems = items;
          }
        } else if (lowerHeader.includes('help') || lowerHeader.includes('whatsapp') || lowerHeader.includes('reply')) {
          if (!result.helpTitle) result.helpTitle = tempHeader;
          if (!result.helpDesc) result.helpDesc = block;
        } else if (lowerHeader.includes('feedback') || lowerHeader.includes('closing') || lowerHeader.includes('success')) {
          if (!result.closingMessage) result.closingMessage = block;
        }
      }
      tempHeader = '';
    }
  });

  return result;
}

export default function ContactPage({ settings, isAdmin, onEdit }: ContactPageProps) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const [cmsPage, setCmsPage] = useState<{ title: string; content: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchCmsContent = async () => {
      try {
        const docSnap = await getDoc(doc(db, "pages", "contact-us"));
        if (docSnap.exists()) {
          const data = docSnap.data();
          setCmsPage({
            title: data.title || "",
            content: data.content || ""
          });
        }
      } catch (err) {
        console.error("Error fetching Contact Us CMS page:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchCmsContent();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !phone.trim() || !message.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      await addDoc(collection(db, "contact_inquiries"), {
        name: name.trim(), phone: phone.trim(), email: email.trim(), message: message.trim(),
        status: "new", createdAt: serverTimestamp(),
      });
      setSubmitted(true);
      setTimeout(() => {
        setSubmitted(false);
        setName("");
        setPhone("");
        setEmail("");
        setMessage("");
      }, 4000);
    } catch (error) {
      console.error("Contact inquiry persistence failed:", error);
      setSubmitError("Your inquiry could not be sent. Please try again or contact us through WhatsApp.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleWhatsAppChat = () => {
    const text = encodeURIComponent(`Hello ${settings?.storeName || "Zyro.lk"} Customer Care! I have a question regarding products and stock status.`);
    const waNumber = settings?.whatsappNumber 
      ? settings.whatsappNumber.replace(/[^0-9]/g, "") 
      : "";
    if (!waNumber) {
      alert("WhatsApp chat is currently being configured by the store administrator. Please try again soon or contact support!");
      return;
    }
    window.open(`https://wa.me/${waNumber}?text=${text}`, '_blank');
  };

  // Default values
  let pageTitle = "Get In Touch With " + (settings?.storeName || "Zyro.lk");
  let intro = "Have questions about brand warranties, solar solutions, or custom product ordering? Our professional sales team is standing by to assist you.";
  let supportDesc = "Our back-office representative will respond with pricing, quotation invoices, or warranty details within 2 hours.";
  let hoursTitle = "Operating Hours";
  let hoursItems = [
    { label: "Weekdays", value: "9:00 AM - 7:00 PM" },
    { label: "Saturday", value: "9:00 AM - 5:00 PM" },
    { label: "Sunday & Poya Days", value: "Closed" }
  ];
  let helpTitle = "Instant WhatsApp Reply";
  let helpDesc = "Want the fastest response? Skip forms entirely and talk to our support team on WhatsApp right now.";
  let closingMessage = "Thank you for contacting us. One of our specialists will reach out to you via phone or email very shortly.";

  const activeContent = cmsPage?.content || DEFAULT_CONTACT_CONTENT;
  if (cmsPage?.title) {
    pageTitle = cmsPage.title;
  }

  const parsed = parseContactContent(activeContent);
  if (parsed.intro) intro = parsed.intro;
  if (parsed.supportDesc) supportDesc = parsed.supportDesc;
  if (parsed.hoursItems && parsed.hoursItems.length > 0) {
    hoursItems = parsed.hoursItems;
  }
  if (parsed.hoursTitle) hoursTitle = parsed.hoursTitle;
  if (parsed.helpTitle) helpTitle = parsed.helpTitle;
  if (parsed.helpDesc) helpDesc = parsed.helpDesc;
  if (parsed.closingMessage) closingMessage = parsed.closingMessage;

  return (
    <div className="bg-slate-50 min-h-screen py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto space-y-12">
        
        {/* Navigation Action Row */}
        {isAdmin && onEdit && (
          <div className="flex justify-end">
            <button
              onClick={() => onEdit("contact-us")}
              className="inline-flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer shadow-sm hover:shadow-md"
            >
              <Edit3 className="h-3.5 w-3.5 text-white" />
              <span>Edit Contact Page Content</span>
            </button>
          </div>
        )}

        {/* Header Title */}
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 font-display">
            {pageTitle}
          </h1>
          <p className="mt-3 text-slate-500 font-light text-sm sm:text-base leading-relaxed">
            {intro}
          </p>
        </div>

        {/* Contact Grid layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* Direct Channels Cards (Left) */}
          <div className="lg:col-span-5 space-y-6 text-left">
            
            <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-xs">
              <h3 className="text-lg font-bold text-slate-900 font-display mb-4">Direct Touchpoints</h3>
              
              <div className="space-y-4">
                {/* Location */}
                <div className="flex items-start space-x-3.5">
                  <div className="p-2.5 bg-blue-50 text-brand-blue rounded-xl">
                    <MapPin className="h-5 w-5" />
                  </div>
                  <div>
                    <span className="block text-xs text-slate-400 font-bold uppercase tracking-wider">Showroom</span>
                    <span className="text-sm font-medium text-slate-800 leading-relaxed">
                      {settings?.contactAddress || "Showroom address pending setup"}
                    </span>
                  </div>
                </div>

                {/* Phone support */}
                <div className="flex items-start space-x-3.5">
                  <div className="p-2.5 bg-blue-50 text-brand-blue rounded-xl">
                    <Phone className="h-5 w-5" />
                  </div>
                  <div>
                    <span className="block text-xs text-slate-400 font-bold uppercase tracking-wider">Direct Hotline</span>
                    <span className="text-sm font-medium text-slate-800 leading-relaxed block">
                      {settings?.contactPhone || "Hotline pending setup"}
                    </span>
                  </div>
                </div>

                {/* Email */}
                <div className="flex items-start space-x-3.5">
                  <div className="p-2.5 bg-blue-50 text-brand-blue rounded-xl">
                    <Mail className="h-5 w-5" />
                  </div>
                  <div>
                    <span className="block text-xs text-slate-400 font-bold uppercase tracking-wider">Sales Email</span>
                    <span className="text-sm font-medium text-slate-800 leading-relaxed">
                      {settings?.contactEmail || "Email pending setup"}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Hours card */}
            <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-xs">
              <h3 className="text-lg font-bold text-slate-900 font-display mb-4 flex items-center">
                <Clock className="h-5 w-5 text-brand-blue mr-2" />
                {hoursTitle}
              </h3>
              <div className="space-y-2 text-sm text-slate-600">
                {hoursItems.map((item, idx) => (
                  <div key={idx} className={`flex justify-between py-1.5 ${idx < hoursItems.length - 1 ? 'border-b border-slate-50' : ''}`}>
                    <span>{item.label}</span>
                    <span className={`font-semibold ${item.value.toLowerCase().includes('closed') ? 'text-brand-blue' : 'text-slate-800'}`}>
                      {item.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* WhatsApp CTA card */}
            <div className="bg-emerald-50 border border-emerald-100 rounded-3xl p-6 text-center space-y-4">
              <MessageSquare className="h-8 w-8 text-emerald-600 mx-auto" />
              <div className="space-y-1">
                <h4 className="text-base font-bold text-emerald-900 font-display">{helpTitle}</h4>
                <p className="text-xs text-emerald-700 font-light leading-relaxed">
                  {helpDesc}
                </p>
              </div>
              <button
                onClick={handleWhatsAppChat}
                className="w-full min-h-11 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-bold transition-all shadow-xs flex items-center justify-center cursor-pointer focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-500/30 focus-visible:ring-offset-2"
                aria-label="Start a customer support chat on WhatsApp"
              >
                <Phone className="h-3.5 w-3.5 mr-2 text-white fill-white" />
                Chat on WhatsApp
              </button>
            </div>

          </div>

          {/* Interactive Form (Right) */}
          <div className="lg:col-span-7 bg-white border border-slate-100 rounded-3xl p-6 md:p-8 shadow-xs text-left">
            <h3 className="text-xl font-bold text-slate-900 font-display mb-2">Send us an Inquiry</h3>
            <p className="text-xs text-slate-400 font-light leading-relaxed mb-6">
              {supportDesc}
            </p>

            {submitted ? (
              <div className="py-12 text-center space-y-4" role="status" aria-live="polite">
                <CheckCircle className="h-14 w-14 text-emerald-500 mx-auto animate-pulse" />
                <h4 className="text-xl font-bold font-display text-slate-900">Inquiry Sent Successfully!</h4>
                <p className="text-sm text-slate-500 max-w-sm mx-auto font-light leading-relaxed">
                  {closingMessage}
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" aria-label="Customer inquiry form">
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Name */}
                  <div>
                    <label htmlFor="contact-name" className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Your Name *</label>
                    <input
                      id="contact-name"
                      type="text"
                      required
                      placeholder="Kumara Alwis"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="min-h-11 w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:border-brand-blue focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                    />
                  </div>

                  {/* Phone */}
                  <div>
                    <label htmlFor="contact-phone" className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">WhatsApp / Contact Number *</label>
                    <input
                      id="contact-phone"
                      type="tel"
                      required
                      placeholder="+94 77 123 4567"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="min-h-11 w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:border-brand-blue focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                    />
                  </div>
                </div>

                {/* Email */}
                <div>
                  <label htmlFor="contact-email" className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Email Address</label>
                  <input
                    id="contact-email"
                    type="email"
                    placeholder="kumara@gmail.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={160}
                    className="min-h-11 w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:border-brand-blue focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                  />
                </div>

                {/* Message */}
                <div>
                  <label htmlFor="contact-message" className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Inquiry Details *</label>
                  <textarea
                    id="contact-message"
                    required
                    rows={4}
                    placeholder="Describe what product you are interested in, quantities required, or delivery questions..."
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    maxLength={2000}
                    className="w-full text-sm px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus-visible:outline-none focus-visible:border-brand-blue focus-visible:ring-4 focus-visible:ring-brand-blue/15"
                  ></textarea>
                </div>

                {submitError && <p className="text-xs font-semibold text-red-600" role="alert">{submitError}</p>}

                {/* Button */}
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full min-h-11 px-4 py-3.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-sm font-bold shadow-md shadow-slate-900/10 cursor-pointer flex items-center justify-center transition-all focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-900/25 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
                >
                  <Send className="h-4 w-4 mr-1.5" />
                  {submitting ? "Sending Inquiry..." : "Submit Inquiry"}
                </button>

              </form>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}
