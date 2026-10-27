// Undo/redo stack. Each entry knows how to apply and revert itself.

export interface HistoryEntry {
  description: string;
  apply(): void;
  revert(): void;
  /** Cursor row to jump to on undo/redo, if any. */
  row?: number;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private savedAt: HistoryEntry | null = null;
  private chain: HistoryEntry[] | null = null;
  limit = 500;

  /** Applies the entry and records it. */
  push(entry: HistoryEntry): void {
    entry.apply();
    if (this.chain) {
      this.chain.push(entry);
      return;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Groups every push until finishChain() into one undo step. */
  startChain(): void {
    this.chain = [];
  }

  finishChain(description: string): void {
    const entries = this.chain ?? [];
    this.chain = null;
    if (!entries.length) return;
    if (entries.length === 1) {
      this.undoStack.push(entries[0]);
    } else {
      this.undoStack.push({
        description,
        row: entries[0].row,
        apply: () => entries.forEach((e) => e.apply()),
        revert: () => [...entries].reverse().forEach((e) => e.revert()),
      });
    }
    this.redoStack = [];
  }

  undo(): HistoryEntry | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.revert();
    this.redoStack.push(e);
    return e;
  }

  redo(): HistoryEntry | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.apply();
    this.undoStack.push(e);
    return e;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.savedAt = null;
  }

  markSaved(): void {
    this.savedAt = this.undoStack[this.undoStack.length - 1] ?? null;
  }

  get isDirty(): boolean {
    return (this.undoStack[this.undoStack.length - 1] ?? null) !== this.savedAt;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
