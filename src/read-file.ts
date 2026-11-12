/* Чтение только пути, который resolveInsideRoot уже удержал внутри корня. */
/* eslint-disable security/detect-non-literal-fs-filename -- путь после тюрьмы, литерал невозможен */
import { open, readFile, stat } from "node:fs/promises";

import { errorCode, resolveInsideRoot } from "./jail.js";
import { ToolError } from "./tool-error.js";

const READ_LIMIT_BYTES = 64 * 1024;

export async function readFileText(
  fileRoot: string,
  userPath: string,
): Promise<{ text: string; truncated: boolean }> {
  const real = await resolveInsideRoot(fileRoot, userPath);
  let info;
  try {
    info = await stat(real);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new ToolError("not_found", "not found");
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new ToolError("invalid_args", "not a file");
  }
  if (info.size > READ_LIMIT_BYTES) {
    const handle = await open(real, "r");
    try {
      const buffer = Buffer.alloc(READ_LIMIT_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, READ_LIMIT_BYTES, 0);
      const text = decodeLimited(buffer.subarray(0, bytesRead), true);
      if (text === null) {
        throw new ToolError("invalid_args", "binary content");
      }
      return { text, truncated: true };
    } finally {
      await handle.close();
    }
  }
  const buffer = await readFile(real);
  const text = decodeLimited(buffer, false);
  if (text === null) {
    throw new ToolError("invalid_args", "binary content");
  }
  return { text, truncated: false };
}

function decodeLimited(bytes: Buffer, truncated: boolean): string | null {
  const body = truncated ? trimIncompleteTail(bytes) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

function trimIncompleteTail(bytes: Buffer): Buffer {
  const length = bytes.length;
  const window = Math.min(4, length);
  for (let back = 1; back <= window; back += 1) {
    const index = length - back;
    const byte = bytes.readUInt8(index);
    if ((byte & 0xc0) === 0x80) {
      continue;
    }
    const needed = utf8LeadLength(byte);
    if (needed === 0 || back < needed) {
      return bytes.subarray(0, index);
    }
    return bytes;
  }
  return bytes.subarray(0, Math.max(0, length - 3));
}

function utf8LeadLength(lead: number): number {
  if ((lead & 0x80) === 0) {
    return 1;
  }
  if ((lead & 0xe0) === 0xc0) {
    return 2;
  }
  if ((lead & 0xf0) === 0xe0) {
    return 3;
  }
  if ((lead & 0xf8) === 0xf0) {
    return 4;
  }
  return 0;
}
