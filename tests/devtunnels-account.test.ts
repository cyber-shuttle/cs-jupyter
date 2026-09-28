// The Dev Tunnels account dialog: showing the connected account, starting and
// polling a device flow to completion, and disconnecting.
import { describe, expect, it, vi } from "vitest";
import { PlaneClient } from "../src/PlaneClient";
import { DevTunnelsAccount } from "../src/DevTunnelsAccount";

describe("DevTunnelsAccount dialog", () => {
  it("connects a Microsoft account through the device flow and reports it connected", async () => {
    const pollDevTunnelsAccount = vi
      .fn()
      .mockResolvedValueOnce({
        status: "pending",
        intervalSeconds: 1,
        connected: false,
      })
      .mockResolvedValueOnce({
        status: "connected",
        connected: true,
        provider: "microsoft",
        account: "person@example.com",
        connectedAt: "2026-01-01T00:00:00Z",
      });
    const api = {
      getDevTunnelsAccount: vi.fn(async () => ({ connected: false })),
      connectDevTunnelsAccount: vi.fn(async () => ({
        handle: "A".repeat(43),
        userCode: "ABCD-EFGH",
        verificationUri: "https://microsoft.com/devicelogin",
        expiresInSeconds: 900,
        intervalSeconds: 1,
      })),
      pollDevTunnelsAccount,
    } as unknown as PlaneClient;
    const widget = new DevTunnelsAccount(api);
    document.body.appendChild(widget.node);
    await widget.refresh();

    widget.node
      .querySelector<HTMLButtonElement>(
        '[data-session-action="connect-microsoft"]',
      )!
      .click();
    await vi.waitFor(() =>
      expect(document.querySelector("dialog")).not.toBeNull(),
    );
    await vi.waitFor(
      () => expect(pollDevTunnelsAccount).toHaveBeenCalledTimes(2),
      {
        timeout: 5000,
      },
    );
    await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
    expect(widget.node.textContent).toContain("person@example.com");
    widget.dispose();
  });

  it("shows the connected account and disconnects after confirming inline", async () => {
    const disconnectDevTunnelsAccount = vi.fn(async () => ({
      connected: false,
    }));
    const api = {
      getDevTunnelsAccount: vi.fn(async () => ({
        connected: true,
        provider: "github",
        account: "octocat",
        connectedAt: "2026-01-01T00:00:00Z",
      })),
      disconnectDevTunnelsAccount,
    } as unknown as PlaneClient;
    const widget = new DevTunnelsAccount(api);
    await widget.refresh();
    const card = widget.node.querySelector(".csDevTunnelsCard")!;
    expect(card.textContent).toContain("\u2713 GitHub");
    expect(card.textContent).toContain("octocat");
    expect(
      card.querySelector('[data-session-action="disconnect-devtunnels"]'),
    ).not.toBeNull();
    expect(
      widget.node.querySelector('[data-session-action="connect-microsoft"]'),
    ).not.toBeNull();
    expect(
      widget.node.querySelector('[data-session-action="connect-github"]'),
    ).toBeNull();

    widget.node
      .querySelector<HTMLButtonElement>(
        '[data-session-action="disconnect-devtunnels"]',
      )!
      .click();
    widget.node
      .querySelector<HTMLButtonElement>(
        '[data-session-action="confirm-delete-disconnect-devtunnels"]',
      )!
      .click();
    await vi.waitFor(() =>
      expect(disconnectDevTunnelsAccount).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(
        widget.node.querySelector(
          '[data-session-action="disconnect-devtunnels"]',
        ),
      ).toBeNull(),
    );
    widget.dispose();
  });
});
