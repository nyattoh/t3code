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
