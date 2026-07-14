export type DesktopTurnGeneration = number;

/** Single-flight lease for one desktop tab. */
export class DesktopTurnAdmission {
  private nextGeneration = 0;
  private activeGeneration: DesktopTurnGeneration | null = null;

  begin(): DesktopTurnGeneration | null {
    if (this.activeGeneration !== null) return null;
    const generation = ++this.nextGeneration;
    this.activeGeneration = generation;
    return generation;
  }

  isCurrent(generation: DesktopTurnGeneration): boolean {
    return this.activeGeneration === generation;
  }

  finish(generation: DesktopTurnGeneration): boolean {
    if (!this.isCurrent(generation)) return false;
    this.activeGeneration = null;
    return true;
  }

  invalidate(): void {
    this.nextGeneration += 1;
    this.activeGeneration = null;
  }

  get running(): boolean {
    return this.activeGeneration !== null;
  }
}
