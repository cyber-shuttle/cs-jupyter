// The Dev Tunnels link dialog: showing the current link, starting and polling
// a device flow to completion, and unlinking.
import { describe, expect, it, vi } from "vitest";
import { ControlClient } from "../src/ControlClient";
import { TunnelLink } from "../src/TunnelLink";

describe("TunnelLink dialog", () => {
  it("starts and polls a Microsoft link to completion and reports it linked", async () => {
    const pollTunnelLink = vi
      .fn()
      .mockResolvedValueOnce({
        status: "pending",
        intervalSeconds: 1,
        linked: false,
      })
      .mockResolvedValueOnce({
        status: "linked",
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
    await vi.waitFor(() => expect(document.querySelector("dialog")).toBeNull());
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
