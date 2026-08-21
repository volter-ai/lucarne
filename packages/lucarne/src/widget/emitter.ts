// A tiny, dependency-free pub/sub — the ONE piece of "framework" the runtime core is allowed to lean on (see
// LS-15 dev/03's grep gate: the core must stay framework-free DOM + this emitter; a UI-library import belongs
// only under the dedicated adapter subpath, kept separate from this core).
export type Listener<T> = (value: T) => void;
export type Unsubscribe = () => void;

export class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  on(cb: Listener<T>): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(value: T): void {
    for (const cb of [...this.listeners]) cb(value);
  }

  clear(): void {
    this.listeners.clear();
  }
}
