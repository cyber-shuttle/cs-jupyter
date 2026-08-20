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

export function stepHeader(
  backLabel: string,
  title: string,
  onBack: () => void,
): HTMLElement {
  const top = element("div", "", "csFormTop");
  top.append(
    button(backLabel, "csTextButton", onBack),
    element("div", title, "csFormTitle"),
  );
  return top;
}
