// The review step: cs-plane validates the generated Slurm script before
// submission. The script is shown only when validation fails. The busy flag is
// passed in from the composing form's submission state, not mirrored here.
import {
  errorMessage,
  ISessionCreateRequest,
  ISessionValidation,
} from "./Common";
import { ControlClient } from "./ControlClient";
import { button, copyText, element } from "./dom";

export interface IReviewStepHooks {
  onBack: () => void;
  onSubmit: (request: ISessionCreateRequest) => void;
  isDisposed: () => boolean;
  onChange: () => void;
}

export class ReviewStep {
  private _request: ISessionCreateRequest | undefined;
  private _validation: ISessionValidation | undefined;
  private _validationError = "";
  private _validating = false;
  private _abort: AbortController | undefined;
  private _submit: HTMLButtonElement | undefined;
  private _status: HTMLElement | undefined;
  private _errorNode: HTMLElement | undefined;
  private _sync: (() => void) | undefined;
  private _busy = false;

  constructor(private _api: ControlClient) {}

  get isActive(): boolean {
    return !!this._request;
  }

  private get _passed(): boolean {
    return this._validation?.status === "PASSED";
  }

  private get _failed(): boolean {
    return this._validation?.status === "FAILED";
  }

  start(request: ISessionCreateRequest): void {
    this.leave();
    this._request = request;
  }

  leave(): void {
    this.cancel();
    this._request = undefined;
    this._validation = undefined;
    this._validationError = "";
    this._submit = undefined;
    this._status = undefined;
    this._errorNode = undefined;
    this._sync = undefined;
  }

  cancel(): void {
    this._abort?.abort();
    this._abort = undefined;
    this._validating = false;
  }

  async validate(hooks: IReviewStepHooks): Promise<void> {
    const request = this._request;
    if (!request || hooks.isDisposed()) return;
    this.cancel();
    const abort = new AbortController();
    this._abort = abort;
    const current = (): boolean =>
      !abort.signal.aborted && this._request === request && !hooks.isDisposed();
    this._validation = undefined;
    this._validationError = "";
    this._validating = true;
    hooks.onChange();
    try {
      const validation = await this._api.validateCreateRequest(
        request,
        abort.signal,
      );
      if (current()) {
        this._validation = validation;
      }
    } catch (error) {
      if (current()) {
        this._validationError = errorMessage(error);
      }
    }
    if (current()) {
      this._validating = false;
      this._abort = undefined;
      hooks.onChange();
    }
  }

  private _validationState(): { text: string; modifier: string } {
    if (this._validating) {
      return {
        text: "Validating with Slurm…",
        modifier: "csValidationStatusBusy",
      };
    }
    if (this._validation) {
      return {
        text: `Validation ${this._passed ? "passed" : "failed"}. ${this._validation.message}`,
        modifier: this._passed ? "csValidationPassed" : "csValidationFailed",
      };
    }
    return {
      text: this._validationError || "Script unavailable.",
      modifier: this._validationError ? "csValidationFailed" : "",
    };
  }

  sync(busy: boolean, formError: string): void {
    this._busy = busy;
    if (this._submit) {
      this._submit.replaceChildren(
        ...(busy ? [element("span", "", "csSpinner")] : []),
        document.createTextNode(busy ? "Submitting…" : "Submit"),
      );
      this._submit.disabled = busy || this._validating || !this._passed;
    }
    if (this._status) {
      const { text, modifier } = this._validationState();
      this._status.replaceChildren(
        ...(this._validating ? [element("span", "", "csSpinner")] : []),
        document.createTextNode(text),
      );
      this._status.className = `csValidationStatus ${modifier}`.trim();
    }
    if (this._errorNode) {
      const failed = !!formError || !!this._validationError || this._failed;
      const detail =
        formError || this._validation?.stderr || this._validationError;
      this._errorNode.textContent = detail;
      this._errorNode.hidden = !detail;
      this._errorNode.className = `csValidationError${failed ? "" : " csValidationDetail"}`;
    }
    this._sync?.();
  }

  build(hooks: IReviewStepHooks): HTMLElement {
    const request = this._request;
    if (!request) {
      throw new Error("Session review request is unavailable.");
    }
    const review = element("section", "", "csSessionReview");
    const heading = element("h2", "Review Slurm job", "csStepHeading");
    const description = element(
      "p",
      "cs-plane validates the generated Slurm script before submission; the script appears only if validation fails.",
      "csMeta",
    );
    const scriptHeader = element("div", "", "csScriptHeader");
    const scriptLabel = element("label", "Generated Slurm script", "csLabel", {
      for: "cybershuttle-slurm-script",
    });
    const copy = button("Copy script", "csSecondaryButton", () => {
      const generatedScript = this._validation?.script ?? "";
      if (generatedScript) {
        void copyText(generatedScript);
      }
    });
    scriptHeader.append(scriptLabel, copy);
    const script = element("pre", "", "csSlurmScript", {
      id: "cybershuttle-slurm-script",
      tabindex: "0",
    });
    const status = element("div", "", "csValidationStatus", {
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    });
    this._status = status;
    const validationError = element("pre", "", "csValidationError");
    this._errorNode = validationError;
    const retry = button("Retry validation", "csSecondaryButton", () => {
      void this.validate(hooks);
    });
    const footer = element("div", "", "csFormFooter");
    const back = button("Back", "csSecondaryButton", hooks.onBack);
    const submit = button("Submit", "csPrimaryButton", () => {
      if (!this._busy && !this._validating && this._passed && this._request) {
        hooks.onSubmit(this._request);
      }
    });
    this._submit = submit;
    footer.append(back, submit);
    this._sync = () => {
      const generatedScript = this._validation?.script ?? "";
      script.textContent = generatedScript;
      copy.disabled = !generatedScript;
      scriptHeader.hidden = script.hidden = !this._failed || !generatedScript;
      retry.hidden =
        this._validating || (!this._validationError && !this._failed);
    };
    review.append(
      heading,
      description,
      scriptHeader,
      script,
      status,
      validationError,
      retry,
      footer,
    );
    return review;
  }
}
