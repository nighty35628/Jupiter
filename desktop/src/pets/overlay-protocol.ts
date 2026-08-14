import type { Lang } from "../i18n";
import type { Theme, ThemeStyle } from "../theme";
import type { PetDefinition, PetOutcome } from "./types";

export const PET_OVERLAY_WINDOW_LABEL = "pet-overlay";
export const PET_OVERLAY_SNAPSHOT_EVENT = "jupiter://pet-overlay/snapshot";
export const PET_OVERLAY_READY_EVENT = "jupiter://pet-overlay/ready";
export const PET_OVERLAY_OPEN_TASK_EVENT = "jupiter://pet-overlay/open-task";
export const PET_OVERLAY_ACTION_EVENT = "jupiter://pet-overlay/action";

export type PetTaskStatus = "waiting" | "blocked" | "ready" | "working" | "thinking" | "idle";

export type PetTaskActivity = {
  tabId: string;
  title: string;
  status: PetTaskStatus;
  active: boolean;
  updatedAt: number;
  completionSequence: number;
  completionOutcome: PetOutcome;
};

export type PetOverlaySnapshot = {
  version: 1;
  enabled: boolean;
  pet: PetDefinition;
  activeTabId: string;
  activities: PetTaskActivity[];
  language: Lang;
  theme: Theme;
  themeStyle: ThemeStyle;
};

export type PetOverlayOpenTask = {
  tabId: string;
};

export type PetOverlayAction = {
  action: "open-settings" | "hide";
};
