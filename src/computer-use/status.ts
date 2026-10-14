export interface ComputerUseStatus {
  state:
    | "disabled"
    | "unsupported-surface"
    | "unsupported-model"
    | "driver-missing"
    | "idle"
    | "starting"
    | "ready"
    | "busy"
    | "fault";
  reason?: string;
  owner?: string;
  permissions: {
    screen: "unknown" | "verified" | "denied";
    input: "unknown" | "verified" | "denied";
  };
}
