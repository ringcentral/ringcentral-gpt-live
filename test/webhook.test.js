import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import OpenAI from "openai";
import {
  acceptLiveSession,
  createWebhookServer,
  hasSipCallToken,
  rejectLiveSession,
} from "../src/webhook.js";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

function signedHeaders(secretBytes, body, id = "wh_test") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
}

const quietLogger = { log() {}, warn() {}, error() {} };

test("HTTP server logs every request with method, path, status, and duration", async (t) => {
  const logs = [];
  const server = createWebhookServer({
    unwrap: async () => ({ type: "ignored" }),
    acceptCall: async () => {},
    logger: { ...quietLogger, log: (message) => logs.push(message) },
  });
  t.after(() => close(server));
  const origin = await listen(server);

  await fetch(`${origin}/health?do-not-log=this-query`);
  await fetch(`${origin}/missing`, { method: "PUT" });
  await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });

  assert.equal(logs.length, 3);
  assert.match(logs[0], /^HTTP GET \/health -> 200 \(\d+\.\dms\)$/);
  assert.match(logs[1], /^HTTP PUT \/missing -> 404 \(\d+\.\dms\)$/);
  assert.match(logs[2], /^HTTP POST \/webhook -> 200 \(\d+\.\dms\)$/);
  assert.equal(logs.some((message) => message.includes("do-not-log")), false);
});

test("SIP call token is taken only from the From URI user", () => {
  const event = {
    data: {
      sip_headers: [
        { name: "To", value: "<sip:project@example.com>" },
        { name: "From", value: '"Demo" <sip:0123456789abcdef@192.0.2.1>;tag=x' },
      ],
    },
  };
  assert.equal(hasSipCallToken(event, "0123456789abcdef"), true);
  assert.equal(hasSipCallToken(event, "fedcba9876543210"), false);
  assert.equal(hasSipCallToken({ data: {} }, "0123456789abcdef"), false);
});

test("real OpenAI SDK verification accepts and deduplicates a Live SIP webhook", async (t) => {
  const secretBytes = randomBytes(32);
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const client = new OpenAI({ apiKey: "sk-test", webhookSecret: secret });
  const accepted = [];
  const server = createWebhookServer({
    unwrap: (body, headers) => client.webhooks.unwrap(body, headers),
    acceptCall: async (sessionId) => accepted.push(sessionId),
    logger: quietLogger,
  });
  t.after(() => close(server));
  const origin = await listen(server);
  const body = JSON.stringify({
    object: "event",
    id: "evt_test",
    type: "live.transport.incoming",
    data: { type: "sip", session_id: "live_test" },
  });
  const headers = signedHeaders(secretBytes, body);

  const first = await fetch(`${origin}/webhook`, { method: "POST", headers, body });
  const second = await fetch(`${origin}/webhook`, { method: "POST", headers, body });
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "accepted\n");
  assert.equal(second.status, 200);
  assert.equal(await second.text(), "duplicate\n");
  assert.deepEqual(accepted, ["live_test"]);
});

test("current and deprecated Live events cannot decide the same session twice", async (t) => {
  const accepted = [];
  let nextEvent = {
    id: "evt_current",
    type: "live.transport.incoming",
    data: { type: "sip", session_id: "live_same" },
  };
  const server = createWebhookServer({
    unwrap: async () => nextEvent,
    acceptCall: async (sessionId) => accepted.push(sessionId),
    logger: quietLogger,
  });
  t.after(() => close(server));
  const origin = await listen(server);

  const first = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });
  nextEvent = {
    id: "evt_legacy",
    type: "live.call.incoming",
    data: { session_id: "live_same" },
  };
  const legacy = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });

  assert.equal(await first.text(), "accepted\n");
  assert.equal(await legacy.text(), "duplicate\n");
  assert.deepEqual(accepted, ["live_same"]);
});

test("altering the signed raw body is rejected before session acceptance", async (t) => {
  const secretBytes = randomBytes(32);
  const client = new OpenAI({
    apiKey: "sk-test",
    webhookSecret: `whsec_${secretBytes.toString("base64")}`,
  });
  let accepted = false;
  const server = createWebhookServer({
    unwrap: (body, headers) => client.webhooks.unwrap(body, headers),
    acceptCall: async () => { accepted = true; },
    logger: quietLogger,
  });
  t.after(() => close(server));
  const original = JSON.stringify({
    type: "live.transport.incoming",
    data: { type: "sip", session_id: "live_test" },
  });
  const origin = await listen(server);
  const response = await fetch(`${origin}/webhook`, {
    method: "POST",
    headers: signedHeaders(secretBytes, original, "wh_changed"),
    body: `${original} `,
  });
  assert.equal(response.status, 400);
  assert.equal(accepted, false);
});

test("unrelated and non-SIP webhooks are acknowledged without acceptance", async (t) => {
  let event = { type: "response.completed", data: {} };
  let accepted = false;
  const server = createWebhookServer({
    unwrap: async () => event,
    acceptCall: async () => { accepted = true; },
    logger: quietLogger,
  });
  t.after(() => close(server));
  const origin = await listen(server);

  const unrelated = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });
  event = {
    type: "live.transport.incoming",
    data: { type: "webrtc", session_id: "live_webrtc" },
  };
  const nonSip = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });

  assert.equal(await unrelated.text(), "ignored\n");
  assert.equal(await nonSip.text(), "ignored\n");
  assert.equal(accepted, false);
});

test("authorized-caller check rejects an unexpected SIP caller", async (t) => {
  let accepted = false;
  const rejected = [];
  const server = createWebhookServer({
    unwrap: async () => ({
      id: "evt_unexpected",
      type: "live.transport.incoming",
      data: { type: "sip", session_id: "live_unexpected", sip_headers: [] },
    }),
    authorizeCall: () => false,
    acceptCall: async () => { accepted = true; },
    rejectCall: async (sessionId) => rejected.push(sessionId),
    logger: quietLogger,
  });
  t.after(() => close(server));
  const origin = await listen(server);
  const response = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "rejected\n");
  assert.equal(accepted, false);
  assert.deepEqual(rejected, ["live_unexpected"]);
});

test("monitoring starts after acceptance and its failure does not fail the webhook", async (t) => {
  const order = [];
  const errors = [];
  const server = createWebhookServer({
    unwrap: async () => ({
      id: "evt_monitored",
      type: "live.transport.incoming",
      data: { type: "sip", session_id: "live_monitored" },
    }),
    acceptCall: async () => { order.push("accepted"); },
    monitorCall: () => {
      order.push("monitored");
      throw new Error("monitor unavailable");
    },
    logger: { ...quietLogger, error: (message) => errors.push(message) },
  });
  t.after(() => close(server));
  const origin = await listen(server);

  const response = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "accepted\n");
  assert.deepEqual(order, ["accepted", "monitored"]);
  assert.deepEqual(errors, [
    "Live sideband monitor failed for live_monitored: monitor unavailable",
  ]);
});

test("a failed acceptance remains retryable", async (t) => {
  let attempts = 0;
  const server = createWebhookServer({
    unwrap: async () => ({
      id: `evt_attempt_${attempts}`,
      type: "live.transport.incoming",
      data: { type: "sip", session_id: "live_retry" },
    }),
    acceptCall: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("accept failed");
    },
    logger: quietLogger,
  });
  t.after(() => close(server));
  const origin = await listen(server);

  const first = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });
  const retry = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });
  assert.equal(first.status, 502);
  assert.equal(retry.status, 200);
  assert.equal(await retry.text(), "accepted\n");
  assert.equal(attempts, 2);
});

test("acceptLiveSession sends the documented endpoint and body", async () => {
  let captured;
  await acceptLiveSession("live/a b", {
    apiKey: "sk-secret",
    model: "gpt-live-1",
    instructions: "Be helpful.",
    initialGreetingInstructions: "Greet the caller now, then pause and listen.",
    voice: "marin",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response("", { status: 200 });
    },
  });
  assert.equal(captured.url, "https://api.openai.com/v1/live/sessions/live%2Fa%20b/accept");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer sk-secret");
  assert.deepEqual(JSON.parse(captured.options.body), {
    session: {
      type: "live",
      model: "gpt-live-1",
      instructions: "Be helpful.",
      input: [{
        type: "message",
        role: "developer",
        content: [{
          type: "input_text",
          text: "Greet the caller now, then pause and listen.",
        }],
      }],
      audio: { output: { voice: "marin" } },
    },
  });
});

test("acceptLiveSession validates voice and surfaces non-2xx responses", async () => {
  await assert.rejects(
    acceptLiveSession("live_test", { apiKey: "sk-secret", voice: "" }),
    /voice must be a non-empty string/,
  );
  await assert.rejects(
    acceptLiveSession("live_test", {
      apiKey: "sk-secret",
      fetchImpl: async () => new Response("bad request", { status: 400 }),
    }),
    /failed \(400\): bad request/,
  );
});

test("acceptLiveSession configures a dedicated Responses backend and tools", async () => {
  let body;
  await acceptLiveSession("live_tools", {
    apiKey: "sk-secret",
    backendModel: "gpt-6-luna",
    backendInstructions: "Use store tools.",
    tools: [{ type: "function", name: "check_inventory", parameters: { type: "object" } }],
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response("", { status: 200 });
    },
  });
  assert.deepEqual(body.session.delegation, {
    type: "responses",
    responses: {
      model: "gpt-6-luna",
      instructions: "Use store tools.",
      tools: [{ type: "function", name: "check_inventory", parameters: { type: "object" } }],
      tool_choice: "auto",
      parallel_tool_calls: false,
    },
  });
});

test("rejectLiveSession sends SIP status 603 to the Live reject action", async () => {
  let captured;
  await rejectLiveSession("live_test", {
    apiKey: "sk-secret",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response("", { status: 200 });
    },
  });
  assert.equal(captured.url, "https://api.openai.com/v1/live/sessions/live_test/reject");
  assert.deepEqual(JSON.parse(captured.options.body), { status_code: 603 });
});
