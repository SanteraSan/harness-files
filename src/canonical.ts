import { createHash } from "node:crypto";

const MAX_DEPTH = 32;

interface Cursor {
  index: number;
}

export type CanonResult =
  | { ok: true; text: string; sha256: Buffer }
  | { ok: false; reason: "invalid_body" | "unknown_field" | "payload_too_large" };

/** Повтор ключа в одном объекте — invalid_body ещё до хеша. */
export function parseJson(raw: string, limitBytes: number): CanonResult & { value?: unknown } {
  if (Buffer.byteLength(raw, "utf8") > limitBytes) {
    return { ok: false, reason: "payload_too_large" };
  }
  if (!keysAreUnique(raw)) {
    return { ok: false, reason: "invalid_body" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "invalid_body" };
  }
  const scanned = scanValue(value, 0);
  if (scanned !== null) {
    return { ok: false, reason: scanned };
  }
  return { ok: true, text: raw, sha256: sha256(raw), value };
}

/**
 * UTF-8, без пробелов, ключи по байтам UTF-8, -0 как 0.
 * Хеш считается по этому тексту, не по сырым байтам с другим порядком ключей.
 */
export function canonicalSha256(value: unknown): CanonResult {
  const text = canonicalize(value, 0);
  if (text === null) {
    return { ok: false, reason: "invalid_body" };
  }
  return { ok: true, text, sha256: sha256(text) };
}

export function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function canonicalize(value: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) {
    return null;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const part = canonicalize(item, depth + 1);
      if (part === null) {
        return null;
      }
      parts.push(part);
    }
    return `[${parts.join(",")}]`;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const keys = Object.keys(value).sort(compareUtf8);
  const parts: string[] = [];
  for (const key of keys) {
    const inner = canonicalize(readOwn(value, key), depth + 1);
    if (inner === null) {
      return null;
    }
    parts.push(`${JSON.stringify(key)}:${inner}`);
  }
  return `{${parts.join(",")}}`;
}

function readOwn(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return undefined;
  }
  return descriptor.value;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function scanValue(value: unknown, depth: number): "invalid_body" | "unknown_field" | null {
  if (depth > MAX_DEPTH) {
    return "invalid_body";
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : "invalid_body";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = scanValue(item, depth + 1);
      if (reason !== null) {
        return reason;
      }
    }
    return null;
  }
  if (!isPlainObject(value)) {
    return "unknown_field";
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return "unknown_field";
    }
    const reason = scanValue(readOwn(value, key), depth + 1);
    if (reason !== null) {
      return reason;
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function keysAreUnique(text: string): boolean {
  const cursor: Cursor = { index: 0 };
  if (!readValue(text, cursor, 0)) {
    return false;
  }
  skipWhitespace(text, cursor);
  return cursor.index === text.length;
}

function skipWhitespace(source: string, cursor: Cursor): void {
  while (cursor.index < source.length) {
    const code = source.charCodeAt(cursor.index);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) {
      return;
    }
    cursor.index += 1;
  }
}

function readValue(source: string, cursor: Cursor, depth: number): boolean {
  if (depth > MAX_DEPTH) {
    return false;
  }
  skipWhitespace(source, cursor);
  const code = source.charCodeAt(cursor.index);
  if (code === 123) {
    return readObject(source, cursor, depth);
  }
  if (code === 91) {
    return readArray(source, cursor, depth);
  }
  if (code === 34) {
    return readString(source, cursor);
  }
  return readLiteral(source, cursor);
}

function readObject(source: string, cursor: Cursor, depth: number): boolean {
  cursor.index += 1;
  const seen = new Set<string>();
  skipWhitespace(source, cursor);
  if (source.charCodeAt(cursor.index) === 125) {
    cursor.index += 1;
    return true;
  }
  for (;;) {
    const key = readStringText(source, cursor);
    if (key === null) {
      return false;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    skipWhitespace(source, cursor);
    if (source.charCodeAt(cursor.index) !== 58) {
      return false;
    }
    cursor.index += 1;
    if (!readValue(source, cursor, depth + 1)) {
      return false;
    }
    skipWhitespace(source, cursor);
    const next = source.charCodeAt(cursor.index);
    if (next === 125) {
      cursor.index += 1;
      return true;
    }
    if (next !== 44) {
      return false;
    }
    cursor.index += 1;
    skipWhitespace(source, cursor);
  }
}

function readArray(source: string, cursor: Cursor, depth: number): boolean {
  cursor.index += 1;
  skipWhitespace(source, cursor);
  if (source.charCodeAt(cursor.index) === 93) {
    cursor.index += 1;
    return true;
  }
  for (;;) {
    if (!readValue(source, cursor, depth + 1)) {
      return false;
    }
    skipWhitespace(source, cursor);
    const next = source.charCodeAt(cursor.index);
    if (next === 93) {
      cursor.index += 1;
      return true;
    }
    if (next !== 44) {
      return false;
    }
    cursor.index += 1;
    skipWhitespace(source, cursor);
  }
}

function readLiteral(source: string, cursor: Cursor): boolean {
  const start = cursor.index;
  while (cursor.index < source.length) {
    const code = source.charCodeAt(cursor.index);
    if (code === 44 || code === 125 || code === 93 || code === 32 || code === 9 || code === 10 || code === 13) {
      break;
    }
    cursor.index += 1;
  }
  return cursor.index > start;
}

function readString(source: string, cursor: Cursor): boolean {
  return readStringText(source, cursor) !== null;
}

function readStringText(source: string, cursor: Cursor): string | null {
  if (source.charCodeAt(cursor.index) !== 34) {
    return null;
  }
  cursor.index += 1;
  let text = "";
  while (cursor.index < source.length) {
    const code = source.charCodeAt(cursor.index);
    if (code === 34) {
      cursor.index += 1;
      return text;
    }
    if (code < 0x20) {
      return null;
    }
    if (code === 92) {
      const escaped = readEscape(source, cursor);
      if (escaped === null) {
        return null;
      }
      text += escaped;
      continue;
    }
    text += String.fromCharCode(code);
    cursor.index += 1;
  }
  return null;
}

function escapedCharacter(escaped: number): string | null {
  if (escaped === 34) {
    return '"';
  }
  if (escaped === 92) {
    return "\\";
  }
  if (escaped === 47) {
    return "/";
  }
  if (escaped === 98) {
    return "\b";
  }
  if (escaped === 102) {
    return "\f";
  }
  if (escaped === 110) {
    return "\n";
  }
  if (escaped === 114) {
    return "\r";
  }
  if (escaped === 116) {
    return "\t";
  }
  return null;
}

function readEscape(source: string, cursor: Cursor): string | null {
  const escaped = source.charCodeAt(cursor.index + 1);
  if (Number.isNaN(escaped)) {
    return null;
  }
  const mapped = escapedCharacter(escaped);
  if (mapped !== null) {
    cursor.index += 2;
    return mapped;
  }
  if (escaped !== 117) {
    return null;
  }
  const hex = source.slice(cursor.index + 2, cursor.index + 6);
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
    return null;
  }
  cursor.index += 6;
  return String.fromCharCode(Number.parseInt(hex, 16));
}
