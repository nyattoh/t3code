import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

import { httpJevCall, JevError, route, type JevCall } from "../src/route.ts";
import { handle } from "../src/server.ts";
import { defaultDbPath, JevStore } from "../src/store.ts";

const input = {
  requestId: "req-1",
  taskSummary: "Rename a variable across one file.",
  policy: "Cheapest combination that will succeed.",
  candidates: [
    { model: "gpt-5.5", reasoningEffort: "low" },
    { model: "gpt-5.5", reasoningEffort: "high" },
  ],
};

const answer = (choice: string, probabilities: Record<string, number>) => ({
  model: "jev-2026-10",
  answers: { route: { type: "choice", choice, confidence: probabilities[choice], probabilities } },
});

const countingCall = (response: unknown) => {
  const calls: unknown[] = [];
  const call: JevCall = async (body) => {
    calls.push(body);
    return response;
  };
  return { call, calls };
};

const tempDb = () =>
  NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jev-mcp-")),
    "jev",
    "jev.sqlite",
  );

NodeTest.test("routes to the candidate Jev chose and stores it", async () => {
  const store = new JevStore(tempDb());
  const { call, calls } = countingCall(
    answer("c0", { c0: 0.7, c1: 0.2, insufficient_evidence: 0.1 }),
  );
  const result = await route(input, { store, call });
  NodeAssert.equal(result.model, "gpt-5.5");
  NodeAssert.equal(result.reasoningEffort, "low");
  NodeAssert.equal(result.confidence, 0.7);
  NodeAssert.equal(result.replayed, false);
  NodeAssert.equal(calls.length, 1);
  NodeAssert.deepEqual(Object.keys((calls[0] as any).questions.route.criteria), [
    "c0",
    "c1",
    "insufficient_evidence",
  ]);
});

NodeTest.test("replays a stored decision across restarts without calling Jev", async () => {
  const path = tempDb();
  const first = new JevStore(path);
  const decided = await route(input, {
    store: first,
    call: countingCall(answer("c1", { c0: 0.1, c1: 0.8, insufficient_evidence: 0.1 })).call,
  });
  first.close();
  const { call, calls } = countingCall(null);
  const replay = await route(input, { store: new JevStore(path), call });
  NodeAssert.equal(calls.length, 0);
  NodeAssert.equal(replay.replayed, true);
  NodeAssert.equal(replay.decisionId, decided.decisionId);
  NodeAssert.equal(replay.reasoningEffort, "high");
});

NodeTest.test("rejects a reused requestId with different input", async () => {
  const store = new JevStore(":memory:");
  await route(input, {
    store,
    call: countingCall(answer("c0", { c0: 0.6, c1: 0.3, insufficient_evidence: 0.1 })).call,
  });
  await NodeAssert.rejects(
    route({ ...input, policy: "Highest quality." }, { store, call: countingCall(null).call }),
    (error: unknown) => error instanceof JevError && error.code === "duplicate-request",
  );
});

NodeTest.test(
  "surfaces insufficient evidence and malformed answers as errors, storing no decision",
  async () => {
    const store = new JevStore(":memory:");
    await NodeAssert.rejects(
      route(input, {
        store,
        call: countingCall(
          answer("insufficient_evidence", { c0: 0.2, c1: 0.2, insufficient_evidence: 0.6 }),
        ).call,
      }),
      (error: unknown) => error instanceof JevError && error.code === "insufficient-evidence",
    );
    await NodeAssert.rejects(
      route(
        { ...input, requestId: "req-2" },
        {
          store,
          call: countingCall(answer("c0", { c0: 0.4, c1: 0.5, insufficient_evidence: 0.1 })).call,
        },
      ),
      (error: unknown) => error instanceof JevError && error.code === "invalid-response",
    );
    NodeAssert.equal(store.get("req-1")?.decision, null);
  },
);

NodeTest.test("rejects duplicate candidates and empty summaries before calling Jev", async () => {
  const { call, calls } = countingCall(null);
  const store = new JevStore(":memory:");
  for (const bad of [
    { ...input, candidates: [input.candidates[0], input.candidates[0]] },
    { ...input, taskSummary: " " },
  ]) {
    await NodeAssert.rejects(
      route(bad, { store, call }),
      (e: unknown) => e instanceof JevError && e.code === "invalid-input",
    );
  }
  NodeAssert.equal(calls.length, 0);
});

NodeTest.test("imports legacy jev_execution_requests rows once", () => {
  const store = new JevStore(":memory:");
  const rows = [{ command_id: "cmd-1", request_digest: "abc" }];
  NodeAssert.equal(store.importLegacy(rows), 1);
  NodeAssert.equal(store.importLegacy(rows), 0);
  NodeAssert.deepEqual(store.get("cmd-1"), {
    requestId: "cmd-1",
    requestDigest: "abc",
    decision: null,
  });
});

NodeTest.test("stores data under T3CODE_HOME/jev, not in T3's database", () => {
  NodeAssert.equal(
    defaultDbPath({ T3CODE_HOME: "D:\\t3home" }),
    NodePath.join("D:\\t3home", "jev", "jev.sqlite"),
  );
});

NodeTest.test("answers MCP initialize and tools/list", async () => {
  const deps = { store: new JevStore(":memory:"), call: countingCall(null).call };
  const init: any = await handle(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    deps,
  );
  NodeAssert.deepEqual(init.result.serverInfo, { name: "jev", version: "0.1.0" });
  const list: any = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, deps);
  NodeAssert.deepEqual(
    list.result.tools.map((t: { name: string }) => t.name),
    ["jev_route"],
  );
  NodeAssert.equal(
    await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, deps),
    undefined,
  );
});

NodeTest.test("runs as a stdio MCP process and reports a missing key as a tool error", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jev-mcp-proc-"));
  const main = NodeURL.fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jev_route", arguments: input },
    },
  ];
  const run = NodeChildProcess.spawnSync(process.execPath, [main], {
    input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    env: { ...process.env, T3CODE_HOME: dir, TYPESAFE_API_KEY: "" },
    encoding: "utf8",
  });
  NodeAssert.equal(run.status, 0, run.stderr);
  const responses = run.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  NodeAssert.deepEqual(
    responses.map((r) => r.id),
    [1, 2],
  );
  NodeAssert.equal(responses[1].result.isError, true);
  NodeAssert.equal(JSON.parse(responses[1].result.content[0].text).code, "missing-key");
  NodeFS.writeFileSync(
    NodePath.join(dir, "legacy.json"),
    JSON.stringify([{ command_id: "cmd-9", request_digest: "d" }]),
  );
  const imported = NodeChildProcess.spawnSync(
    process.execPath,
    [main, "--import-legacy", NodePath.join(dir, "legacy.json")],
    {
      env: { ...process.env, T3CODE_HOME: dir },
      encoding: "utf8",
    },
  );
  NodeAssert.equal(JSON.parse(imported.stdout).imported, 1);
});

NodeTest.test("sends a trimmed API key", async () => {
  const headers: string[] = [];
  const fetcher = (async (_url: unknown, init: { headers: Record<string, string> }) => {
    headers.push(init.headers.Authorization!);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  await httpJevCall(fetcher, () => "  secret-key\n")({}, new AbortController().signal);
  NodeAssert.deepEqual(headers, ["Bearer secret-key"]);
});

NodeTest.test("waits for another process's write instead of failing busy", async () => {
  const path = tempDb();
  const store = new JevStore(path);
  const holder = new NodeSqlite.DatabaseSync(path);
  holder.exec("BEGIN IMMEDIATE");
  const storeUrl = NodeURL.pathToFileURL(
    NodePath.resolve(import.meta.dirname, "../src/store.ts"),
  ).href;
  const script = `import { JevStore } from ${JSON.stringify(storeUrl)};
new JevStore(${JSON.stringify(path)}).reserve("req-busy", "d");`;
  const worker = NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  worker.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => worker.on("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 500));
  NodeAssert.equal(store.get("req-busy"), undefined);
  holder.exec("COMMIT");
  NodeAssert.equal(await exited, 0, stderr);
  NodeAssert.equal(store.get("req-busy")?.requestDigest, "d");
  holder.close();
});
