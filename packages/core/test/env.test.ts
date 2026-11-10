import { describe, expect, it } from "vitest";
import { choiceEnv, ConfigError, intEnv, listEnv, requiredEnv, stringEnv, urlEnv } from "../src";

const fails = (fn: () => unknown, message: RegExp) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected a ConfigError");
};

describe("requiredEnv / stringEnv", () => {
  it("returns the trimmed value", () => {
    expect(requiredEnv({ A: "  x " }, "A")).toBe("x");
    expect(stringEnv({ A: "y" }, "A", "d")).toBe("y");
  });

  it.each([[undefined], [""], ["   "]])("treats %j as unset", (value) => {
    fails(() => requiredEnv({ A: value }, "A"), /A is required/);
    expect(stringEnv({ A: value }, "A", "fallback")).toBe("fallback");
  });
});

describe("intEnv", () => {
  it("uses the fallback when the variable is unset or blank, instead of turning '' into 0", () => {
    expect(intEnv({}, "N", 7)).toBe(7);
    expect(intEnv({ N: "" }, "N", 7)).toBe(7);
  });

  it.each([["0", 0], ["42", 42], ["-3", -3], [" 9 ", 9]])("reads %j", (text, expected) => {
    expect(intEnv({ N: text }, "N", 1)).toBe(expected);
  });

  it.each(["abc", "1.5", "1e3", "0x10", "3x", "--1", "NaN", "Infinity"])("rejects %j, naming the variable", (text) => {
    fails(() => intEnv({ PORT: text }, "PORT", 1), /PORT must be a whole number/);
  });

  it("rejects numbers that cannot be represented exactly", () => {
    fails(() => intEnv({ N: "99999999999999999999" }, "N", 1), /too large/);
  });

  it("enforces the range, inclusive", () => {
    expect(intEnv({ N: "5" }, "N", 1, { min: 5, max: 5 })).toBe(5);
    fails(() => intEnv({ N: "0" }, "N", 1, { min: 1 }), /at least 1/);
    fails(() => intEnv({ N: "70000" }, "N", 1, { max: 65535 }), /at most 65535/);
  });

  it("does not range-check the fallback away: an unset variable just uses it", () => {
    expect(intEnv({}, "N", 4000, { min: 1, max: 65535 })).toBe(4000);
  });
});

describe("listEnv", () => {
  it("splits on commas, trims, and drops empties", () => {
    expect(listEnv({ L: " a , b,, c " }, "L", [])).toEqual(["a", "b", "c"]);
  });

  it("uses the fallback when unset, and rejects a list with nothing in it", () => {
    expect(listEnv({}, "L", ["x"])).toEqual(["x"]);
    fails(() => listEnv({ L: " , , " }, "L", ["x"]), /at least one/);
  });
});

describe("choiceEnv", () => {
  it("accepts a listed value and falls back when unset", () => {
    expect(choiceEnv({ L: "debug" }, "L", ["info", "debug"], "info")).toBe("debug");
    expect(choiceEnv({}, "L", ["info", "debug"], "info")).toBe("info");
  });

  it("rejects anything else, listing what is allowed", () => {
    fails(() => choiceEnv({ L: "verbose" }, "L", ["info", "debug"], "info"), /one of info, debug/);
  });
});

describe("urlEnv", () => {
  it("accepts a URL with an allowed protocol", () => {
    expect(urlEnv({ U: "postgres://u:p@h:5432/db" }, "U", ["postgres:", "postgresql:"])).toBe("postgres://u:p@h:5432/db");
  });

  it("rejects a missing value, a non-URL and the wrong protocol", () => {
    fails(() => urlEnv({}, "U", ["amqp:"]), /U is required/);
    fails(() => urlEnv({ U: "not a url" }, "U", ["amqp:"]), /not a valid URL/);
    fails(() => urlEnv({ U: "http://h" }, "U", ["amqp:", "amqps:"]), /must start with amqp: or amqps:/);
  });

  it("never puts the value, which may contain a password, in the error", () => {
    try {
      urlEnv({ U: "mysql://user:s3cret@h/db" }, "U", ["postgres:"]);
    } catch (err) {
      expect((err as Error).message).not.toContain("s3cret");
    }
  });
});
