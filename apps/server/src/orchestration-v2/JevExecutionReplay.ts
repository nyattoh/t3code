import { CommandId, ThreadId, type ModelSelection } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as JevRouting from "../provider/JevRoutingService.ts";
import { AttachmentClaimError } from "./AttachmentClaims.ts";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Check durable receipts before consulting an evictable, process-local decision. */
export const prepare = Effect.fn("JevExecutionReplay.prepare")(function* (input: {
  readonly kind: "dispatch" | "launch";
  readonly payload: unknown;
  readonly commandId: CommandId;
  readonly jevDecisionId?: string | undefined;
  readonly modelSelection?: ModelSelection | undefined;
}) {
  const contextSql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(contextSql)) {
    if (input.jevDecisionId === undefined) return null;
    return yield* new AttachmentClaimError({
      message: "Jev execution persistence is unavailable.",
    });
  }
  const sql = contextSql.value;
  const digest = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(canonical({ kind: input.kind, payload: input.payload })))
    .digest("hex");
  const readDigest = sql<{
    request_digest: string;
  }>`SELECT request_digest FROM jev_execution_requests WHERE command_id = ${input.commandId}`;
  const rows = yield* readDigest.pipe(
    Effect.mapError(
      () => new AttachmentClaimError({ message: "Failed to read Jev execution receipt." }),
    ),
  );
  if (rows.length > 0 && rows[0]!.request_digest !== digest) {
    return yield* new AttachmentClaimError({
      message: "The command ID was already bound to a different Jev request.",
    });
  }
  if (rows.length === 0 && input.jevDecisionId === undefined) return null;

  const receipts = yield* sql<{
    command_id: string;
    aggregate_kind: string;
    aggregate_id: string;
    command_type: string;
    status: string;
  }>`SELECT command_id, aggregate_kind, aggregate_id, command_type, status
     FROM orchestration_command_receipts
     WHERE command_id = ${input.commandId} OR command_id = ${`${input.commandId}:initial-message`}`.pipe(
    Effect.mapError(() => new AttachmentClaimError({ message: "Failed to read command receipt." })),
  );
  const receipt = receipts.find((item) => item.command_id === input.commandId);
  if (receipt && rows.length === 0) {
    return yield* new AttachmentClaimError({
      message: "The command ID belongs to a different request.",
    });
  }
  if (receipt?.status === "rejected") {
    return yield* new AttachmentClaimError({
      message: "This Jev execution request was previously rejected.",
    });
  }
  if (receipt?.status === "accepted" && receipt.aggregate_kind === "thread") {
    if (input.kind === "dispatch" && receipt.command_type === "message.dispatch") {
      return ThreadId.make(receipt.aggregate_id);
    }
    const initial = receipts.find(
      (item) => item.command_id === `${input.commandId}:initial-message`,
    );
    if (
      input.kind === "launch" &&
      ["thread.create", "thread.metadata.update"].includes(receipt.command_type) &&
      initial?.status === "accepted" &&
      initial.command_type === "message.dispatch" &&
      initial.aggregate_kind === "thread" &&
      initial.aggregate_id === receipt.aggregate_id
    ) {
      return ThreadId.make(receipt.aggregate_id);
    }
  }

  // No accepted execution to replay. Restart/eviction never authorizes new work.
  yield* JevRouting.validateExecution(input).pipe(
    Effect.mapError((error) => new AttachmentClaimError({ message: error.detail })),
  );
  yield* sql`INSERT INTO jev_execution_requests (command_id, request_digest)
    VALUES (${input.commandId}, ${digest}) ON CONFLICT(command_id) DO NOTHING`.pipe(
    Effect.mapError(
      () => new AttachmentClaimError({ message: "Failed to bind Jev execution request." }),
    ),
  );
  const reserved = yield* readDigest.pipe(
    Effect.mapError(
      () => new AttachmentClaimError({ message: "Failed to read Jev execution receipt." }),
    ),
  );
  if (reserved[0]?.request_digest !== digest) {
    return yield* new AttachmentClaimError({
      message: "The command ID was already bound to a different Jev request.",
    });
  }
  return null;
});
