import React, { useState, useEffect, useRef } from 'react';
import { WebsiteSettings } from '../types';
import { getBrowserStorage, readStoredJson, writeStoredJson } from '../services/browser/persistentStorage';

interface FloatingWhatsAppProps {
  settings: WebsiteSettings | null;
  isAdminMode: boolean;
  isOverlayOpen?: boolean;
}

export default function FloatingWhatsApp({ settings, isAdminMode, isOverlayOpen = false }: FloatingWhatsAppProps) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  
  const dragStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const buttonStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const hasMoved = useRef(false);

  const FAB_SIZE = 64;
  const EDGE_GUTTER = 16;
  const mobileBottomClearance = () => FAB_SIZE + (window.innerWidth < 768 ? 112 : 24);
  const clampPosition = (x: number, y: number) => {
    const maxX = Math.max(EDGE_GUTTER, window.innerWidth - FAB_SIZE - EDGE_GUTTER);
    const maxY = Math.max(EDGE_GUTTER, window.innerHeight - mobileBottomClearance());
    const clampedX = Math.max(EDGE_GUTTER, Math.min(maxX, x));
    const clampedY = Math.max(EDGE_GUTTER, Math.min(maxY, y));
    const nearLeft = clampedX < window.innerWidth / 2;
    return { x: nearLeft ? EDGE_GUTTER : maxX, y: clampedY };
  };

  const whatsappNumber = settings?.whatsappNumber || "";

  // Initialize position from localStorage or default
  useEffect(() => {
    const saved = readStoredJson(
      getBrowserStorage('localStorage'),
      'zyro_whatsapp_position',
      null as { x: number; y: number } | null,
      (value): value is { x: number; y: number } => Boolean(
        value && typeof value === 'object' &&
        Number.isFinite((value as { x?: unknown }).x) && Number.isFinite((value as { y?: unknown }).y),
      ),
    );
    if (saved) {
      setPosition(clampPosition(saved.x, saved.y));
    } else {
      setPosition(clampPosition(window.innerWidth - 80, window.innerHeight - 180));
    }
  }, []);

  // Recalculate/clamp position on window resize
  useEffect(() => {
    const handleResize = () => {
      if (!position) return;
      setPosition(clampPosition(position.x, position.y));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [position]);

  const handleStart = (clientX: number, clientY: number) => {
    if (!position) return;
    setIsDragging(true);
    hasMoved.current = false;
    dragStart.current = { x: clientX, y: clientY };
    buttonStart.current = { x: position.x, y: position.y };
  };

  const handleMove = (clientX: number, clientY: number) => {
    if (!isDragging) return;
    const dx = clientX - dragStart.current.x;
    const dy = clientY - dragStart.current.y;
    
    // Threshold to differentiate drag vs click
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
      hasMoved.current = true;
    }

    const nextX = buttonStart.current.x + dx;
    const nextY = buttonStart.current.y + dy;

    setPosition(clampPosition(nextX, nextY));
  };

  const handleEnd = () => {
    if (!isDragging || !position) return;
    setIsDragging(false);

    const finalPos = clampPosition(position.x, position.y);
    setPosition(finalPos);
    writeStoredJson(getBrowserStorage('localStorage'), 'zyro_whatsapp_position', finalPos);
  };

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      handleMove(e.clientX, e.clientY);
    };

    const onMouseUp = () => {
      handleEnd();
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      // Prevent screen scrolling while dragging WhatsApp
      if (e.cancelable) {
        e.preventDefault();
      }
      handleMove(e.touches[0].clientX, e.touches[0].clientY);
    };

    const onTouchEnd = () => {
      handleEnd();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [isDragging, position]);

  const handleClick = (e: React.MouseEvent) => {
    if (hasMoved.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const cleanNumber = whatsappNumber.replace(/[^0-9]/g, "");
    window.open(`https://wa.me/${cleanNumber}`, '_blank', 'noopener,noreferrer');
  };

  // Determine standard position before mount
  const inlineStyles: React.CSSProperties = position
    ? {
        left: `${position.x}px`,
        top: `${position.y}px`,
        transform: 'none',
        transition: isDragging ? 'none' : 'left 240ms cubic-bezier(0.16, 1, 0.3, 1), top 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      }
    : {};

  // Default tailwind fallback classes for initial load to avoid flash
  const fallbackClasses = position
    ? "fixed z-40"
    : "fixed bottom-[calc(7.25rem+env(safe-area-inset-bottom))] md:bottom-6 right-4 z-40";

  const isNearLeft = position ? position.x < window.innerWidth / 2 : false;

  if (!whatsappNumber || isAdminMode || isOverlayOpen) return null;

  return (
    <button
      id="floating-whatsapp-btn"
      onClick={handleClick}
      onMouseDown={(e) => {
        if (e.button !== 0) return; // Left click only
        handleStart(e.clientX, e.clientY);
      }}
      onTouchStart={(e) => {
        if (e.touches.length === 0) return;
        handleStart(e.touches[0].clientX, e.touches[0].clientY);
      }}
      style={inlineStyles}
      className={`zy-floating-whatsapp ${fallbackClasses} w-16 h-16 rounded-full bg-[#25D366] text-white flex items-center justify-center shadow-[0_8px_30px_rgba(37,211,102,0.4)] border-2 border-white cursor-pointer group select-none touch-none`}
      aria-label="Chat on WhatsApp"
    >
      {/* Dynamic orientation for tooltip based on screen side */}
      <span 
        className={`absolute bg-slate-900 text-white text-[11px] font-bold py-1.5 px-3 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap shadow-md pointer-events-none transition-all duration-200 z-50 ${
          isNearLeft ? 'left-20' : 'right-20'
        }`}
      >
        Chat with Support 💬
      </span>

      {/* Official WhatsApp SVG Icon */}
      <svg
        viewBox="0 0 24 24"
        className="w-9 h-9 fill-current text-white"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946C.06 5.348 5.397.01 12.008.01c3.202.001 6.212 1.246 8.477 3.513 2.262 2.268 3.507 5.28 3.505 8.484-.004 6.657-5.34 11.997-11.953 11.997-2.005-.001-3.973-.502-5.724-1.457L0 24zm6.59-4.846c1.6.95 3.188 1.449 4.625 1.45 5.332.003 9.685-4.346 9.688-9.686.002-2.586-1.004-5.018-2.833-6.849C16.237 2.238 13.805 1.23 11.218 1.23c-5.34 0-9.69 4.347-9.693 9.688-.001 1.704.449 3.364 1.3 4.814l-.997 3.64 3.733-.978zM17.65 14.71c-.328-.164-1.94-.957-2.24-1.066-.298-.11-.516-.164-.733.164-.218.328-.84.11-.84.11s-.415-.49-.785-.858c-.523-.523-.847-1.127-.957-1.345-.11-.218-.012-.336.096-.444.098-.098.218-.255.328-.383.11-.127.146-.218.218-.364.073-.146.036-.273-.018-.382-.055-.109-.516-1.24-.707-1.696-.186-.447-.373-.385-.516-.392-.134-.007-.287-.008-.44-.008-.153 0-.402.058-.613.29-.211.233-.807.789-.807 1.924 0 1.135.824 2.23 1.054 2.544.134.184 2.015 3.078 4.881 4.316.682.294 1.215.47 1.63.602.685.218 1.309.187 1.802.114.549-.081 1.941-.793 2.214-1.517.273-.724.273-1.344.192-1.472-.081-.127-.298-.218-.626-.382z" />
      </svg>
    </button>
  );
}
