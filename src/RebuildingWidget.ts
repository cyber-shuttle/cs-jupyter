// Shared render loop for widgets that redraw their whole DOM from state.
// Rebuild fully, then restore only focus, by data-session-action; a shared clock
// then re-renders while _counting() reports a live countdown. Disclosure state is
// tracked separately, in each widget's own open set. PanelBoundWidget redraws
// on every panel state change and disconnects on dispose; a subclass overriding
// _onStateChanged calls super first so the state is stored.
import { Widget } from "@lumino/widgets";
import { errorMessage } from "./Common";
import { Clock } from "./dom";
import type { CyberShuttlePanel } from "./CyberShuttlePanel";
import type { ISessionUiState } from "./session";

export abstract class RebuildingWidget extends Widget {
  private _clock = new Clock(() => this._render());
  protected abstract _rebuild(): void;
  protected _counting(): boolean {
    return false;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._clock.stop();
    super.dispose();
  }

  protected _render(): void {
    const action = this.node.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.sessionAction
      : undefined;
    this._rebuild();
    if (action !== undefined) {
      Array.from(
        this.node.querySelectorAll<HTMLElement>("[data-session-action]"),
      )
        .find((control) => control.dataset.sessionAction === action)
        ?.focus();
    }
    this._clock.sync(this._counting());
  }
}

export abstract class PanelBoundWidget extends RebuildingWidget {
  protected _state: ISessionUiState;

  constructor(protected _panel: CyberShuttlePanel) {
    super();
    this._state = _panel.state;
    this._panel.stateChanged.connect(this._onStateChanged, this);
  }

  dispose(): void {
    this._panel.stateChanged.disconnect(this._onStateChanged, this);
    super.dispose();
  }

  protected _onStateChanged(
    _sender: CyberShuttlePanel,
    state: ISessionUiState,
  ): void {
    this._state = state;
    this._render();
  }
}

export abstract class RemoteListWidget extends RebuildingWidget {
  protected _busy = false;
  protected _error = "";
  protected _confirming = "";
  protected _saving = false;
  protected _formError = "";

  abstract refresh(): Promise<void>;

  protected async _submitForm(submit: () => Promise<void>): Promise<void> {
    this._saving = true;
    this._formError = "";
    this._sync();
    try {
      await submit();
      if (this.isDisposed) {
        return;
      }
      this._saving = false;
      await this.refresh();
    } catch (error) {
      this._formError = errorMessage(error);
      this._saving = false;
      this._sync();
    }
  }

  protected _sync(): void {
    if (!this.isDisposed) {
      this._render();
    }
  }

  protected _confirm(name: string): void {
    this._confirming = name;
    this._sync();
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
