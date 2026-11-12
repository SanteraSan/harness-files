import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, logConfigReady } from "./config.js";
import { startFileService } from "./http.js";
import { logger } from "./log.js";

if (isMainModule(import.meta.url)) {
  try {
    const config = loadConfig(process.env);
    logConfigReady(config);
    await startFileService(config);
  } catch (error) {
    logger.error({ err: error }, "file service stopped");
    process.exit(1);
  }
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(moduleUrl);
}
