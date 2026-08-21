export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className?: string,
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  if (className) {
    value.className = className;
  }
  return value;
}

export function button(
  text: string,
  className: string,
  onClick?: () => void,
): HTMLButtonElement {
  const value = element("button", text, className);
  value.type = "button";
  if (onClick) {
    value.onclick = onClick;
  }
  return value;
}

export function field(label: string, control: HTMLElement): HTMLElement {
  const value = element("label", "", "csField");
  value.append(element("span", label, "csLabel"), control);
  return value;
}

export function closeButton(
  onClick: () => void,
  label = "Close",
): HTMLButtonElement {
  const value = button("", "csModalClose", onClick);
  value.title = label;
  value.setAttribute("aria-label", label);
  value.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>`;
  return value;
}

// The one place a runtime's state becomes a pill, so the list and the detail
// cannot drift apart on what a state looks like.
export function statePill(state: string): HTMLElement {
  return element(
    "span",
    state,
    `csRuntimeState csRuntimeState-${state.toLowerCase()}`,
  );
}
