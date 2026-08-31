import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// showDeviceCodeModal builds the scrim as a <dialog>, so the rule that styles
// it has to reset the UA dialog box — fit-content sizing, auto margins, a
// solid border, a max-width — or the full-viewport scrim shrink-wraps into a
// small bordered card. jsdom does no layout, so the stylesheet is read directly.
it("resets the UA dialog box on the device-code scrim", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(
    join(import.meta.dirname, "..", "style", "base.css"),
    "utf8",
  );
  document.head.append(style);
  const overlay = [...style.sheet!.cssRules].find(
    (rule): rule is CSSStyleRule =>
      rule instanceof CSSStyleRule &&
      rule.selectorText === ".csDeviceCodeOverlay",
  )!;
  const declared = (property: string): string =>
    overlay.style.getPropertyValue(property);
  expect(declared("position")).toBe("fixed");
  expect(declared("inset")).toBe("0");
  expect(declared("width")).toBe("auto");
  expect(declared("height")).toBe("auto");
  expect(declared("max-width")).toBe("none");
  expect(declared("max-height")).toBe("none");
  expect(declared("margin")).toBe("0");
  expect(declared("border")).toBe("0");
  style.remove();
});
