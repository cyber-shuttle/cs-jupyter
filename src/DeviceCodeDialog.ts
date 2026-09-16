// The accessible modal that shows a sign-in device code. It has
// the verification link, the one-time code with a copy button, and a status
// line. The overlay attaches to document.body directly so a themed ancestor
// cannot clip it.
import { button, copyText, element } from "./dom";

interface IDeviceAuthorization {
  label: string;
  userCode: string;
  verificationUri: string;
}

const COPY_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.2"><rect x="5.6" y="5.6" width="8" height="8" rx="1.4" /><path d="M10.9 5.6V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v5.6a1.4 1.4 0 0 0 1.4 1.4h1.7" /></g></svg>`;
const CHECK_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3.4 8.4 3 3 6.2-6.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>`;

export function showDeviceCodeDialog(
  authorization: IDeviceAuthorization,
  cancel: () => void,
): { close(): void } {
  const activeElement = document.activeElement;
  const overlay = element("dialog", "", "csDeviceCodeOverlay");
  const dialog = element("section", "", "csDeviceCodeDialog");
  const title = element("h2", `Sign in to ${authorization.label}`);
  title.id = `cs-device-code-title-${crypto.randomUUID()}`;
  overlay.setAttribute("aria-labelledby", title.id);
  const instructions = element(
    "p",
    `Open the ${authorization.label} sign-in page and enter this one-time code:`,
  );
  instructions.id = `cs-device-code-instructions-${crypto.randomUUID()}`;
  overlay.setAttribute("aria-describedby", instructions.id);
  const code = element("code", authorization.userCode, "csDeviceCode");
  code.setAttribute("aria-label", `Device code ${authorization.userCode}`);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "csDeviceCodeCopy";
  copy.innerHTML = COPY_GLYPH;
  const describeCopy = (text: string): void => {
    copy.title = text;
    copy.setAttribute("aria-label", text);
  };
  describeCopy("Copy code");
  let copyReset: ReturnType<typeof setTimeout> | undefined;
  copy.onclick = async () => {
    clearTimeout(copyReset);
    if (await copyText(authorization.userCode)) {
      copy.innerHTML = CHECK_GLYPH;
      copy.classList.add("csDeviceCodeCopied");
      describeCopy("Code copied");
      copyReset = setTimeout(() => {
        copy.innerHTML = COPY_GLYPH;
        copy.classList.remove("csDeviceCodeCopied");
        describeCopy("Copy code");
      }, 2000);
    } else {
      copy.innerHTML = COPY_GLYPH;
      copy.classList.remove("csDeviceCodeCopied");
      describeCopy("Could not copy the code");
    }
  };
  const codeRow = element("div", "", "csDeviceCodeRow");
  codeRow.append(code, copy);

  const actions = element("div", "", "csDeviceCodeActions");
  const open = document.createElement("a");
  open.className = "csPrimaryButton csDeviceCodeOpen";
  open.href = authorization.verificationUri;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.referrerPolicy = "no-referrer";
  open.textContent = "Open sign-in page";
  open.onclick = () => {
    open.classList.add("csDeviceCodeWaiting");
    open.textContent = "";
    open.append(
      element("span", "", "csSpinner"),
      document.createTextNode("Waiting…"),
    );
  };
  actions.appendChild(open);

  const close = button("", "csDialogClose", cancel);
  close.title = "Close";
  close.setAttribute("aria-label", "Close");
  close.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>`;

  dialog.append(close, title, instructions, codeRow, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener("cancel", cancel);
  overlay.showModal();
  open.focus();

  return {
    close: () => {
      overlay.remove();
      if (activeElement instanceof HTMLElement && activeElement.isConnected) {
        activeElement.focus();
      }
    },
  };
}
