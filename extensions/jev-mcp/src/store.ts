import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export type Decision = {
  readonly decisionId: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly reason: string;
  readonly confidence: number;
};

export type StoredRequest = {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly decision: Decision | null;
};

export type LegacyRow = { readonly command_id: string; readonly request_digest: string };

export function defaultDbPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const home = env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
  return NodePath.join(home, "jev", "jev.sqlite");
}

export class JevStore {
  readonly #db: NodeSqlite.DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    this.#db = new NodeSqlite.DatabaseSync(path);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jev_requests (
        request_id TEXT PRIMARY KEY NOT NULL,
        request_digest TEXT NOT NULL,
        decision_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
  }

  /** Records the request before Jev is called and returns whatever row now owns the id. */
  reserve(requestId: string, requestDigest: string): StoredRequest {
    this.#db
      .prepare("INSERT OR IGNORE INTO jev_requests (request_id, request_digest) VALUES (?, ?)")
      .run(requestId, requestDigest);
    return this.get(requestId)!;
  }

  complete(requestId: string, decision: Decision): void {
    this.#db
      .prepare(
        "UPDATE jev_requests SET decision_json = ? WHERE request_id = ? AND decision_json IS NULL",
      )
      .run(JSON.stringify(decision), requestId);
  }

  get(requestId: string): StoredRequest | undefined {
    const row = this.#db
      .prepare(
        "SELECT request_id, request_digest, decision_json FROM jev_requests WHERE request_id = ?",
      )
      .get(requestId) as
      | { request_id: string; request_digest: string; decision_json: string | null }
      | undefined;
    if (row === undefined) return undefined;
    return {
      requestId: row.request_id,
      requestDigest: row.request_digest,
      decision: row.decision_json === null ? null : (JSON.parse(row.decision_json) as Decision),
    };
  }

  /** Carries rows exported from T3's former jev_execution_requests table. */
  importLegacy(rows: ReadonlyArray<LegacyRow>): number {
    const insert = this.#db.prepare(
      "INSERT OR IGNORE INTO jev_requests (request_id, request_digest) VALUES (?, ?)",
    );
    let imported = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows)
        imported += Number(insert.run(row.command_id, row.request_digest).changes);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return imported;
  }

  close(): void {
    this.#db.close();
  }
}
