const STORES = {
  SC: {
    id: "SC",
    name: "Stridewell Santa Clara",
    address: "101 Track Lane, Santa Clara, CA 95050",
    phone: "+1 408 555 0101",
    hours: "Monday through Saturday 10 AM to 8 PM; Sunday 11 AM to 6 PM",
  },
  SJ: {
    id: "SJ",
    name: "Stridewell San Jose",
    address: "202 Tempo Terrace, San Jose, CA 95113",
    phone: "+1 408 555 0102",
    hours: "Monday through Saturday 10 AM to 8 PM; Sunday 11 AM to 6 PM",
  },
  PA: {
    id: "PA",
    name: "Stridewell Palo Alto",
    address: "303 Trailhead Avenue, Palo Alto, CA 94301",
    phone: "+1 650 555 0103",
    hours: "Monday through Saturday 10 AM to 7 PM; Sunday 11 AM to 5 PM",
  },
  SF: {
    id: "SF",
    name: "Stridewell San Francisco",
    address: "404 Bay Runner Road, San Francisco, CA 94103",
    phone: "+1 415 555 0104",
    hours: "Monday through Saturday 10 AM to 8 PM; Sunday 11 AM to 6 PM",
  },
};

const PRODUCTS = {
  GLIDE4: { id: "GLIDE4", name: "Veloce Glide 4", type: "road, everyday trainer", price: 140 },
  CLOUD2: { id: "CLOUD2", name: "Tern Cloud Runner 2", type: "road, cushioned", price: 130 },
  RIDGE1: { id: "RIDGE1", name: "Ridgeline Trail Pro", type: "trail", price: 155 },
};

const DISTANCES_FROM_SANTA_CLARA = { SJ: 8, PA: 14, SF: 45 };
const INVENTORY_KEY = (storeId, productId, size) => `${storeId}:${productId}:${size}`;

export const STRIDEWELL_LIVE_INSTRUCTIONS = `
You are the AI phone assistant for Stridewell Santa Clara, a fictional running and outdoor store.
At the start of every call, identify the store and say that you are its AI assistant.
Sound like a practical running buddy: friendly, brief, and never pushy. Use short sentences, ask one
question at a time, and stop immediately when interrupted.

Delegate every store address or hours question, inventory question, nearest-store lookup, hold, text
confirmation, and request to connect to staff to the backend agent. Never guess store details, stock,
distance, or whether an action succeeded. The backend
may report that a demo action was only recorded in memory; describe that limitation honestly.

Never take payment or ask for card details. Do not recommend a shoe size. For returns, fit questions, or
a request for a person, offer to connect the caller to store staff. Politely redirect unrelated requests
back to Stridewell products and store help. Never read a caller's phone number aloud.
`.trim();

export const STRIDEWELL_BACKEND_INSTRUCTIONS = `
You support a GPT-Live voice assistant for the fictional Stridewell Santa Clara store (store ID SC).
Use the provided tools for all store facts and actions. Do not invent inventory. If a tool reports unknown
inventory, say that staff must confirm it. A hold lasts 24 hours and pickup is usually ready within about
24 hours. Never take payment, request card details, guess a shoe size, or reveal a caller phone number.

For an out-of-stock item, check the nearest store with stock. Place a hold only after the caller clearly
confirms that they want one. Send a demo text confirmation only after a hold exists. For returns, fit
questions, or explicit requests for a person, use request_human_connection. Keep results concise because
they will be spoken aloud. Tool actions are demo-only in-memory records; do not claim an external SMS or
phone transfer happened when the tool result says it was only recorded.
`.trim();

export const STRIDEWELL_TOOLS = [
  {
    type: "function",
    name: "get_store_details",
    description: "Get the fictional address, phone number, and opening hours for a Stridewell store.",
    parameters: {
      type: "object",
      properties: { store_id: { type: "string", enum: Object.keys(STORES) } },
      required: ["store_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "check_inventory",
    description: "Check the known inventory status for one product, US size, and Stridewell store.",
    parameters: {
      type: "object",
      properties: {
        store_id: { type: "string", enum: Object.keys(STORES) },
        product_id: { type: "string", enum: Object.keys(PRODUCTS) },
        size: { type: "number", enum: [9, 10, 11] },
      },
      required: ["store_id", "product_id", "size"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "find_nearest_store_with_stock",
    description: "Find the nearest store with known stock. Demo distances are defined from Santa Clara.",
    parameters: {
      type: "object",
      properties: {
        origin_store_id: { type: "string", enum: ["SC"] },
        product_id: { type: "string", enum: Object.keys(PRODUCTS) },
        size: { type: "number", enum: [9, 10, 11] },
      },
      required: ["origin_store_id", "product_id", "size"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "place_hold",
    description: "Place a 24-hour demo hold on a pair with known available inventory.",
    parameters: {
      type: "object",
      properties: {
        store_id: { type: "string", enum: Object.keys(STORES) },
        product_id: { type: "string", enum: Object.keys(PRODUCTS) },
        size: { type: "number", enum: [9, 10, 11] },
      },
      required: ["store_id", "product_id", "size"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "send_text_confirmation",
    description: "Record a demo text confirmation for an existing hold without exposing a phone number.",
    parameters: {
      type: "object",
      properties: { hold_id: { type: "string" } },
      required: ["hold_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "request_human_connection",
    description: "Record a request to connect the caller to a store for fit, returns, or human help.",
    parameters: {
      type: "object",
      properties: {
        store_id: { type: "string", enum: Object.keys(STORES) },
        reason: { type: "string", enum: ["fit", "return", "other"] },
      },
      required: ["store_id", "reason"],
      additionalProperties: false,
    },
  },
];

function itemDetails(storeId, productId, size) {
  return { store: STORES[storeId], product: PRODUCTS[productId], size };
}

export function createStridewellStore({ random = Math.random } = {}) {
  const inventory = new Map();
  for (const storeId of Object.keys(STORES)) {
    for (const productId of Object.keys(PRODUCTS)) {
      for (const size of [9, 10, 11]) {
        inventory.set(INVENTORY_KEY(storeId, productId, size), Math.floor(random() * 4) + 1);
      }
    }
  }
  // Scenario overrides: the hero item is out in Santa Clara and San Jose.
  inventory.set(INVENTORY_KEY("SC", "GLIDE4", 10), 0);
  inventory.set(INVENTORY_KEY("SJ", "GLIDE4", 10), 0);
  const holds = new Map();
  const texts = [];
  const connectionRequests = [];
  let nextHold = 1;
  let nextConnection = 1;

  const checkInventory = ({ store_id: storeId, product_id: productId, size }) => {
    const details = itemDetails(storeId, productId, size);
    if (!details.store || !details.product || ![9, 10, 11].includes(size)) {
      return { status: "invalid_request" };
    }
    const quantity = inventory.get(INVENTORY_KEY(storeId, productId, size));
    return {
      status: quantity === undefined ? "unknown" : quantity > 0 ? "in_stock" : "out_of_stock",
      quantity: quantity ?? null,
      ...details,
    };
  };

  return {
    execute(name, args = {}) {
      if (name === "get_store_details") {
        const store = STORES[args.store_id];
        return store ? { status: "found", store } : { status: "invalid_request" };
      }

      if (name === "check_inventory") return checkInventory(args);

      if (name === "find_nearest_store_with_stock") {
        const { origin_store_id: originStoreId, product_id: productId, size } = args;
        if (originStoreId !== "SC" || !PRODUCTS[productId] || ![9, 10, 11].includes(size)) {
          return { status: "invalid_request" };
        }
        const match = Object.entries(DISTANCES_FROM_SANTA_CLARA)
          .sort((left, right) => left[1] - right[1])
          .find(([storeId]) => (inventory.get(INVENTORY_KEY(storeId, productId, size)) ?? 0) > 0);
        if (!match) return { status: "no_known_stock", product: PRODUCTS[productId], size };
        const [storeId, distanceMiles] = match;
        return {
          status: "in_stock",
          store: STORES[storeId],
          product: PRODUCTS[productId],
          size,
          distance_miles: distanceMiles,
          quantity: inventory.get(INVENTORY_KEY(storeId, productId, size)),
        };
      }

      if (name === "place_hold") {
        const { store_id: storeId, product_id: productId, size } = args;
        const key = INVENTORY_KEY(storeId, productId, size);
        const quantity = inventory.get(key);
        if (!quantity || quantity < 1) {
          return { status: "unavailable", ...itemDetails(storeId, productId, size) };
        }
        const hold = {
          hold_id: `SW-${String(nextHold++).padStart(4, "0")}`,
          status: "held",
          ...itemDetails(storeId, productId, size),
          hold_duration_hours: 24,
          pickup_timing: "usually ready within about 24 hours",
          text_sent: false,
          remaining_quantity: quantity - 1,
        };
        holds.set(hold.hold_id, hold);
        inventory.set(key, quantity - 1);
        return hold;
      }

      if (name === "send_text_confirmation") {
        const hold = holds.get(args.hold_id);
        if (!hold) return { status: "hold_not_found", hold_id: args.hold_id };
        if (!hold.text_sent) {
          hold.text_sent = true;
          texts.push({ hold_id: hold.hold_id, status: "recorded_in_demo" });
        }
        return {
          status: "recorded_in_demo",
          hold_id: hold.hold_id,
          note: "No SMS provider is connected, so no external text was sent.",
        };
      }

      if (name === "request_human_connection") {
        const store = STORES[args.store_id];
        if (!store) return { status: "invalid_request" };
        const request = {
          request_id: `ROUTE-${String(nextConnection++).padStart(4, "0")}`,
          status: "recorded_in_demo",
          store,
          reason: args.reason,
          note: "No carrier transfer was attempted because all store numbers are fictional.",
        };
        connectionRequests.push(request);
        return request;
      }

      throw new Error(`Unknown Stridewell tool: ${name}`);
    },
    snapshot() {
      return {
        inventory: Object.fromEntries(inventory),
        holds: structuredClone([...holds.values()]),
        texts: structuredClone(texts),
        connectionRequests: structuredClone(connectionRequests),
      };
    },
  };
}
