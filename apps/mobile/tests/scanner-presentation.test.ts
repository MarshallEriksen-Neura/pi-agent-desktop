import { describe, expect, it } from "vitest";
import {
  SCANNER_ACTIVE_CLASS,
  setScannerPresentationActive,
} from "@/security/scanner-presentation";

function fakeDocument() {
  const htmlClasses = new Set<string>();
  const bodyClasses = new Set<string>();

  const classList = (classes: Set<string>) => ({
    toggle(name: string, force?: boolean) {
      if (force === true) classes.add(name);
      if (force === false) classes.delete(name);
      return classes.has(name);
    },
  });

  return {
    target: {
      documentElement: { classList: classList(htmlClasses) },
      body: { classList: classList(bodyClasses) },
    } as unknown as Pick<Document, "documentElement" | "body">,
    htmlClasses,
    bodyClasses,
  };
}

describe("scanner presentation", () => {
  it("makes both DOM background owners scanner-active and restores them", () => {
    const { target, htmlClasses, bodyClasses } = fakeDocument();

    setScannerPresentationActive(true, target);
    expect(htmlClasses.has(SCANNER_ACTIVE_CLASS)).toBe(true);
    expect(bodyClasses.has(SCANNER_ACTIVE_CLASS)).toBe(true);

    setScannerPresentationActive(false, target);
    expect(htmlClasses.has(SCANNER_ACTIVE_CLASS)).toBe(false);
    expect(bodyClasses.has(SCANNER_ACTIVE_CLASS)).toBe(false);
  });

  it("is safe when no document exists", () => {
    expect(() => setScannerPresentationActive(true, undefined)).not.toThrow();
  });
});
