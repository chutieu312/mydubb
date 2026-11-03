import { describe, expect, it } from "vitest";
import css from "../public/extension-privacy.css?raw";
import html from "../public/extension-privacy.html?raw";

// The page is published as it is: nothing builds, fills in or checks it later.
describe("the extension privacy policy page", () => {
  it("is a page of its own: no script, no app bundle, nothing the server's CSP would refuse", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain('id="root"');
    expect(html).not.toContain("noindex");
  });

  it("loads nothing from another site, and calls no API", () => {
    const loaded = [...html.matchAll(/<(?:link|img|iframe|source|audio|video)\b[^>]*\b(?:href|src)="([^"]+)"/gi)];
    expect(loaded.map((match) => match[1]).sort()).toEqual(["/extension-privacy.css", "/favicon.svg"]);
    expect(css).not.toMatch(/url\(|@import/i);
    expect(html).not.toContain("/api/");
  });

  it("holds no internal note, marker or website appendix", () => {
    // Case-sensitive: "the saved draft" is what Clear removes.
    expect(html).not.toMatch(/\[PO|Appendix|DRAFT|Draft|Product Owner|TODO|placeholder/);
    expect(html).not.toMatch(/published on|now live/i);
  });

  it("names the operator and the contact, and keeps the Limited Use statement", () => {
    expect(html).toContain("Operator: Can Nguyen");
    expect(html).toContain('href="mailto:support@mydubb.com"');
    expect(html.replace(/\s+/g, " ")).toContain(
      "adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements",
    );
  });
});
