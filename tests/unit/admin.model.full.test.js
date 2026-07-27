import * as AdminModule from "../../src/models/admin.js";

const moduleValue = AdminModule.default ?? AdminModule;

const getEnumerableEntries = (value) => {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return [];
  }

  return Object.entries(value);
};

describe("admin module", () => {
  test("loads successfully and exports at least one value", () => {
    expect(AdminModule).toBeDefined();

    const namespaceEntries = Object.entries(AdminModule).filter(
      ([name]) => name !== "__esModule",
    );

    expect(namespaceEntries.length).toBeGreaterThan(0);

    for (const [, value] of namespaceEntries) {
      expect(value).not.toBeUndefined();
    }
  });

  test("exports a non-null data object", () => {
    expect(moduleValue).not.toBeNull();
    expect(typeof moduleValue).toBe("object");
    expect(Array.isArray(moduleValue)).toBe(false);
  });

  test("exposes enumerable admin definition data", () => {
    const entries = getEnumerableEntries(moduleValue);

    expect(entries.length).toBeGreaterThan(0);

    for (const [key, value] of entries) {
      expect(typeof key).toBe("string");
      expect(key.length).toBeGreaterThan(0);
      expect(value).not.toBeUndefined();
    }
  });

  test("allows its exported definition to be inspected without mutation", () => {
    const originalKeys = Object.keys(moduleValue);
    const copiedDefinition = { ...moduleValue };

    expect(Object.keys(copiedDefinition)).toEqual(originalKeys);

    for (const key of originalKeys) {
      expect(copiedDefinition[key]).toBe(moduleValue[key]);
    }

    expect(Object.keys(moduleValue)).toEqual(originalKeys);
  });
});
