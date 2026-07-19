import { appLogger } from "./logging";

export interface RuntimeConfig {
  adminEmail: string;
  allowedOrigins: string[];
  corsAllowsAllOrigins: boolean;
  requireAppCheck: boolean;
}

let cachedConfig: RuntimeConfig | null = null;
const PRODUCTION_ADMIN_EMAIL = "zyrolkofficial@gmail.com";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://zyro.lk",
  "https://www.zyro.lk",
  "https://zyrolk-e0164.web.app",
];

function parseAllowedOrigins(rawValue: string | undefined): string[] {
  const configured = (rawValue || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const values = configured.length > 0 ? configured : DEFAULT_ALLOWED_ORIGINS;
  return [...new Set(values.map((origin) => {
    const parsed = new URL(origin);
    const isLocalDevelopment = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.origin !== origin || (parsed.protocol !== "https:" && !isLocalDevelopment)) {
      throw new Error(`API_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }
    return parsed.origin;
  }))];
}

export function loadRuntimeConfig(): RuntimeConfig {
  const allowedOrigins = parseAllowedOrigins(process.env.API_ALLOWED_ORIGINS);

  return {
    adminEmail: PRODUCTION_ADMIN_EMAIL,
    allowedOrigins,
    corsAllowsAllOrigins: false,
    requireAppCheck: process.env.REQUIRE_APP_CHECK !== "false",
  };
}

export function getRuntimeConfig(): RuntimeConfig {
  if (!cachedConfig) {
    cachedConfig = loadRuntimeConfig();
    appLogger.info("Runtime configuration validated.", {
      adminEmailConfigured: true,
      allowedOriginsCount: cachedConfig.allowedOrigins.length,
      corsMode: "allowlist",
      appCheckRequired: cachedConfig.requireAppCheck,
    });
  }

  return cachedConfig;
}
