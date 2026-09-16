// Shared render loop for widgets that redraw their whole DOM from state.
// Rebuild fully, then restore only focus, by data-session-action; a shared clock
// then re-renders while _counting() reports a live countdown. Disclosure state is
// tracked separately, in each widget's own open set.
import { Widget } from "@lumino/widgets";
import { errorMessage } from "./Common";
import { Clock } from "./dom";

export abstract class RebuildingWidget extends Widget {
  private _clock = new Clock(() => this._render());
  protected abstract _rebuild(): void;
  protected _counting(): boolean {
    return false;
  }

  dispose(): void {
    this._clock.stop();
    super.dispose();
  }

  protected _render(): void {
    const action = this.node.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.sessionAction
      : undefined;
    this._rebuild();
    if (action !== undefined) {
      for (const control of Array.from(
        this.node.querySelectorAll<HTMLElement>("[data-session-action]"),
      )) {
        if (control.dataset.sessionAction === action) {
          control.focus();
          break;
        }
      }
    }
    this._clock.sync(this._counting());
  }
}

export abstract class RemoteListWidget extends RebuildingWidget {
  protected _busy = false;
  protected _error = "";
  protected _confirming = "";

  abstract refresh(): Promise<void>;

  protected _sync(): void {
    if (!this.isDisposed) {
      this._render();
    }
  }

  protected async _refreshing(load: () => Promise<void>): Promise<void> {
    this._busy = true;
    this._error = "";
    this._sync();
    try {
      await load();
    } catch (error) {
      this._error = errorMessage(error);
    } finally {
      this._busy = false;
      this._sync();
    }
  }

  protected async _removeItem(remove: () => Promise<void>): Promise<void> {
    this._confirming = "";
    try {
      await remove();
      await this.refresh();
    } catch (error) {
      this._error = errorMessage(error);
      this._sync();
    }
  }
}
