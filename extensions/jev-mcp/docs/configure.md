# Connecting jev-mcp to T3 Code

T3 Code needs no changes. Each provider loads MCP servers from its own configuration, and T3 adds its `t3-code` server next to them.

Use a stable checkout for the server path, for example `D:\develop\works\t3code\extensions\jev-mcp\src\main.ts`. Set `TYPESAFE_API_KEY` and `T3CODE_HOME` as user environment variables so every launch path sees them.

## Codex

T3 starts Codex with `CODEX_HOME` set to the provider instance's home path when one is configured, and Codex's default home (`%USERPROFILE%\.codex`) otherwise. Add to that home's `config.toml`:

```toml
[mcp_servers.jev]
command = "node"
args = ['D:\develop\works\t3code\extensions\jev-mcp\src\main.ts']
env_vars = ["TYPESAFE_API_KEY", "T3CODE_HOME"]
```

`env_vars` forwards those variables from T3's environment, so the key is not written into the file.

T3 passes its own server as a `mcp_servers` config override on every thread. Codex merges that override with `config.toml` instead of replacing the table. With codex-cli 0.162.1, a `config.toml` holding only `jev` plus `-c 'mcp_servers={"t3-code"={url="..."}}'` lists both `jev` and `t3-code` in `codex mcp list`.

Check the entry with `codex mcp get jev`.

### Benchmark ledger

The fork hardcoded a `bench-ledger` server behind `T3_BENCH_LEDGER_*` variables. Declare it the same way instead:

```toml
[mcp_servers.bench-ledger]
command = 'C:\path\to\python.exe'
args = ["-m", "model_effort_router.bench_ledger_mcp", "--ledger", 'D:\path\to\ledger.jsonl']
env = { PYTHONPATH = 'D:\path\to\model-effort-router\src' }
```

## Claude

T3's Claude adapter does not set `settingSources`. The Claude Agent SDK (0.3.276) loads every filesystem settings source when that option is omitted, the same as the CLI. T3 adds `t3-code` with `setMcpServers`, which per the SDK only manages servers added that way and leaves servers from settings in place. So a user-scope server is loaded in T3's Claude threads:

```sh
claude mcp add --scope user jev -- node D:\develop\works\t3code\extensions\jev-mcp\src\main.ts
```

If the Claude provider instance sets `CLAUDE_CONFIG_DIR`, run the command with the same `CLAUDE_CONFIG_DIR` so the entry lands in that directory. Check with `claude mcp list`.

This follows from the adapter source and the SDK documentation. It has not yet been observed in a running T3 Claude thread. To confirm, open a Claude thread in T3 and ask it to list its MCP tools. `jev_route` should appear.
