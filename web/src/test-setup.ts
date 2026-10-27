import '@testing-library/jest-dom/vitest';

// Node 26 ships its own `localStorage` global that stays undefined unless
// --localstorage-file is passed, which shadows jsdom's implementation here.
class MemoryStorage implements Storage {
  #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, String(value));
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  clear(): void {
    this.#items.clear();
  }
}

if (!globalThis.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
}
