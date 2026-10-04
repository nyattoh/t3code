import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Routing from "../src/provider/JevRoutingService.ts";
import * as Registry from "../src/provider/Services/ProviderRegistry.ts";
import { routingCandidates, type JevCall } from "../src/provider/jevRouting.ts";

const baseline: ModelSelection = {
  instanceId: "codex-a" as ModelSelection["instanceId"],
  model: "verified-model",
  options: [{ id: "reasoningEffort", value: "low" }],
};
const provider: ServerProvider = {
  instanceId: baseline.instanceId,
  driver: "codex" as ServerProvider["driver"],
  version: null,
  checkedAt: "2026-10-04T00:00:00.000Z" as ServerProvider["checkedAt"],
  slashCommands: [],
  skills: [],
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [
    {
      slug: "verified-model",
      name: "Verified",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [{ id: "low", label: "Low" }],
          },
        ],
      },
    },
  ],
};
const candidate = routingCandidates(provider)[0]!;
const request = {
  requestId: "test-command" as import("@t3tools/contracts").CommandId,
  mode: "jev" as const,
  baseline,
  taskSummary: "Localized fix",
  policy: "Quality preference; no measured ranking.",
};
const mockCall: JevCall = async () => ({
  model: "jev-mock",
  answers: {
    route: {
      type: "choice",
      choice: candidate.id,
      confidence: 1,
      probabilities: { [candidate.id]: 1, insufficient_evidence: 0 },
    },
  },
});

const testLayer = (read: () => ReadonlyArray<ServerProvider>, call: JevCall) =>
  Routing.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Registry.ProviderRegistry, {
          getProviders: Effect.sync(read),
        } as Registry.ProviderRegistry["Service"]),
        Layer.succeed(Routing.JevClient, Routing.JevClient.of({ choose: call })),
      ),
    ),
  );

NodeTest.test(
  "service discovers the provider instance and revalidates the catalog before returning",
  async () => {
    let reads = 0;
    let calls = 0;
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Routing.JevRoutingService).select(request);
      }).pipe(
        Effect.provide(
          testLayer(
            () => {
              reads++;
              return [provider];
            },
            async (...args) => {
              calls++;
              return mockCall(...args);
            },
          ),
        ),
      ),
    );
    NodeAssert.equal(reads, 2);
    NodeAssert.equal(calls, 1);
    NodeAssert.deepEqual(decision.selection, baseline);
  },
);
NodeTest.test(
  "service returns a typed missing-instance failure without contacting Jev",
  async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Routing.JevRoutingService).select(request);
      }).pipe(
        Effect.flip,
        Effect.provide(
          testLayer(
            () => [],
            async () => NodeAssert.fail("must not call Jev"),
          ),
        ),
      ),
    );
    NodeAssert.equal(error.code, "provider-unavailable");
  },
);
NodeTest.test("service stops when discovery changes while Jev is answering", async () => {
  let reads = 0;
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Routing.JevRoutingService).select(request);
    }).pipe(
      Effect.flip,
      Effect.provide(testLayer(() => (++reads === 1 ? [provider] : []), mockCall)),
    ),
  );
  NodeAssert.equal(error.code, "catalog-changed");
});
NodeTest.test("service manual mode bypasses the external decision boundary", async () => {
  const decision = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Routing.JevRoutingService).select({
        requestId: request.requestId,
        mode: "manual",
        baseline,
        selection: baseline,
      });
    }).pipe(
      Effect.provide(
        testLayer(
          () => [provider],
          async () => NodeAssert.fail("must not call Jev"),
        ),
      ),
    ),
  );
  NodeAssert.equal(decision.mode, "manual");
  NodeAssert.equal(decision.signal, undefined);
});
NodeTest.test("service coalesces duplicate selection IDs and rejects changed input", async () => {
  let calls = 0;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Routing.JevRoutingService;
      const decisions = yield* Effect.all([service.select(request), service.select(request)], {
        concurrency: "unbounded",
      });
      const failure = yield* service.select({ ...request, policy: "changed" }).pipe(Effect.flip);
      return { decisions, failure };
    }).pipe(
      Effect.provide(
        testLayer(
          () => [provider],
          async (...args) => {
            calls++;
            return mockCall(...args);
          },
        ),
      ),
    ),
  );
  NodeAssert.equal(calls, 1);
  NodeAssert.deepEqual(result.decisions[0], result.decisions[1]);
  NodeAssert.equal(result.failure.code, "duplicate-request");
});
