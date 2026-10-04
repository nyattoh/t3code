import { describe, expect, it } from "vite-plus/test";
import { createJevSendGuard, type JevSendState } from "@t3tools/client-runtime/operations";

describe("the production Jev composer submission guard", () => {
  it.each(["changed draft", "changed model", "changed attachments", "changed effort"])(
    "never clears or submits %s",
    (fingerprint) => {
      let state: JevSendState = { threadKey: "same", generation: 1, fingerprint: "initial" };
      const guard = createJevSendGuard(() => state);
      state = { ...state, fingerprint };
      expect(
        guard.clearDraft(() => {
          throw new Error("must not clear");
        }),
      ).toBe(false);
      expect(guard.isCurrent()).toBe(false);
    },
  );
  it("permits its own clear but rejects subsequent edits or cancellation", () => {
    let state: JevSendState = { threadKey: "same", generation: 1, fingerprint: "initial" };
    const guard = createJevSendGuard(() => state);
    expect(
      guard.clearDraft(() => {
        state = { ...state, fingerprint: "cleared" };
      }),
    ).toBe(true);
    expect(guard.isCurrent()).toBe(true);
    state = { ...state, generation: 2 };
    expect(guard.isCurrent()).toBe(false);
  });
});
