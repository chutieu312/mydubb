import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { Tabs } from "./tabs";

const html = readFileSync(join(__dirname, "../../static/sidepanel.html"), "utf8");
const $ = (id: string) => document.getElementById(id)!;
let tabs: Tabs;

function key(id: string, name: string) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  $(id).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
  tabs = new Tabs();
  tabs.wire(new AbortController().signal);
});

describe("tabs", () => {
  it("are an ARIA tab list: one selected tab in the tab order, its panel shown, the other hidden", () => {
    expect($("tab-create").getAttribute("role")).toBe("tab");
    expect($("tab-create").parentElement!.getAttribute("role")).toBe("tablist");
    expect($("panel-create").getAttribute("aria-labelledby")).toBe("tab-create");
    expect($("tab-create").getAttribute("aria-controls")).toBe("panel-create");
    tabs.select("listen");
    expect($("tab-listen").getAttribute("aria-selected")).toBe("true");
    expect($("tab-create").getAttribute("aria-selected")).toBe("false");
    expect($("tab-listen").tabIndex).toBe(0);
    expect($("tab-create").tabIndex).toBe(-1);
    // A hidden panel takes its controls out of the tab order and the accessibility tree.
    expect($("panel-create").hidden).toBe(true);
    expect($("panel-listen").hidden).toBe(false);
  });

  it("arrow keys, Home and End move and select, with the focus on the new tab", () => {
    $("tab-create").focus();
    const right = key("tab-create", "ArrowRight");
    expect(right.defaultPrevented).toBe(true);
    expect(tabs.active).toBe("listen");
    expect(document.activeElement).toBe($("tab-listen"));
    key("tab-listen", "ArrowRight"); // wraps
    expect(tabs.active).toBe("create");
    key("tab-create", "ArrowLeft");
    expect(tabs.active).toBe("listen");
    key("tab-listen", "Home");
    expect(tabs.active).toBe("create");
    key("tab-create", "End");
    expect(tabs.active).toBe("listen");
    expect(key("tab-listen", "Enter").defaultPrevented).toBe(false);
  });

  it("focus inside a panel being hidden moves to the tab shown instead of being lost", () => {
    $("transcript").focus();
    tabs.jobAccepted();
    expect(document.activeElement).toBe($("tab-listen"));
    // Focus already lost (Chrome blurs a button that becomes disabled) is given to the tab too.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    tabs.requestRefused(null);
    expect(document.activeElement).toBe($("tab-create"));
    // Focus elsewhere (the header) is left alone.
    $("tab-create").focus();
    tabs.select("listen");
    tabs.select("create");
    expect(document.activeElement).toBe($("tab-create"));
  });

  it("restoring a job switches to Listen only while the user has not chosen a tab", () => {
    $("tab-create").click();
    tabs.jobRestored();
    expect(tabs.active).toBe("create");
    const fresh = new Tabs();
    fresh.jobRestored();
    expect(fresh.active).toBe("listen");
    // A selection from the page always goes to the form, and then restoring changes nothing.
    const sent = new Tabs();
    sent.select("listen");
    sent.selectionArrived();
    sent.jobRestored();
    expect(sent.active).toBe("create");
  });

  it("the Listen badge appears only while Listen is not shown", () => {
    tabs.listenAttention("ready");
    expect($("listen-badge").hidden).toBe(false);
    expect($("listen-badge").textContent).toBe("New");
    expect($("tab-listen").textContent).toContain("New");
    tabs.select("listen");
    expect($("listen-badge").hidden).toBe(true);
    tabs.listenAttention("error");
    expect($("listen-badge").hidden).toBe(true);
  });
});
