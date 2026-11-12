import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const examplePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../examples/services.manifest.json",
);

describe("services manifest example", () => {
  it("должен назвать переменную секрета и не хранить значение", async () => {
    const raw = await readFile(examplePath, "utf8");
    expect(raw).not.toContain("Bearer ");
    expect(raw).not.toContain("sk-");
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toMatchObject({
      contract: "harness.services.v1",
      services: [
        {
          id: "files",
          base_url: "http://127.0.0.1:8091/",
          auth: { type: "bearer", env: "FILE_SERVICE_TOKEN" },
          tools: [
            { name: "read_file", effect: "read" },
            { name: "list_dir", effect: "read" },
            { name: "record_note", effect: "write" },
          ],
        },
      ],
    });
  });
});
