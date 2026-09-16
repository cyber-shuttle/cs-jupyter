// The login dock is a fixed-position overlay that must vanish once a login
// succeeds. It must also come back for the next login on the same dock
// instance.
import { describe, expect, it, vi } from "vitest";
import { SshLoginDock } from "../src/SshLoginDock";
import { FakeOperation } from "./fakes";

describe("SshLoginDock visibility", () => {
  it("hides itself once a login succeeds, and shows again on the next login", async () => {
    const operation = new FakeOperation();
    const dock = new SshLoginDock(() => operation);

    const login = dock.login("nexus", vi.fn());
    expect(dock.isHidden).toBe(false);

    const { ready } = operation.starts[0].callbacks;
    ready?.();
    await login;
    expect(dock.isHidden).toBe(true);

    dock.login("nexus", vi.fn());
    expect(dock.isHidden).toBe(false);
    expect(operation.starts).toHaveLength(2);
  });

  it("hides itself once a login fails, leaving no stranded dismiss control", async () => {
    const operation = new FakeOperation();
    const dock = new SshLoginDock(() => operation);

    const login = dock.login("nexus", vi.fn());
    expect(dock.isHidden).toBe(false);

    const { failed } = operation.starts[0].callbacks;
    failed?.("Authentication failed.");
    await expect(login).rejects.toThrow("Authentication failed.");
    expect(dock.isHidden).toBe(true);
  });
});
