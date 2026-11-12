/* Запись только внутри FILE_ROOT/out. Симлинк на месте out — ошибка. */
/* eslint-disable security/detect-non-literal-fs-filename -- путь после тюрьмы, литерал невозможен */
import { type Stats } from "node:fs";
import { lstat, mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";

import { errorCode, isInsideRoot, resolveInsideRoot } from "./jail.js";
import { ToolError } from "./tool-error.js";

const OUT_DIR = "out";
const NOTE_BYTES = 64 * 1024;

export interface NotePlan {
  relative: string;
  parentReal: string;
  fileName: string;
  text: string;
}

export function assertNoteShape(userPath: string, text: string): string[] {
  if (Buffer.byteLength(text, "utf8") > NOTE_BYTES) {
    throw new ToolError("too_large", "file too large");
  }
  return noteSegments(userPath);
}

/** Есть ли уже конечный файл. Каталоги не создаёт. */
export async function lookupNote(
  fileRoot: string,
  segments: readonly string[],
): Promise<"absent" | "present"> {
  const rootReal = await resolveInsideRoot(fileRoot, ".");
  const outLexical = path.join(rootReal, OUT_DIR);
  const outInfo = await lstatIfExists(outLexical);
  if (outInfo === null) {
    return "absent";
  }
  if (outInfo.isSymbolicLink() || !outInfo.isDirectory()) {
    throw new ToolError("forbidden", "path escapes root");
  }
  const outReal = await resolveInsideRoot(rootReal, OUT_DIR);
  if (outReal !== outLexical) {
    throw new ToolError("forbidden", "path escapes root");
  }
  const inside = segments.slice(1);
  const fileName = inside[inside.length - 1];
  if (fileName === undefined) {
    throw new ToolError("invalid_args", "invalid arguments");
  }
  let parent = outReal;
  let relative = "";
  for (const directory of inside.slice(0, -1)) {
    const dirInfo = await lstatIfExists(path.join(parent, directory));
    if (dirInfo === null) {
      return "absent";
    }
    if (dirInfo.isSymbolicLink()) {
      throw new ToolError("forbidden", "path escapes root");
    }
    if (!dirInfo.isDirectory()) {
      throw new ToolError("invalid_args", "not a file");
    }
    relative = relative.length === 0 ? directory : `${relative}/${directory}`;
    parent = await resolveInsideRoot(outReal, relative);
  }
  const fileInfo = await lstatIfExists(path.join(parent, fileName));
  if (fileInfo === null) {
    return "absent";
  }
  if (fileInfo.isSymbolicLink()) {
    throw new ToolError("forbidden", "path escapes root");
  }
  if (!fileInfo.isFile()) {
    throw new ToolError("invalid_args", "not a file");
  }
  return "present";
}

export async function prepareNote(
  fileRoot: string,
  userPath: string,
  text: string,
): Promise<NotePlan> {
  if (Buffer.byteLength(text, "utf8") > NOTE_BYTES) {
    throw new ToolError("too_large", "file too large");
  }
  const segments = noteSegments(userPath);
  const outReal = await openOut(fileRoot);
  const inside = segments.slice(1);
  const fileName = inside[inside.length - 1];
  if (fileName === undefined) {
    throw new ToolError("invalid_args", "invalid arguments");
  }
  let parent = outReal;
  let relative = "";
  for (const directory of inside.slice(0, -1)) {
    relative = relative.length === 0 ? directory : `${relative}/${directory}`;
    await mkdirIfMissing(path.join(parent, directory));
    parent = await resolveInsideRoot(outReal, relative);
    const info = await stat(parent);
    if (!info.isDirectory()) {
      throw new ToolError("invalid_args", "not a file");
    }
  }
  return {
    relative: segments.join("/"),
    parentReal: parent,
    fileName,
    text,
  };
}

export async function noteExists(plan: NotePlan): Promise<boolean> {
  try {
    const real = await resolveInsideRoot(plan.parentReal, plan.fileName);
    const info = await stat(real);
    if (!info.isFile()) {
      throw new ToolError("invalid_args", "not a file");
    }
    return true;
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Файл создаётся флагом wx и сбрасывается на диск до ответа вызывающему.
 * Уже существующий файл эта функция не открывает.
 */
export async function writeNote(plan: NotePlan): Promise<void> {
  const target = path.join(plan.parentReal, plan.fileName);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, "wx");
    await handle.writeFile(plan.text, "utf8");
    await handle.sync();
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new ToolError("conflict", "file exists");
    }
    throw error;
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
  const directory = await open(plan.parentReal, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  try {
    const real = await resolveInsideRoot(plan.parentReal, plan.fileName);
    const root = await resolveInsideRoot(plan.parentReal, ".");
    if (!isInsideRoot(root, real)) {
      throw new ToolError("forbidden", "path escapes root");
    }
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
}

function noteSegments(userPath: string): string[] {
  if (userPath.length === 0 || userPath.length > 4096 || userPath.includes("\0")) {
    throw new ToolError("invalid_args", "invalid arguments");
  }
  if (path.isAbsolute(userPath) || path.win32.isAbsolute(userPath)) {
    throw new ToolError("forbidden", "path escapes root");
  }
  const segments: string[] = [];
  let current = "";
  for (const char of userPath) {
    if (char === "/" || char === "\\") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  if (segments.length < 2 || segments[0] !== OUT_DIR) {
    throw new ToolError("forbidden", "path escapes root");
  }
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment.length > 255 ||
      segment === "." ||
      segment === ".." ||
      segment === ".record-note"
    ) {
      throw new ToolError("forbidden", "path escapes root");
    }
  }
  return segments;
}

async function openOut(fileRoot: string): Promise<string> {
  const rootReal = await resolveInsideRoot(fileRoot, ".");
  const outLexical = path.join(rootReal, OUT_DIR);
  let info = await lstatIfExists(outLexical);
  if (info !== null && info.isSymbolicLink()) {
    throw new ToolError("forbidden", "path escapes root");
  }
  if (info === null) {
    await mkdirIfMissing(outLexical);
    info = await lstatIfExists(outLexical);
  }
  if (info === null || info.isSymbolicLink() || !info.isDirectory()) {
    throw new ToolError("forbidden", "path escapes root");
  }
  const outReal = await resolveInsideRoot(rootReal, OUT_DIR);
  if (outReal !== outLexical) {
    throw new ToolError("forbidden", "path escapes root");
  }
  return outReal;
}

async function mkdirIfMissing(directory: string): Promise<void> {
  try {
    await mkdir(directory);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
}

async function lstatIfExists(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}
