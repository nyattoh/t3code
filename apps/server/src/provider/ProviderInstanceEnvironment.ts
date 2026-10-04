import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment ?? []) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  // Jev is a server-side selector; coding agents must not inherit its credential.
  // Environment names are case-insensitive on Windows.
  for (const name of Object.keys(next)) {
    if (name.toUpperCase() === "TYPESAFE_API_KEY") next[name] = undefined;
  }
  // Undefined masks the host key even when a spawner merges process.env again.
  next.TYPESAFE_API_KEY = undefined;
  return next;
}
