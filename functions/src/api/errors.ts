import * as express from "express";
import { appLogger } from "./logging";

export class ApiError extends Error {
  statusCode: number;
  publicMessage: string;

  constructor(message: string, statusCode = 500, publicMessage = message) {
    super(message);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

export function getErrorStatusCode(error: unknown, fallbackStatusCode = 500): number {
  const statusCode = Number((error as { statusCode?: unknown })?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : fallbackStatusCode;
}

export function getClientErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof ApiError) {
    return error.publicMessage;
  }

  const statusCode = getErrorStatusCode(error);
  if (statusCode >= 500) {
    return fallbackMessage;
  }

  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" && message.trim() ? message : fallbackMessage;
}

export function sendApiError(
  res: express.Response,
  error: unknown,
  options: {
    logMessage: string;
    fallbackMessage: string;
    fallbackStatusCode?: number;
    context?: Record<string, unknown>;
    successEnvelope?: boolean;
  },
): void {
  const statusCode = getErrorStatusCode(error, options.fallbackStatusCode || 500);
  const clientMessage = getClientErrorMessage(error, options.fallbackMessage);

  appLogger.error(options.logMessage, {
    ...(options.context || {}),
    statusCode,
    error,
  });

  if (options.successEnvelope) {
    res.status(statusCode).json({ success: false, error: clientMessage });
    return;
  }

  res.status(statusCode).json({ error: clientMessage });
}

export function sendSupplierFailure(
  res: express.Response,
  error: unknown,
  options: {
    logMessage: string;
    fallbackMessage: string;
    fallbackStatusCode?: number;
    context?: Record<string, unknown>;
    includeStatus?: boolean;
  },
): void {
  const statusCode = getErrorStatusCode(error, options.fallbackStatusCode || 500);
  const clientMessage = getClientErrorMessage(error, options.fallbackMessage);

  appLogger.error(options.logMessage, {
    ...(options.context || {}),
    statusCode,
    error,
  });

  res.status(statusCode).json({
    success: false,
    ...(options.includeStatus ? { status: "Failed" } : {}),
    error: clientMessage,
  });
}
