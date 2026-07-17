export const PET_ATLAS_COLUMNS = 8;
export const PET_ATLAS_ROWS = 11;
export const PET_DEFAULT_ID = "builtin:companion-cube";
export const PET_PREFERENCES_STORAGE_KEY = "jupiter.desktopPet.v1";

export type PetBaseActivity = "idle" | "thinking" | "working" | "waiting";
export type PetOutcome = "success" | "failure" | null;
export type PetVisualActivity =
  | "idle"
  | "dragging-right"
  | "dragging-left"
  | "waving"
  | "jumping"
  | "failure"
  | "waiting"
  | "running"
  | "review";

export type DesktopPetPreferences = {
  enabled: boolean;
  selectedId: string;
};

export type PetDefinition = {
  id: string;
  packageId: string;
  displayName: string;
  description: string;
  source: "builtin" | "custom";
  spriteUrl: string;
  thumbnailUrl?: string;
  atlasWidth: number;
  atlasHeight: number;
  pixelated: boolean;
  spriteVersionNumber: 2;
};

export type CustomPetRecord = {
  id: string;
  displayName: string;
  description?: string;
  spriteVersionNumber: 2;
  spritePath: string;
  thumbnailPath?: string;
};

export type CustomPetError = {
  packageId: string;
  message: string;
};

export type CustomPetScanResult = {
  root: string;
  pets: CustomPetRecord[];
  errors: CustomPetError[];
};

export type PetCatalogState = {
  root: string | null;
  customPets: PetDefinition[];
  errors: CustomPetError[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
};

export type DesktopPetUi = {
  preferences: DesktopPetPreferences;
  builtins: readonly PetDefinition[];
  catalog: PetCatalogState;
  selectedPet: PetDefinition;
  selectedUnavailable: boolean;
  setEnabled: (enabled: boolean) => void;
  selectPet: (id: string) => void;
  refreshCustomPets: () => Promise<void>;
  openCustomPetDirectory: () => Promise<void>;
};

export type PetTabActivity = {
  busy: boolean;
  activeToolCalls: readonly string[];
  pendingApprovals: readonly string[];
  skillRunning: boolean;
  turnFailed: boolean;
  turnAborted: boolean;
  completionSequence: number;
  completionOutcome: PetOutcome;
  resetSequence: number;
  updatedAt: number;
};

export const DEFAULT_PET_PREFERENCES: DesktopPetPreferences = {
  enabled: false,
  selectedId: PET_DEFAULT_ID,
};

export const EMPTY_PET_TAB_ACTIVITY: PetTabActivity = {
  busy: false,
  activeToolCalls: [],
  pendingApprovals: [],
  skillRunning: false,
  turnFailed: false,
  turnAborted: false,
  completionSequence: 0,
  completionOutcome: null,
  resetSequence: 0,
  updatedAt: 0,
};
