import { emitTo, listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import {
  PET_OVERLAY_OPEN_TASK_EVENT,
  PET_OVERLAY_READY_EVENT,
  PET_OVERLAY_SNAPSHOT_EVENT,
  PET_OVERLAY_WINDOW_LABEL,
  type PetOverlayOpenTask,
  type PetOverlaySnapshot,
} from "./overlay-protocol";

async function publishSnapshot(snapshot: PetOverlaySnapshot): Promise<void> {
  try {
    await emitTo(PET_OVERLAY_WINDOW_LABEL, PET_OVERLAY_SNAPSHOT_EVENT, snapshot);
  } catch {
    // Browser-only previews do not have the native overlay window.
  }
}

export function usePetOverlayBridge(
  snapshot: PetOverlaySnapshot,
  onOpenTask: (tabId: string) => void,
): void {
  const snapshotRef = useRef(snapshot);
  const onOpenTaskRef = useRef(onOpenTask);
  snapshotRef.current = snapshot;
  onOpenTaskRef.current = onOpenTask;

  useEffect(() => {
    void publishSnapshot(snapshot);
  }, [snapshot]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const subscriptions = [
      listen(PET_OVERLAY_READY_EVENT, () => {
        void publishSnapshot(snapshotRef.current);
      }),
      listen<PetOverlayOpenTask>(PET_OVERLAY_OPEN_TASK_EVENT, (event) => {
        onOpenTaskRef.current(event.payload.tabId);
      }),
    ];
    void Promise.all(subscriptions).then((items) => {
      if (disposed) {
        for (const unlisten of items) unlisten();
      } else {
        unlisteners.push(...items);
      }
    });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);
}
