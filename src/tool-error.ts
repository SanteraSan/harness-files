export const ERROR_CODES = [
  "invalid_args",
  "not_found",
  "forbidden",
  "too_large",
  "conflict",
  "unavailable",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ToolError extends Error {
  readonly errorCode: ErrorCode;

  constructor(errorCode: ErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
    this.errorCode = errorCode;
  }
}
