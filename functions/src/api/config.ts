import { appLogger } from "./logging";

export interface RuntimeConfig {
  adminEmail: string;
  allowedOrigins: string[];
  corsAllowsAllOrigins: boolean;
}

let cachedConfig: RuntimeConfig | null = null;

function parseAllowedOrigins(rawValue: string | undefined): string[] {
  return (rawValue || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function loadRuntimeConfig(): RuntimeConfig {
  const adminEmail = (process.env.ADMIN_EMAIL || "zyrolkofficial@gmail.com").trim().toLowerCase();

  if (!adminEmail) {
    appLogger.error("Required runtime configuration is missing.", { missing: ["ADMIN_EMAIL"] });
    throw new Error("Missing required runtime configuration: ADMIN_EMAIL");
  }

  const allowedOrigins = parseAllowedOrigins(process.env.API_ALLOWED_ORIGINS);

  return {
    adminEmail,
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
