export interface SupplierImageDiagnosticTarget {
  currentSrc: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  getAttribute(name: string): string | null;
}

export interface SupplierImageFailureDetails {
  currentSrc: string;
  src: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  "navigator.onLine": boolean;
  "location.href": string;
  timestamp: string;
}

interface SupplierImageDiagnosticContext {
  nodeEnvironment?: string;
  online?: boolean;
  pageUrl?: string;
  timestamp?: string;
  log?: (message: string, details: SupplierImageFailureDetails) => void;
}

const runtimeNodeEnvironment = (): string => {
  const viteEnvironment = (import.meta as ImportMeta & { env?: { MODE?: string } }).env;
  return viteEnvironment?.MODE || "production";
};

export const createSupplierImageFailureReporter = () => {
  const loggedUrls = new Set<string>();

  return (
    image: SupplierImageDiagnosticTarget,
    context: SupplierImageDiagnosticContext = {},
  ): void => {
    if ((context.nodeEnvironment || runtimeNodeEnvironment()) === "production") return;

    const currentSrc = image.currentSrc || "";
    const src = image.getAttribute("src") || "";
    const failureKey = currentSrc || src;
    if (loggedUrls.has(failureKey)) return;
    loggedUrls.add(failureKey);

    const details: SupplierImageFailureDetails = {
      currentSrc,
      src,
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      "navigator.onLine": context.online ?? (typeof navigator !== "undefined" ? navigator.onLine : false),
      "location.href": context.pageUrl ?? (typeof location !== "undefined" ? location.href : ""),
      timestamp: context.timestamp || new Date().toISOString(),
    };

    (context.log || console.error)("Image failed to load", details);
  };
};

export const reportSupplierImageFailure = createSupplierImageFailureReporter();
