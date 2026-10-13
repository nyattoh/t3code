#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

type MigrationRow = readonly [id: number, name: string];

/** Official T3 Code V2 migration history (0.0.46-nightly.20261013.3053 and main as of 2026-10-13). */
export const OFFICIAL_V2: ReadonlyArray<MigrationRow> = [
  [55, "OrchestrationV2"],
  [56, "RemoveRedundantProjectionIndexes"],
  [57, "ScheduledTaskWebhooks"],
  [58, "WebhookRelayDeliveries"],
  [59, "McpAppModelContext"],
  [60, "ThreadSnapshotWindowIndexes"],
  [61, "PullRequestReviewGuides"],
];

/** Copied from official 057_ScheduledTaskWebhooks.ts, minus the ALTERs applied per missing column. */
const SCHEDULED_TASK_WEBHOOKS = [
  `CREATE TABLE IF NOT EXISTS scheduled_task_webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    method TEXT NOT NULL,
    query TEXT NOT NULL,
    headers_json TEXT NOT NULL,
    body TEXT NOT NULL,
    body_bytes INTEGER NOT NULL,
    body_truncated INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    signature_verified INTEGER NOT NULL,
    missing_fields_json TEXT NOT NULL,
    rendered_prompt TEXT,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_task_webhook_deliveries_task
    ON scheduled_task_webhook_deliveries(task_id, received_at)`,
];

export type DbState = {
  readonly migrations: ReadonlyArray<MigrationRow>;
  readonly jevRows: ReadonlyArray<Record<string, unknown>> | null;
  readonly threads: number;
  readonly missingColumns: ReadonlyArray<string>;
  readonly hasDeliveries: boolean;
};

export type Report = {
  readonly apply: boolean;
  readonly before: Omit<DbState, "jevRows"> & { readonly jevRows: number | null };
  readonly exportPath: string;
  readonly statements: ReadonlyArray<string>;
  readonly after?: Omit<DbState, "jevRows"> & { readonly quickCheck: string };
};

const tableExists = (db: NodeSqlite.DatabaseSync, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

export function inspect(db: NodeSqlite.DatabaseSync): DbState {
  const migrations = db
    .prepare(
      "SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 55 ORDER BY migration_id",
    )
    .all()
    .map((row): MigrationRow => [Number(row.migration_id), String(row.name)]);
  const taskColumns = tableExists(db, "scheduled_tasks")
    ? db
        .prepare("PRAGMA table_info(scheduled_tasks)")
        .all()
        .map((column) => String(column.name))
    : [];
  return {
    migrations,
    jevRows: tableExists(db, "jev_execution_requests")
      ? db
          .prepare("SELECT * FROM jev_execution_requests")
          .all()
          .map((row) => ({ ...row }))
      : null,
    threads: Number(
      db.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_threads").get()!.n,
    ),
    missingColumns: ["webhook_token", "webhook_secret"].filter(
      (column) => !taskColumns.includes(column),
    ),
    hasDeliveries: tableExists(db, "scheduled_task_webhook_deliveries"),
  };
}

/** The official rows this database should hold: every official id up to the highest one recorded. */
const expectedHistory = (migrations: ReadonlyArray<MigrationRow>) => {
  const highest = Math.max(0, ...migrations.map(([id]) => id));
  return OFFICIAL_V2.filter(([id]) => id <= highest);
};

const sameRows = (a: ReadonlyArray<MigrationRow>, b: ReadonlyArray<MigrationRow>) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Empty when the database already has the official history and no Jev table. */
export function plan(state: DbState): ReadonlyArray<string> {
  if (sameRows(state.migrations, expectedHistory(state.migrations)) && state.jevRows === null)
    return [];
  const official = expectedHistory(state.migrations).map(([id, name]): MigrationRow =>
    id === 57 ? [57, "JevExecutionRequests"] : [id, name],
  );
  if (!sameRows(state.migrations, official))
    throw new Error(
      `Refusing to touch an unrecognized history. Expected ${JSON.stringify(official)}, found ${JSON.stringify(state.migrations)}.`,
    );
  return [
    ...state.missingColumns.map(
      (column) => `ALTER TABLE scheduled_tasks ADD COLUMN ${column} TEXT`,
    ),
    ...SCHEDULED_TASK_WEBHOOKS,
    "DROP TABLE IF EXISTS jev_execution_requests",
    "UPDATE effect_sql_migrations SET name = 'ScheduledTaskWebhooks' WHERE migration_id = 57 AND name = 'JevExecutionRequests'",
  ];
}

export function verify(
  state: DbState,
  quickCheck: string,
  expectedThreads: number,
): ReadonlyArray<string> {
  return [
    ...(quickCheck === "ok" ? [] : [`quick_check returned ${quickCheck}`]),
    ...(state.threads === expectedThreads
      ? []
      : [`thread count ${state.threads}, expected ${expectedThreads}`]),
    ...(sameRows(state.migrations, expectedHistory(state.migrations))
      ? []
      : ["migration history differs from official"]),
    ...(state.missingColumns.length === 0 && state.hasDeliveries
      ? []
      : ["ScheduledTaskWebhooks schema incomplete"]),
    ...(state.jevRows === null ? [] : ["jev_execution_requests still present"]),
  ];
}

const withoutRows = ({ jevRows, ...rest }: DbState) => ({
  ...rest,
  jevRows: jevRows?.length ?? null,
});

export function cutover(options: {
  readonly dbPath: string;
  readonly exportDir: string;
  readonly backupDir?: string | undefined;
  readonly apply: boolean;
}): Report {
  // A clean close leaves no WAL; a non-empty one holds writes from a running T3 Code.
  for (const suffix of ["-wal", "-journal"]) {
    const sidecar = options.dbPath + suffix;
    if (NodeFS.existsSync(sidecar) && NodeFS.statSync(sidecar).size > 0)
      throw new Error(`${sidecar} is not empty. Quit T3 Code and retry.`);
  }
  const db = new NodeSqlite.DatabaseSync(options.dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    // Holding the write lock for the whole run fails fast if anything else has the database open for writing.
    db.exec("BEGIN IMMEDIATE");
    const before = inspect(db);
    const statements = plan(before);
    NodeFS.mkdirSync(options.exportDir, { recursive: true });
    const exportPath = NodePath.join(options.exportDir, "jev_execution_requests.json");
    NodeFS.writeFileSync(exportPath, JSON.stringify(before.jevRows ?? [], null, 2));
    const report: Report = {
      apply: options.apply,
      before: withoutRows(before),
      exportPath,
      statements,
    };
    if (!options.apply || statements.length === 0) {
      db.exec("ROLLBACK");
      return report;
    }
    if (options.backupDir !== undefined) {
      NodeFS.mkdirSync(options.backupDir, { recursive: true });
      const backupPath = NodePath.join(options.backupDir, NodePath.basename(options.dbPath));
      if (NodeFS.existsSync(backupPath)) throw new Error(`${backupPath} already exists.`);
      NodeFS.copyFileSync(options.dbPath, backupPath);
    }
    try {
      for (const statement of statements) db.exec(statement);
      const after = inspect(db);
      const quickCheck = String(db.prepare("PRAGMA quick_check").get()!.quick_check);
      const problems = verify(after, quickCheck, before.threads);
      if (problems.length > 0)
        throw new Error(`Verification failed, rolled back: ${problems.join("; ")}`);
      db.exec("COMMIT");
      return { ...report, after: { ...withoutRows(after), quickCheck } };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      db: { type: "string" },
      "export-dir": { type: "string" },
      "backup-dir": { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  if (values.db === undefined || values["export-dir"] === undefined) {
    process.stderr.write(
      "usage: node cutover.ts --db <statev2.sqlite> --export-dir <dir> [--backup-dir <dir>] [--apply]\n",
    );
    process.exit(2);
  }
  const report = cutover({
    dbPath: values.db,
    exportDir: values["export-dir"],
    backupDir: values["backup-dir"],
    apply: values.apply,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
