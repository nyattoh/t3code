import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades 56 to durable Jev request digests without changing existing receipts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 56 });
    yield* sql`INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
      VALUES ('existing', 'thread', 'thread', 'message.dispatch', '2026-10-04T00:00:00.000Z', 1, 'accepted', NULL)`;
    yield* runMigrations({ toMigrationInclusive: 57 });
    yield* sql`INSERT INTO jev_execution_requests (command_id, request_digest) VALUES ('existing', 'digest')`;
    yield* runMigrations({ toMigrationInclusive: 57 });
    const receipts = yield* sql<{
      status: string;
      result_sequence: number;
    }>`SELECT status, result_sequence FROM orchestration_command_receipts WHERE command_id = 'existing'`;
    assert.equal(receipts[0]?.status, "accepted");
    assert.equal(receipts[0]?.result_sequence, 1);
    const digests = yield* sql<{
      request_digest: string;
    }>`SELECT request_digest FROM jev_execution_requests WHERE command_id = 'existing'`;
    assert.equal(digests[0]?.request_digest, "digest");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
