import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import { logger } from "./log.js";

const HOST = "127.0.0.1";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  FILE_ROOT: z.string().min(1),
  FILE_SERVICE_TOKEN: z.string().min(1),
  FILE_SERVICE_HOST: z.literal(HOST).default(HOST),
  FILE_SERVICE_PORT: z.coerce.number().int().min(1).max(65535),
  SERVICE_ID: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .default("files"),
});

export interface ServiceConfig {
  databaseUrl: string;
  fileRoot: string;
  tokenSha256: Buffer;
  host: typeof HOST;
  port: number;
  serviceId: string;
}

export class ConfigError extends Error {
  readonly code = "config_invalid";

  constructor(fields: readonly string[]) {
    super(`invalid config: ${fields.join(", ")}`);
    this.name = "ConfigError";
  }
}

/** Единственное чтение окружения. В объекте остаётся только SHA-256 токена. */
export function loadConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const parsed = envSchema.safeParse(pickEnv(env));
  if (!parsed.success) {
    throw new ConfigError(fieldNames(parsed.error.issues));
  }
  const data = parsed.data;
  if (data.FILE_SERVICE_HOST !== HOST) {
    throw new ConfigError(["FILE_SERVICE_HOST"]);
  }
  const tokenSha256 = createHash("sha256").update(data.FILE_SERVICE_TOKEN, "utf8").digest();
  return {
    databaseUrl: data.DATABASE_URL,
    fileRoot: path.resolve(data.FILE_ROOT),
    tokenSha256,
    host: HOST,
    port: data.FILE_SERVICE_PORT,
    serviceId: data.SERVICE_ID,
  };
}

/**
 * Сравниваются SHA-256, оба по 32 байта.
 * Сырой токен в журнал и в ответ не попадает.
 */
export function bearerMatches(header: string, expectedSha256: Buffer): boolean {
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return false;
  }
  const presented = header.slice(prefix.length);
  if (presented.length === 0 || presented.length > 4096) {
    return false;
  }
  const actual = createHash("sha256").update(presented, "utf8").digest();
  if (actual.length !== expectedSha256.length) {
    return false;
  }
  return timingSafeEqual(actual, expectedSha256);
}

export function logConfigReady(config: ServiceConfig): void {
  logger.info(
    { host: config.host, port: config.port, service_id: config.serviceId },
    "file service configured",
  );
}

function pickEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const raw: Record<string, string> = Object.create(null) as Record<string, string>;
  copy(raw, "DATABASE_URL", env.DATABASE_URL);
  copy(raw, "FILE_ROOT", env.FILE_ROOT);
  if (env.FILE_SERVICE_TOKEN !== undefined) {
    raw.FILE_SERVICE_TOKEN = env.FILE_SERVICE_TOKEN;
  }
  copy(raw, "FILE_SERVICE_HOST", env.FILE_SERVICE_HOST);
  copy(raw, "FILE_SERVICE_PORT", env.FILE_SERVICE_PORT);
  copy(raw, "SERVICE_ID", env.SERVICE_ID);
  return raw;
}

function copy(target: Record<string, string>, key: string, value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  const next = value.trim();
  if (next.length > 0) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: next,
      writable: true,
    });
  }
}

function fieldNames(issues: readonly { path: readonly PropertyKey[] }[]): string[] {
  const fields: string[] = [];
  for (const issue of issues) {
    const name = issue.path.length > 0 ? String(issue.path[0]) : "config";
    if (!fields.includes(name)) {
      fields.push(name);
    }
  }
  return fields.length > 0 ? fields : ["config"];
}
