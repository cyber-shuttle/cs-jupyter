import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthClient,
  AuthInteractionCancelledError,
  AuthInteractionRequiredError,
  type IAuthClientDependencies,
} from "../src/AuthClient";

const options = {
  controlApiUrl: "https://control.example.edu/api/v1",
};

const deviceAuthorization = {
  handle: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  userCode: "ABCD-EFGH",
  verificationUri: "https://microsoft.com/devicelogin",
  expiresInSeconds: 900,
  intervalSeconds: 1,
};

const tokens = {
  status: "complete",
  expiresInSeconds: 60,
  accessToken: "access-token",
  idToken: "id-token",
};

interface MockReply {
  status?: number;
  body: unknown;
  contentType?: string;
  redirected?: boolean;
}

function fetchSequence(replies: Array<MockReply | Error>): typeof fetch {
  return vi.fn(async () => {
    const next = replies.shift();
    if (!next) throw new Error("unexpected broker request");
    if (next instanceof Error) throw next;
    const response = new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": next.contentType ?? "application/json" },
    });
    if (next.redirected) {
      Object.defineProperty(response, "redirected", { value: true });
    }
    return response;
  }) as unknown as typeof fetch;
}

function advancingDependencies(
  replies: Array<MockReply | Error>,
  initialNow = 1_000,
): IAuthClientDependencies & { fetch: typeof fetch; nowValue: () => number } {
  let now = initialNow;
  return {
    fetch: fetchSequence(replies),
    now: () => now,
    nowValue: () => now,
    sleep: vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    }),
  };
}

beforeEach(() => {
  document
    .querySelectorAll(".csDeviceCodeOverlay")
    .forEach((node) => node.remove());
  localStorage.clear();
  sessionStorage.clear();
});

describe("AuthClient device-code broker flow", () => {
  it("uses only cs-control start and poll shapes and retains unexpired credentials", async () => {
    const dependencies = advancingDependencies([
      { body: deviceAuthorization },
      { status: 202, body: { status: "pending", intervalSeconds: 1 } },
      { status: 202, body: { status: "pending", intervalSeconds: 6 } },
      { body: tokens },
    ]);
    const auth = new AuthClient(options, dependencies);

    await expect(auth.acquireToken()).rejects.toBeInstanceOf(
      AuthInteractionRequiredError,
    );
    await expect(auth.interactiveLogin()).resolves.toEqual({
      accessToken: "access-token",
      idToken: "id-token",
    });
    await expect(auth.acquireToken()).resolves.toEqual({
      accessToken: "access-token",
      idToken: "id-token",
    });

    expect(dependencies.sleep).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(dependencies.sleep!).mock.calls.map(([wait]) => wait),
    ).toEqual([1000, 1000, 6000]);
    const calls = vi.mocked(dependencies.fetch).mock.calls;
    expect(calls.map(([url]) => String(url))).toEqual([
      "https://control.example.edu/api/v1/oauth/device/start",
      `https://control.example.edu/api/v1/oauth/device/poll/${deviceAuthorization.handle}`,
      `https://control.example.edu/api/v1/oauth/device/poll/${deviceAuthorization.handle}`,
      `https://control.example.edu/api/v1/oauth/device/poll/${deviceAuthorization.handle}`,
    ]);
    for (const [, init] of calls) {
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(init?.body).toBeUndefined();
    }
    expect(calls.map(([url]) => String(url)).join(" ")).not.toContain(
      "microsoftonline.com",
    );
  });

  it("requires another explicit interaction after in-memory credentials expire", async () => {
    let now = 0;
    const dependencies = advancingDependencies(
      [
        { body: deviceAuthorization },
        { body: { ...tokens, expiresInSeconds: 2 } },
      ],
      now,
    );
    const auth = new AuthClient(options, {
      ...dependencies,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    await auth.interactiveLogin();
    now += 2000;
    await expect(auth.acquireToken()).rejects.toBeInstanceOf(
      AuthInteractionRequiredError,
    );
    expect(vi.mocked(dependencies.fetch)).toHaveBeenCalledTimes(2);
  });

  it("shows the unchanged accessible modal and cancels broker polling", async () => {
    let observedSignal: AbortSignal | undefined;
    const clipboard = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboard },
    });
    const auth = new AuthClient(options, {
      fetch: fetchSequence([{ body: deviceAuthorization }]),
      sleep: (_milliseconds, signal) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    });

    const login = auth.interactiveLogin();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
    );
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.textContent).toContain("ABCD-EFGH");
    const open = dialog.querySelector("a") as HTMLAnchorElement;
    expect(open.href).toBe("https://microsoft.com/devicelogin");
    expect(open.target).toBe("_blank");
    expect(open.rel).toContain("noopener");
    expect(document.activeElement).toBe(open);

    // Opening the page moves the answer to the other device, so the button
    // reports waiting instead of inviting a second click.
    open.click();
    expect(open.textContent).toContain("Waiting");
    expect(open.querySelector(".csSpinner")).not.toBeNull();

    const copy = dialog.querySelector<HTMLButtonElement>(".csDeviceCodeCopy")!;
    expect(copy.getAttribute("aria-label")).toBe("Copy code");
    copy.click();
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("ABCD-EFGH"));
    await vi.waitFor(() =>
      expect(copy.getAttribute("aria-label")).toBe("Code copied"),
    );
    expect(copy.classList.contains("csDeviceCodeCopied")).toBe(true);
    expect(dialog.textContent).not.toContain("Code copied.");

    const close =
      dialog.querySelector<HTMLButtonElement>(".csDeviceCodeClose")!;
    expect(close.getAttribute("aria-label")).toBe("Close");
    close.click();
    await expect(login).rejects.toBeInstanceOf(AuthInteractionCancelledError);
    expect(observedSignal?.aborted).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("expires without polling when the broker deadline passes", async () => {
    const dependencies = advancingDependencies(
      [
        {
          body: {
            ...deviceAuthorization,
            expiresInSeconds: 3,
            intervalSeconds: 5,
          },
        },
      ],
      0,
    );
    await expect(
      new AuthClient(options, dependencies).interactiveLogin(),
    ).rejects.toThrow("expired");
    expect(vi.mocked(dependencies.fetch)).toHaveBeenCalledOnce();
    expect(dependencies.sleep).toHaveBeenCalledWith(
      3000,
      expect.any(AbortSignal),
    );
  });

  it.each([
    {
      name: "denial",
      replies: [
        { body: deviceAuthorization },
        {
          status: 403,
          body: {
            error: {
              code: "authorization_denied",
              message: "authorization was denied",
            },
          },
        },
      ] as MockReply[],
      message: "denied",
    },
    {
      name: "network failure",
      replies: [
        { body: deviceAuthorization },
        new TypeError("network unavailable"),
      ] as Array<MockReply | Error>,
      message: "network unavailable",
    },
  ])("reports $name and removes the modal", async ({ replies, message }) => {
    const dependencies = advancingDependencies(replies);
    await expect(
      new AuthClient(options, dependencies).interactiveLogin(),
    ).rejects.toThrow(message);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("times out a start request without reporting explicit cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let requestSignal: AbortSignal | undefined;
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      }) as unknown as typeof globalThis.fetch;
      const login = new AuthClient(options, { fetch }).interactiveLogin();
      const rejection = expect(login).rejects.toThrow(
        "device authorization request timed out",
      );

      await vi.advanceTimersByTimeAsync(15_000);

      await rejection;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "device expiry",
      expiresInSeconds: 2,
      advanceMilliseconds: 1_000,
      message: "device sign-in expired",
    },
    {
      name: "per-request bound",
      expiresInSeconds: 3600,
      advanceMilliseconds: 15_000,
      message: "poll request timed out",
    },
  ])(
    "aborts a never-resolving poll at the $name deadline",
    async ({ expiresInSeconds, advanceMilliseconds, message }) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        let pollSignal: AbortSignal | undefined;
        const fetch = vi
          .fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                ...deviceAuthorization,
                expiresInSeconds,
              }),
              { headers: { "content-type": "application/json" } },
            ),
          )
          .mockImplementationOnce(
            (_input: RequestInfo | URL, init?: RequestInit) => {
              pollSignal = init?.signal as AbortSignal;
              return new Promise<Response>(() => undefined);
            },
          ) as unknown as typeof globalThis.fetch;
        const login = new AuthClient(options, { fetch }).interactiveLogin();
        const rejection = expect(login).rejects.toThrow(message);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(advanceMilliseconds);

        await rejection;
        expect(pollSignal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("stops reading and cancels a chunked response above 64 KiB", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(40 * 1024).fill(65));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetch = vi.fn(
      async () =>
        new Response(stream, {
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      new AuthClient(options, { fetch }).interactiveLogin(),
    ).rejects.toThrow("invalid device response");
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
  });

  it.each([
    "application/json",
    "application/json; charset=utf-8",
    " Application/JSON ; charset=UTF-8",
  ])(
    "accepts the exact JSON media type with parameters: %s",
    async (contentType) => {
      const dependencies = advancingDependencies([
        { body: deviceAuthorization, contentType },
        { body: tokens, contentType },
      ]);

      await expect(
        new AuthClient(options, dependencies).interactiveLogin(),
      ).resolves.toEqual({ accessToken: "access-token", idToken: "id-token" });
    },
  );

  it.each(["application/jsonp", "application/json-patch+json", "text/json"])(
    "rejects non-JSON media type %s",
    async (contentType) => {
      await expect(
        new AuthClient(options, {
          fetch: fetchSequence([{ body: deviceAuthorization, contentType }]),
        }).interactiveLogin(),
      ).rejects.toThrow("invalid device response");
    },
  );

  it.each([
    ["zero expiry", { expiresInSeconds: 0 }],
    ["fractional expiry", { expiresInSeconds: 1.5 }],
    ["expiry above maximum", { expiresInSeconds: 3601 }],
    ["overflowing expiry", { expiresInSeconds: Number.MAX_SAFE_INTEGER }],
    ["zero interval", { intervalSeconds: 0 }],
    ["fractional interval", { intervalSeconds: 1.5 }],
    ["interval above maximum", { intervalSeconds: 61 }],
    ["overflowing interval", { intervalSeconds: Number.MAX_SAFE_INTEGER }],
  ])("rejects a start response with %s", async (_name, replacement) => {
    await expect(
      new AuthClient(options, {
        fetch: fetchSequence([
          { body: { ...deviceAuthorization, ...replacement } },
        ]),
      }).interactiveLogin(),
    ).rejects.toThrow("invalid device authorization");
  });

  it.each([0, 1.5, 86401, Number.MAX_SAFE_INTEGER])(
    "rejects success expiry %s",
    async (expiresInSeconds) => {
      const dependencies = advancingDependencies([
        { body: deviceAuthorization },
        { body: { ...tokens, expiresInSeconds } },
      ]);
      await expect(
        new AuthClient(options, dependencies).interactiveLogin(),
      ).rejects.toThrow("token response was invalid");
    },
  );

  it.each([0, 1.5, 61, Number.MAX_SAFE_INTEGER])(
    "rejects pending interval %s",
    async (intervalSeconds) => {
      const dependencies = advancingDependencies([
        { body: deviceAuthorization },
        { status: 202, body: { status: "pending", intervalSeconds } },
      ]);
      await expect(
        new AuthClient(options, dependencies).interactiveLogin(),
      ).rejects.toThrow("invalid pending response");
    },
  );

  it("accepts maximum start, interval, and success expiry values", async () => {
    const dependencies = advancingDependencies([
      {
        body: {
          ...deviceAuthorization,
          expiresInSeconds: 3600,
          intervalSeconds: 60,
        },
      },
      { body: { ...tokens, expiresInSeconds: 86400 } },
    ]);

    await expect(
      new AuthClient(options, dependencies).interactiveLogin(),
    ).resolves.toEqual({ accessToken: "access-token", idToken: "id-token" });
    expect(dependencies.sleep).toHaveBeenCalledWith(
      60_000,
      expect.any(AbortSignal),
    );
  });

  it("strictly rejects redirects, non-JSON, extra fields, and unsafe control URLs", async () => {
    expect(
      () =>
        new AuthClient({
          controlApiUrl: "https://secret@control.example/api/v1",
        }),
    ).toThrow("invalid");
    expect(
      () => new AuthClient({ controlApiUrl: "http://control.example/api/v1" }),
    ).toThrow("invalid");

    for (const reply of [
      { body: deviceAuthorization, redirected: true },
      { body: deviceAuthorization, contentType: "text/plain" },
      { body: { ...deviceAuthorization, deviceCode: "must-not-be-exposed" } },
    ]) {
      await expect(
        new AuthClient(options, {
          fetch: fetchSequence([reply]),
        }).interactiveLogin(),
      ).rejects.toThrow("invalid");
    }
  });

  it("keeps OAuth credentials out of local storage, URLs, and logs", async () => {
    const originalUrl = window.location.href;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const dependencies = advancingDependencies([
      { body: deviceAuthorization },
      { body: tokens },
    ]);

    const result = await new AuthClient(
      options,
      dependencies,
    ).interactiveLogin();

    expect(result).toEqual({
      accessToken: "access-token",
      idToken: "id-token",
    });
    // Credentials survive a reload in per-tab session storage only: local
    // storage would outlive the tab, and a URL would leak them to history.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.getItem("cybershuttle.oauth.v1")).toContain(
      "access-token",
    );
    expect(window.location.href).toBe(originalUrl);
    expect(
      vi
        .mocked(dependencies.fetch)
        .mock.calls.map(([url]) => String(url))
        .join(" "),
    ).not.toMatch(/access-token|id-token/);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});

describe("AuthClient credential persistence", () => {
  it("restores an unexpired credential into a fresh client and drops it on expiry or sign-out", async () => {
    const dependencies = advancingDependencies([
      { body: deviceAuthorization },
      { body: tokens },
    ]);
    const signedIn = new AuthClient(options, dependencies);
    await signedIn.interactiveLogin();

    // Opening a runtime navigates the page, so the next client is a new object.
    const reloaded = new AuthClient(options, {
      fetch: fetchSequence([]),
      now: dependencies.nowValue,
    });
    await expect(reloaded.acquireToken()).resolves.toEqual({
      accessToken: "access-token",
      idToken: "id-token",
    });

    const expired = new AuthClient(options, {
      fetch: fetchSequence([]),
      now: () => dependencies.nowValue() + 60_000,
    });
    await expect(expired.acquireToken()).rejects.toBeInstanceOf(
      AuthInteractionRequiredError,
    );

    await signedIn.interactiveLogin().catch(() => undefined);
    signedIn.invalidateToken();
    await expect(
      new AuthClient(options, {
        fetch: fetchSequence([]),
        now: dependencies.nowValue,
      }).acquireToken(),
    ).rejects.toBeInstanceOf(AuthInteractionRequiredError);
  });
});
