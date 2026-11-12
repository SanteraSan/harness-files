import type { ErrorCode } from "./tool-error.js";

export const CONTRACT = "harness.tool.v2";

export interface Echo {
  nonce: string;
  runId: string;
  toolCallId: string;
}

export interface ToolSuccess {
  contract: typeof CONTRACT;
  ok: true;
  text: string;
  truncated: boolean;
  duration_ms: number;
  blobs: [];
  nonce: string;
  run_id: string;
  tool_call_id: string;
}

export interface ToolFailureBody {
  contract: typeof CONTRACT;
  ok: false;
  error: string;
  error_code: ErrorCode;
  truncated: false;
  duration_ms: number;
  blobs: [];
  nonce: string;
  run_id: string;
  tool_call_id: string;
}

export type ToolBody = ToolSuccess | ToolFailureBody;

export function successBody(
  echo: Echo,
  text: string,
  truncated: boolean,
  durationMs: number,
): ToolSuccess {
  return {
    contract: CONTRACT,
    ok: true,
    text,
    truncated,
    duration_ms: clampDuration(durationMs),
    blobs: [],
    nonce: echo.nonce,
    run_id: echo.runId,
    tool_call_id: echo.toolCallId,
  };
}

export function failureBody(
  echo: Echo,
  error: string,
  errorCode: ErrorCode,
  durationMs: number,
): ToolFailureBody {
  return {
    contract: CONTRACT,
    ok: false,
    error,
    error_code: errorCode,
    truncated: false,
    duration_ms: clampDuration(durationMs),
    blobs: [],
    nonce: echo.nonce,
    run_id: echo.runId,
    tool_call_id: echo.toolCallId,
  };
}

function clampDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return 0;
  }
  return Math.min(600_000, Math.round(durationMs));
}
