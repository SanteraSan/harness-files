import pino from "pino";

export const logger = pino({
  level: "info",
  redact: {
    paths: [
      "DATABASE_URL",
      "databaseUrl",
      "FILE_SERVICE_TOKEN",
      "authorization",
      "Authorization",
      "req.headers.authorization",
      "password",
    ],
    censor: "[redacted]",
  },
  serializers: {
    err(error: unknown): { type: string; code: string } {
      return {
        type: error instanceof Error ? error.name : "unknown",
        code: errorCode(error),
      };
    },
  },
});

export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) {
      return code;
    }
  }
  return "unknown";
}
