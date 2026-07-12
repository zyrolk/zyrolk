import { appLogger } from "./logging";

export interface RuntimeConfig {
  adminEmail: string;
  allowedOrigins: string[];
  corsAllowsAllOrigins: boolean;
}

let cachedConfig: RuntimeConfig | null = null;
const PRODUCTION_ADMIN_EMAIL = "zyrolkofficial@gmail.com";

function parseAllowedOrigins(rawValue: string | undefined): string[] {
  return (rawValue || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function loadRuntimeConfig(): RuntimeConfig {
  const allowedOrigins = parseAllowedOrigins(process.env.API_ALLOWED_ORIGINS);

  return {
    adminEmail: PRODUCTION_ADMIN_EMAIL,
    allowedOrigins,
    corsAllowsAllOrigins: allowedOrigins.length === 0,
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  if (!cachedConfig) {
    cachedConfig = loadRuntimeConfig();
    appLogger.info("Runtime configuration validated.", {
      adminEmailConfigured: true,
      allowedOriginsCount: cachedConfig.allowedOrigins.length,
      corsMode: cachedConfig.corsAllowsAllOrigins ? "compatibility-wildcard" : "allowlist",
    });
  }

  return cachedConfig;
}
