// A session's identity in the URL is the sessionId and generation pair, or
// nothing. Selection accepts only a valid, matching pair.
import { describe, expect, it } from "vitest";
import { sessionLiteUrl, selectedSession } from "../src/session-state";

const id = "s-012345abcdef";
const generation = "g-0123456789abcdef";

describe("native Lite session routing", () => {
  it("selects only on a valid session and generation pair", () => {
    expect(
      selectedSession(`?session=not-a-session&generation=${generation}`),
    ).toBeUndefined();
    expect(selectedSession(`?session=${id}`)).toBeUndefined();
    expect(selectedSession(`?session=${id}&generation=${generation}`)).toEqual({
      sessionId: id,
      generation,
    });
  });

  it("keeps session selection within the current Lite application URL", () => {
    expect(
      sessionLiteUrl(id, "g-0123456789abcdef", "folder/example.ipynb", {
        href: "http://localhost/lite/lab/index.html?old=value",
      }),
    ).toBe(
      "http://localhost/lite/lab/index.html?old=value&session=s-012345abcdef&generation=g-0123456789abcdef&path=folder%2Fexample.ipynb",
    );
  });
});
