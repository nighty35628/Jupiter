import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { setLang, t, useLang } from "../i18n";
import { PET_DRAG_THRESHOLD, petDragActivity, petDragDistance, petRollAngle } from "./overlay-drag";
import {
  PET_OVERLAY_OPEN_TASK_EVENT,
  PET_OVERLAY_READY_EVENT,
  PET_OVERLAY_SNAPSHOT_EVENT,
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
  const [dragActivity, setDragActivity] = useState<PetVisualActivity | null>(null);
  const [dragAngle, setDragAngle] = useState(0);
  const [transientActivity, setTransientActivity] = useState<PetVisualActivity | null>(null);
  const dragRef = useRef<DragSession | null>(null);
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

  useEffect(() => {
    if (!snapshot) return;
    const action = snapshot.enabled ? overlayWindow.show() : overlayWindow.hide();
    void action.catch(() => undefined);
  }, [overlayWindow, snapshot]);

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

  const openTask = useCallback((tabId: string) => {
    const payload: PetOverlayOpenTask = { tabId };
    void emitTo("main", PET_OVERLAY_OPEN_TASK_EVENT, payload).catch(() => undefined);
    setTrayOpen(false);
  }, []);

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !positionRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearTransient();
    setTrayOpen(false);
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
        style={overlayStyle}
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
