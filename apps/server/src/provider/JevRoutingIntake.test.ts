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
import * as Launches from "../orchestration-v2/ThreadLaunchService.ts";
import {
  CommandId,
  ThreadId,
  MessageId,
  ProjectId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";

const command = (
  decisionId: string,
): Extract<OrchestrationV2Command, { type: "message.dispatch" }> => ({
  type: "message.dispatch",
  createdBy: "user",
  creationSource: "web",
  commandId: request.requestId,
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  text: "test",
  attachments: [],
  modelSelection: baseline,
  dispatchMode: { type: "start_immediately" },
  jevDecisionId: decisionId,
});

const rejectionCases = (["dispatch", "launch"] as const).flatMap((path) =>
  (["catalog", "tuple", "command", "ticket"] as const).map((invalid) => ({ path, invalid })),
);

it.effect.each(rejectionCases)(
  "real intake $path rejects $invalid changes after Jev selection",
  ({ path, invalid }) => {
    let current = provider;
    let calls = 0;
    let executions = 0;
    return Effect.gen(function* () {
      const routing = yield* Routing.JevRoutingService;
      const decision = yield* routing.select(request);
      expect(decision.decisionId).toBeTypeOf("string");
      if (invalid === "catalog") current = { ...provider, models: [] };
      const selected =
        invalid === "tuple" ? { ...baseline, model: "unverified" } : decision.selection;
      const commandId = invalid === "command" ? CommandId.make("other") : request.requestId;
      const jevDecisionId = invalid === "ticket" ? "unknown-ticket" : decision.decisionId!;
      const error =
        path === "dispatch"
          ? yield* Effect.flip(
              Intake.dispatchCommand({
                ...command(jevDecisionId),
                commandId,
                modelSelection: selected,
              }),
            )
          : yield* Effect.flip(
              Intake.launchThread({
                commandId,
                jevDecisionId,
                modelSelection: selected,
                projectId: ProjectId.make("project"),
                title: "Test",
                runtimeMode: "approval-required",
                interactionMode: "default",
                workspaceStrategy: { type: "root" },
                initialMessage: { text: "test", attachments: [] },
                createdBy: "user",
                creationSource: "web",
              }),
            );
      expect(error._tag).toBe("AttachmentClaimError");
      expect(calls).toBe(1);
      expect(executions).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqlitePersistenceMemory,
          ServerConfig.layerTest(process.cwd(), { prefix: "jev-intake-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
          testLayer(
            () => [current],
            async (...args) => {
              calls++;
              return mockCall(...args);
            },
          ),
          Layer.mock(Threads.ThreadManagementService)({
            dispatch: () =>
              Effect.sync(() => {
                executions++;
                return { sequence: 1, storedEvents: [] };
              }),
          }),
          Layer.mock(Launches.ThreadLaunchService)({
            launch: () =>
              Effect.sync(() => {
                executions++;
                return {} as never;
              }),
          }),
        ),
      ),
    );
  },
);

it.effect.each(["dispatch", "launch"] as const)(
  "real intake %s accepts the bound tuple with one Jev request",
  (path) => {
    let calls = 0;
    let executions = 0;
    return Effect.gen(function* () {
      const routing = yield* Routing.JevRoutingService;
      const first = yield* routing.select(request);
      const second = yield* routing.select(request);
      expect(first.decisionId).toBe(second.decisionId);
      if (path === "dispatch") yield* Intake.dispatchCommand(command(first.decisionId!));
      else
        yield* Intake.launchThread({
          commandId: request.requestId,
          jevDecisionId: first.decisionId!,
          modelSelection: first.selection,
          projectId: ProjectId.make("project"),
          title: "Test",
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "test", attachments: [] },
          createdBy: "user",
          creationSource: "web",
        });
      expect(calls).toBe(1);
      expect(executions).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqlitePersistenceMemory,
          ServerConfig.layerTest(process.cwd(), { prefix: "jev-intake-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
          testLayer(
            () => [provider],
            async (...args) => {
              calls++;
              return mockCall(...args);
            },
          ),
          Layer.mock(Threads.ThreadManagementService)({
            dispatch: () =>
              Effect.sync(() => {
                executions++;
                return { sequence: 1, storedEvents: [] };
              }),
          }),
          Layer.mock(Launches.ThreadLaunchService)({
            launch: () =>
              Effect.sync(() => {
                executions++;
                return {} as never;
              }),
          }),
        ),
      ),
    );
  },
);
