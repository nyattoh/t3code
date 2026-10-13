import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTest from "node:test";

import { cutover, OFFICIAL_V2 } from "../cutover/cutover.ts";

const forkHistory = OFFICIAL_V2.map(
  ([id, name]) => [id, id === 57 ? "JevExecutionRequests" : name] as const,
);

function forkDb(
  options: { history?: ReadonlyArray<readonly [number, string]>; jevRows?: number } = {},
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jev-cutover-"));
  const dbPath = NodePath.join(dir, "statev2.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);
    CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY);
    CREATE TABLE jev_execution_requests (command_id TEXT PRIMARY KEY NOT NULL, request_digest TEXT NOT NULL);
  `);
  const insert = db.prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)");
  for (let id = 1; id <= 54; id++) insert.run(id, `Migration${id}`);
  for (const [id, name] of options.history ?? forkHistory) insert.run(id, name);
  for (let i = 0; i < 3; i++)
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?)").run(`t${i}`);
  for (let i = 0; i < (options.jevRows ?? 0); i++)
    db.prepare("INSERT INTO jev_execution_requests VALUES (?, ?)").run(`cmd-${i}`, `digest-${i}`);
  db.close();
  return {
    dir,
    dbPath,
    exportDir: NodePath.join(dir, "export"),
    backupDir: NodePath.join(dir, "backup"),
  };
}

const history = (dbPath: string) => {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      "SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55 ORDER BY 1",
    )
    .all()
    .map((r) => [Number(r.migration_id), String(r.name)]);
  db.close();
  return rows;
};

NodeTest.test("dry run reports the plan, exports rows, and changes nothing", () => {
  const fixture = forkDb({ jevRows: 2 });
  const report = cutover({ ...fixture, apply: false });
  NodeAssert.equal(report.statements.length, 6);
  NodeAssert.deepEqual(history(fixture.dbPath), forkHistory);
  NodeAssert.equal(JSON.parse(NodeFS.readFileSync(report.exportPath!, "utf8")).length, 2);
  NodeAssert.equal(NodeFS.existsSync(fixture.backupDir), false);
});

NodeTest.test(
  "apply rewrites the fork history to official, keeps threads, and backs up first",
  () => {
    const fixture = forkDb({ jevRows: 1 });
    const report = cutover({ ...fixture, apply: true });
    NodeAssert.deepEqual(history(fixture.dbPath), OFFICIAL_V2);
    NodeAssert.equal(report.after?.threads, 3);
    NodeAssert.equal(report.after?.quickCheck, "ok");
    NodeAssert.deepEqual(report.after?.missingColumns, []);
    NodeAssert.equal(report.after?.hasDeliveries, true);
    NodeAssert.equal(report.after?.jevRows, null);
    NodeAssert.deepEqual(history(NodePath.join(fixture.backupDir, "statev2.sqlite")), forkHistory);
    NodeAssert.deepEqual(JSON.parse(NodeFS.readFileSync(report.exportPath!, "utf8")), [
      { command_id: "cmd-0", request_digest: "digest-0" },
    ]);
  },
);

NodeTest.test("a second apply is a no-op and keeps the first export", () => {
  const fixture = forkDb({ jevRows: 2 });
  const first = cutover({ ...fixture, apply: true });
  const again = cutover({ ...fixture, backupDir: undefined, apply: true });
  NodeAssert.deepEqual(again.statements, []);
  NodeAssert.equal(again.after, undefined);
  NodeAssert.equal(again.exportPath, null);
  NodeAssert.equal(JSON.parse(NodeFS.readFileSync(first.exportPath!, "utf8")).length, 2);
});

NodeTest.test("refuses an unrecognized history and leaves it untouched", () => {
  const odd = forkHistory.map(([id, name]) => [id, id === 58 ? "SomethingElse" : name] as const);
  const fixture = forkDb({ history: odd });
  NodeAssert.throws(() => cutover({ ...fixture, apply: true }), /unrecognized history/);
  NodeAssert.deepEqual(history(fixture.dbPath), odd);
});

NodeTest.test("refuses while another connection holds the write lock", () => {
  const fixture = forkDb();
  const holder = new NodeSqlite.DatabaseSync(fixture.dbPath);
  holder.exec("BEGIN IMMEDIATE");
  try {
    NodeAssert.throws(() => cutover({ ...fixture, apply: true }), /locked|busy/i);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
  NodeAssert.deepEqual(history(fixture.dbPath), forkHistory);
});

NodeTest.test("refuses a database with a non-empty WAL", () => {
  const fixture = forkDb();
  NodeFS.writeFileSync(`${fixture.dbPath}-wal`, "x");
  NodeAssert.throws(() => cutover({ ...fixture, apply: true }), /not empty/);
});
