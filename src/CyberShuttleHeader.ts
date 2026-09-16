// The title row is the one fixed part of the launcher UI, built as its own
// widget. Signed out it shows a single sign-in button. Signed in the same
// control names the account and hides sign-out behind a menu.
import { Signal } from "@lumino/signaling";
import { RebuildingWidget } from "./RebuildingWidget";
import { emptyState, type ISessionUiState } from "./session-ui-state";
import { button, element } from "./dom";

export class CyberShuttleHeader extends RebuildingWidget {
  readonly signInRequested = new Signal<this, void>(this);
  readonly signOutRequested = new Signal<this, void>(this);

  private _state = emptyState();
  private _accountMenuOpen = false;

  constructor() {
    super();
    this.addClass("csSessionHeaderWidget");
    this._render();
  }

  setState(state: ISessionUiState): void {
    this._state = state;
    this._render();
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const header = element(
      "header",
      "",
      "jp-Launcher-sectionHeader csSessionLauncherHeader",
    );
    const title = element("h2", "CyberShuttle", "jp-Launcher-sectionTitle");
    header.append(
      element("div", "", "csSessionSectionIcon"),
      title,
      this._identityControl(),
    );
    this.node.appendChild(header);
  }

  private _identityControl(): HTMLElement {
    const holder = element("div", "", "csIdentity");
    if (!this._state.signedIn) {
      const signIn = button("", "csTextButton csIdentityButton csSignInButton");
      signIn.append(
        userGlyph(),
        element("span", this._state.signingIn ? "Signing in…" : "Sign in"),
      );
      signIn.dataset.sessionAction = "sign-in";
      signIn.disabled = this._state.signingIn;
      signIn.onclick = () => this.signInRequested.emit(undefined);
      holder.appendChild(signIn);
      return holder;
    }
    const trigger = button("", "csTextButton csIdentityButton csAccountButton");
    trigger.append(
      userGlyph(),
      element("span", this._state.account ?? "Account"),
    );
    trigger.dataset.sessionAction = "account";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", String(this._accountMenuOpen));
    trigger.onclick = () => {
      this._accountMenuOpen = !this._accountMenuOpen;
      this._render();
    };
    holder.appendChild(trigger);
    if (this._accountMenuOpen) {
      const menu = element("div", "", "csAccountMenu", { role: "menu" });
      const signOut = button("Sign out", "csAccountMenuItem");
      signOut.dataset.sessionAction = "sign-out";
      signOut.setAttribute("role", "menuitem");
      signOut.onclick = () => {
        this._accountMenuOpen = false;
        this.signOutRequested.emit(undefined);
      };
      menu.appendChild(signOut);
      holder.appendChild(menu);
    }
    return holder;
  }
}

function userGlyph(): SVGSVGElement {
  const holder = element("div", "");
  holder.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><circle cx="10" cy="10" r="8.6" /><circle cx="10" cy="8.2" r="2.6" /><path d="M5.3 16.5a5 5 0 0 1 9.4 0" /></g></svg>`;
  return holder.firstElementChild as SVGSVGElement;
}
