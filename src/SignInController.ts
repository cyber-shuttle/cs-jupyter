// The panel's sign-in state machine: signing in, signing out, and sign in
// again after a poll's auth failure. Bootstrapping after sign-in and dropping
// cached Jupyter access on sign-out are the panel's own concern. A credential
// already restored on page load counts as a live sign-in, not one still
// requested.
import { AuthInteractionRequiredError } from "./AuthClient";
import { errorMessage } from "./Common";
import type { ControlClient } from "./ControlClient";

interface ISignInHooks {
  isDisposed: () => boolean;
  emitState: () => void;
  activate: () => Promise<void>;
  stopPolling: () => void;
  setUpdatesStatus: (message: string) => void;
  onError: (message: string) => void;
}

export class SignInController {
  private _signedIn = false;
  private _signingIn = false;
  private _signInPromise: Promise<void> | undefined;

  constructor(
    private _api: ControlClient,
    private _hooks: ISignInHooks,
  ) {}

  get signedIn(): boolean {
    return this._signedIn;
  }

  get signingIn(): boolean {
    return this._signingIn;
  }

  get account(): string | undefined {
    return this._signedIn ? this._api.account : undefined;
  }

  signIn(): Promise<void> {
    if (!this._signInPromise) {
      this._signingIn = true;
      this._hooks.onError("");
      this._hooks.emitState();
      this._signInPromise = this._signIn().finally(() => {
        this._signingIn = false;
        this._signInPromise = undefined;
        if (!this._hooks.isDisposed()) this._hooks.emitState();
      });
    }
    return this._signInPromise;
  }

  private async _signIn(): Promise<void> {
    try {
      await this._api.signIn();
      if (this._hooks.isDisposed()) return;
      await this._activate();
    } catch (error) {
      if (!this._hooks.isDisposed()) {
        if (error instanceof AuthInteractionRequiredError) {
          this.requireAuthentication();
        } else {
          this._hooks.onError(errorMessage(error));
        }
      }
    }
  }

  signOut(): void {
    this._api.signOut();
    this._hooks.stopPolling();
    this._signedIn = false;
  }

  async resume(): Promise<void> {
    try {
      await this._api.resumeSignIn();
    } catch {
      return;
    }
    if (!this._hooks.isDisposed()) await this._activate();
  }

  requireAuthentication(): void {
    if (this._hooks.isDisposed()) return;
    this._signedIn = false;
    this._hooks.stopPolling();
    this._hooks.setUpdatesStatus("Sign in again to resume session updates.");
  }

  private async _activate(): Promise<void> {
    this._signedIn = true;
    await this._hooks.activate();
  }
}
