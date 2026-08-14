import { emitTo, listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import {
  PET_OVERLAY_ACTION_EVENT,
  PET_OVERLAY_OPEN_TASK_EVENT,
  PET_OVERLAY_READY_EVENT,
  PET_OVERLAY_SNAPSHOT_EVENT,
  PET_OVERLAY_WINDOW_LABEL,
  type PetOverlayAction,
  type PetOverlayOpenTask,
  type PetOverlaySnapshot,
} from "./overlay-protocol";

export type PetOverlayBridgeHandlers = {
  onOpenTask: (tabId: string) => void;
  onOpenSettings: () => void;
  onHide: () => void;
};

async function publishSnapshot(snapshot: PetOverlaySnapshot): Promise<void> {
  try {
    await emitTo(PET_OVERLAY_WINDOW_LABEL, PET_OVERLAY_SNAPSHOT_EVENT, snapshot);
  } catch {
    // Browser-only previews do not have the native overlay window.
  }
}

export function usePetOverlayBridge(
  snapshot: PetOverlaySnapshot,
  handlers: PetOverlayBridgeHandlers,
): void {
  const snapshotRef = useRef(snapshot);
  const handlersRef = useRef(handlers);
  snapshotRef.current = snapshot;
  handlersRef.current = handlers;

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
        handlersRef.current.onOpenTask(event.payload.tabId);
      }),
      listen<PetOverlayAction>(PET_OVERLAY_ACTION_EVENT, (event) => {
        if (event.payload.action === "open-settings") handlersRef.current.onOpenSettings();
        else if (event.payload.action === "hide") handlersRef.current.onHide();
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
