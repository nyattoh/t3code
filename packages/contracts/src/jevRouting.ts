import * as Schema from "effect/Schema";

import { CommandId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const common = {
  requestId: CommandId,
  baseline: ModelSelection,
  constraints: Schema.optional(
    Schema.Struct({
      models: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      efforts: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    }),
  ),
};

export const JevRouteInput = Schema.Union([
  Schema.Struct({ ...common, mode: Schema.Literal("manual"), selection: ModelSelection }),
  Schema.Struct({
    ...common,
    mode: Schema.Literal("jev"),
    taskSummary: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
    policy: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  }),
]);
export type JevRouteInput = typeof JevRouteInput.Type;

export const JevRouteDecision = Schema.Struct({
  decisionId: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.Literals(["manual", "jev"]),
  selection: ModelSelection,
  reason: Schema.String,
  signal: Schema.optional(
    Schema.Struct({
      model: Schema.String,
      confidence: Schema.Number,
      probabilities: Schema.Record(Schema.String, Schema.Number),
    }),
  ),
});
export type JevRouteDecision = typeof JevRouteDecision.Type;

export class JevSelectionError extends Schema.TaggedError<JevSelectionError>()(
  "JevSelectionError",
  {
    code: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
