import { randomUUID } from "node:crypto";

export type ComputerUsePermissionMode = "standard" | "bounded" | "unrestricted";

export interface ScreenBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleFactor?: number;
}

export interface ComputerUseObservation {
  id: string;
  epoch: number;
  capturedAt: number;
  imageWidth: number;
  imageHeight: number;
  screen: ScreenBounds;
  windowId?: string;
}

export interface ComputerUsePoint {
  x: number;
  y: number;
}

export interface ComputerUseClick {
  type: "click";
  observationId: string;
  x: number;
  y: number;
  button?: "left" | "middle" | "right";
}

export interface ComputerUseMove {
  type: "move";
  observationId: string;
  x: number;
  y: number;
}

export interface ComputerUseScroll {
  type: "scroll";
  observationId: string;
  x: number;
  y: number;
  direction: "up" | "down" | "left" | "right";
  amount?: number;
}

export interface ComputerUseType {
  type: "type";
  observationId: string;
  text: string;
}

export type ComputerUseAction =
  | ComputerUseClick
  | ComputerUseMove
  | ComputerUseScroll
  | ComputerUseType;

export interface ComputerUseFence {
  owner: string;
  epoch: number;
  leaseToken: string;
}

export function newObservationId(): string {
  return `obs-${randomUUID()}`;
}

export function mapObservationPoint(
  observation: ComputerUseObservation,
  point: ComputerUsePoint,
): ComputerUsePoint {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= observation.imageWidth ||
    point.y >= observation.imageHeight
  ) {
    throw new Error("Computer Use point is outside the observation bounds");
  }
  return {
    x: Math.round(
      observation.screen.left + (point.x / observation.imageWidth) * observation.screen.width,
    ),
    y: Math.round(
      observation.screen.top + (point.y / observation.imageHeight) * observation.screen.height,
    ),
  };
}
