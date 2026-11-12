import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import OpenAI from "openai";
import { acceptLiveSession, createWebhookServer, rejectLiveSession } from "../src/webhook.js";

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

function incomingEvent(sessionId, id = `evt_${sessionId}`) {
  return { id, type: "live.transport.incoming", data: { type: "sip", session_id: sessionId } };
}

test("a duplicate arriving while the first accept is in flight mirrors its outcome", async (t) => {
  for (const outcome of ["success", "failure"]) {
    let finishAccept;
    let attempts = 0;
    let deliveries = 0;
    const server = createWebhookServer({
      unwrap: async () => incomingEvent(`live_race_${outcome}`, `evt_${outcome}_${deliveries++}`),
      acceptCall: () => {
        attempts += 1;
        return new Promise((resolve, reject) => {
          finishAccept = () => (outcome === "success" || attempts > 1
            ? resolve()
            : reject(new Error("accept failed")));
        });
      },
      logger: quietLogger,
    });
    t.after(() => close(server));
    const origin = await listen(server);
    const post = () => fetch(`${origin}/webhook`, { method: "POST", body: "{}" });

    const first = post();
    while (!finishAccept) await new Promise((resolve) => setImmediate(resolve));
    const duplicate = post();
    // Let the duplicate reach the handler before the first accept settles.
    while (deliveries < 2) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    finishAccept();
    const [firstResponse, duplicateResponse] = await Promise.all([first, duplicate]);

    if (outcome === "success") {
      assert.equal(await firstResponse.text(), "accepted\n");
      assert.equal(duplicateResponse.status, 200);
      assert.equal(await duplicateResponse.text(), "duplicate\n");
    } else {
      assert.equal(firstResponse.status, 502);
      // Acknowledging the duplicate here would stop the sender from ever retrying.
      assert.equal(duplicateResponse.status, 502);
      finishAccept = undefined;
      const retry = post();
      while (!finishAccept) await new Promise((resolve) => setImmediate(resolve));
      finishAccept();
      assert.equal(await (await retry).text(), "accepted\n");
    }
    assert.equal(attempts, outcome === "success" ? 1 : 2);
  }
});

test("an accept with no HTTP response still attaches the monitor and stays retryable", async (t) => {
  const monitored = [];
  let attempts = 0;
  const server = createWebhookServer({
    unwrap: async () => incomingEvent("live_ambiguous", `evt_ambiguous_${attempts}`),
    acceptCall: (sessionId) => {
      attempts += 1;
      return acceptLiveSession(sessionId, {
        apiKey: "sk-test",
        fetchImpl: async () => {
          if (attempts === 1) throw new DOMException("The operation timed out", "TimeoutError");
          return new Response(
            JSON.stringify({ error: { code: "decision_already_made" } }),
            { status: 409 },
          );
        },
      });
    },
    monitorCall: (sessionId) => { monitored.push(sessionId); },
    logger: quietLogger,
  });
  t.after(() => close(server));
  const origin = await listen(server);

  const first = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });
  assert.equal(first.status, 502);
  assert.deepEqual(monitored, ["live_ambiguous"]);

  const retry = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });
  assert.equal(retry.status, 200);
  assert.equal(await retry.text(), "accepted\n");
  assert.deepEqual(monitored, ["live_ambiguous", "live_ambiguous"]);

  const later = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });
  assert.equal(await later.text(), "duplicate\n");
  assert.equal(attempts, 2);
});

test("a definite accept failure does not attach the monitor", async (t) => {
  const monitored = [];
  const server = createWebhookServer({
    unwrap: async () => incomingEvent("live_refused"),
    acceptCall: (sessionId) => acceptLiveSession(sessionId, {
      apiKey: "sk-test",
      fetchImpl: async () => new Response("bad session", { status: 400 }),
    }),
    monitorCall: (sessionId) => { monitored.push(sessionId); },
    logger: quietLogger,
  });
  t.after(() => close(server));
  const origin = await listen(server);

  const response = await fetch(`${origin}/webhook`, { method: "POST", body: "{}" });
  assert.equal(response.status, 502);
  assert.deepEqual(monitored, []);
});
