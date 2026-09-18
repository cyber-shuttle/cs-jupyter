// Dev Tunnels link dialog: shows the linked provider and account, offers to
// unlink, or, when unlinked, starts and polls the device flow for Microsoft or
// GitHub through cs-control. Session create and run-again reopen this same
// widget when cs-control refuses for want of a link, and `onLinked` tells the
// caller to retry once linking succeeds. Polling paces itself by the server's
// intervalSeconds alone; server-side backoff is the upgrade if 429s appear.
import { RemoteListWidget } from "./RebuildingWidget";
import { errorMessage, type TunnelProvider } from "./Common";
import { ControlClient, type ITunnelLinkStatus } from "./ControlClient";
import { showDeviceCodeDialog } from "./DeviceCodeDialog";
import { button, confirmDelete, dialogBody, element } from "./dom";

const PROVIDER_LABEL: Record<TunnelProvider, string> = {
  microsoft: "Microsoft",
  github: "GitHub",
};

const MICROSOFT_GLYPH = `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="currentColor"><rect x="2.5" y="2.5" width="6.8" height="6.8" /><rect x="10.7" y="2.5" width="6.8" height="6.8" /><rect x="2.5" y="10.7" width="6.8" height="6.8" /><rect x="10.7" y="10.7" width="6.8" height="6.8" /></g></svg>`;
const GITHUB_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>`;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class TunnelLink extends RemoteListWidget {
  onLinked: (() => void) | undefined;
  private _status: ITunnelLinkStatus | undefined;
  private _linking: TunnelProvider | undefined;

  constructor(private _api: ControlClient) {
    super();
    this.id = "cybershuttle-tunnel-link";
    this.addClass("csSessionPanel");
    this._render();
  }

  async refresh(): Promise<void> {
    await this._refreshing(async () => {
      this._status = await this._api.getTunnelLink();
    });
  }

  private async _link(provider: TunnelProvider): Promise<void> {
    this._linking = provider;
    this._error = "";
    this._sync();
    let dialog: { close(): void } | undefined;
    try {
      const start = await this._api.startTunnelLink(provider);
      dialog = showDeviceCodeDialog(
        {
          label: PROVIDER_LABEL[provider],
          userCode: start.userCode,
          verificationUri: start.verificationUri,
        },
        () => {
          this._linking = undefined;
          this._sync();
        },
      );
      let interval = start.intervalSeconds * 1000;
      const deadline = Date.now() + start.expiresInSeconds * 1000;
      while (this._linking === provider) {
        if (Date.now() >= deadline) {
          throw new Error(
            `${PROVIDER_LABEL[provider]} device sign-in expired.`,
          );
        }
        await sleep(interval);
        if (this._linking !== provider) return;
        const poll = await this._api.pollTunnelLink(start.handle);
        if ("status" in poll) {
          interval = poll.intervalSeconds * 1000;
          continue;
        }
        this._status = poll;
        this._linking = undefined;
        this._sync();
        this.onLinked?.();
        return;
      }
    } catch (error) {
      if (this.isDisposed) return;
      this._error = errorMessage(error);
      this._linking = undefined;
      this._sync();
    } finally {
      dialog?.close();
    }
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = dialogBody(
      "Sessions run over your own Dev Tunnels account, linked once and kept by cs-control.",
      this._error,
    );
    if (this._status?.linked) {
      card.appendChild(this._linkedEntry(this._status));
    } else if (!this._busy) {
      card.appendChild(this._linkButtons());
    }
    scroll.appendChild(card);
    this.node.appendChild(root);
  }

  private _linkedEntry(
    status: Extract<ITunnelLinkStatus, { linked: true }>,
  ): HTMLElement {
    const row = element("div", "", "csSshKeyRow");
    row.append(
      element("span", PROVIDER_LABEL[status.provider], "csCardTitle"),
      element("span", status.account ?? "", "csMeta"),
    );
    if (this._confirming === "unlink") {
      row.append(
        ...confirmDelete(
          "Unlink Dev Tunnels?",
          "unlink-tunnel",
          () => {
            this._confirming = "";
            this._render();
          },
          () =>
            void this._removeItem(() =>
              this._api.removeTunnelLink().then(() => undefined),
            ),
        ),
      );
      return row;
    }
    const unlink = button("Unlink", "csDangerButton", () => {
      this._confirming = "unlink";
      this._render();
    });
    unlink.dataset.sessionAction = "unlink-tunnel";
    row.appendChild(unlink);
    return row;
  }

  private _linkButtons(): HTMLElement {
    const holder = element("div", "", "csSshAddForm");
    for (const provider of ["microsoft", "github"] as const) {
      const item = button(
        "",
        "csSecondaryButton csIdentityButton",
        () => void this._link(provider),
      );
      item.disabled = this._linking !== undefined;
      item.innerHTML =
        provider === "microsoft" ? MICROSOFT_GLYPH : GITHUB_GLYPH;
      item.append(element("span", `Link ${PROVIDER_LABEL[provider]}`));
      item.dataset.sessionAction = `link-${provider}`;
      holder.appendChild(item);
    }
    return holder;
  }
}
