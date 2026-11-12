const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function booleanFromEnvironment(name, fallback = false, environment = process.env) {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new Error(`${name} must be true or false`);
}
