/* Каталог миграций — путь пакета, не путь модели. */
/* eslint-disable security/detect-non-literal-fs-filename -- имя файла миграции литералом в readdir не задаётся */
import { readdir } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

import { errorCode } from "./log.js";

export type Sql = postgres.Sql;

export class DatabaseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}

export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: "harness-files",
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 15_000,
    },
    onnotice() {
      return undefined;
    },
  });
}

export function migrationsDirectory(): string {
  return path.resolve(import.meta.dirname, "../migrations");
}

/** Имя базы. Пароль и пользователь в результат не входят. */
export function databaseName(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new DatabaseError("invalid_database_url", "database url is invalid");
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (name.length === 0 || name.includes("/")) {
    throw new DatabaseError("invalid_database_url", "database url is invalid");
  }
  return name;
}

export function assertTestDatabase(databaseUrl: string): string {
  const name = databaseName(databaseUrl);
  if (!name.endsWith("_test")) {
    throw new DatabaseError("test_database_refused", "test database name must end with _test");
  }
  return name;
}

export async function applyMigrations(sql: Sql, migrationsDir: string): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      version text primary key
    )
  `;
  const names = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  for (const fileName of names) {
    const version = fileName;
    const existing = await sql<{ version: string }[]>`
      select version from schema_migrations where version = ${version}
    `;
    if (existing.length > 0) {
      continue;
    }
    const filePath = path.join(migrationsDir, fileName);
    await sql.begin(async (tx) => {
      await tx.file(filePath);
      await tx`insert into schema_migrations (version) values (${version})`;
    });
  }
}

export function postgresErrorCode(error: unknown): string | null {
  const code = errorCode(error);
  return code === "unknown" ? null : code;
}
