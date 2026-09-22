// The Dev Tunnels link dialog: showing the current link, starting and polling
// a device flow to completion, and unlinking. Run-again is exercised end to
// end through the panel, the same retry path a 409 tunnel_link_required
// session create takes.
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "@jupyterlab/apputils";
import { Widget } from "@lumino/widgets";
import { ControlClient, ControlError } from "../src/ControlClient";
import { TunnelLink } from "../src/TunnelLink";
import {
  controlFake,
  panelFake,
  sessionFixture,
  sessionListFixture,
} from "./fakes";

describe("TunnelLink dialog", () => {
  it("starts and polls a Microsoft link to completion and reports it linked", async () => {
    const pollTunnelLink = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending", intervalSeconds: 1 })
      .mockResolvedValueOnce({
        linked: true,
        provider: "microsoft",
        account: "person@example.com",
        linkedAt: "2026-01-01T00:00:00Z",
      });
    const api = {
      getTunnelLink: vi.fn(async () => ({ linked: false })),
      startTunnelLink: vi.fn(async () => ({
        handle: "A".repeat(43),
        userCode: "ABCD-EFGH",
        verificationUri: "https://microsoft.com/devicelogin",
        expiresInSeconds: 900,
        intervalSeconds: 1,
      })),
      pollTunnelLink,
    } as unknown as ControlClient;
    const widget = new TunnelLink(api);
    const onLinked = vi.fn();
    widget.onLinked = onLinked;
    document.body.appendChild(widget.node);
    await widget.refresh();

    widget.node
      .querySelector<HTMLButtonElement>(
        '[data-session-action="link-microsoft"]',
      )!
      .click();
    await vi.waitFor(() =>
      expect(document.querySelector("dialog")).not.toBeNull(),
    );
    await vi.waitFor(() => expect(pollTunnelLink).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(document.querySelector("dialog")).toBeNull();
    expect(widget.node.textContent).toContain("person@example.com");
    widget.dispose();
  });

  it("shows the linked account and unlinks after confirming inline", async () => {
    const removeTunnelLink = vi.fn(async () => ({ linked: false }));
    const api = {
      getTunnelLink: vi.fn(async () => ({
        linked: true,
        provider: "github",
        account: "octocat",
        linkedAt: "2026-01-01T00:00:00Z",
      })),
      removeTunnelLink,
    } as unknown as ControlClient;
    const widget = new TunnelLink(api);
    await widget.refresh();
    const card = widget.node.querySelector(".csLinkCard")!;
    expect(card.textContent).toContain("\u2713 GitHub");
    expect(card.textContent).toContain("octocat");
    expect(
      card.querySelector('[data-session-action="unlink-tunnel"]'),
    ).not.toBeNull();
    expect(
      widget.node.querySelector('[data-session-action="link-microsoft"]'),
    ).not.toBeNull();
    expect(
      widget.node.querySelector('[data-session-action="link-github"]'),
    ).toBeNull();

    widget.node
      .querySelector<HTMLButtonElement>(
        '[data-session-action="unlink-tunnel"]',
      )!
      .click();
    widget.node
      .querySelector<HTMLButtonElement>(
        '[data-session-action="confirm-delete-unlink-tunnel"]',
      )!
      .click();
    await vi.waitFor(() => expect(removeTunnelLink).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(
        widget.node.querySelector('[data-session-action="unlink-tunnel"]'),
      ).toBeNull(),
    );
    widget.dispose();
  });
});

describe("run-again retried after linking Dev Tunnels", () => {
  it("reopens the link dialog on a 409 and retries run-again once it reports linked", async () => {
    const base = sessionFixture({
      id: "s-111111111111",
      state: "STOPPED",
      sshHost: "nexus",
    });
    const startSession = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlError("tunnel_link_required", "Link Dev Tunnels first"),
      )
      .mockResolvedValueOnce({ ...base, state: "QUEUED" as const });
    const api = controlFake({
      listSessions: vi.fn(async () => sessionListFixture([base])),
      startSession,
    });
    const panel = panelFake(api);
    (panel as any)._modals._tunnelLinkWidget = () => new FakeTunnelLinkWidget();
    await panel.signIn();
    await vi.waitFor(() => expect(panel.state.sessions.length).toBe(1));

    const running = panel.actions.runAgain(base.id);
    await vi.waitFor(() => expect(Dialog.tracker.size).toBe(1));
    Dialog.tracker.currentWidget!.reject();
    await running;

    expect(startSession).toHaveBeenCalledTimes(2);
    expect(panel.state.sessions[0].state).toBe("QUEUED");
    panel.dispose();
  });
});

class FakeTunnelLinkWidget extends Widget {
  onLinked: (() => void) | undefined;
  async refresh(): Promise<void> {
    this.onLinked?.();
  }
}
