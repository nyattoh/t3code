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
        claim_expires_at INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    const columns = this.#db
      .prepare("PRAGMA table_info(jev_requests)")
      .all()
      .map((c) => String(c.name));
    if (!columns.includes("claim_expires_at"))
      this.#db.exec("ALTER TABLE jev_requests ADD COLUMN claim_expires_at INTEGER");
  }

  /**
   * Records the request and, in the same transaction, claims the right to call Jev for it.
   * Every MCP session runs its own process, so the claim lives in the shared file:
   * "claimed" means this caller must call Jev and then complete or release, "pending"
   * means another caller holds an unexpired claim, "settled" means the row already
   * has a decision or belongs to different input.
   */
  claim(
    requestId: string,
    requestDigest: string,
    now: number,
    ttlMs: number,
  ): { readonly state: "claimed" | "pending" | "settled"; readonly row: StoredRequest } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare("INSERT OR IGNORE INTO jev_requests (request_id, request_digest) VALUES (?, ?)")
        .run(requestId, requestDigest);
      const row = this.get(requestId)!;
      const { expires } = this.#db
        .prepare("SELECT claim_expires_at AS expires FROM jev_requests WHERE request_id = ?")
        .get(requestId) as { expires: number | null };
      let state: "claimed" | "pending" | "settled";
      if (row.decision !== null || row.requestDigest !== requestDigest) state = "settled";
      else if (expires !== null && expires > now) state = "pending";
      else {
        this.#db
          .prepare("UPDATE jev_requests SET claim_expires_at = ? WHERE request_id = ?")
          .run(now + ttlMs, requestId);
        state = "claimed";
      }
      this.#db.exec("COMMIT");
      return { state, row };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  release(requestId: string): void {
    this.#db
      .prepare(
        "UPDATE jev_requests SET claim_expires_at = NULL WHERE request_id = ? AND decision_json IS NULL",
      )
      .run(requestId);
  }

  complete(requestId: string, decision: Decision): void {
    this.#db
      .prepare(
        "UPDATE jev_requests SET decision_json = ?, claim_expires_at = NULL WHERE request_id = ? AND decision_json IS NULL",
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
