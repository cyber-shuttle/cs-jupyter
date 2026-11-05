import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPrompts } from "../src/LoginPrompts";
import { acceptDialog } from "./fakes";

const prompt = {
  authId: "a1",
  hostName: "login.example.org",
  port: 22,
  loginUser: "me",
  sshCredentialId: "5e8f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  banner: "Authorized use only",
  name: "",
  instruction: "",
  prompts: [{ text: "Password:", echo: false }],
  createdAt: "2026-01-01T00:00:00Z",
};

describe("login prompts", () => {
  afterEach(() => document.body.replaceChildren());

  it("asks once per pending login and posts the answers", async () => {
    const api = {
      listLoginPrompts: vi.fn(async () => [prompt]),
      answerLoginPrompt: vi.fn(async () => undefined),
    };
    const prompts = new LoginPrompts(api);
    const asked = prompts.check();
    await vi.waitFor(() =>
      expect(document.querySelector(".jp-Dialog input")).not.toBeNull(),
    );
    await prompts.check();
    expect(api.listLoginPrompts).toHaveBeenCalledTimes(1);
    const input = document.querySelector<HTMLInputElement>(".jp-Dialog input")!;
    expect(input.type).toBe("password");
    expect(document.querySelector(".jp-Dialog")!.textContent).toContain(
      "me@login.example.org",
    );
    input.value = "secret";
    await acceptDialog();
    await asked;
    expect(api.answerLoginPrompt).toHaveBeenCalledWith("a1", {
      responses: ["secret"],
    });
  });
});
