// The two views of the side panel, Create audio and Listen (WAI-ARIA tabs, automatic activation).
// Switching only shows and hides markup: the draft, the job being followed, the playback session
// and Sync live elsewhere and carry on whichever tab is shown. An inactive panel is `hidden`, so
// nothing in it stays in the tab order.

export type TabName = "create" | "listen";

const NAMES: readonly TabName[] = ["create", "listen"];

/** What the Dubbing half of the panel asks of the tabs (see DubbingHost). */
export interface TabRequests {
  /** The server accepted a Generate click: show its progress. */
  jobAccepted(): void;
  /** The server refused a Generate click: back to the form, focus on the field to fix. */
  requestRefused(focusId: string | null): void;
  /** A followed job was restored when the panel opened. */
  jobRestored(): void;
  /** Something on Listen needs a look while it is not shown. */
  listenAttention(kind: "ready" | "error"): void;
}

export class Tabs implements TabRequests {
  private current: TabName = "create";
  // Once the user picked a tab (or a selection arrived), restoring never switches by itself.
  private settled = false;

  constructor(private readonly doc: Document = document) {}

  get active(): TabName {
    return this.current;
  }

  wire(signal: AbortSignal): void {
    for (const name of NAMES) {
      const tab = this.tab(name);
      tab.addEventListener("click", () => this.select(name, { byUser: true }), { signal });
      tab.addEventListener("keydown", (event) => this.onKey(event, name), { signal });
    }
    this.byId("go-create").addEventListener("click", () => this.select("create", { byUser: true, focus: true }), { signal });
  }

  select(name: TabName, options: { focus?: boolean; byUser?: boolean } = {}): void {
    if (options.byUser) this.settled = true;
    // Focus inside the panel being hidden would be lost, and focus already lost (Chrome drops it
    // from a button that becomes disabled, like Generate while sending) stays lost: either way it
    // moves to the tab that is shown.
    const active = this.doc.activeElement;
    const focusLost =
      this.current !== name && (active === null || active === this.doc.body || this.panel(this.current).contains(active));
    this.current = name;
    for (const other of NAMES) {
      const selected = other === name;
      const tab = this.tab(other);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      this.panel(other).hidden = !selected;
    }
    if (name === "listen") this.badge("");
    if (options.focus || focusLost) this.tab(name).focus();
  }

  /** A selection from the page belongs to the form. */
  selectionArrived(): void {
    this.settled = true;
    this.select("create");
  }

  jobAccepted(): void {
    this.settled = true;
    this.select("listen");
  }

  requestRefused(focusId: string | null): void {
    this.select("create");
    const target = focusId ? this.doc.getElementById(focusId) : null;
    if (target instanceof HTMLElement) target.focus();
  }

  jobRestored(): void {
    if (!this.settled) this.select("listen");
    this.settled = true;
  }

  listenAttention(kind: "ready" | "error"): void {
    if (this.current !== "listen") this.badge(kind === "ready" ? "New" : "Error");
  }

  private badge(text: string): void {
    const badge = this.doc.getElementById("listen-badge");
    if (!badge) return;
    badge.textContent = text;
    badge.hidden = text === "";
  }

  private onKey(event: KeyboardEvent, from: TabName): void {
    const index = NAMES.indexOf(from);
    let next: TabName | undefined;
    if (event.key === "ArrowRight") next = NAMES[(index + 1) % NAMES.length];
    else if (event.key === "ArrowLeft") next = NAMES[(index - 1 + NAMES.length) % NAMES.length];
    else if (event.key === "Home") next = NAMES[0];
    else if (event.key === "End") next = NAMES[NAMES.length - 1];
    if (!next) return;
    event.preventDefault();
    this.select(next, { byUser: true, focus: true });
  }

  private tab(name: TabName): HTMLElement {
    return this.byId(`tab-${name}`);
  }

  private panel(name: TabName): HTMLElement {
    return this.byId(`panel-${name}`);
  }

  private byId(id: string): HTMLElement {
    const el = this.doc.getElementById(id);
    if (!el) throw new Error(`missing #${id}`);
    return el;
  }
}
