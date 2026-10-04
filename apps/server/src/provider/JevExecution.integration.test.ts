import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";

import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Routing from "./JevRoutingService.ts";
import * as Registry from "./Services/ProviderRegistry.ts";
import { routingCandidates, type JevCall } from "./jevRouting.ts";

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

import * as Intake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import {
  CommandId,
  ThreadId,
  MessageId,
  ProjectId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";

import * as Fiber from "effect/Fiber";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const database = SqlitePersistenceMemory;
const adapter = {
  instanceId: baseline.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("real model execution is disabled"),
} as ProviderAdapterV2Shape;
const orchestration = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "jev-execution" },
  Adapters.makeLayer([adapter]),
  { databaseLayer: database, runEffectWorker: false },
);
const downstream = Layer.mergeAll(
  database,
  orchestration,
  Threads.layer.pipe(Layer.provide(orchestration)),
  ServerConfig.layerTest(process.cwd(), { prefix: "jev-integration-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
);
const threadId = ThreadId.make("jev-thread");
const createThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project"),
    title: "Test",
    modelSelection: baseline,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});
const message = (
  id: string,
  decisionId?: string,
): Extract<OrchestrationV2Command, { type: "message.dispatch" }> => ({
  type: "message.dispatch",
  commandId: CommandId.make(id),
  threadId,
  messageId: MessageId.make(`message-${id}`),
  text: "test",
  attachments: [],
  modelSelection: baseline,
  dispatchMode: { type: "start_immediately" },
  createdBy: "user",
  creationSource: "web",
  ...(decisionId === undefined ? {} : { jevDecisionId: decisionId }),
});

it.effect(
  "rejects a concurrent run under the real serialized Orchestrator instead of queuing Jev",
  () => {
    let entered!: () => void;
    let answer!: (value: unknown) => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<unknown>((resolve) => {
      answer = resolve;
    });
    return Effect.gen(function* () {
      yield* createThread;
      const routing = yield* Routing.JevRoutingService;
      const selection = yield* routing.select(request).pipe(Effect.forkScoped);
      yield* Effect.promise(() => ready);
      const threads = yield* Threads.ThreadManagementService;
      yield* threads.dispatch(message("other-client"));
      answer(yield* Effect.promise(() => mockCall({} as never, new AbortController().signal)));
      const decision = yield* Fiber.join(selection);
      const error = yield* Intake.dispatchCommand(
        message(request.requestId, decision.decisionId),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestratorCommandRejectedError");
      const projection = yield* threads.getThreadProjection(threadId);
      expect(projection.runs).toHaveLength(1);
      expect(projection.runs.filter((run) => run.status === "queued")).toEqual([]);
      expect(projection.messages.map((item) => item.id)).not.toContain(
        `message-${request.requestId}`,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          downstream,
          testLayer(
            () => [provider],
            async () => {
              entered();
              return waiting;
            },
          ),
        ),
      ),
    );
  },
);

it.effect.each(["restart", "eviction"] as const)(
  "replays an accepted real intake command after decision-cache %s",
  (change) => {
    let calls = 0;
    const routingLayer = testLayer(
      () => [provider],
      async (...args) => {
        calls++;
        return mockCall(...args);
      },
    );
    return Effect.gen(function* () {
      yield* createThread;
      const routing = yield* Routing.JevRoutingService;
      const decision = yield* routing.select(request);
      const command = message(request.requestId, decision.decisionId);
      const first = yield* Intake.dispatchCommand(command);
      if (change === "eviction") {
        for (let index = 0; index < 256; index++) {
          yield* routing.select({ ...request, requestId: CommandId.make(`evict-${index}`) });
        }
        const missing = yield* routing
          .validateExecution({
            decisionId: decision.decisionId!,
            commandId: request.requestId,
            selection: decision.selection,
          })
          .pipe(Effect.flip);
        expect(missing.code).toBe("invalid-selection");
      }
      const before = calls;
      const replay =
        change === "restart"
          ? yield* Intake.dispatchCommand(command).pipe(
              Effect.provide(testLayer(() => [provider], mockCall)),
            )
          : yield* Intake.dispatchCommand(command);
      expect(replay.sequence).toBe(first.sequence);
      expect(replay.storedEvents).toEqual(first.storedEvents);
      expect(calls).toBe(before);
      const threads = yield* Threads.ThreadManagementService;
      expect((yield* threads.getThreadProjection(threadId)).runs).toHaveLength(1);
      for (const changed of [
        { ...command, text: "tampered" },
        { ...command, jevDecisionId: undefined },
        { ...command, modelSelection: { ...baseline, model: "tampered" } },
      ]) {
        const error = yield* Intake.dispatchCommand(changed).pipe(Effect.flip);
        expect(error._tag).toBe("AttachmentClaimError");
      }
    }).pipe(Effect.provide(Layer.mergeAll(downstream, routingLayer)));
  },
);
