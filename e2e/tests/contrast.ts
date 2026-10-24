import type { Locator } from "@playwright/test";

/** WCAG contrast ratio of the text colour of `target` against its effective background. */
export async function textContrast(target: Locator): Promise<number> {
  return target.evaluate((element) => {
    const parse = (value: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) throw new Error(`Unsupported colour: ${value}`);
      const [r, g, b, a] = m[1]!.split(/[ ,/]+/).map(Number);
      return { r: r!, g: g!, b: b!, a: a ?? 1 };
    };
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const [x, y, z] = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * x! + 0.7152 * y! + 0.0722 * z!;
    };
    let node: Element | null = element;
    let background = { r: 255, g: 255, b: 255, a: 1 };
    while (node) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color.a > 0) {
        background = color;
        break;
      }
      node = node.parentElement;
    }
    const text = parse(getComputedStyle(element).color);
    const [hi, lo] = [luminance(text), luminance(background)].sort((p, q) => q - p);
    return (hi! + 0.05) / (lo! + 0.05);
  });
}

/** Contrast of a control's border against the surface around it (needs 3:1 for UI components). */
export async function borderContrast(target: Locator): Promise<number> {
  return target.evaluate((element) => {
    const parse = (value: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) throw new Error(`Unsupported colour: ${value}`);
      const [r, g, b, a] = m[1]!.split(/[ ,/]+/).map(Number);
      return { r: r!, g: g!, b: b!, a: a ?? 1 };
    };
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const [x, y, z] = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * x! + 0.7152 * y! + 0.0722 * z!;
    };
    let node: Element | null = element.parentElement;
    let surface = { r: 255, g: 255, b: 255, a: 1 };
    while (node) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color.a > 0) {
        surface = color;
        break;
      }
      node = node.parentElement;
    }
    const border = parse(getComputedStyle(element).borderTopColor);
    const [hi, lo] = [luminance(border), luminance(surface)].sort((p, q) => q - p);
    return (hi! + 0.05) / (lo! + 0.05);
  });
}
