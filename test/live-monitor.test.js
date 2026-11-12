import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { monitorLiveSession } from "../src/live-monitor.js";

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = [];
  }

  send(message) {
    this.sent.push(message);
  }

  close(code, reason) {
    this.closed.push({ code, reason });
  }
}

function capturingLogger() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    logger: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
  };
}

test("Live monitor attaches by session ID with project authentication", () => {
  const socket = new FakeWebSocket();
  const captured = capturingLogger();
  let factoryArguments;
  let closedMonitor;

  const monitor = monitorLiveSession("live/a b", {
    apiKey: "sk-test",
    logger: captured.logger,
    webSocketFactory: (url, options) => {
      factoryArguments = { url, options };
      return socket;
    },
    onClose: (closed) => { closedMonitor = closed; },
  });

  assert.equal(monitor.socket, socket);
  assert.deepEqual(factoryArguments, {
    url: "wss://api.openai.com/v1/live/sessions/live%2Fa%20b/attach",
    options: { headers: { Authorization: "Bearer sk-test" } },
  });
  socket.emit("message", Buffer.from('{"type":"session.started"}'));
  monitor.send({ type: "session.input_audio.mute" });
  assert.equal(captured.logs.some((entry) => entry.startsWith("[WebSocket ")), false);
  assert.deepEqual(socket.sent, ['{"type":"session.input_audio.mute"}']);

  socket.emit("open");
  socket.emit("error", new Error("socket failed"));
  socket.emit("close", 1000, Buffer.from("complete"));
  assert.ok(captured.logs.includes("Live sideband monitor connected for live/a b."));
  assert.ok(captured.logs.includes("Live sideband monitor closed for live/a b (code 1000: complete)."));
  assert.deepEqual(captured.errors, ["Live sideband monitor error for live/a b: socket failed"]);
  assert.equal(closedMonitor, monitor);

  monitor.close({ code: 1001, reason: "shutdown" });
  assert.deepEqual(socket.closed, [{ code: 1001, reason: "shutdown" }]);
});

test("Live monitor logs inbound and outbound messages when enabled", () => {
  const socket = new FakeWebSocket();
  const captured = capturingLogger();
  const monitor = monitorLiveSession("live_logged", {
    apiKey: "sk-test",
    logger: captured.logger,
    logMessages: true,
    webSocketFactory: () => socket,
  });

  socket.emit("message", Buffer.from('{"type":"session.started"}'));
  monitor.send({ type: "session.input_audio.mute" });

  assert.ok(captured.logs.includes(
    '[WebSocket INBOUND live_logged]\n{"type":"session.started"}',
  ));
  assert.ok(captured.logs.includes(
    '[WebSocket OUTBOUND live_logged]\n{"type":"session.input_audio.mute"}',
  ));
});

test("Live monitor redacts reflected audio without changing WebSocket messages", () => {
  const socket = new FakeWebSocket();
  const captured = capturingLogger();
  const monitor = monitorLiveSession("live_audio", {
    apiKey: "sk-test",
    logger: captured.logger,
    logMessages: true,
    webSocketFactory: () => socket,
  });
  const inputEvent = {
    type: "session.input_audio.append",
    audio: "AAAAAAAAAAAA",
  };
  const outputEvent = {
    type: "session.output_audio.delta",
    delta: "BBBBBBBB",
    start_ms: 0,
    end_ms: 20,
  };

  socket.emit("message", Buffer.from(JSON.stringify(inputEvent)));
  socket.emit("message", Buffer.from(JSON.stringify(outputEvent)));
  monitor.send(inputEvent);

  assert.ok(captured.logs.includes(
    '[WebSocket INBOUND live_audio]\n{"type":"session.input_audio.append","audio":"[audio omitted: 12 base64 characters]"}',
  ));
  assert.ok(captured.logs.includes(
    '[WebSocket INBOUND live_audio]\n{"type":"session.output_audio.delta","delta":"[audio omitted: 8 base64 characters]","start_ms":0,"end_ms":20}',
  ));
  assert.ok(captured.logs.includes(
    '[WebSocket OUTBOUND live_audio]\n{"type":"session.input_audio.append","audio":"[audio omitted: 12 base64 characters]"}',
  ));
  assert.deepEqual(socket.sent, [JSON.stringify(inputEvent)]);
  assert.equal(captured.logs.some((entry) => entry.includes("AAAAAAAAAAAA")), false);
  assert.equal(captured.logs.some((entry) => entry.includes("BBBBBBBB")), false);
});

test("Live monitor sends the spoken greeting once when attached", () => {
  const socket = new FakeWebSocket();
  monitorLiveSession("live_greeting", {
    apiKey: "sk-test",
    initialSpokenGreeting: "Welcome. How can I help?",
    eventIdFactory: () => "event_greeting",
    webSocketFactory: () => socket,
  });

  socket.emit("open");
  socket.emit("open");

  assert.deepEqual(socket.sent.map(JSON.parse), [{
    type: "session.commentary.append",
    event_id: "event_greeting",
    delegation_id: null,
    content: "Welcome. How can I help?",
  }]);
});

test("Live monitor logs caller and assistant transcript deltas", () => {
  const socket = new FakeWebSocket();
  const captured = capturingLogger();
  monitorLiveSession("live_conversation", {
    apiKey: "sk-test",
    logger: captured.logger,
    logMessages: true,
    webSocketFactory: () => socket,
  });

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "session.input_transcript.delta",
    delta: "  tell me\n  a joke  ",
  })));
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "session.output_transcript.delta",
    delta: "Why did the chicken cross the road?",
  })));
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "session.input_transcript.delta",
    delta: "   ",
  })));

  assert.deepEqual(
    captured.logs.filter((entry) => entry.startsWith("TEXT>>")),
    [
      "TEXT>>ME: tell me a joke",
      "TEXT>>AI: Why did the chicken cross the road?",
    ],
  );
});

test("Live monitor reports invalid JSON without crashing", () => {
  const socket = new FakeWebSocket();
  const captured = capturingLogger();
  monitorLiveSession("live_invalid", {
    apiKey: "sk-test",
    logger: captured.logger,
    webSocketFactory: () => socket,
  });

  socket.emit("message", Buffer.from("not json"));
  assert.deepEqual(captured.errors, ["Live sideband received invalid JSON for live_invalid."]);
});

test("Live monitor executes a Responses function call and continues it", async () => {
  const socket = new FakeWebSocket();
  const calls = [];
  let nextEventId = 0;
  monitorLiveSession("live_tools", {
    apiKey: "sk-test",
    eventIdFactory: () => `event_${++nextEventId}`,
    toolExecutor: async (name, args, context) => {
      calls.push({ name, args, context });
      return { status: "in_stock", store_id: "PA" };
    },
    webSocketFactory: () => socket,
  });

  const toolEvent = {
    type: "response.event",
    delegation_id: "delegation_1",
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "check_inventory",
        arguments: '{"store_id":"PA","product_id":"GLIDE4","size":10}',
      },
    },
  };
  socket.emit("message", Buffer.from(JSON.stringify(toolEvent)));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [{
    name: "check_inventory",
    args: { store_id: "PA", product_id: "GLIDE4", size: 10 },
    context: { sessionId: "live_tools" },
  }]);
  assert.deepEqual(socket.sent.map(JSON.parse), [
    {
      type: "response.item.create",
      event_id: "event_1",
      item: {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"status":"in_stock","store_id":"PA"}',
      },
    },
    { type: "response.create", event_id: "event_2" },
  ]);

  socket.emit("message", Buffer.from(JSON.stringify(toolEvent)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
});

test("Live monitor returns tool errors to the backend without stalling", async () => {
  const socket = new FakeWebSocket();
  const captured = capturingLogger();
  monitorLiveSession("live_tool_error", {
    apiKey: "sk-test",
    logger: captured.logger,
    eventIdFactory: () => "event_error",
    toolExecutor: () => { throw new Error("inventory offline"); },
    webSocketFactory: () => socket,
  });
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "response.event",
    event: {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: "call_bad", name: "check_inventory", arguments: "{}" },
    },
  })));
  await new Promise((resolve) => setImmediate(resolve));

  const sent = socket.sent.map(JSON.parse);
  assert.deepEqual(JSON.parse(sent[0].item.output), {
    status: "error", message: "inventory offline",
  });
  assert.equal(sent[1].type, "response.create");
  assert.deepEqual(captured.errors, ["Stridewell tool check_inventory failed: inventory offline"]);
});

test("Live monitor validates required connection inputs", () => {
  assert.throws(
    () => monitorLiveSession("", { apiKey: "sk-test" }),
    /session_id is required/,
  );
  assert.throws(
    () => monitorLiveSession("live_test"),
    /OPENAI_API_KEY is required/,
  );
});

function toolCallEvent(callId) {
  return {
    type: "response.event",
    event: {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: callId, name: "check_inventory", arguments: "{}" },
    },
  };
}

function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay };
      pending.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
    runNext: () => pending.shift().callback(),
  };
}

test("Live monitor ignores JSON frames that are not objects", () => {
  const socket = new FakeWebSocket();
  const captured = capturingLogger();
  monitorLiveSession("live_null", {
    apiKey: "sk-test",
    logger: captured.logger,
    webSocketFactory: () => socket,
  });

  for (const frame of ["null", "[1]", "7", '"text"']) {
    assert.doesNotThrow(() => socket.emit("message", Buffer.from(frame)));
  }
  assert.deepEqual(
    captured.errors,
    Array(4).fill("Live sideband received a non-object frame for live_null."),
  );
});

test("Live monitor always logs server errors and the session close reason", () => {
  const socket = new FakeWebSocket();
  const captured = capturingLogger();
  monitorLiveSession("live_errors", {
    apiKey: "sk-test",
    logger: captured.logger,
    logMessages: false,
    webSocketFactory: () => socket,
  });

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", code: "unknown_call_id", message: "No such call" },
  })));
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "session.closed",
    reason: "remote_hangup",
  })));

  assert.deepEqual(captured.errors, [
    "Live sideband reported an error for live_errors: unknown_call_id: No such call",
  ]);
  assert.ok(captured.logs.includes("Live session live_errors closed (reason: remote_hangup)."));
});

test("Live monitor re-attaches after a drop and answers tool calls on the new socket", async () => {
  const sockets = [];
  const timers = manualTimers();
  const executed = [];
  let closed = 0;
  const monitor = monitorLiveSession("live_drop", {
    apiKey: "sk-test",
    logger: capturingLogger().logger,
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    toolExecutor: async (name, args) => {
      executed.push(name);
      return { status: "ok" };
    },
    initialSpokenGreeting: "Hello",
    onClose: () => { closed += 1; },
    ...timers,
  });
  sockets[0].emit("open");
  sockets[0].emit("message", Buffer.from(JSON.stringify(toolCallEvent("call_before"))));
  await new Promise((resolve) => setImmediate(resolve));

  sockets[0].emit("close", 1006, Buffer.alloc(0));
  assert.equal(closed, 0);
  assert.deepEqual(timers.pending.map((timer) => timer.delay), [250]);

  // A result produced while detached is held, then delivered once the new socket opens.
  monitor.send({ type: "held" });
  timers.runNext();
  assert.equal(sockets.length, 2);
  assert.equal(monitor.socket, sockets[1]);
  assert.deepEqual(sockets[1].sent, []);
  sockets[1].emit("open");
  assert.deepEqual(sockets[1].sent, ['{"type":"held"}']);

  // The attach replays recent events; the already-answered call must not run again.
  sockets[1].emit("message", Buffer.from(JSON.stringify(toolCallEvent("call_before"))));
  sockets[1].emit("message", Buffer.from(JSON.stringify(toolCallEvent("call_after"))));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(executed, ["check_inventory", "check_inventory"]);
  assert.equal(
    sockets[1].sent.map(JSON.parse).filter((event) => event.type === "response.item.create")[0]
      .item.call_id,
    "call_after",
  );
  // The greeting was spoken on the first attach and is not repeated.
  assert.equal(sockets[1].sent.some((message) => message.includes("commentary")), false);
});

test("Live monitor does not re-attach once the session is closed or it was asked to close", () => {
  for (const ending of ["session.closed", "close()"]) {
    const sockets = [];
    const timers = manualTimers();
    let closed = 0;
    const monitor = monitorLiveSession("live_done", {
      apiKey: "sk-test",
      logger: capturingLogger().logger,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      onClose: () => { closed += 1; },
      ...timers,
    });
    if (ending === "session.closed") {
      sockets[0].emit("message", Buffer.from('{"type":"session.closed","reason":"remote_hangup"}'));
    } else {
      monitor.close();
    }
    sockets[0].emit("close", 1006, Buffer.alloc(0));

    assert.equal(timers.pending.length, 0, ending);
    assert.equal(sockets.length, 1, ending);
    assert.equal(closed, 1, ending);
  }
});

test("Live monitor gives up after its re-attach attempts and reports the close once", () => {
  const sockets = [];
  const timers = manualTimers();
  let closed = 0;
  const monitor = monitorLiveSession("live_gone", {
    apiKey: "sk-test",
    logger: capturingLogger().logger,
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    onClose: () => { closed += 1; },
    reattachDelaysMs: [10, 20],
    ...timers,
  });

  sockets[0].emit("close", 1006, Buffer.alloc(0));
  timers.runNext();
  sockets[1].emit("close", 1006, Buffer.alloc(0));
  assert.equal(closed, 0);
  timers.runNext();
  sockets[2].emit("close", 1006, Buffer.alloc(0));
  assert.equal(closed, 1);
  assert.equal(timers.pending.length, 0);

  // Closing while a retry is pending cancels it and reports the close.
  const waiting = monitorLiveSession("live_waiting", {
    apiKey: "sk-test",
    logger: capturingLogger().logger,
    webSocketFactory: () => new FakeWebSocket(),
    onClose: () => { closed += 1; },
    ...timers,
  });
  waiting.socket.emit("close", 1006, Buffer.alloc(0));
  assert.equal(timers.pending.length, 1);
  waiting.close();
  assert.equal(timers.pending.length, 0);
  assert.equal(closed, 2);
  assert.ok(monitor);
});

test("Live monitor stops re-attaching when every attach is only refused with an error", () => {
  const sockets = [];
  const timers = manualTimers();
  const captured = capturingLogger();
  let closed = 0;
  const monitor = monitorLiveSession("live_refused", {
    apiKey: "sk-test",
    logger: captured.logger,
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
    onClose: () => { closed += 1; },
    reattachDelaysMs: [10, 20],
    ...timers,
  });

  for (let attach = 0; attach < 10 && closed === 0; attach += 1) {
    const socket = sockets.at(-1);
    socket.emit("open");
    socket.emit("message", Buffer.from('{"type":"error","error":{"code":"session_not_found"}}'));
    if (attach === 0) monitor.send({ type: "held" });
    socket.emit("close", 1006, Buffer.alloc(0));
    if (timers.pending.length > 0) {
      if (attach === 0) monitor.send({ type: "held" });
      timers.runNext();
    }
  }

  assert.equal(sockets.length, 3);
  assert.equal(closed, 1);
  assert.equal(timers.pending.length, 0);
  // After giving up, nothing is queued silently: the next send goes straight to the socket.
  monitor.send({ type: "late" });
  assert.deepEqual(sockets.at(-1).sent.at(-1), '{"type":"late"}');
});
