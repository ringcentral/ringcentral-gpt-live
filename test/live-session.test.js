import assert from "node:assert/strict";
import test from "node:test";
import { createSessionMonitors } from "../src/live-session.js";

function fakeMonitors() {
  const sessions = new Map();
  return {
    sessions,
    monitor: (sessionId, options) => {
      const instance = {
        options,
        closed: [],
        close(closeOptions) {
          this.closed.push(closeOptions);
          options.onClose(this);
        },
      };
      sessions.set(sessionId, instance);
      return instance;
    },
  };
}

const HERO = { store_id: "PA", product_id: "GLIDE4", size: 10 };

test("each live session gets its own holds and inventory", () => {
  const fake = fakeMonitors();
  const monitors = createSessionMonitors({ apiKey: "sk-test", monitor: fake.monitor });
  monitors.monitorCall("live_a");
  monitors.monitorCall("live_b");
  const callerA = fake.sessions.get("live_a").options.toolExecutor;
  const callerB = fake.sessions.get("live_b").options.toolExecutor;

  const stockBefore = callerB("check_inventory", HERO).quantity;
  const hold = callerA("place_hold", HERO);
  assert.equal(hold.hold_id, "SW-0001");

  // Caller B can neither see nor act on caller A's hold, and B's stock is untouched.
  assert.equal(callerB("send_text_confirmation", { hold_id: "SW-0001" }).status, "hold_not_found");
  assert.equal(callerB("check_inventory", HERO).quantity, stockBefore);
  assert.equal(callerA("send_text_confirmation", { hold_id: "SW-0001" }).status, "recorded_in_demo");
});

test("a session keeps one monitor and store until it closes, then starts fresh", () => {
  const fake = fakeMonitors();
  let stores = 0;
  const monitors = createSessionMonitors({
    apiKey: "sk-test",
    monitor: fake.monitor,
    createStore: () => {
      stores += 1;
      return { execute: () => ({}) };
    },
  });

  const first = monitors.monitorCall("live_same");
  assert.equal(monitors.monitorCall("live_same"), first);
  assert.equal(stores, 1);

  monitors.closeAll({ code: 1001, reason: "shutdown" });
  assert.deepEqual(first.closed, [{ code: 1001, reason: "shutdown" }]);
  assert.notEqual(monitors.monitorCall("live_same"), first);
  assert.equal(stores, 2);
});
