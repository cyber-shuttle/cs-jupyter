// Vitest global setup: configures JupyterLab's PageConfig and patches jsdom APIs
// the test environment lacks: Vitest's jsdom leaves window.localStorage and
// sessionStorage undefined, and jsdom 26 declares HTMLDialogElement but
// implements neither showModal nor close.
import { PageConfig } from "@jupyterlab/coreutils";

PageConfig.setOption(
  "cybershuttleControlApiUrl",
  "http://localhost:8045/api/v1",
);
class TestStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: new TestStorage(),
});
Object.defineProperty(window, "sessionStorage", {
  configurable: true,
  value: new TestStorage(),
});

Object.defineProperty(globalThis, "DragEvent", {
  value: class extends MouseEvent {},
  configurable: true,
});

HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  this.open = false;
};

globalThis.requestIdleCallback = (callback) =>
  window.setTimeout(
    () => callback({ didTimeout: false, timeRemaining: () => 50 }),
    0,
  );
globalThis.cancelIdleCallback = (handle) => window.clearTimeout(handle);

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});
