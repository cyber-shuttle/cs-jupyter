import { describe, expect, it } from "vitest";
import { runtimeLiteUrl, selectedRuntime } from "../src/runtime-ui";

const id = "rt-012345abcdef";
const generation = "g-0123456789abcdef";

describe("native Lite runtime routing", () => {
  it("selects only on a valid runtime and generation pair", () => {
    expect(
      selectedRuntime(`?runtime=not-a-runtime&generation=${generation}`),
    ).toBeUndefined();
    expect(selectedRuntime(`?runtime=${id}`)).toBeUndefined();
    expect(selectedRuntime(`?runtime=${id}&generation=${generation}`)).toEqual({
      runtimeId: id,
      generation,
    });
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
