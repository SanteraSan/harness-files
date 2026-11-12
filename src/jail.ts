/* Путь присылает модель, литерала нет. realpath и префикс с разделителем — правило I19. */
/* eslint-disable security/detect-non-literal-fs-filename -- проверка корня не выражается литералом пути */
import { realpath } from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./tool-error.js";

/**
 * realpath корня и цели, затем префикс с разделителем.
 * Без разделителя каталог с общим префиксом имени проходит проверку.
 */
export async function resolveInsideRoot(fileRoot: string, userPath: string): Promise<string> {
  if (userPath.length === 0 || userPath.length > 4096 || userPath.includes("\0")) {
    throw new ToolError("invalid_args", "invalid arguments");
  }
  const rootReal = await realpath(fileRoot);
  const resolved = path.resolve(rootReal, userPath);
  if (!isInsideRoot(rootReal, resolved)) {
    throw new ToolError("forbidden", "path escapes root");
  }
  let real: string;
  try {
    real = await realpath(resolved);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new ToolError("not_found", "not found");
    }
    throw error;
  }
  if (!isInsideRoot(rootReal, real)) {
    throw new ToolError("forbidden", "path escapes root");
  }
  return real;
}

export function isInsideRoot(rootReal: string, candidate: string): boolean {
  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  return candidate === rootReal || candidate.startsWith(prefix);
}

export function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && code.length > 0 && code.length <= 32) {
      return code;
    }
  }
  return null;
}
