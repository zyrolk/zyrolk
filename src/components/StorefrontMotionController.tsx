import { RefObject, useLayoutEffect } from 'react';

interface StorefrontMotionControllerProps {
  rootRef: RefObject<HTMLElement | null>;
  motionKey: string;
}

const REVEAL_SELECTOR = '[data-zy-reveal]';
const IMMEDIATE_REVEAL_SELECTOR = '[data-zy-reveal="immediate"]';
const MAX_STAGGER_INDEX = 6;
const REVEAL_FAILSAFE_MS = 1200;

export default function StorefrontMotionController({
  rootRef,
  motionKey,
}: StorefrontMotionControllerProps) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const revealNodes = Array.from(root.querySelectorAll(REVEAL_SELECTOR)) as HTMLElement[];
    if (revealNodes.length === 0) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const immediateNodes = revealNodes.filter((node) => node.matches(IMMEDIATE_REVEAL_SELECTOR));
    const observedNodes = revealNodes.filter((node) => !node.matches(IMMEDIATE_REVEAL_SELECTOR));

    immediateNodes.forEach((node) => { node.dataset.zyRevealState = 'visible'; });

    if (prefersReducedMotion || typeof IntersectionObserver === 'undefined' || observedNodes.length === 0) {
      observedNodes.forEach((node) => { node.dataset.zyRevealState = 'visible'; });
      return;
    }

    observedNodes.forEach((node, index) => {
      node.dataset.zyRevealState = 'pending';
      node.style.setProperty('--zy-reveal-delay', `${Math.min(index % 7, MAX_STAGGER_INDEX) * 42}ms`);
    });

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const node = entry.target as HTMLElement;
        node.dataset.zyRevealState = 'visible';
        observer.unobserve(node);
      });
    }, {
      rootMargin: '0px 0px -7% 0px',
      threshold: 0.08,
    });

    observedNodes.forEach((node) => observer.observe(node));

    const failsafeTimer = window.setTimeout(() => {
      observedNodes.forEach((node) => {
        if (node.dataset.zyRevealState === 'pending') node.dataset.zyRevealState = 'visible';
      });
    }, REVEAL_FAILSAFE_MS);

    return () => {
      window.clearTimeout(failsafeTimer);
      observer.disconnect();
    };
  }, [motionKey, rootRef]);

  return null;
}
