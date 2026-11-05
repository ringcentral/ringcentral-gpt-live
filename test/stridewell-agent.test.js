import assert from "node:assert/strict";
import test from "node:test";
import { createStridewellStore, STRIDEWELL_TOOLS } from "../src/stridewell-agent.js";

test("Stridewell exposes readable function tools for the backend agent", () => {
  assert.deepEqual(
    STRIDEWELL_TOOLS.map((tool) => tool.name),
    [
      "get_store_details",
      "check_inventory",
      "find_nearest_store_with_stock",
      "place_hold",
      "send_text_confirmation",
      "request_human_connection",
    ],
  );
  assert.ok(STRIDEWELL_TOOLS.every((tool) => tool.type === "function"));
});

test("hero inventory lookup skips San Jose and finds Palo Alto", () => {
  const store = createStridewellStore({ random: () => 0.4 });

  const santaClara = store.execute("check_inventory", {
    store_id: "SC", product_id: "GLIDE4", size: 10,
  });
  assert.equal(santaClara.status, "out_of_stock");
  assert.equal(santaClara.quantity, 0);
  const sanJose = store.execute("check_inventory", {
    store_id: "SJ", product_id: "GLIDE4", size: 10,
  });
  assert.equal(sanJose.status, "out_of_stock");
  assert.equal(sanJose.quantity, 0);

  const nearest = store.execute("find_nearest_store_with_stock", {
    origin_store_id: "SC", product_id: "GLIDE4", size: 10,
  });
  assert.equal(nearest.status, "in_stock");
  assert.equal(nearest.store.id, "PA");
  assert.equal(nearest.distance_miles, 14);
  assert.equal(nearest.quantity, 2);
});

test("store details return fictional addresses from the in-memory table", () => {
  const store = createStridewellStore();
  const result = store.execute("get_store_details", { store_id: "PA" });
  assert.equal(result.status, "found");
  assert.equal(result.store.address, "303 Trailhead Avenue, Palo Alto, CA 94301");
  assert.match(result.store.hours, /Monday through Saturday/);
});

test("non-hero inventory initializes within the requested one-to-four range", () => {
  const minimum = createStridewellStore({ random: () => 0 }).execute("check_inventory", {
    store_id: "SC", product_id: "CLOUD2", size: 9,
  });
  const maximum = createStridewellStore({ random: () => 0.999999 }).execute("check_inventory", {
    store_id: "SF", product_id: "RIDGE1", size: 11,
  });
  assert.equal(minimum.quantity, 1);
  assert.equal(maximum.quantity, 4);
});

test("all stores, products, and sizes have numeric inventory", () => {
  const store = createStridewellStore({ random: () => 0.5 });
  const snapshot = store.snapshot();
  assert.equal(Object.keys(snapshot.inventory).length, 4 * 3 * 3);
  assert.ok(Object.values(snapshot.inventory).every((quantity) => Number.isInteger(quantity)));
  assert.equal(snapshot.inventory["SC:GLIDE4:10"], 0);
  assert.equal(snapshot.inventory["SJ:GLIDE4:10"], 0);
  assert.equal(snapshot.inventory["PA:GLIDE4:10"], 3);
});

test("hold and confirmation tools update state and cannot hold one pair twice", () => {
  const store = createStridewellStore({ random: () => 0 });
  const hold = store.execute("place_hold", {
    store_id: "PA", product_id: "GLIDE4", size: 10,
  });
  assert.equal(hold.status, "held");
  assert.equal(hold.hold_id, "SW-0001");

  const secondHold = store.execute("place_hold", {
    store_id: "PA", product_id: "GLIDE4", size: 10,
  });
  assert.equal(secondHold.status, "unavailable");

  const confirmation = store.execute("send_text_confirmation", { hold_id: hold.hold_id });
  assert.equal(confirmation.status, "recorded_in_demo");
  assert.match(confirmation.note, /no external text/i);

  const snapshot = store.snapshot();
  assert.equal(hold.remaining_quantity, 0);
  assert.equal(snapshot.inventory["PA:GLIDE4:10"], 0);
  assert.equal(snapshot.holds[0].text_sent, true);
  assert.deepEqual(snapshot.texts, [{ hold_id: "SW-0001", status: "recorded_in_demo" }]);
});

test("human connection requests are explicit in-memory demo records", () => {
  const store = createStridewellStore();
  const request = store.execute("request_human_connection", { store_id: "PA", reason: "fit" });
  assert.equal(request.status, "recorded_in_demo");
  assert.equal(request.store.id, "PA");
  assert.match(request.note, /no carrier transfer/i);
  assert.equal(store.snapshot().connectionRequests.length, 1);
});
