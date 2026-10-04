export interface JevSendState {
  readonly threadKey: string | null;
  readonly generation: number;
  readonly fingerprint: string;
}

/** Shared by the composer and its final client dispatch check. */
export function createJevSendGuard(read: () => JevSendState) {
  const initial = read();
  let expectedFingerprint = initial.fingerprint;
  let dispatched = false;
  const isCurrent = () => {
    const current = read();
    return (
      current.threadKey === initial.threadKey &&
      current.generation === initial.generation &&
      current.fingerprint === expectedFingerprint
    );
  };
  return {
    isCurrent,
    canCancel: () => !dispatched && isCurrent(),
    markDispatched: () => {
      dispatched = true;
    },
    clearDraft: (clear: () => void) => {
      if (!isCurrent()) return false;
      clear();
      expectedFingerprint = read().fingerprint;
      return true;
    },
  };
}
