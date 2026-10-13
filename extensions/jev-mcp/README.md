# jev-mcp

Jev model routing for T3 Code as a standalone MCP server. It is not part of T3's pnpm workspace, server, or database, so official T3 Code updates cannot conflict with it.

## What it does

One tool, `jev_route`. Given a task summary, a policy, and the model and reasoning-effort combinations the caller may use, it asks Jev (`https://api.typesafe.ai/v1/systemone`) to choose one. The answer is advisory. The agent uses it to pick a model for a subagent or a new thread. It cannot switch the model of the thread it runs in.

Each `requestId` is recorded before Jev is called. Repeating a request with the same id and input returns the stored decision without calling Jev. Reusing an id with different input fails with `duplicate-request`.

## Storage

`%T3CODE_HOME%\jev\jev.sqlite` (`~/.t3/jev/jev.sqlite` when `T3CODE_HOME` is unset), or `--db <path>`. T3's `statev2.sqlite` is never opened.

Rows exported from T3's former `jev_execution_requests` table import with:

```sh
node extensions/jev-mcp/src/main.ts --import-legacy jev_execution_requests.json
```

## Requirements

Node 24 or newer (runs TypeScript directly, uses `node:sqlite`). No npm dependencies. `TYPESAFE_API_KEY` in the server's environment.

## Tests

```sh
cd extensions/jev-mcp && node --test test/*.test.ts
```

## Moving a fork database to official T3 Code

The Jev fork recorded its own migration as `57 JevExecutionRequests`. Official T3 Code uses 57 for `ScheduledTaskWebhooks` and refuses to start on that history. `cutover/cutover.ts` rewrites such a database so official builds open it.

1. Quit T3 Code.
2. Dry run. It prints the plan and writes `jev_execution_requests.json` without changing the database:

   ```sh
   node extensions/jev-mcp/cutover/cutover.ts --db "$T3CODE_HOME/userdata/statev2.sqlite" --export-dir ./jev-export
   ```

3. Apply. It copies the database into `--backup-dir`, then in one transaction adds the `ScheduledTaskWebhooks` schema, drops `jev_execution_requests`, and renames row 57. It checks `quick_check`, the thread count, and the migration history before committing, and rolls back if any check fails:

   ```sh
   node extensions/jev-mcp/cutover/cutover.ts --db "$T3CODE_HOME/userdata/statev2.sqlite" --export-dir ./jev-export --backup-dir ./jev-backup --apply
   ```

4. Import the exported rows into the Jev store with `--import-legacy` (see Storage).

It refuses a history it does not recognize, a non-empty WAL, and a database another process holds the write lock on. Running it again on a converted database does nothing.
