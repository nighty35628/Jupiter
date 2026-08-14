import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { emitTo, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { setLang, t, useLang } from "../i18n";
import { I } from "../icons";
import { PetNativeContextMenu } from "./native-context-menu";
import { PET_DRAG_THRESHOLD, petDragActivity, petDragDistance, petRollAngle } from "./overlay-drag";
import {
  PET_OVERLAY_ACTION_EVENT,
  PET_OVERLAY_OPEN_TASK_EVENT,
  PET_OVERLAY_READY_EVENT,
  PET_OVERLAY_SNAPSHOT_EVENT,
  type PetOverlayAction,
  type PetOverlayOpenTask,
  type PetOverlaySnapshot,
  type PetTaskActivity,
  type PetTaskStatus,
} from "./overlay-protocol";
import { PetErrorBoundary, PetSprite } from "./runtime";
import { PET_DEFAULT_ID, type PetVisualActivity } from "./types";

type DragSession = {
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  startWindowX: number;
  startWindowY: number;
  scaleFactor: number;
  lastScreenX: number;
  moved: boolean;
};

type PetOverlayStyle = CSSProperties & {
  "--companion-roll-angle"?: string;
};

type PetContextMenuPosition = { x: number; y: number };

const PET_OVERLAY_WIDTH = 248;
const PET_OVERLAY_HEIGHT = 220;
const PET_CONTEXT_MENU_WIDTH = 188;
const PET_CONTEXT_MENU_HEIGHT = 180;
const PET_CONTEXT_MENU_MARGIN = 8;

export function clampPetContextMenuPosition(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
): PetContextMenuPosition {
  return {
    x: Math.max(
      PET_CONTEXT_MENU_MARGIN,
      Math.min(x, viewportWidth - PET_CONTEXT_MENU_WIDTH - PET_CONTEXT_MENU_MARGIN),
    ),
    y: Math.max(
      PET_CONTEXT_MENU_MARGIN,
      Math.min(y, viewportHeight - PET_CONTEXT_MENU_HEIGHT - PET_CONTEXT_MENU_MARGIN),
    ),
  };
}

function statusLabel(status: PetTaskStatus): string {
  switch (status) {
    case "waiting":
      return t("pets.statusWaiting");
    case "blocked":
      return t("pets.statusBlocked");
    case "ready":
      return t("pets.statusReady");
    case "working":
      return t("pets.statusWorking");
    case "thinking":
      return t("pets.statusThinking");
    default:
      return t("pets.statusIdle");
  }
}

export function petVisualActivity(status: PetTaskStatus): PetVisualActivity {
  switch (status) {
    case "waiting":
      return "waiting";
    case "blocked":
      return "failure";
    case "ready":
      return "review";
    case "working":
    case "thinking":
      return "running";
    default:
      return "idle";
  }
}

export function PetOverlayApp() {
  useLang();
  const overlayWindow = useMemo(() => getCurrentWindow(), []);
  const [snapshot, setSnapshot] = useState<PetOverlaySnapshot | null>(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<PetContextMenuPosition | null>(null);
  const [nativeContextMenuFailed, setNativeContextMenuFailed] = useState(false);
  const [contextMenuHighlightedIndex, setContextMenuHighlightedIndex] = useState(-1);
  const [dragActivity, setDragActivity] = useState<PetVisualActivity | null>(null);
  const [dragAngle, setDragAngle] = useState(0);
  const [transientActivity, setTransientActivity] = useState<PetVisualActivity | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const positionRef = useRef<{ x: number; y: number } | null>(null);
  const scaleFactorRef = useRef(1);
  const pendingPositionRef = useRef<{ x: number; y: number } | null>(null);
  const movingRef = useRef(false);
  const transientTimerRef = useRef<number | null>(null);
  const completionSequenceRef = useRef(new Map<string, number>());

  const clearTransient = useCallback(() => {
    if (transientTimerRef.current !== null) window.clearTimeout(transientTimerRef.current);
    transientTimerRef.current = null;
    setTransientActivity(null);
  }, []);

  const playTransient = useCallback(
    (activity: PetVisualActivity, duration: number) => {
      clearTransient();
      setTransientActivity(activity);
      transientTimerRef.current = window.setTimeout(() => {
        transientTimerRef.current = null;
        setTransientActivity(null);
      }, duration);
    },
    [clearTransient],
  );

  useEffect(() => clearTransient, [clearTransient]);

  useEffect(() => {
    if (!contextMenu) return;
    contextMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    const dismissOnBlur = () => setContextMenu(null);
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("blur", dismissOnBlur);
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("blur", dismissOnBlur);
    };
  }, [contextMenu]);

  useEffect(() => {
    document.documentElement.dataset.window = "pet-overlay";
    document.body.dataset.window = "pet-overlay";
    let disposed = false;
    let received = false;
    let retryTimer: number | null = null;
    let unlisten: (() => void) | null = null;

    const announceReady = () => {
      void emitTo("main", PET_OVERLAY_READY_EVENT).catch(() => undefined);
    };

    void listen<PetOverlaySnapshot>(PET_OVERLAY_SNAPSHOT_EVENT, (event) => {
      received = true;
      if (retryTimer !== null) window.clearInterval(retryTimer);
      retryTimer = null;
      setLang(event.payload.language);
      document.documentElement.dataset.theme = event.payload.theme;
      document.documentElement.dataset.themeStyle = event.payload.themeStyle;
      setSnapshot(event.payload);
    }).then((stop) => {
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      announceReady();
      retryTimer = window.setInterval(() => {
        if (!received) announceReady();
      }, 750);
    });

    return () => {
      disposed = true;
      unlisten?.();
      if (retryTimer !== null) window.clearInterval(retryTimer);
      delete document.documentElement.dataset.window;
      delete document.body.dataset.window;
    };
  }, []);

  useEffect(() => {
    void Promise.all([overlayWindow.outerPosition(), overlayWindow.scaleFactor()])
      .then(([position, scaleFactor]) => {
        positionRef.current = { x: position.x, y: position.y };
        scaleFactorRef.current = scaleFactor;
      })
      .catch(() => undefined);
  }, [overlayWindow]);

  const overlayEnabled = snapshot?.enabled;
  useEffect(() => {
    if (overlayEnabled === undefined) return;
    const action = overlayEnabled ? overlayWindow.show() : overlayWindow.hide();
    void action.catch(() => undefined);
  }, [overlayEnabled, overlayWindow]);

  const activities = snapshot?.activities ?? [];
  const activeActivities = activities.filter((activity) => activity.status !== "idle");
  const primary =
    activeActivities[0] ??
    activities.find((activity) => activity.active) ??
    activities[0] ??
    ({
      tabId: snapshot?.activeTabId ?? "",
      title: t("pets.currentTask"),
      status: "idle",
      active: true,
      updatedAt: 0,
      completionSequence: 0,
      completionOutcome: null,
    } satisfies PetTaskActivity);
  const activeTabId = snapshot?.activeTabId || primary.tabId;

  useEffect(() => {
    const seen = completionSequenceRef.current.get(primary.tabId);
    completionSequenceRef.current.set(primary.tabId, primary.completionSequence);
    if (seen === undefined || primary.completionSequence === seen || !primary.completionOutcome) {
      return;
    }
    playTransient(primary.completionOutcome === "failure" ? "failure" : "jumping", 1_200);
  }, [playTransient, primary.completionOutcome, primary.completionSequence, primary.tabId]);

  useEffect(() => {
    if (activeActivities.length <= 1) setTrayOpen(false);
  }, [activeActivities.length]);

  const flushWindowPosition = useCallback(async () => {
    if (movingRef.current) return;
    movingRef.current = true;
    try {
      while (pendingPositionRef.current) {
        const next = pendingPositionRef.current;
        pendingPositionRef.current = null;
        await overlayWindow.setPosition(new PhysicalPosition(next.x, next.y));
        positionRef.current = next;
      }
    } catch {
      pendingPositionRef.current = null;
    } finally {
      movingRef.current = false;
      if (pendingPositionRef.current) void flushWindowPosition();
    }
  }, [overlayWindow]);

  const queueWindowPosition = useCallback(
    (position: { x: number; y: number }) => {
      pendingPositionRef.current = position;
      void flushWindowPosition();
    },
    [flushWindowPosition],
  );

  const resetPetPosition = useCallback(async () => {
    try {
      const monitor = await currentMonitor();
      const scale = monitor?.scaleFactor && monitor.scaleFactor > 0 ? monitor.scaleFactor : 1;
      const workArea = monitor?.workArea;
      const next = workArea
        ? {
            x: Math.round(
              workArea.position.x + workArea.size.width - (PET_OVERLAY_WIDTH + 20) * scale,
            ),
            y: Math.round(
              workArea.position.y + workArea.size.height - (PET_OVERLAY_HEIGHT + 18) * scale,
            ),
          }
        : { x: 32, y: 96 };
      scaleFactorRef.current = scale;
      queueWindowPosition(next);
      playTransient("jumping", 620);
    } catch {
      // Keep the current position when monitor information is unavailable.
    }
  }, [playTransient, queueWindowPosition]);

  const openTask = useCallback((tabId: string) => {
    const payload: PetOverlayOpenTask = { tabId };
    void emitTo("main", PET_OVERLAY_OPEN_TASK_EVENT, payload).catch(() => undefined);
    setTrayOpen(false);
    setContextMenu(null);
  }, []);

  const requestOverlayAction = useCallback((action: PetOverlayAction["action"]) => {
    const payload: PetOverlayAction = { action };
    void emitTo("main", PET_OVERLAY_ACTION_EVENT, payload).catch(() => undefined);
    setContextMenu(null);
  }, []);

  const nativeContextMenuRef = useRef<PetNativeContextMenu | null>(null);
  useEffect(() => {
    const menu = new PetNativeContextMenu(overlayWindow, {
      openTask,
      interact: () => playTransient("waving", 820),
      resetPosition: () => void resetPetPosition(),
      openSettings: () => requestOverlayAction("open-settings"),
      hide: () => requestOverlayAction("hide"),
    });
    nativeContextMenuRef.current = menu;
    return () => {
      nativeContextMenuRef.current = null;
      void menu.dispose();
    };
  }, [openTask, overlayWindow, playTransient, requestOverlayAction, resetPetPosition]);

  const openContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    if ((event.target as Element).closest(".pet-context-menu")) return;
    clearTransient();
    setTrayOpen(false);
    const nativeMenu = nativeContextMenuRef.current;
    if (nativeMenu && !nativeContextMenuFailed) {
      void nativeMenu
        .show({
          activeTabId,
          labels: {
            openTask: t("pets.contextOpenTask"),
            interact: t("pets.contextInteract"),
            resetPosition: t("pets.contextResetPosition"),
            settings: t("pets.contextSettings"),
            hide: t("pets.contextHide"),
          },
        })
        .catch(() => {
          setNativeContextMenuFailed(true);
          setContextMenuHighlightedIndex(-1);
          setContextMenu(
            clampPetContextMenuPosition(
              event.clientX,
              event.clientY,
              window.innerWidth || PET_OVERLAY_WIDTH,
              window.innerHeight || PET_OVERLAY_HEIGHT,
            ),
          );
        });
      return;
    }
    setContextMenuHighlightedIndex(-1);
    setContextMenu(
      clampPetContextMenuPosition(
        event.clientX,
        event.clientY,
        window.innerWidth || PET_OVERLAY_WIDTH,
        window.innerHeight || PET_OVERLAY_HEIGHT,
      ),
    );
  };

  const handleContextMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setContextMenu(null);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [
      ...(contextMenuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    if (items.length === 0) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next =
      contextMenuHighlightedIndex < 0
        ? delta > 0
          ? 0
          : items.length - 1
        : (contextMenuHighlightedIndex + delta + items.length) % items.length;
    setContextMenuHighlightedIndex(next);
    items[next]?.focus({ preventScroll: true });
  };

  const handleContextMenuMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const item = (event.target as Element).closest<HTMLButtonElement>("button[role='menuitem']");
    if (!item || !event.currentTarget.contains(item)) return;
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role='menuitem']"),
    ];
    const next = items.indexOf(item);
    if (next < 0 || next === contextMenuHighlightedIndex) return;
    setContextMenuHighlightedIndex(next);
    item.focus({ preventScroll: true });
  };

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !positionRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearTransient();
    setTrayOpen(false);
    setContextMenu(null);
    dragRef.current = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      startWindowX: positionRef.current.x,
      startWindowY: positionRef.current.y,
      scaleFactor: scaleFactorRef.current,
      lastScreenX: event.screenX,
      moved: false,
    };
  };

  const continueDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.screenX - drag.startScreenX;
    const deltaY = event.screenY - drag.startScreenY;
    const stepX = event.screenX - drag.lastScreenX;
    drag.lastScreenX = event.screenX;
    if (!drag.moved && petDragDistance(deltaX, deltaY) < PET_DRAG_THRESHOLD) return;
    drag.moved = true;
    setDragActivity((current) => petDragActivity(stepX, current));
    setDragAngle(petRollAngle(deltaX));
    queueWindowPosition({
      x: Math.round(drag.startWindowX + deltaX * drag.scaleFactor),
      y: Math.round(drag.startWindowY + deltaY * drag.scaleFactor),
    });
  };

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragActivity(null);
    setDragAngle(0);
    if (drag.moved) {
      playTransient("jumping", 620);
    } else if (!cancelled) {
      playTransient("waving", 720);
      openTask(primary.tabId);
    }
  };

  if (!snapshot?.enabled) return null;

  const isCompanionCube = snapshot.pet.id === PET_DEFAULT_ID;
  const statusActivity = petVisualActivity(primary.status);
  const visualActivity = dragActivity ?? transientActivity ?? statusActivity;
  const hasStatus = primary.status !== "idle";
  const overlayStyle: PetOverlayStyle | undefined =
    isCompanionCube && dragActivity ? { "--companion-roll-angle": `${dragAngle}deg` } : undefined;

  return (
    <PetErrorBoundary key={snapshot.pet.id}>
      <div
        className="pet-overlay-root"
        data-activity={visualActivity}
        data-status={primary.status}
        data-pet={snapshot.pet.packageId}
        data-tray-open={trayOpen}
        data-context-menu-open={contextMenu !== null}
        style={overlayStyle}
        onContextMenu={openContextMenu}
      >
        {hasStatus ? (
          <button
            type="button"
            className="pet-status-bubble"
            data-status={primary.status}
            aria-expanded={activeActivities.length > 1 ? trayOpen : undefined}
            onClick={() => {
              if (activeActivities.length > 1) setTrayOpen((open) => !open);
              else openTask(primary.tabId);
            }}
          >
            <span className="pet-status-dot" aria-hidden="true" />
            <span className="pet-status-copy">
              <span className="pet-status-label">{statusLabel(primary.status)}</span>
              <span className="pet-status-title">{primary.title}</span>
            </span>
            {activeActivities.length > 1 ? (
              <span className="pet-status-count">{activeActivities.length}</span>
            ) : null}
          </button>
        ) : null}

        {trayOpen && activeActivities.length > 1 ? (
          <ul className="pet-activity-tray" aria-label={t("pets.activityTray")}>
            {activeActivities.map((activity) => (
              <li key={activity.tabId}>
                <button
                  type="button"
                  className="pet-activity-row"
                  data-status={activity.status}
                  onClick={() => openTask(activity.tabId)}
                >
                  <span className="pet-status-dot" aria-hidden="true" />
                  <span className="pet-activity-copy">
                    <span>{activity.title}</span>
                    <small>{statusLabel(activity.status)}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {contextMenu ? (
          <div
            ref={contextMenuRef}
            className="pet-context-menu"
            role="menu"
            aria-label={t("pets.contextMenu")}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onKeyDown={handleContextMenuKeyDown}
            onMouseMove={handleContextMenuMouseMove}
            onPointerLeave={() => setContextMenuHighlightedIndex(-1)}
          >
            <button
              type="button"
              role="menuitem"
              data-highlighted={contextMenuHighlightedIndex === 0 || undefined}
              disabled={!activeTabId}
              onClick={() => openTask(activeTabId)}
            >
              <I.play size={14} />
              <span>{t("pets.contextOpenTask")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-highlighted={contextMenuHighlightedIndex === 1 || undefined}
              onClick={() => {
                setContextMenu(null);
                playTransient("waving", 820);
              }}
            >
              <I.paw size={14} />
              <span>{t("pets.contextInteract")}</span>
            </button>
            <hr className="pet-context-separator" />
            <button
              type="button"
              role="menuitem"
              data-highlighted={contextMenuHighlightedIndex === 2 || undefined}
              onClick={() => {
                setContextMenu(null);
                void resetPetPosition();
              }}
            >
              <I.rotate size={14} />
              <span>{t("pets.contextResetPosition")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              data-highlighted={contextMenuHighlightedIndex === 3 || undefined}
              onClick={() => requestOverlayAction("open-settings")}
            >
              <I.cog size={14} />
              <span>{t("pets.contextSettings")}</span>
            </button>
            <hr className="pet-context-separator" />
            <button
              type="button"
              role="menuitem"
              className="danger"
              data-highlighted={contextMenuHighlightedIndex === 4 || undefined}
              onClick={() => requestOverlayAction("hide")}
            >
              <I.x size={14} />
              <span>{t("pets.contextHide")}</span>
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className="pet-overlay-actor"
          aria-label={t("pets.openTask")}
          title={t("pets.dragHint")}
          onPointerDown={beginDrag}
          onPointerMove={continueDrag}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
          onClick={(event) => {
            if (event.detail === 0) openTask(primary.tabId);
          }}
        >
          <PetSprite
            pet={snapshot.pet}
            activity={visualActivity}
            lookAround={visualActivity === "idle" && !isCompanionCube}
            frameOverride={isCompanionCube && dragActivity ? 0 : undefined}
            className="pet-overlay-sprite"
          />
        </button>
      </div>
    </PetErrorBoundary>
  );
}
