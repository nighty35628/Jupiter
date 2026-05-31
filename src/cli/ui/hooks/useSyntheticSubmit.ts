import { type Dispatch, type SetStateAction, useCallback, useMemo } from "react";
import type { Scrollback } from "./useScrollback.js";

interface AbortableLoop {
  abort: () => void;
}

export interface SyntheticSubmitDeps {
  log: Scrollback;
  busy: boolean;
  loop: AbortableLoop;
  setQueuedSubmit: Dispatch<SetStateAction<string | null>>;
  handleSubmit: (text: string) => Promise<void>;
}

export interface SyntheticSubmit {
  /** Push info marker + ship synthetic. Aborts + queues if turn is busy. */
  post(args: { marker: string; synthetic: string }): Promise<void>;
  /** No-marker variant — caller has already pushed (or wants to skip) the row. */
  submit(synthetic: string): Promise<void>;
}

export function useSyntheticSubmit(deps: SyntheticSubmitDeps): SyntheticSubmit {
  const { log, busy, loop, setQueuedSubmit, handleSubmit } = deps;

  const submit = useCallback(
    async (synthetic: string): Promise<void> => {
      if (busy) {
        loop.abort();
        setQueuedSubmit(synthetic);
        return;
      }
      await handleSubmit(synthetic);
    },
    [busy, loop, setQueuedSubmit, handleSubmit],
  );

  const post = useCallback(
    async (args: { marker: string; synthetic: string }): Promise<void> => {
      log.pushInfo(args.marker);
      await submit(args.synthetic);
    },
    [log, submit],
  );

  return useMemo(() => ({ post, submit }), [post, submit]);
}
