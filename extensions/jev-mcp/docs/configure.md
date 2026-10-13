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

Codex asks for approval before each MCP tool call. Under `approval_policy = "never"` (for example `codex exec`) the call is refused with `MCP tool call requires approval`. Add `default_tools_approval_mode = "approve"` to `[mcp_servers.jev]` to allow `jev_route` without a prompt. With codex-cli 0.162.1 and that setting, `codex exec` called `jev/jev_route` and returned Jev's answer.

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

## T3 Code Desktop with the WSL backend

When T3 Desktop runs its server inside WSL, providers run in the distro and the Windows setup above does not apply:

- The Desktop strips `T3CODE_HOME` from the environment it hands to `wsl.exe` and forwards only an allowlist (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, telemetry variables). `TYPESAFE_API_KEY` is not on it. See `WSL_FORWARDED_ENV_NAMES` in `apps/desktop/src/backend/DesktopBackendConfiguration.ts`.
- Codex and Claude read their config from the distro's home (`~/.codex/config.toml`, `~/.claude.json`), not from `%USERPROFILE%`.
- `node` must be Node 24 or newer inside the distro, and paths must be Linux paths.

Workaround:

1. Forward the key with the Windows user variable `WSLENV`. The Desktop keeps the user's `WSLENV` and appends its own names to it:

   ```powershell
   [Environment]::SetEnvironmentVariable('WSLENV', 'TYPESAFE_API_KEY', 'User')
   ```

   If `WSLENV` already has entries, append `:TYPESAFE_API_KEY` instead of replacing them. Restart T3 Code afterwards.

2. In the distro, register the server with an explicit store path, because `T3CODE_HOME` does not arrive:

   ```toml
   [mcp_servers.jev]
   command = "node"
   args = ["/mnt/d/develop/works/t3code-jev-detached/extensions/jev-mcp/src/main.ts", "--db", "/home/<you>/.t3/jev/jev.sqlite"]
   env_vars = ["TYPESAFE_API_KEY"]
   ```

   ```sh
   claude mcp add --scope user jev -- node /mnt/d/develop/works/t3code-jev-detached/extensions/jev-mcp/src/main.ts --db ~/.t3/jev/jev.sqlite
   ```

   A store on `/mnt/d` works, but SQLite locking across the 9P mount is slower and less reliable than on the distro's own filesystem, so keep the store under the distro home.
