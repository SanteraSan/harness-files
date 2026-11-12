import { z } from "zod";

import { CONTRACT } from "./outcome.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOOL_CALL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SERVICE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const uuidSchema = z.string().regex(UUID_RE);

const requestSchema = z
  .object({
    contract: z.literal(CONTRACT),
    run_id: uuidSchema,
    tool_call_id: z.string().regex(TOOL_CALL_ID_RE),
    agent_id: uuidSchema,
    service: z.string().regex(SERVICE_ID_RE),
    name: z.string().regex(TOOL_NAME_RE),
    arguments: z.custom<Record<string, unknown>>((value) => isPlainObject(value)),
    nonce: uuidSchema,
  })
  .strict();

export interface ParsedRequest {
  runId: string;
  toolCallId: string;
  agentId: string;
  service: string;
  name: string;
  args: Record<string, unknown>;
  nonce: string;
}

export type RejectReason =
  | "invalid_body"
  | "unknown_field"
  | "unsupported_version"
  | "unknown_tool";

export function parseRequest(value: unknown): { ok: true; value: ParsedRequest } | { ok: false; reason: RejectReason } {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "invalid_body" };
  }
  if (Object.hasOwn(value, "contract") && value.contract !== CONTRACT) {
    return { ok: false, reason: "unsupported_version" };
  }
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: issueReason(parsed.error.issues) };
  }
  return {
    ok: true,
    value: {
      runId: parsed.data.run_id,
      toolCallId: parsed.data.tool_call_id,
      agentId: parsed.data.agent_id,
      service: parsed.data.service,
      name: parsed.data.name,
      args: parsed.data.arguments,
      nonce: parsed.data.nonce,
    },
  };
}

export function codePointLength(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; ) {
    const code = value.codePointAt(index);
    count += 1;
    index += code !== undefined && code > 0xffff ? 2 : 1;
  }
  return count;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export interface IdempotencyHeader {
  status: "absent" | "invalid" | "present";
  key?: string;
  runId?: string;
  toolCallId?: string;
}

/** Ровно одна quoted-string `<run_id>:<tool_call_id>`. Повтор и параметры — invalid. */
export function parseIdempotencyHeader(value: string | undefined): IdempotencyHeader {
  if (value === undefined) {
    return { status: "absent" };
  }
  if (value.length < 4 || value.length > 200 || !value.startsWith('"') || !value.endsWith('"')) {
    return { status: "invalid" };
  }
  const inner = value.slice(1, -1);
  const colon = inner.indexOf(":");
  if (colon <= 0) {
    return { status: "invalid" };
  }
  const runId = inner.slice(0, colon);
  const toolCallId = inner.slice(colon + 1);
  if (toolCallId.includes(":") || !UUID_RE.test(runId) || !TOOL_CALL_ID_RE.test(toolCallId)) {
    return { status: "invalid" };
  }
  return { status: "present", key: `${runId}:${toolCallId}`, runId, toolCallId };
}

export function decodeToolName(segment: string): string | null {
  if (segment.length === 0 || segment.length > 256 || segment.includes("/") || segment.includes("%2f") || segment.includes("%2F")) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > 64 || decoded === "." || decoded === "..") {
    return null;
  }
  if (!TOOL_NAME_RE.test(decoded)) {
    return null;
  }
  return decoded;
}

function issueReason(issues: readonly { code: string }[]): RejectReason {
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      return "unknown_field";
    }
  }
  return "invalid_body";
}
