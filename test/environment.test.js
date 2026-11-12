import assert from "node:assert/strict";
import test from "node:test";
import { booleanFromEnvironment } from "../src/environment.js";

test("boolean environment settings are strict, defaultable, and independent", () => {
  const environment = {
    LOG_SIP_MESSAGES: "true",
    LOG_WEBSOCKET_MESSAGES: "0",
    RECORD_INCOMING_AUDIO: "off",
  };

  assert.equal(booleanFromEnvironment("LOG_SIP_MESSAGES", false, environment), true);
  assert.equal(booleanFromEnvironment("LOG_WEBSOCKET_MESSAGES", true, environment), false);
  assert.equal(booleanFromEnvironment("RECORD_INCOMING_AUDIO", true, environment), false);
  assert.equal(booleanFromEnvironment("MISSING", false, environment), false);
  assert.equal(booleanFromEnvironment("MISSING", true, environment), true);
  assert.equal(booleanFromEnvironment("YES", false, { YES: " yes " }), true);
  assert.equal(booleanFromEnvironment("OFF", true, { OFF: "off" }), false);
  assert.throws(
    () => booleanFromEnvironment("INVALID", false, { INVALID: "sometimes" }),
    /INVALID must be true or false/,
  );
});
