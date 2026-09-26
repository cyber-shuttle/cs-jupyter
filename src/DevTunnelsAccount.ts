// Dev Tunnels account dialog: one box per provider, the connected one a ticked
// box naming the account with Disconnect inside it, the other a button that
// starts and polls the device flow through cs-plane. The account is optional:
// it lets a session choose a Dev Tunnel besides cs-plane's own link.
// Polling paces itself by cs-plane's intervalSeconds alone; backoff in
// cs-plane is the upgrade if 429s appear.
import { RemoteListWidget } from "./RebuildingWidget";
import {
  DEVTUNNELS_PROVIDERS,
  errorMessage,
  type DevTunnelsProvider,
} from "./Common";
import { PlaneClient, type IDevTunnelsAccountStatus } from "./PlaneClient";
import { showDeviceCodeDialog } from "./DeviceCodeDialog";
import { button, confirmDelete, dialogBody, element } from "./dom";

const PROVIDER_LABEL: Record<DevTunnelsProvider, string> = {
  microsoft: "Microsoft",
  github: "GitHub",
};

const PROVIDER_GLYPH: Record<DevTunnelsProvider, string> = {
  microsoft: `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="currentColor"><rect x="2.5" y="2.5" width="6.8" height="6.8" /><rect x="10.7" y="2.5" width="6.8" height="6.8" /><rect x="2.5" y="10.7" width="6.8" height="6.8" /><rect x="10.7" y="10.7" width="6.8" height="6.8" /></g></svg>`,
  github: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>`,
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export class DevTunnelsAccount extends RemoteListWidget {
  private _status: IDevTunnelsAccountStatus | undefined;
  private _connecting: DevTunnelsProvider | undefined;

  constructor(private _api: PlaneClient) {
    super();
    this.id = "cybershuttle-devtunnels-account";
    this.addClass("csSessionPanel");
    this._render();
  }

  async refresh(): Promise<void> {
    await this._refreshing(async () => {
      this._status = await this._api.getDevTunnelsAccount();
    });
  }

  private async _connect(provider: DevTunnelsProvider): Promise<void> {
    this._connecting = provider;
    this._error = "";
    this._sync();
    let dialog: { close(): void } | undefined;
    try {
      const start = await this._api.connectDevTunnelsAccount(provider);
      dialog = showDeviceCodeDialog(
        {
          label: PROVIDER_LABEL[provider],
          userCode: start.userCode,
          verificationUri: start.verificationUri,
        },
        () => {
          this._connecting = undefined;
          this._sync();
        },
      );
      let interval = start.intervalSeconds * 1000;
      const deadline = Date.now() + start.expiresInSeconds * 1000;
      while (this._connecting === provider) {
        if (Date.now() >= deadline) {
          throw new Error(
            `${PROVIDER_LABEL[provider]} device sign-in expired.`,
          );
        }
        await sleep(interval);
        if (this._connecting !== provider) return;
        const poll = await this._api.pollDevTunnelsAccount(start.handle);
        if (poll.status === "pending") {
          interval = poll.intervalSeconds * 1000;
          continue;
        }
        this._status = poll;
        this._connecting = undefined;
        this._sync();
        return;
      }
    } catch (error) {
      if (this.isDisposed) return;
      this._error = errorMessage(error);
      this._connecting = undefined;
      this._sync();
    } finally {
      dialog?.close();
    }
  }

  protected _rebuild(): void {
    this.node.textContent = "";
    const { root, scroll, card } = dialogBody(
      "Connect a Dev Tunnels account to let a session use a Dev Tunnel. Optional; cs-plane keeps the credential.",
      this._error,
    );
    if (!this._busy) {
      card.appendChild(this._providers());
    }
    scroll.appendChild(card);
    this.node.appendChild(root);
  }

  private _providers(): HTMLElement {
    const holder = element("div", "", "csSshAddForm csDevTunnelsProviders");
    for (const provider of DEVTUNNELS_PROVIDERS) {
      const connected =
        this._status?.connected && this._status.provider === provider
          ? this._status
          : undefined;
      holder.appendChild(
        connected
          ? this._connectedCard(connected)
          : this._connectButton(provider),
      );
    }
    return holder;
  }

  private _connectedCard(
    status: Extract<IDevTunnelsAccountStatus, { connected: true }>,
  ): HTMLElement {
    const row = element("div", "", "csDevTunnelsCard");
    row.innerHTML = PROVIDER_GLYPH[status.provider];
    const account = element("span", "", "csDevTunnelsAccountName");
    account.append(
      element(
        "span",
        `\u2713 ${PROVIDER_LABEL[status.provider]}`,
        "csCardTitle",
      ),
      element("span", status.account ?? "", "csMeta"),
    );
    row.appendChild(account);
    if (this._confirming === "disconnect") {
      row.append(
        ...confirmDelete(
          "Disconnect this Dev Tunnels account?",
          "disconnect-devtunnels",
          () => this._confirm(""),
          () =>
            void this._deleteItem(() =>
              this._api.disconnectDevTunnelsAccount(),
            ),
          "Disconnect",
        ),
      );
      return row;
    }
    const disconnect = button("Disconnect", "csDangerButton", () =>
      this._confirm("disconnect"),
    );
    disconnect.dataset.sessionAction = "disconnect-devtunnels";
    row.appendChild(disconnect);
    return row;
  }

  private _connectButton(provider: DevTunnelsProvider): HTMLElement {
    const item = button(
      "",
      "csSecondaryButton csIdentityButton",
      () => void this._connect(provider),
    );
    item.disabled = this._connecting !== undefined;
    item.innerHTML = PROVIDER_GLYPH[provider];
    item.append(element("span", `Connect ${PROVIDER_LABEL[provider]}`));
    item.dataset.sessionAction = `connect-${provider}`;
    return item;
  }
}
