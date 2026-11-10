/**
 * Reading configuration from environment variables, strictly. `Number(process.env.X)` turns an empty
 * string into 0 and a typo into NaN, and the service then starts with a nonsense value. These fail
 * at startup, with a message naming the variable, instead.
 */
export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The variable's value, treating an empty string as unset (compose passes `FOO=` for a blank). */
function raw(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export function requiredEnv(env: Env, name: string): string {
  const value = raw(env, name);
  if (value === undefined) throw new ConfigError(`${name} is required`);
  return value;
}

export function stringEnv(env: Env, name: string, fallback: string): string {
  return raw(env, name) ?? fallback;
}

/** A whole number, within `min` and `max` when given. Anything else (1.5, 1e3, "abc", " 3x") is an error. */
export function intEnv(env: Env, name: string, fallback: number, { min, max }: { min?: number; max?: number } = {}): number {
  const text = raw(env, name);
  if (text === undefined) return fallback;
  if (!/^-?\d+$/.test(text)) throw new ConfigError(`${name} must be a whole number, got "${text}"`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new ConfigError(`${name} is too large: "${text}"`);
  if (min !== undefined && value < min) throw new ConfigError(`${name} must be at least ${min}, got ${value}`);
  if (max !== undefined && value > max) throw new ConfigError(`${name} must be at most ${max}, got ${value}`);
  return value;
}

/** A comma-separated list, trimmed, without empty items. */
export function listEnv(env: Env, name: string, fallback: string[]): string[] {
  const text = raw(env, name);
  if (text === undefined) return fallback;
  const items = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new ConfigError(`${name} must list at least one value`);
  return items;
}

/** One of a fixed set of values. */
export function choiceEnv<T extends string>(env: Env, name: string, choices: readonly T[], fallback: T): T {
  const text = raw(env, name);
  if (text === undefined) return fallback;
  if (!(choices as readonly string[]).includes(text)) throw new ConfigError(`${name} must be one of ${choices.join(", ")}, got "${text}"`);
  return text as T;
}

/** A URL with one of the given protocols. The message never includes the value: it may hold a password. */
export function urlEnv(env: Env, name: string, protocols: readonly string[]): string {
  const text = requiredEnv(env, name);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  if (!protocols.includes(url.protocol)) throw new ConfigError(`${name} must start with ${protocols.join(" or ")}`);
  return text;
}
