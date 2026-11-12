/* Временный каталог теста не бывает литералом. */
/* eslint-disable security/detect-non-literal-fs-filename -- путь корня создаётся в tmp, не приходит от модели */
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { canonicalSha256 } from "../src/canonical.js";
import { loadConfig, type ServiceConfig } from "../src/config.js";
import { assertTestDatabase, createSql, type Sql } from "../src/db.js";
import { countIdempotency } from "../src/idempotency.js";
import { startFileService, type RunningService } from "../src/http.js";

const TOKEN = "test-secret-value";
const RUN_ID = "00000000-0000-4000-8000-000000000010";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const NONCE = "00000000-0000-4000-8000-0000000000aa";

const databaseUrl = process.env.FILE_SERVICE_TEST_DATABASE_URL ?? "";
if (databaseUrl.length === 0) {
  throw new Error("FILE_SERVICE_TEST_DATABASE_URL is required");
}
assertTestDatabase(databaseUrl);

describe("file service", () => {
  let root = "";
  let outside = "";
  let sibling = "";
  let service: RunningService;
  let sql: Sql;
  let base = "";

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "harness-files-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    sibling = path.join(base, "root-evil");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(sibling, { recursive: true });
    const config: ServiceConfig = {
      ...loadConfig({
        DATABASE_URL: databaseUrl,
        FILE_ROOT: root,
        FILE_SERVICE_TOKEN: TOKEN,
        FILE_SERVICE_HOST: "127.0.0.1",
        FILE_SERVICE_PORT: "9",
        SERVICE_ID: "files",
      }),
      port: 0,
      fileRoot: root,
    };
    service = await startFileService(config);
    activeUrl = service.url;
    sql = createSql(databaseUrl);
  });

  beforeEach(async () => {
    await sql`delete from tool_idempotency`;
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await rm(outside, { recursive: true, force: true });
    await mkdir(outside, { recursive: true });
    await rm(sibling, { recursive: true, force: true });
    await mkdir(sibling, { recursive: true });
  });

  afterAll(async () => {
    await service.close();
    await sql.end({ timeout: 5 });
    await rm(base, { recursive: true, force: true });
  });

  it("должен ответить на health без секрета", async () => {
    const response = await fetch(`${service.url}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("должен отказать запросу без bearer", async () => {
    const response = await call("read_file", { path: "a.txt" }, { token: null });
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain(TOKEN);
    expect(JSON.parse(body)).toEqual({ reason: "unauthorized" });
  });

  it("должен прочитать файл внутри корня", async () => {
    await writeFile(path.join(root, "note.txt"), "привет", "utf8");
    const response = await call("read_file", { path: "note.txt" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; text: string; truncated: boolean; error?: string };
    expect(body.ok).toBe(true);
    expect(body.text).toBe("привет");
    expect(body.truncated).toBe(false);
    expect(await countIdempotency(sql)).toBe(0);
  });

  it("должен отказать симлинку наружу и соседнему каталогу", async () => {
    await writeFile(path.join(outside, "secret.txt"), "hidden", "utf8");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    await writeFile(path.join(sibling, "secret.txt"), "sibling", "utf8");

    const link = await call("read_file", { path: "leak.txt" });
    const linkBody = (await link.json()) as { ok: boolean; error: string; error_code: string };
    expect(link.status).toBe(200);
    expect(linkBody.ok).toBe(false);
    expect(linkBody.error).toBe("path escapes root");
    expect(linkBody.error_code).toBe("forbidden");

    const parent = await call("read_file", { path: "../root-evil/secret.txt" });
    const parentBody = (await parent.json()) as { ok: boolean; error_code: string };
    expect(parentBody.ok).toBe(false);
    expect(parentBody.error_code).toBe("forbidden");

    const absolute = await call("read_file", { path: path.join(outside, "secret.txt") });
    const absoluteBody = (await absolute.json()) as { ok: boolean; error_code: string };
    expect(absoluteBody.ok).toBe(false);
    expect(absoluteBody.error_code).toBe("forbidden");
  });

  it("должен обрезать list_dir на 8000 кодпоинтах", async () => {
    for (let index = 0; index < 1601; index += 1) {
      await writeFile(path.join(root, String(index).padStart(4, "0")), "x", "utf8");
    }
    const response = await call("list_dir", {});
    const body = (await response.json()) as { ok: boolean; text: string; truncated: boolean };
    expect(body.ok).toBe(true);
    expect(body.truncated).toBe(true);
    expect(codePoints(body.text)).toBeLessThanOrEqual(8000);
    expect(body.text.endsWith("\n")).toBe(false);
    expect(body.text.split("\n")).toHaveLength(1600);
  });

  it("должен записать заметку и не перезаписать существующий файл", async () => {
    const first = await call("record_note", { path: "out/a.txt", text: "one" }, { toolCallId: "call_note" });
    const created = (await first.json()) as { ok: boolean; text: string };
    expect(first.status).toBe(200);
    expect(created).toMatchObject({ ok: true, text: "wrote out/a.txt", truncated: false });
    expect(await readFile(path.join(root, "out", "a.txt"), "utf8")).toBe("one");

    const again = await call(
      "record_note",
      { path: "out/a.txt", text: "two" },
      { toolCallId: "call_other" },
    );
    const conflict = (await again.json()) as { ok: boolean; error: string; error_code: string };
    expect(again.status).toBe(200);
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toBe("file exists");
    expect(conflict.error_code).toBe("conflict");
    expect(await readFile(path.join(root, "out", "a.txt"), "utf8")).toBe("one");
  });

  it("должен вернуть сохранённый ответ на тот же ключ и то же тело", async () => {
    const first = await call("record_note", { path: "out/same.txt", text: "same" }, { toolCallId: "call_same" });
    const firstBody = await first.json();
    const second = await call("record_note", { path: "out/same.txt", text: "same" }, { toolCallId: "call_same" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(await readFile(path.join(root, "out", "same.txt"), "utf8")).toBe("same");
    expect(await countIdempotency(sql)).toBe(1);
  });

  it("должен ответить 409 на тот же ключ и другое тело", async () => {
    const first = await call("record_note", { path: "out/hash.txt", text: "alpha" }, { toolCallId: "call_hash" });
    expect(first.status).toBe(200);
    const second = await call("record_note", { path: "out/hash.txt", text: "beta" }, { toolCallId: "call_hash" });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ reason: "idempotency_conflict" });
    expect(await readFile(path.join(root, "out", "hash.txt"), "utf8")).toBe("alpha");
  });

  it("должен дописать ответ, если свой файл уже на диске, и не сделать conflict", async () => {
    const argumentsValue = { path: "out/kept.txt", text: "fresh" };
    const envelope = envelopeFor("record_note", argumentsValue, "call_kept");
    const hashed = canonicalSha256(envelope);
    if (!hashed.ok) {
      throw new Error("hash");
    }
    await mkdir(path.join(root, "out"), { recursive: true });
    await writeFile(path.join(root, "out", "kept.txt"), "kept", "utf8");
    await sql`
      insert into tool_idempotency (idempotency_key, body_sha256, state, response)
      values (${`${RUN_ID}:call_kept`}, ${hashed.sha256}, 'started', null)
    `;
    const response = await call("record_note", argumentsValue, { toolCallId: "call_kept" });
    const body = (await response.json()) as { ok: boolean; text: string; error?: string };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.text).toBe("wrote out/kept.txt");
    expect(await readFile(path.join(root, "out", "kept.txt"), "utf8")).toBe("kept");
    const info = await lstat(path.join(root, "out", "kept.txt"));
    expect(info.isSymbolicLink()).toBe(false);
  });

  it("не должен положить секрет в сохранённый ответ", async () => {
    const response = await call("record_note", { path: "out/plain.txt", text: "plain" }, { toolCallId: "call_secret" });
    expect(response.status).toBe(200);
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain(TOKEN);
    const stored = await sql<{ response: string }[]>`
      select response::text as response from tool_idempotency
    `;
    expect(stored[0]?.response ?? "").not.toContain(TOKEN);
  });
});

function envelopeFor(
  name: string,
  argumentsValue: Record<string, unknown>,
  toolCallId = "call_1",
): Record<string, unknown> {
  return {
    contract: "harness.tool.v2",
    run_id: RUN_ID,
    tool_call_id: toolCallId,
    agent_id: AGENT_ID,
    service: "files",
    name,
    arguments: argumentsValue,
    nonce: NONCE,
  };
}

async function call(
  name: string,
  argumentsValue: Record<string, unknown>,
  options: { token?: string | null; toolCallId?: string } = {},
): Promise<Response> {
  const toolCallId = options.toolCallId ?? "call_1";
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "x-contract-version": "harness.tool.v2",
  };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  }
  if (name === "record_note") {
    headers["idempotency-key"] = `"${RUN_ID}:${toolCallId}"`;
  }
  return fetch(`${currentUrl()}/v1/tools/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(envelopeFor(name, argumentsValue, toolCallId)),
  });
}

let activeUrl = "";

function currentUrl(): string {
  if (activeUrl.length === 0) {
    throw new Error("service url is empty");
  }
  return activeUrl;
}

function codePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; ) {
    const code = value.codePointAt(index);
    count += 1;
    index += code !== undefined && code > 0xffff ? 2 : 1;
  }
  return count;
}
