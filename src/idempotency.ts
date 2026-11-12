import { timingSafeEqual } from "node:crypto";

import postgres from "postgres";

import type { Sql } from "./db.js";
import { postgresErrorCode } from "./db.js";
import type { ToolBody } from "./outcome.js";
import { ToolError } from "./tool-error.js";

type Transaction = postgres.TransactionSql;

export type WriteDecision =
  | { kind: "done"; body: ToolBody }
  | { kind: "conflict" }
  | { kind: "busy" }
  | { kind: "perform" };

interface StoredRow {
  body_sha256: Buffer;
  state: "started" | "done";
  response: ToolBody | null;
}

/** Удаляет не больше 20 протухших ключей. Отдельного крона нет. */
export async function purgeExpired(sql: Sql): Promise<void> {
  await sql`
    delete from tool_idempotency
    where idempotency_key in (
      select idempotency_key
      from tool_idempotency
      where created_at < now() - interval '72 hours'
      limit 20
    )
  `;
}

/**
 * Строка started коммитится до записи файла.
 * Повтор с тем же хешем и уже лежащим файлом дописывает ответ, а не conflict.
 */
export async function claimWrite(
  sql: Sql,
  key: string,
  hash: Buffer,
  occupied: boolean,
  occupiedBody: ToolBody,
): Promise<WriteDecision> {
  try {
    return await claimOnce(sql, key, hash, occupied, occupiedBody);
  } catch (error) {
    if (postgresErrorCode(error) === "55P03") {
      return { kind: "busy" };
    }
    if (postgresErrorCode(error) === "23505") {
      try {
        return await claimOnce(sql, key, hash, occupied, occupiedBody);
      } catch (retryError) {
        if (postgresErrorCode(retryError) === "55P03") {
          return { kind: "busy" };
        }
        throw retryError;
      }
    }
    throw error;
  }
}

/** Ответ сохранён и строка done. HTTP вызывающий шлёт только после этого. */
export async function finishWrite(
  sql: Sql,
  key: string,
  hash: Buffer,
  body: ToolBody,
): Promise<WriteDecision> {
  try {
    return await sql.begin(async (tx) => {
      const row = await lockRow(tx, key);
      if (row === null) {
        throw new ToolError("internal", "internal");
      }
      if (!sameHash(row.body_sha256, hash)) {
        return { kind: "conflict" };
      }
      if (row.state === "done") {
        if (row.response === null) {
          throw new ToolError("internal", "internal");
        }
        return { kind: "done", body: row.response };
      }
      await tx`
        update tool_idempotency
        set state = 'done', response = ${tx.json(asJson(body))}
        where idempotency_key = ${key}
          and state = 'started'
      `;
      return { kind: "done", body };
    });
  } catch (error) {
    if (postgresErrorCode(error) === "55P03") {
      return { kind: "busy" };
    }
    throw error;
  }
}

export async function countIdempotency(sql: Sql): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from tool_idempotency
  `;
  return Number(rows[0]?.count ?? "0");
}

async function claimOnce(
  sql: Sql,
  key: string,
  hash: Buffer,
  occupied: boolean,
  occupiedBody: ToolBody,
): Promise<WriteDecision> {
  return sql.begin(async (tx) => {
    const row = await lockRow(tx, key);
    if (row === null) {
      if (occupied) {
        await insertDone(tx, key, hash, occupiedBody);
        return { kind: "done", body: occupiedBody };
      }
      await tx`
        insert into tool_idempotency (idempotency_key, body_sha256, state, response)
        values (${key}, ${hash}, 'started', null)
      `;
      return { kind: "perform" };
    }
    if (!sameHash(row.body_sha256, hash)) {
      return { kind: "conflict" };
    }
    if (row.state === "done") {
      if (row.response === null) {
        throw new ToolError("internal", "internal");
      }
      return { kind: "done", body: row.response };
    }
    return { kind: "perform" };
  });
}

async function lockRow(tx: Transaction, key: string): Promise<StoredRow | null> {
  const rows = await tx<StoredRow[]>`
    select body_sha256, state, response
    from tool_idempotency
    where idempotency_key = ${key}
    for update nowait
  `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    body_sha256: Buffer.from(row.body_sha256),
    state: row.state,
    response: row.response,
  };
}

async function insertDone(
  tx: Transaction,
  key: string,
  hash: Buffer,
  body: ToolBody,
): Promise<void> {
  await tx`
    insert into tool_idempotency (idempotency_key, body_sha256, state, response)
    values (${key}, ${hash}, 'done', ${tx.json(asJson(body))})
  `;
}

function asJson(body: ToolBody): postgres.JSONValue {
  return JSON.parse(JSON.stringify(body)) as postgres.JSONValue;
}

function sameHash(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length || left.length !== 32) {
    return false;
  }
  return timingSafeEqual(left, right);
}
