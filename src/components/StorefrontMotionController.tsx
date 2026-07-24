import { RefObject, useLayoutEffect } from 'react';

interface StorefrontMotionControllerProps {
  rootRef: RefObject<HTMLElement | null>;
  motionKey: string;
}

const REVEAL_SELECTOR = '[data-zy-reveal]';
const MAX_STAGGER_INDEX = 6;

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
    if (prefersReducedMotion || typeof IntersectionObserver === 'undefined') {
      revealNodes.forEach((node) => { node.dataset.zyRevealState = 'visible'; });
      return;
    }

    revealNodes.forEach((node, index) => {
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

    revealNodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [motionKey, rootRef]);

  return null;
}
