// .csSshAuth is SlurmDiscovery's in-form progress row; the login dock has its
// own fixed-position class, .csSshLoginDock. Pinning .csSshAuth to position
// fixed would float the in-form progress row and terminal over the shell.
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const css = readFileSync(join(__dirname, "../style/base.css"), "utf8");

function rule(selector: string): string {
  const match = css.match(
    new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    ),
  );
  if (!match) throw new Error(`no rule found for ${selector}`);
  return match[1];
}

describe("SSH auth CSS", () => {
  it("gives the login dock its own fixed-position class", () => {
    const body = rule(".csSshLoginDock");
    expect(body).toContain("position: fixed");
  });

  it("keeps .csSshAuth inline, not fixed, for SlurmDiscovery's in-form area", () => {
    const body = rule(".csSshAuth");
    expect(body).not.toContain("position: fixed");
  });
});
