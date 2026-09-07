import { fakeAuth } from "./fakes";
import { describe, expect, it, vi } from "vitest";
import { ControlClient, UNCHANGED } from "../src/ControlClient";
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
    vi.fn<typeof globalThis.fetch>(async () => response(value)),
  );

const runtimesOf = async (value: unknown) => {
  const list = await clientFor(value).listRuntimes();
  if (list === UNCHANGED) {
    throw new Error("cs-control answered 304 to a client with no list");
  }
  return list.runtimes;
};

describe("checked narrow cs-control runtime JSON contract", () => {
  it("accepts only allocation state and rejects removed private/application fields", async () => {
    const [runtime] = await runtimesOf({
      runtimes: [providerFixture],
      logs: [],
    });
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
          logs: [],
        }).listRuntimes(),
      ).rejects.toThrow("invalid runtime");
    }
    await expect(
      clientFor({
        runtimes: [{ ...providerFixture, state: "ready" }],
        logs: [],
      }).listRuntimes(),
    ).rejects.toThrow("invalid runtime");
  });
});
