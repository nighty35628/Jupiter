export type DesktopTurnGeneration = number;
export type DesktopTurnKind = "ask" | "agent";

/** Single-flight lease for one desktop tab. */
export class DesktopTurnAdmission {
  private nextGeneration = 0;
  private activeGeneration: DesktopTurnGeneration | null = null;
  private activeKind: DesktopTurnKind | null = null;
  private agentLoopEntered = false;

  begin(kind: DesktopTurnKind = "agent"): DesktopTurnGeneration | null {
    if (this.activeGeneration !== null) return null;
    const generation = ++this.nextGeneration;
    this.activeGeneration = generation;
    this.activeKind = kind;
    this.agentLoopEntered = false;
    return generation;
  }

  isCurrent(generation: DesktopTurnGeneration): boolean {
    return this.activeGeneration === generation;
  }

  enterAgentLoop(generation: DesktopTurnGeneration): boolean {
    if (!this.isCurrent(generation) || this.activeKind !== "agent") return false;
    this.agentLoopEntered = true;
    return true;
  }

  finish(generation: DesktopTurnGeneration): boolean {
    if (!this.isCurrent(generation)) return false;
    this.activeGeneration = null;
    this.activeKind = null;
    this.agentLoopEntered = false;
    return true;
  }

  invalidate(): void {
    this.nextGeneration += 1;
    this.activeGeneration = null;
    this.activeKind = null;
    this.agentLoopEntered = false;
  }

  get running(): boolean {
    return this.activeGeneration !== null;
  }

  get kind(): DesktopTurnKind | null {
    return this.activeKind;
  }

  get loopEntered(): boolean {
    return this.agentLoopEntered;
  }
}
