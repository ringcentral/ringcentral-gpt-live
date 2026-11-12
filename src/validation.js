const SIP_CALL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// The test caller sends this token as the user part of its SIP From URI.
export function assertSipCallToken(value) {
  if (typeof value !== "string" || !SIP_CALL_TOKEN_PATTERN.test(value)) {
    throw new Error("SIP_CALL_TOKEN must contain 16-64 letters, digits, underscores, or hyphens");
  }
  return value;
}

export function assertPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return value;
}
