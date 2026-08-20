import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const liteConfig = JSON.parse(
  readFileSync(resolve(root, "jupyter-lite.json"), "utf8"),
)["jupyter-config-data"];

const localKernelPackages = [
  "@jupyterlite/pyodide-kernel",
  "@jupyterlite/pyodide-kernel-extension",
  "@jupyterlite/xeus",
  "@jupyterlite/javascript-kernel",
  "@jupyterlite/javascript-kernel-extension",
];

const requiredLiteSupportServices = [
  "@jupyterlite/services-extension:event-manager",
  "@jupyterlite/services-extension:nbconvert-manager",
  "@jupyterlite/services-extension:settings",
  "@jupyterlite/services-extension:user-manager",
  "@jupyterlite/services-extension:workspace-manager",
];

const disabledUpstreamServices = [
  "@jupyterlab/services-extension:default-drive",
  "@jupyterlab/services-extension:contents-manager",
  "@jupyterlab/services-extension:kernel-manager",
  "@jupyterlab/services-extension:kernel-spec-manager",
  "@jupyterlab/services-extension:session-manager",
  "@jupyterlab/services-extension:service-manager",
  "@jupyterlite/services-extension:default-drive",
  "@jupyterlite/services-extension:kernel-client",
  "@jupyterlite/services-extension:kernel-manager",
  "@jupyterlite/services-extension:kernel-spec-client",
  "@jupyterlite/services-extension:kernel-spec-manager",
  "@jupyterlite/services-extension:kernel-specs",
  "@jupyterlite/services-extension:session-manager",
];

describe("remote-only native workspace distribution", () => {
  it("holds no Microsoft credential or authority in the browser bundle", () => {
    expect(liteConfig).toMatchObject({ cybershuttleControlApiUrl: "" });
    expect(packageJson.dependencies).not.toHaveProperty("@azure/msal-browser");
    const authSource = readFileSync(resolve(root, "src/AuthClient.ts"), "utf8");
    expect(authSource).not.toContain("login.microsoftonline.com");
    expect(authSource).not.toContain("c0df98ca-23b4-4bce-bb9f-72039b28d3a5");
  });

  it("does not install a local kernel provider", () => {
    const installed = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    for (const provider of localKernelPackages) {
      expect(installed).not.toHaveProperty(provider);
    }
  });

  it("keeps local shell settings while replacing compute services", () => {
    expect(liteConfig.disabledExtensions).not.toContain(
      "@jupyterlab/services-extension:server-settings",
    );
    expect(liteConfig.disabledExtensions).toEqual(
      expect.arrayContaining(disabledUpstreamServices),
    );
    expect(liteConfig.deferredExtensions).toContain(
      "@jupyterlab/terminal-extension:plugin",
    );
    expect(liteConfig.disabledExtensions).not.toContain(
      "@jupyterlab/terminal-extension:plugin",
    );
    for (const support of requiredLiteSupportServices) {
      expect(liteConfig.disabledExtensions).not.toContain(support);
    }
  });

  it("shares every host package crossing the package boundary", () => {
    for (const name of [
      "@jupyterlab/application",
      "@jupyterlab/apputils",
      "@jupyterlab/coreutils",
      "@jupyterlab/services",
      "@lumino/signaling",
      "@lumino/widgets",
    ]) {
      expect(packageJson.jupyterlab.sharedPackages[name]).toMatchObject({
        bundled: false,
        singleton: true,
      });
    }
  });
});
