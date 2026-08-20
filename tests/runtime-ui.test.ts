import { describe, expect, it } from "vitest";
import { resolveRuntimeId, runtimeLiteUrl } from "../src/runtime-ui";

const id = "rt-012345abcdef";

describe("native Lite runtime routing", () => {
  it("treats a malformed runtime query as unselected", () => {
    expect(resolveRuntimeId("?runtime=not-a-runtime")).toBeUndefined();
    expect(resolveRuntimeId(`?runtime=${id}`)).toBe(id);
  });

  it("keeps runtime selection within the current Lite application URL", () => {
    expect(
      runtimeLiteUrl(id, "g-0123456789abcdef", "folder/example.ipynb", {
        href: "http://localhost/lite/lab/index.html?old=value",
      }),
    ).toBe(
      "http://localhost/lite/lab/index.html?old=value&runtime=rt-012345abcdef&generation=g-0123456789abcdef&path=folder%2Fexample.ipynb",
    );
  });
});
