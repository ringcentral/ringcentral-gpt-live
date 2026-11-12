import assert from "node:assert/strict";
import dgram from "node:dgram";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import {
  SipMessageDecoder,
  getHeader,
  getHeaders,
  serializeSipResponse,
} from "../src/protocol.js";
import { SipCall } from "../src/sip-call.js";

const quietLogger = { log() {}, warn() {}, error() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(condition) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return;
    await tick();
  }
  throw new Error("Condition was not reached");
}

// Stands in for the TLS connection to the SIP server: it records what the caller writes
// and lets each test script the server's side of the dialog.
class FakeSipServerSocket extends EventEmitter {
  constructor(onRequest) {
    super();
    this.localAddress = "127.0.0.1";
    this.localPort = 50_000;
    this.destroyed = false;
    this.decoder = new SipMessageDecoder();
    this.written = [];
    this.onRequest = onRequest;
    setImmediate(() => this.emit("secureConnect"));
  }

  setKeepAlive() {}

  write(bytes) {
    for (const message of this.decoder.push(bytes)) {
      this.written.push(message);
      if (message.kind === "request") setImmediate(() => this.onRequest?.(message, this));
    }
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }

  deliver(bytes) {
    if (!this.destroyed) this.emit("data", Buffer.from(bytes));
  }

  requests() {
    return this.written.filter((message) => message.kind === "request");
  }

  methods() {
    return this.requests().map((message) => message.method);
  }

  responses() {
    return this.written
      .filter((message) => message.kind === "response")
      .map((message) => `${message.status} ${getHeader(message, "cseq")}`);
  }
}

function inviteAnswer(invite, rtpPort) {
  const sdp = [
    "v=0",
    "o=- 1 1 IN IP4 127.0.0.1",
    "s=-",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=audio ${rtpPort} RTP/SAVP 0`,
    "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd",
    "a=rtpmap:0 PCMU/8000",
    "a=sendrecv",
    "",
  ].join("\r\n");
  return [
    "SIP/2.0 200 OK",
    ...getHeaders(invite, "via").map((value) => `Via: ${value}`),
    `From: ${getHeader(invite, "from")}`,
    `To: ${getHeader(invite, "to")};tag=remote`,
    `Call-ID: ${getHeader(invite, "call-id")}`,
    `CSeq: ${getHeader(invite, "cseq")}`,
    "Contact: <sip:live@127.0.0.1:5061;transport=tls>",
    "Content-Type: application/sdp",
    `Content-Length: ${Buffer.byteLength(sdp)}`,
    "",
    sdp,
  ].join("\r\n");
}

function serverRequest(method, invite, { callId = getHeader(invite, "call-id"), cseq = 10, body = "" } = {}) {
  return [
    `${method} sip:node-demo@127.0.0.1:50000;transport=tls SIP/2.0`,
    `Via: SIP/2.0/TLS 127.0.0.1:5061;branch=z9hG4bK-server-${cseq}`,
    `From: ${getHeader(invite, "to")};tag=remote`,
    `To: ${getHeader(invite, "from")}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} ${method}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

async function rtpSink(t) {
  const socket = dgram.createSocket("udp4");
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  t.after(() => socket.close());
  return socket.address().port;
}

function startCall(onRequest, options = {}) {
  let socket;
  const call = new SipCall({
    projectId: "proj_test",
    callToken: "token_0123456789abcdef",
    durationSeconds: 20,
    logger: quietLogger,
    tlsConnect: () => {
      socket = new FakeSipServerSocket(onRequest);
      return socket;
    },
    ...options,
  });
  const finished = call.run().then(() => undefined, (error) => error);
  return { call, finished, socket: () => socket };
}

test("a fatal error during an established call still ends the remote session with BYE", async (t) => {
  const rtpPort = await rtpSink(t);
  let failRecording;
  const { finished, socket } = startCall((request, server) => {
    if (request.method === "INVITE") server.deliver(inviteAnswer(request, rtpPort));
    if (request.method === "BYE") server.deliver(serializeSipResponse(request, 200, "OK"));
  }, {
    incomingAudioFile: "incoming.raw",
    recordingFactory: async (path, { onError }) => {
      failRecording = onError;
      return { path, write() {}, close: async () => {} };
    },
  });

  await until(() => socket()?.methods().includes("ACK"));
  failRecording(new Error("disk full"));

  assert.match((await finished).message, /disk full/);
  assert.deepEqual(socket().methods(), ["INVITE", "ACK", "BYE"]);
});

test("stopping while the call is ringing cancels the INVITE and acknowledges the 487", async () => {
  let invite;
  const { call, finished, socket } = startCall((request, server) => {
    if (request.method === "INVITE") {
      invite = request;
      server.deliver(serializeSipResponse(request, 180, "Ringing"));
    }
    if (request.method === "CANCEL") {
      server.deliver(serializeSipResponse(request, 200, "OK"));
      server.deliver(serializeSipResponse(invite, 487, "Request Terminated"));
    }
  });

  await until(() => call.provisionalSeen);
  call.stop();

  assert.match((await finished).message, /Call stopped by user/);
  assert.deepEqual(socket().methods(), ["INVITE", "CANCEL", "ACK"]);
  const cancel = socket().requests()[1];
  assert.equal(getHeader(cancel, "cseq"), "1 CANCEL");
  assert.equal(getHeader(cancel, "via"), getHeader(invite, "via"));
  assert.equal(cancel.uri, invite.uri);
  assert.equal(getHeader(cancel, "to"), getHeader(invite, "to"));
});

test("a call answered before the CANCEL takes effect is acknowledged and hung up", async (t) => {
  const rtpPort = await rtpSink(t);
  let invite;
  const { call, finished, socket } = startCall((request, server) => {
    if (request.method === "INVITE") {
      invite = request;
      server.deliver(serializeSipResponse(request, 180, "Ringing"));
    }
    if (request.method === "CANCEL") server.deliver(inviteAnswer(invite, rtpPort));
    if (request.method === "BYE") server.deliver(serializeSipResponse(request, 200, "OK"));
  });

  await until(() => call.provisionalSeen);
  call.stop();

  assert.match((await finished).message, /Call stopped by user/);
  assert.deepEqual(socket().methods(), ["INVITE", "CANCEL", "ACK", "BYE"]);
});

test("an INVITE that times out after ringing is cancelled, and one never answered is not", async () => {
  let invite;
  const ringing = startCall((request, server) => {
    if (request.method === "INVITE") {
      invite = request;
      server.deliver(serializeSipResponse(request, 180, "Ringing"));
    }
    if (request.method === "CANCEL") {
      server.deliver(serializeSipResponse(invite, 487, "Request Terminated"));
    }
  }, { inviteTimeoutMs: 30 });
  assert.match((await ringing.finished).message, /Timed out waiting for a final SIP INVITE response/);
  assert.deepEqual(ringing.socket().methods(), ["INVITE", "CANCEL", "ACK"]);

  // Without a provisional response there is no transaction on the server to cancel.
  const silent = startCall(() => {}, { inviteTimeoutMs: 30 });
  assert.match((await silent.finished).message, /Timed out waiting for a final SIP INVITE response/);
  assert.deepEqual(silent.socket().methods(), ["INVITE"]);
});

test("in-dialog requests from the server are answered instead of left to time out", async (t) => {
  const rtpPort = await rtpSink(t);
  let invite;
  const { finished, socket } = startCall((request, server) => {
    if (request.method === "INVITE") {
      invite = request;
      server.deliver(inviteAnswer(request, rtpPort));
    }
  });
  await until(() => socket()?.methods().includes("ACK"));
  const server = socket();

  server.deliver(serverRequest("OPTIONS", invite, { cseq: 10 }));
  server.deliver(serverRequest("UPDATE", invite, { cseq: 11 }));
  server.deliver(serverRequest("INVITE", invite, { cseq: 12, body: "v=0\r\n" }));
  server.deliver(serverRequest("INFO", invite, { cseq: 13 }));
  server.deliver(serverRequest("OPTIONS", invite, { cseq: 14, callId: "someone-else@example" }));
  server.deliver(serverRequest("ACK", invite, { cseq: 12 }));
  // The call must survive all of the above and still end cleanly on the server's BYE.
  server.deliver(serverRequest("BYE", invite, { cseq: 15 }));

  assert.equal(await finished, undefined);
  assert.deepEqual(server.responses(), [
    "200 10 OPTIONS",
    "200 11 UPDATE",
    "488 12 INVITE",
    "501 13 INFO",
    "481 14 OPTIONS",
    "200 15 BYE",
  ]);
  assert.deepEqual(server.methods(), ["INVITE", "ACK"]);
});
