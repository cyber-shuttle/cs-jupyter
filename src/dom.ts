export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className?: string,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.textContent = text;
  if (className) {
    value.className = className;
  }
  for (const [name, attribute] of Object.entries(attributes)) {
    value.setAttribute(name, attribute);
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

// A message row is rendered only when there is a message to render.
export const notes = (rows: Array<[string, string]>): HTMLElement[] =>
  rows
    .filter(([message]) => message)
    .map(([message, className]) => element("div", message, className));

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

/**
 * Rebuilds a node's contents, leaving keyboard focus on the same action
 * control it was on before.
 */
export function keepingFocus(node: HTMLElement, rebuild: () => void): void {
  const action = node.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.runtimeAction
    : undefined;
  rebuild();
  if (action === undefined) return;
  for (const control of Array.from(
    node.querySelectorAll<HTMLElement>("[data-runtime-action]"),
  )) {
    if (control.dataset.runtimeAction === action) {
      control.focus();
      return;
    }
  }
}

/**
 * A sparkline over a fixed number of slots, so a filling window grows in from
 * the left and then slides. Hand-rolled for the reason every other glyph here
 * is: currentColor follows the theme, and a chart library would be the only
 * dependency of its kind.
 */
export function sparkline(
  points: string,
  className = "csSparkline",
): HTMLElement {
  const holder = element("div", "", className);
  holder.innerHTML = `<svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" focusable="false"><polyline fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="${points}" /></svg>`;
  return holder;
}

/**
 * One line of an allocation's narration. The live tail on a running session and
 * the frozen one on a finished run are the same lines, so they are built here
 * rather than twice.
 */
export function logLine(line: {
  stream: string;
  text: string;
  at: string;
}): HTMLElement {
  const row = element(
    "div",
    "",
    `csRuntimeLogLine csRuntimeLog-${line.stream}`,
  );
  const at = new Date(line.at);
  const stamp = Number.isFinite(at.getTime())
    ? at.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";
  const time = element("time", stamp, "csRuntimeLogTime");
  if (stamp) time.dateTime = line.at;
  time.title = line.stream;
  row.append(time, element("span", line.text, "csRuntimeLogText"));
  return row;
}

/**
 * A one-second tick for the surfaces that count down. cs-control answers 304
 * while a running allocation is unchanged, so state alone would leave the
 * figure sitting still.
 */
export class Clock {
  private id: number | undefined;

  constructor(private tick: () => void) {}

  // Ticking is worth a re-render only while something is actually counting.
  sync(active: boolean): void {
    if (!active) return this.stop();
    this.id ??= window.setInterval(this.tick, 1000);
  }

  stop(): void {
    window.clearInterval(this.id);
    this.id = undefined;
  }
}

// One clock face for the card and the status bar.
export const CLOCK_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><circle cx="8" cy="8" r="5.6" /><path d="M8 4.9V8l2.1 1.6" /></g></svg>`;
