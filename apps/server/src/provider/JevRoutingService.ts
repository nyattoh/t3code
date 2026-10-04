import { JevSelectionError, type JevRouteInput, type ModelSelection } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderRegistry from "./Services/ProviderRegistry.ts";
import {
  environmentJevCall,
  routingCandidates,
  RoutingFailure,
  selectRoute,
  type JevCall,
  type RoutingDecision,
} from "./jevRouting.ts";

/** External boundary, replaced with a mock layer in tests. */
export class JevClient extends Context.Service<JevClient, { readonly choose: JevCall }>()(
  "t3/provider/JevClient",
) {}

export class JevRoutingService extends Context.Service<
  JevRoutingService,
  {
    readonly select: (input: JevRouteInput) => Effect.Effect<RoutingDecision, JevSelectionError>;
    readonly validateExecution: (input: {
      readonly decisionId: string;
      readonly commandId: string;
      readonly selection: ModelSelection | undefined;
    }) => Effect.Effect<void, JevSelectionError>;
  }
>()("t3/provider/JevRoutingService") {}

const selectionError = (error: unknown) => {
  const safe = error instanceof RoutingFailure ? error : new RoutingFailure("transport");
  return new JevSelectionError({
    code: safe.code,
    detail: safe.message,
    ...(safe.status === undefined ? {} : { status: safe.status }),
  });
};

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const client = yield* JevClient;
  const requests = new Map<
    string,
    {
      fingerprint: string;
      effect: Effect.Effect<RoutingDecision, JevSelectionError>;
      completed: boolean;
      input: JevRouteInput;
      decision?: RoutingDecision;
    }
  >();
  return JevRoutingService.of({
    validateExecution: (input) =>
      Effect.gen(function* () {
        const entry = requests.get(input.commandId);
        if (
          !entry?.decision ||
          entry.decision.decisionId !== input.decisionId ||
          !input.selection ||
          JSON.stringify(entry.decision.selection) !== JSON.stringify(input.selection)
        ) {
          return yield* Effect.fail(selectionError(new RoutingFailure("invalid-selection")));
        }
        const current = (yield* registry.getProviders).find(
          (provider) => provider.instanceId === entry.input.baseline.instanceId,
        );
        yield* Effect.try({
          try: () => {
            if (
              !current ||
              !routingCandidates(current, entry.input.constraints, entry.input.baseline).some(
                (candidate) =>
                  JSON.stringify(candidate.selection) === JSON.stringify(input.selection),
              )
            ) {
              throw new RoutingFailure("catalog-changed");
            }
          },
          catch: () => selectionError(new RoutingFailure("catalog-changed")),
        });
      }),
    select: (input) =>
      Effect.gen(function* () {
        const providers = yield* registry.getProviders;
        const snapshot = providers.find(
          (provider) => provider.instanceId === input.baseline.instanceId,
        );
        if (!snapshot)
          return yield* Effect.fail(selectionError(new RoutingFailure("provider-unavailable")));
        const fingerprint = JSON.stringify(input);
        let pending = requests.get(input.requestId);
        if (pending && pending.fingerprint !== fingerprint) {
          return yield* Effect.fail(selectionError(new RoutingFailure("duplicate-request")));
        }
        if (!pending) {
          if (requests.size >= 256) {
            const oldest = [...requests.entries()].find(([, entry]) => entry.completed);
            if (!oldest)
              return yield* Effect.fail(selectionError(new RoutingFailure("duplicate-request")));
            requests.delete(oldest[0]);
          }
          const cached = yield* Effect.cached(
            Effect.tryPromise({
              try: (signal) => selectRoute({ ...input, snapshot }, client.choose, 10_000, signal),
              catch: selectionError,
            }),
          );
          const entry: {
            fingerprint: string;
            effect: Effect.Effect<RoutingDecision, JevSelectionError>;
            completed: boolean;
            input: JevRouteInput;
            decision?: RoutingDecision;
          } = { fingerprint, effect: cached, completed: false, input: structuredClone(input) };
          const decisionId = NodeCrypto.randomUUID();
          entry.effect = cached.pipe(
            Effect.map((decision) => {
              entry.decision ??= { ...decision, decisionId };
              return entry.decision;
            }),
            Effect.ensuring(
              Effect.sync(() => {
                entry.completed = true;
              }),
            ),
          );
          requests.set(input.requestId, entry);
          pending = entry;
        }
        const decision = yield* pending.effect;
        const current = (yield* registry.getProviders).find(
          (provider) => provider.instanceId === snapshot.instanceId,
        );
        yield* Effect.try({
          try: () => {
            if (!current) throw new RoutingFailure("catalog-changed");
            const candidates = routingCandidates(current, input.constraints, input.baseline);
            if (
              !candidates.some(
                (candidate) =>
                  JSON.stringify(candidate.selection) === JSON.stringify(decision.selection),
              )
            ) {
              throw new RoutingFailure("catalog-changed");
            }
          },
          catch: () => selectionError(new RoutingFailure("catalog-changed")),
        });
        return decision;
      }),
  });
});

export const layer = Layer.effect(JevRoutingService, make);
export const clientLayer = Layer.succeed(JevClient, JevClient.of({ choose: environmentJevCall() }));

/** Used by the real intake immediately before dispatch/launch, after attachment awaits. */
export const validateExecution = Effect.fn("JevRoutingService.validateExecution")(
  function* (input: {
    readonly jevDecisionId?: string | undefined;
    readonly commandId: string;
    readonly modelSelection?: ModelSelection | undefined;
  }) {
    if (input.jevDecisionId === undefined) return;
    const service = yield* Effect.serviceOption(JevRoutingService);
    if (Option.isNone(service))
      return yield* Effect.fail(selectionError(new RoutingFailure("invalid-selection")));
    yield* service.value.validateExecution({
      decisionId: input.jevDecisionId,
      commandId: input.commandId,
      selection: input.modelSelection,
    });
  },
);
