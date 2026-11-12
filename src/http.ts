import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { canonicalSha256, parseJson } from "./canonical.js";
import { bearerMatches, type ServiceConfig } from "./config.js";
import { applyMigrations, createSql, migrationsDirectory, type Sql } from "./db.js";
import {
  codePointLength,
  decodeToolName,
  isPlainObject,
  parseIdempotencyHeader,
  parseRequest,
} from "./envelope.js";
import { claimWrite, finishWrite, purgeExpired } from "./idempotency.js";
import { listDirectory } from "./list-dir.js";
import { logger } from "./log.js";
import { failureBody, successBody, type Echo, type ToolBody } from "./outcome.js";
import { readFileText } from "./read-file.js";
import {
  assertNoteShape,
  lookupNote,
  prepareNote,
  writeNote,
} from "./record-note.js";
import { ToolError } from "./tool-error.js";

const BODY_LIMIT = 32 * 1024;
const KNOWN_TOOLS = new Set(["read_file", "list_dir", "record_note"]);

export interface RunningService {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startFileService(config: ServiceConfig): Promise<RunningService> {
  if (config.host !== "127.0.0.1") {
    throw new Error("file service listens on 127.0.0.1");
  }
  const sql = createSql(config.databaseUrl);
  await applyMigrations(sql, migrationsDirectory());
  const server = createServer((req, res) => {
    void handle(req, res, config, sql);
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on("error", (error) => {
    logger.error({ err: error }, "http server error");
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  await listen(server, config.port);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await sql.end({ timeout: 5 });
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServiceConfig,
  sql: Sql,
): Promise<void> {
  try {
    await route(req, res, config, sql);
  } catch (error) {
    logger.error({ err: error }, "request failed");
    if (!res.headersSent) {
      sendJson(res, 400, { reason: "invalid_body" });
    }
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServiceConfig,
  sql: Sql,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health" && url.search === "") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (!authorized(req, config)) {
    sendJson(res, 401, { reason: "unauthorized" });
    return;
  }
  if (req.method !== "POST" || !url.pathname.startsWith("/v1/tools/")) {
    sendJson(res, 404, { reason: "unknown_tool" });
    return;
  }
  const segment = url.pathname.slice("/v1/tools/".length);
  const toolName = decodeToolName(segment);
  if (toolName === null || !KNOWN_TOOLS.has(toolName)) {
    sendJson(res, 404, { reason: "unknown_tool" });
    return;
  }
  if (!jsonContentType(singleHeader(req, "content-type"))) {
    sendJson(res, 400, { reason: "invalid_body" });
    return;
  }
  const versionHeaders = headerValues(req, "x-contract-version");
  if (versionHeaders.length !== 1 || versionHeaders[0] !== "harness.tool.v2") {
    sendJson(res, 400, { reason: "unsupported_version" });
    return;
  }
  const body = await readBody(req);
  if (!body.ok) {
    sendJson(res, body.reason === "payload_too_large" ? 413 : 400, { reason: body.reason });
    return;
  }
  const decoded = parseJsonValue(body.text);
  if (!decoded.ok) {
    sendJson(res, decoded.reason === "payload_too_large" ? 413 : 400, { reason: decoded.reason });
    return;
  }
  const request = parseRequest(decoded.value);
  if (!request.ok) {
    const status = request.reason === "unknown_tool" ? 404 : 400;
    sendJson(res, status, { reason: request.reason });
    return;
  }
  if (request.value.name !== toolName || request.value.service !== config.serviceId) {
    sendJson(res, 400, { reason: "invalid_body" });
    return;
  }
  const idempotencyValues = headerValues(req, "idempotency-key");
  if (idempotencyValues.length > 1) {
    sendJson(res, 400, { reason: "invalid_body" });
    return;
  }
  const idempotency = parseIdempotencyHeader(idempotencyValues[0]);
  if (idempotency.status === "invalid") {
    sendJson(res, 400, { reason: "invalid_body" });
    return;
  }
  if (
    idempotency.status === "present" &&
    (idempotency.runId !== request.value.runId || idempotency.toolCallId !== request.value.toolCallId)
  ) {
    sendJson(res, 400, { reason: "invalid_body" });
    return;
  }
  const started = performance.now();
  const echo: Echo = {
    nonce: request.value.nonce,
    runId: request.value.runId,
    toolCallId: request.value.toolCallId,
  };
  const hash = canonicalSha256({
    arguments: request.value.args,
    agent_id: request.value.agentId,
    contract: "harness.tool.v2",
    name: request.value.name,
    nonce: request.value.nonce,
    run_id: request.value.runId,
    service: request.value.service,
    tool_call_id: request.value.toolCallId,
  });
  if (!hash.ok) {
    sendJson(res, 400, { reason: hash.reason });
    return;
  }
  logger.info({ run_id: echo.runId, tool: toolName }, "tool call");
  if (toolName === "record_note") {
    if (idempotency.status !== "present" || idempotency.key === undefined) {
      sendJson(res, 400, { reason: "invalid_body" });
      return;
    }
    await record(res, config, sql, echo, request.value.args, idempotency.key, hash.sha256, started);
    return;
  }
  await readTool(res, config, toolName, echo, request.value.args, started);
}

async function readTool(
  res: ServerResponse,
  config: ServiceConfig,
  toolName: string,
  echo: Echo,
  args: Record<string, unknown>,
  started: number,
): Promise<void> {
  const checked = toolName === "read_file" ? readArguments(args) : listArguments(args);
  if (!checked.ok) {
    sendJson(res, checked.status, { reason: checked.reason });
    return;
  }
  try {
    if (toolName === "read_file") {
      const loaded = await readFileText(config.fileRoot, checked.path);
      sendJson(res, 200, successBody(echo, loaded.text, loaded.truncated, elapsed(started)));
      return;
    }
    const listed = await listDirectory(config.fileRoot, checked.path);
    sendJson(res, 200, successBody(echo, listed.text, listed.truncated, elapsed(started)));
  } catch (error) {
    sendJson(res, 200, toolFailure(echo, error, elapsed(started)));
  }
}

async function record(
  res: ServerResponse,
  config: ServiceConfig,
  sql: Sql,
  echo: Echo,
  args: Record<string, unknown>,
  key: string,
  hash: Buffer,
  started: number,
): Promise<void> {
  const checked = noteArguments(args);
  if (!checked.ok) {
    sendJson(res, checked.status, { reason: checked.reason });
    return;
  }
  let segments: string[];
  try {
    segments = assertNoteShape(checked.path, checked.text);
  } catch (error) {
    sendJson(res, 200, toolFailure(echo, error, elapsed(started)));
    return;
  }
  let presence: "absent" | "present";
  try {
    presence = await lookupNote(config.fileRoot, segments);
  } catch (error) {
    sendJson(res, 200, toolFailure(echo, error, elapsed(started)));
    return;
  }
  await purgeExpired(sql);
  const occupied = failureBody(echo, "file exists", "conflict", elapsed(started));
  const claimed = await claimWrite(sql, key, hash, presence === "present", occupied);
  if (claimed.kind === "busy") {
    sendJson(res, 409, { reason: "idempotency_in_progress" });
    return;
  }
  if (claimed.kind === "conflict") {
    sendJson(res, 409, { reason: "idempotency_conflict" });
    return;
  }
  if (claimed.kind === "done") {
    sendJson(res, 200, claimed.body);
    return;
  }
  const relative = segments.join("/");
  let body: ToolBody;
  try {
    const again = await lookupNote(config.fileRoot, segments);
    if (again === "present") {
      body = successBody(echo, `wrote ${relative}`, false, elapsed(started));
    } else {
      const plan = await prepareNote(config.fileRoot, checked.path, checked.text);
      try {
        await writeNote(plan);
      } catch (error) {
        if (!(error instanceof ToolError) || error.errorCode !== "conflict") {
          throw error;
        }
      }
      body = successBody(echo, `wrote ${relative}`, false, elapsed(started));
    }
  } catch (error) {
    body = toolFailure(echo, error, elapsed(started));
  }
  const finished = await finishWrite(sql, key, hash, body);
  if (finished.kind === "busy") {
    sendJson(res, 409, { reason: "idempotency_in_progress" });
    return;
  }
  if (finished.kind === "conflict") {
    sendJson(res, 409, { reason: "idempotency_conflict" });
    return;
  }
  if (finished.kind !== "done") {
    sendJson(res, 409, { reason: "idempotency_in_progress" });
    return;
  }
  sendJson(res, 200, finished.body);
}

function toolFailure(echo: Echo, error: unknown, durationMs: number): ToolBody {
  if (error instanceof ToolError) {
    return failureBody(echo, error.message, error.errorCode, durationMs);
  }
  return failureBody(echo, "internal", "internal", durationMs);
}

type ArgsOk = { ok: true; path: string; text?: string };
type ArgsBad = { ok: false; status: 400; reason: "invalid_body" | "unknown_field" };

function readArguments(args: Record<string, unknown>): ArgsOk | ArgsBad {
  const extra = rejectArguments(args, ["path"]);
  if (extra !== null) {
    return extra;
  }
  const pathValue = args.path;
  if (typeof pathValue !== "string" || !bounded(pathValue, 1, 4096)) {
    return { ok: false, status: 400, reason: "invalid_body" };
  }
  return { ok: true, path: pathValue };
}

function listArguments(args: Record<string, unknown>): ArgsOk | ArgsBad {
  const extra = rejectArguments(args, ["path"]);
  if (extra !== null) {
    return extra;
  }
  if (!Object.hasOwn(args, "path")) {
    return { ok: true, path: "." };
  }
  const pathValue = args.path;
  if (typeof pathValue !== "string" || !bounded(pathValue, 1, 4096)) {
    return { ok: false, status: 400, reason: "invalid_body" };
  }
  return { ok: true, path: pathValue };
}

function noteArguments(
  args: Record<string, unknown>,
): { ok: true; path: string; text: string } | ArgsBad {
  const extra = rejectArguments(args, ["path", "text"]);
  if (extra !== null) {
    return extra;
  }
  const pathValue = args.path;
  const text = args.text;
  if (typeof pathValue !== "string" || !bounded(pathValue, 1, 4096)) {
    return { ok: false, status: 400, reason: "invalid_body" };
  }
  if (typeof text !== "string" || !bounded(text, 1, 12085)) {
    return { ok: false, status: 400, reason: "invalid_body" };
  }
  return { ok: true, path: pathValue, text };
}

function rejectArguments(args: Record<string, unknown>, allowed: readonly string[]): ArgsBad | null {
  if (!isPlainObject(args)) {
    return { ok: false, status: 400, reason: "invalid_body" };
  }
  for (const key of Object.keys(args)) {
    if (key === "idempotency_key" || key === "__proto__" || key === "constructor" || key === "prototype") {
      return { ok: false, status: 400, reason: "unknown_field" };
    }
    if (!allowed.includes(key)) {
      return { ok: false, status: 400, reason: "unknown_field" };
    }
  }
  return null;
}

function bounded(value: string, min: number, max: number): boolean {
  const length = codePointLength(value);
  return length >= min && length <= max;
}

function elapsed(started: number): number {
  return performance.now() - started;
}

function authorized(req: IncomingMessage, config: ServiceConfig): boolean {
  const values = headerValues(req, "authorization");
  if (values.length !== 1) {
    return false;
  }
  const header = values[0];
  if (header === undefined) {
    return false;
  }
  return bearerMatches(header, config.tokenSha256);
}

function jsonContentType(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const parts = value.split(";").map((part) => part.trim().toLowerCase());
  if (parts[0] !== "application/json") {
    return false;
  }
  for (const part of parts.slice(1)) {
    if (part.length > 0 && part !== "charset=utf-8") {
      return false;
    }
  }
  return true;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const values = headerValues(req, name);
  return values.length === 1 ? values[0] : undefined;
}

function headerValues(req: IncomingMessage, name: string): string[] {
  const found: string[] = [];
  const raw = req.rawHeaders;
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw.at(index);
    const value = raw.at(index + 1);
    if (key !== undefined && value !== undefined && key.toLowerCase() === name) {
      found.push(value);
    }
  }
  return found;
}

function chunkBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }
  return new Uint8Array();
}

async function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; text: string } | { ok: false; reason: "invalid_body" | "payload_too_large" }> {
  const declared = req.headers["content-length"];
  if (typeof declared === "string") {
    if (!/^[0-9]{1,10}$/.test(declared)) {
      return { ok: false, reason: "invalid_body" };
    }
    if (Number(declared) > BODY_LIMIT) {
      return { ok: false, reason: "payload_too_large" };
    }
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunkBytes(chunk);
    total += buffer.byteLength;
    if (total > BODY_LIMIT) {
      return { ok: false, reason: "payload_too_large" };
    }
    chunks.push(buffer);
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, reason: "invalid_body" };
  }
}

function parseJsonValue(
  text: string,
): { ok: true; value: unknown } | { ok: false; reason: "invalid_body" | "unknown_field" | "payload_too_large" } {
  const parsed = parseJson(text, BODY_LIMIT);
  if (!parsed.ok || parsed.value === undefined) {
    return { ok: false, reason: parsed.ok ? "invalid_body" : parsed.reason };
  }
  return { ok: true, value: parsed.value };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}
