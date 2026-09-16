// Small DOM builders shared across the widgets: elements, detail grids, log
// sections and disclosure lists, plus the walltime countdown math they and
// the status bar share. `disclosure` restores open state after a rebuild by
// caller-supplied identifier. Slurm measures --time from when a job starts
// running, so the full limit shows until then, and the formatted figure
// switches from hours and minutes to minutes and seconds at the one-hour
// mark.
import type { ILogLine, ISession } from "./Common";

export const LOW_TIME_MS = 10 * 60_000;

export function remainingMs(session: ISession, now: number): number {
  const limit = session.resources.wallMinutes * 60_000;
  const started = session.startedAt ? Date.parse(session.startedAt) : NaN;
  return Math.max(0, Number.isFinite(started) ? started + limit - now : limit);
}

export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

export const countsDown = (session: ISession): boolean =>
  session.state === "STARTING" || session.state === "READY";

export function remainingBadge(
  session: ISession,
  now: number,
): { label: string; low: boolean } {
  const left = remainingMs(session, now);
  return { label: formatRemaining(left), low: left <= LOW_TIME_MS };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

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

export const notes = (rows: Array<[string, string]>): HTMLElement[] =>
  rows
    .filter(([message]) => message)
    .map(([message, className]) => element("div", message, className));

export function field(label: string, control: HTMLElement): HTMLElement {
  const value = element("label", "", "csField");
  value.append(element("span", label, "csLabel"), control);
  return value;
}

export function formFooter(
  error: string,
  label: string,
  busy: boolean,
): [HTMLElement, HTMLElement] {
  const note = element("div", error, "csError");
  note.hidden = !error;
  const footer = element("div", "", "csFormFooter");
  const save = button(label, "csPrimaryButton");
  save.type = "submit";
  save.disabled = busy;
  footer.appendChild(save);
  return [note, footer];
}

export function addSection(
  label: string,
  action: string,
  form: HTMLElement | undefined,
  toggle: () => void,
): HTMLElement {
  const section = element("div", "", "csSshAdd");
  const control = button(
    form ? "Cancel" : label,
    "csSecondaryButton csSshAddToggle",
    toggle,
  );
  control.dataset.sessionAction = action;
  section.appendChild(control);
  if (form) section.appendChild(form);
  return section;
}

export function confirmDelete(
  message: string,
  action: string,
  cancel: () => void,
  remove: () => void,
): HTMLElement[] {
  const keep = button("Cancel", "csSecondaryButton", cancel);
  keep.dataset.sessionAction = `confirm-cancel-${action}`;
  const drop = button("Delete", "csDangerButton", remove);
  drop.dataset.sessionAction = `confirm-delete-${action}`;
  return [element("span", message, "csMeta"), keep, drop];
}

export function select(
  name: string,
  options: Array<[string, string]>,
  required = true,
): HTMLSelectElement {
  const value = element("select", "", "csSelect");
  value.name = name;
  value.required = required;
  fillOptions(value, options);
  return value;
}

export function fillOptions(
  control: HTMLSelectElement,
  options: Array<[string, string]>,
  chosen = options[0]?.[0] ?? "",
): void {
  control.replaceChildren(
    ...options.map(([value, label]) => new Option(label, value)),
  );
  control.value = chosen;
}

export function statePill(state: string): HTMLElement {
  return element(
    "span",
    state,
    `csSessionState csSessionState-${state.toLowerCase()}`,
  );
}

export function detailGrid(rows: Array<[string, string]>): HTMLDListElement {
  const grid = element("dl", "", "csSessionDetailGrid");
  for (const [label, value] of rows) {
    grid.append(
      element("dt", label, "csSessionDetailLabel"),
      element("dd", value, "csSessionDetailValue"),
    );
  }
  return grid;
}

export function detailColumns(
  grid: HTMLElement,
  plots?: HTMLElement,
): HTMLElement {
  const columns = element("div", "", "csDetailColumns");
  columns.append(grid, ...(plots ? [plots] : []));
  return columns;
}

export function detailGridWithRemaining(
  rows: Array<[string, string]>,
  session?: ISession,
): HTMLDListElement {
  const remaining =
    session && countsDown(session)
      ? remainingBadge(session, Date.now())
      : undefined;
  const grid = detailGrid(
    remaining ? [...rows, ["Remaining", remaining.label]] : rows,
  );
  if (remaining) {
    grid.children[rows.length * 2 + 1]?.classList.toggle(
      "csSessionDetailLow",
      remaining.low,
    );
  }
  return grid;
}

export function logSection(lines: ILogLine[]): {
  section: HTMLElement;
  scroller: HTMLElement;
} {
  const section = element("section", "", "csSessionLog");
  section.appendChild(element("h4", "Status", "csSessionLogTitle"));
  const scroller = element("div", "", "csSessionLogScroll");
  scroller.role = "log";
  for (const line of lines) {
    scroller.appendChild(logLine(line));
  }
  section.appendChild(scroller);
  return { section, scroller };
}

export function dialogBody(
  subtitle: string,
  error: string,
): { root: HTMLElement; scroll: HTMLElement; card: HTMLElement } {
  const root = element("div", "", "csRoot csScrollRoot");
  root.append(
    element("div", subtitle, "csDialogSubtitle"),
    element("hr", "", "csDialogRule"),
  );
  const scroll = element("div", "", "csDialogScroll");
  if (error) {
    scroll.appendChild(element("div", error, "csError"));
  }
  root.appendChild(scroll);
  return { root, scroll, card: element("div", "", "csCard") };
}

export function disclosure(
  key: string,
  openSet: Set<string>,
  summaryChildren: HTMLElement[],
): { entry: HTMLDetailsElement; body: HTMLElement } {
  const entry = document.createElement("details");
  entry.className = "csSshHostEntry";
  entry.open = openSet.has(key);
  entry.ontoggle = () => (entry.open ? openSet.add(key) : openSet.delete(key));
  const summary = document.createElement("summary");
  summary.className = "csSshHostSummary";
  summary.append(...summaryChildren);
  const body = element("div", "", "csSshHostBody");
  entry.append(summary, body);
  return { entry, body };
}

function logLine(line: ILogLine): HTMLElement {
  const row = element(
    "div",
    "",
    `csSessionLogLine csSessionLog-${line.stream}`,
  );
  const at = new Date(line.at);
  const stamp = Number.isFinite(at.getTime())
    ? at.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";
  const time = element("time", stamp, "csSessionLogTime");
  if (stamp) time.dateTime = line.at;
  time.title = line.stream;
  row.append(time, element("span", line.text, "csSessionLogText"));
  return row;
}

export class Clock {
  private id: number | undefined;

  constructor(private tick: () => void) {}

  sync(active: boolean): void {
    if (!active) return this.stop();
    this.id ??= window.setInterval(this.tick, 1000);
  }

  stop(): void {
    window.clearInterval(this.id);
    this.id = undefined;
  }
}

export const CLOCK_GLYPH = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><circle cx="8" cy="8" r="5.6" /><path d="M8 4.9V8l2.1 1.6" /></g></svg>`;
