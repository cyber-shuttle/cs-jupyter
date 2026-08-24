import { fakeAuth } from "./fakes";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ControlClient } from "../src/ControlClient";
import providerFixture from "./fixtures/cs-control-runtime-contract.json";

const response = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const clientFor = (value: unknown) =>
  new ControlClient(
    "https://control.example.edu/api/v1",
    fakeAuth(),
    vi.fn(async () => response(value)) as any,
  );

describe("checked narrow cs-control runtime JSON contract", () => {
  it("accepts only allocation state and rejects removed private/application fields", async () => {
    const {
      runtimes: [runtime],
    } = await clientFor({
      runtimes: [providerFixture],
      refreshing: false,
      logs: [],
    }).listRuntimes();
    expect(runtime).toEqual(providerFixture);
    for (const forbidden of [
      "owner",
      "tunnel",
      "services",
      "linkspanSpec",
      "privateRoot",
      "workspaceRoot",
      "jobId",
    ]) {
      await expect(
        clientFor({
          runtimes: [{ ...providerFixture, [forbidden]: {} }],
          refreshing: false,
          logs: [],
        }).listRuntimes(),
      ).rejects.toThrow("invalid runtime");
    }
    await expect(
      clientFor({
        runtimes: [{ ...providerFixture, state: "ready" }],
        refreshing: false,
        logs: [],
      }).listRuntimes(),
    ).rejects.toThrow("invalid runtime");
  });
});
