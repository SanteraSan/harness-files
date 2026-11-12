/* Список только каталога, который resolveInsideRoot уже удержал внутри корня. */
/* eslint-disable security/detect-non-literal-fs-filename -- путь после тюрьмы, литерал невозможен */
import { readdir, stat } from "node:fs/promises";

import { errorCode, resolveInsideRoot } from "./jail.js";
import { ToolError } from "./tool-error.js";

const LIST_DIR_TEXT_CODE_POINTS = 8000;

export async function listDirectory(
  fileRoot: string,
  userPath: string | undefined,
): Promise<{ text: string; truncated: boolean }> {
  const real = await resolveInsideRoot(fileRoot, userPath ?? ".");
  let info;
  try {
    info = await stat(real);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new ToolError("not_found", "not found");
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new ToolError("invalid_args", "not a file");
  }
  const dirents = await readdir(real, { withFileTypes: true });
  const entries: { name: string; line: string }[] = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    const line = dirent.isSymbolicLink() || !dirent.isDirectory() ? name : `${name}/`;
    entries.push({ name, line });
  }
  entries.sort((left, right) => compareNames(left.name, right.name));
  const lines = entries.map((entry) => entry.line);
  return boundLines(lines);
}

function boundLines(lines: readonly string[]): { text: string; truncated: boolean } {
  let text = "";
  for (const line of lines) {
    const next = text.length === 0 ? line : `${text}\n${line}`;
    if (codePointLength(next) > LIST_DIR_TEXT_CODE_POINTS) {
      return { text, truncated: true };
    }
    text = next;
  }
  return { text, truncated: false };
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; ) {
    const code = value.codePointAt(index);
    count += 1;
    index += code !== undefined && code > 0xffff ? 2 : 1;
  }
  return count;
}
