import * as NodeReadline from "node:readline";

import { JevError, route, type JevCall } from "./route.ts";
import type { JevStore } from "./store.ts";

const PROTOCOL_VERSION = "2025-06-18";

export const ROUTE_TOOL = {
  name: "jev_route",
  title: "Choose a model with Jev",
  description:
    "Ask Jev to pick one model and reasoning effort from the candidates you list, for the task and policy given. " +
    "Advisory: it does not switch the current thread's model. Reusing a requestId with the same input returns the stored decision.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["requestId", "taskSummary", "policy", "candidates"],
    properties: {
      requestId: { type: "string", description: "Caller-chosen idempotency key." },
      taskSummary: { type: "string", maxLength: 4000 },
      policy: {
        type: "string",
        maxLength: 1000,
        description: "What to optimize, e.g. lowest cost that can pass review.",
      },
      candidates: {
        type: "array",
        minItems: 1,
        maxItems: 254,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["model"],
          properties: { model: { type: "string" }, reasoningEffort: { type: "string" } },
        },
      },
    },
  },
} as const;

type Message = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const isMessage = (value: unknown): value is Message => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { jsonrpc, id, method, params } = value as Record<string, unknown>;
  return (
    jsonrpc === "2.0" &&
    (id === undefined || id === null || typeof id === "string" || typeof id === "number") &&
    (method === undefined || typeof method === "string") &&
    (params === undefined ||
      (typeof params === "object" && params !== null && !Array.isArray(params)))
  );
};

export type ServerDeps = {
  readonly store: JevStore;
  readonly call: JevCall;
  readonly timeoutMs?: number;
};

const reply = (id: Message["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: Message["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** Returns the response for one JSON-RPC message, or undefined for notifications. */
export async function handle(message: Message, deps: ServerDeps): Promise<object | undefined> {
  const isRequest = message.id !== undefined;
  switch (message.method) {
    case "initialize":
      return reply(message.id, {
        protocolVersion:
          typeof message.params?.protocolVersion === "string"
            ? message.params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "jev", version: "0.1.0" },
      });
    case "ping":
      return reply(message.id, {});
    case "tools/list":
      return reply(message.id, { tools: [ROUTE_TOOL] });
    case "tools/call": {
      if (message.params?.name !== ROUTE_TOOL.name)
        return failure(message.id, -32602, `Unknown tool: ${String(message.params?.name)}`);
      try {
        const result = await route(message.params.arguments, deps);
        return reply(message.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (error) {
        const detail =
          error instanceof JevError
            ? { code: error.code, message: error.message }
            : { code: "internal", message: String(error) };
        return reply(message.id, {
          content: [{ type: "text", text: JSON.stringify(detail) }],
          isError: true,
        });
      }
    }
    default:
      return isRequest
        ? failure(message.id, -32601, `Method not found: ${String(message.method)}`)
        : undefined;
  }
}

/** MCP stdio transport: one JSON-RPC message per line on stdin and stdout. */
export function serve(
  deps: ServerDeps,
  input = process.stdin,
  output = process.stdout,
): Promise<void> {
  const lines = NodeReadline.createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    const task = (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(failure(null, -32700, "Parse error"))}\n`);
        return;
      }
      if (!isMessage(parsed)) {
        output.write(`${JSON.stringify(failure(null, -32600, "Invalid Request"))}\n`);
        return;
      }
      const response = await handle(parsed, deps).catch((error: unknown) =>
        parsed.id === undefined ? undefined : failure(parsed.id, -32603, String(error)),
      );
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  return new Promise((resolve) =>
    lines.on("close", () => void Promise.all(pending).then(() => resolve())),
  );
}
