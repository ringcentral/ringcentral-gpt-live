import assert from "node:assert/strict";
import test from "node:test";
import {
  SipMessageDecoder,
  createRtpPacket,
  createSdpOffer,
  extractRtpPayload,
  getHeader,
  parseSdpAnswer,
  parseSipMessage,
  serializeSipRequest,
  serializeSipResponse,
  splitHeaderValues,
} from "../src/protocol.js";
import { formatInviteFailure, logSipMessage, SipCall } from "../src/sip-call.js";
import { createSdesKeyMaterial, SDES_SRTP_SUITE } from "../src/srtp.js";

test("SIP message logging is exact, directional, and optional", () => {
  const logs = [];
  const logger = { log: (message) => logs.push(message) };
  const raw = Buffer.from("OPTIONS sip:test@example.com SIP/2.0\r\nContent-Length: 0\r\n\r\n");

  logSipMessage(logger, false, "OUTBOUND", raw);
  assert.deepEqual(logs, []);

  logSipMessage(logger, true, "OUTBOUND", raw);
  logSipMessage(logger, true, "INBOUND", raw);
  assert.deepEqual(logs, [
    `[SIP OUTBOUND]\n${raw.toString("utf8")}`,
    `[SIP INBOUND]\n${raw.toString("utf8")}`,
  ]);
});

test("SIP request serialization uses CRLF and byte-accurate Content-Length", () => {
  const body = "hello ☃";
  const message = serializeSipRequest("MESSAGE", "sip:test@example.com", {
    Via: "SIP/2.0/TLS caller.example;branch=z9hG4bK-test",
    "Call-ID": "test-call",
  }, body);
  const text = message.toString("utf8");

  assert.match(text, /^MESSAGE sip:test@example\.com SIP\/2\.0\r\n/);
  assert.match(text, /Content-Length: 9\r\n\r\nhello ☃$/);
  assert.equal(text.replace(/\r\n/g, "").includes("\n"), false);
});

test("SIP serialization rejects header injection", () => {
  assert.throws(
    () => serializeSipRequest("INVITE", "sip:test@example.com", { From: "safe\r\nEvil: yes" }),
    /single line/,
  );
});

test("SIP stream decoder handles every two-chunk split", () => {
  const raw = Buffer.from(
    "SIP/2.0 200 OK\r\nCall-ID: abc\r\nContent-Type: application/sdp\r\nContent-Length: 4\r\n\r\ntest",
  );
  for (let split = 0; split <= raw.length; split += 1) {
    const decoder = new SipMessageDecoder();
    const messages = [
      ...decoder.push(raw.subarray(0, split)),
      ...decoder.push(raw.subarray(split)),
    ];
    assert.equal(messages.length, 1, `split at byte ${split}`);
    assert.equal(messages[0].status, 200);
    assert.equal(messages[0].body.toString(), "test");
  }
});

test("SIP stream decoder handles keepalives and coalesced messages", () => {
  const one = "SIP/2.0 100 Trying\r\nContent-Length: 0\r\n\r\n";
  const two = "SIP/2.0 486 Busy Here\r\nl: 0\r\n\r\n";
  const decoder = new SipMessageDecoder();
  const messages = decoder.push(Buffer.from(`\r\n\r\n${one}${two}`));
  assert.deepEqual(messages.map((message) => message.status), [100, 486]);
});

test("SIP parser normalizes compact dialog header names", () => {
  const raw = Buffer.from([
    "SIP/2.0 200 OK",
    "v: SIP/2.0/TLS proxy.example;branch=z9hG4bK-test",
    "f: <sip:caller@example.com>;tag=one",
    "t: <sip:callee@example.com>;tag=two",
    "i: compact-call-id",
    "m: <sip:callee@media.example>",
    "CSeq: 1 INVITE",
    "l: 0",
    "",
    "",
  ].join("\r\n"));
  const [message] = new SipMessageDecoder().push(raw);
  assert.equal(getHeader(message, "call-id"), "compact-call-id");
  assert.equal(getHeader(message, "to"), "<sip:callee@example.com>;tag=two");
  assert.equal(getHeader(message, "contact"), "<sip:callee@media.example>");
  assert.deepEqual(message.headers.get("via"), ["SIP/2.0/TLS proxy.example;branch=z9hG4bK-test"]);
});

test("SIP INVITE failure includes bounded sanitized server diagnostics", () => {
  const response = parseSipMessage(Buffer.from([
    "SIP/2.0 400 Bad\u0000 Request",
    'Warning: 399 sip.example "Odd RTP port"',
    'Reason: SIP;cause=488;text="Bad media"',
    "Content-Type: text/plain",
    "Content-Length: 13",
    "",
    "invalid\nmedia",
  ].join("\r\n")));

  assert.equal(
    formatInviteFailure(response),
    'SIP INVITE failed: 400 Bad Request (Warning: 399 sip.example "Odd RTP port"; Reason: SIP;cause=488;text="Bad media"; Body: invalid media)',
  );
  const longReason = formatInviteFailure({
    status: 500,
    reason: "x".repeat(2_000),
    headers: new Map(),
    body: Buffer.alloc(0),
  });
  assert.equal(longReason.length, "SIP INVITE failed: 500 ".length + 1_000);
});

test("SIP caller rejects an odd configured RTP port", () => {
  assert.throws(
    () => new SipCall({
      projectId: "proj_test",
      callToken: "0123456789abcdef",
      rtpPort: 40001,
    }),
    /RTP_PORT must be 0 or an even port/,
  );
});

test("SIP body may contain the header delimiter", () => {
  const body = "a\r\n\r\nb";
  const raw = serializeSipRequest("MESSAGE", "sip:test@example.com", { "Call-ID": "x" }, body);
  const decoder = new SipMessageDecoder();
  const [message] = decoder.push(raw);
  assert.equal(message.body.toString(), body);
});

test("SIP response copies transaction and dialog headers from BYE", () => {
  const bye = parseSipMessage(Buffer.from([
    "BYE sip:node@192.0.2.2 SIP/2.0",
    "Via: SIP/2.0/TLS first.example;branch=one",
    "Via: SIP/2.0/TLS second.example;branch=two",
    "From: <sip:remote@example.com>;tag=remote",
    "To: <sip:node@example.com>;tag=local",
    "Call-ID: call-1",
    "CSeq: 2 BYE",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n")));
  const response = parseSipMessage(serializeSipResponse(bye, 200, "OK"));

  assert.equal(response.status, 200);
  assert.deepEqual(response.headers.get("via"), [
    "SIP/2.0/TLS first.example;branch=one",
    "SIP/2.0/TLS second.example;branch=two",
  ]);
  assert.equal(getHeader(response, "call-id"), "call-1");
  assert.equal(getHeader(response, "cseq"), "2 BYE");
});

test("Record-Route values split only at top-level commas", () => {
  assert.deepEqual(
    splitHeaderValues('<sip:a.example;lr>, "Proxy, West" <sip:b.example;lr>'),
    ["<sip:a.example;lr>", '"Proxy, West" <sip:b.example;lr>'],
  );
});

test("SDP offer contains the bound PCMU endpoint and advertises Opus", () => {
  const srtp = createSdesKeyMaterial();
  const sdp = createSdpOffer({
    address: "192.0.2.10",
    port: 40000,
    srtp,
    sessionId: 123,
  });
  assert.match(sdp, /c=IN IP4 192\.0\.2\.10\r\n/);
  assert.match(sdp, /m=audio 40000 RTP\/SAVP 0 111\r\n/);
  assert.ok(sdp.includes(`a=crypto:1 ${SDES_SRTP_SUITE} inline:${srtp.inlineKey}\r\n`));
  assert.match(sdp, /a=rtpmap:0 PCMU\/8000\r\n/);
  assert.match(sdp, /a=rtpmap:111 opus\/48000\/2\r\n/);
  assert.ok(sdp.endsWith("\r\n"));
});

test("SDP offer can prefer advertised Opus without implementing it", () => {
  const srtp = createSdesKeyMaterial();
  const sdp = createSdpOffer({
    address: "192.0.2.10",
    port: 40000,
    srtp,
    preferOpus: true,
    sessionId: 123,
  });

  assert.match(sdp, /m=audio 40000 RTP\/SAVP 111 0\r\n/);
  assert.match(sdp, /a=rtpmap:111 opus\/48000\/2\r\n/);
  assert.match(sdp, /a=rtpmap:0 PCMU\/8000\r\n/);
  assert.throws(
    () => createSdpOffer({
      address: "192.0.2.10",
      port: 40000,
      srtp,
      preferOpus: "true",
    }),
    /Opus preference must be a boolean/,
  );
});

test("SDP answer parser honors media address, codec, and direction", () => {
  const answer = [
    "v=0",
    "o=- 1 1 IN IP4 198.51.100.1",
    "s=-",
    "c=IN IP4 198.51.100.2",
    "t=0 0",
    "m=audio 50000 RTP/SAVP 0",
    "c=IN IP4 198.51.100.3",
    "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd",
    "a=rtpmap:0 PCMU/8000",
    "a=recvonly",
  ].join("\r\n");
  assert.deepEqual(parseSdpAnswer(answer), {
    address: "198.51.100.3",
    port: 50000,
    payloadType: 0,
    direction: "recvonly",
    srtp: {
      tag: 1,
      suite: SDES_SRTP_SUITE,
      masterKey: Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"),
      masterSalt: Buffer.from("101112131415161718191a1b1c1d", "hex"),
    },
  });
});

test("SDP answer parser rejects disabled, incompatible, and non-receiving audio", () => {
  const base = [
    "v=0",
    "c=IN IP4 198.51.100.2",
    "t=0 0",
    "m=audio PORT RTP/SAVP PAYLOAD",
    "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd",
    "DIRECTION",
  ].join("\r\n");
  assert.throws(() => parseSdpAnswer(base.replace("PORT", "0").replace("PAYLOAD", "0").replace("DIRECTION", "a=sendrecv")), /rejected audio/);
  assert.throws(() => parseSdpAnswer(base.replace("PORT", "5000").replace("PAYLOAD", "8").replace("DIRECTION", "a=sendrecv")), /PCMU/);
  assert.throws(
    () => parseSdpAnswer(base
      .replace("PORT", "5000")
      .replace("PAYLOAD", "111")
      .replace("DIRECTION", "a=rtpmap:111 opus/48000/2\r\na=sendrecv")),
    /implemented PCMU/,
  );
  assert.throws(() => parseSdpAnswer([
    "v=0",
    "c=IN IP4 198.51.100.2",
    "t=0 0",
    "m=audio 5000 RTP/SAVP 96",
    "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd",
    "a=rtpmap:96 PCMU/8000",
  ].join("\r\n")), /payload type 0/);
  assert.throws(() => parseSdpAnswer(base.replace("PORT", "5000").replace("PAYLOAD", "0").replace("DIRECTION", "a=sendonly")), /does not permit/);
  assert.throws(
    () => parseSdpAnswer(base
      .replace("PORT", "5000")
      .replace("PAYLOAD", "0")
      .replace("DIRECTION", "a=sendrecv")
      .replace("AES_CM_128_HMAC_SHA1_80", "AES_CM_256_HMAC_SHA1_80")),
    /did not select AES_CM_128_HMAC_SHA1_80/,
  );
  assert.throws(
    () => parseSdpAnswer(base
      .replace("PORT", "5000")
      .replace("PAYLOAD", "0")
      .replace("DIRECTION", "a=sendrecv")
      .replace("a=crypto:1", "a=crypto:2")),
    /unoffered SDES-SRTP crypto tag 2/,
  );
});

test("RTP packet is a 20 ms PCMU silence frame", () => {
  const packet = createRtpPacket({
    sequence: 0xffff,
    timestamp: 0xffffffff,
    ssrc: 0x10203040,
    marker: true,
  });
  assert.equal(packet.length, 172);
  assert.equal(packet[0], 0x80);
  assert.equal(packet[1], 0x80);
  assert.equal(packet.readUInt16BE(2), 0xffff);
  assert.equal(packet.readUInt32BE(4), 0xffffffff);
  assert.equal(packet.readUInt32BE(8), 0x10203040);
  assert.ok(packet.subarray(12).every((byte) => byte === 0xff));
});

test("RTP packet preserves an explicit PCMU audio payload", () => {
  const payload = Buffer.from(Array.from({ length: 160 }, (_, index) => index));
  const packet = createRtpPacket({
    sequence: 1,
    timestamp: 2,
    ssrc: 3,
    payload,
  });

  assert.deepEqual(packet.subarray(12), payload);
  assert.throws(
    () => createRtpPacket({ sequence: 1, timestamp: 2, ssrc: 3, payload: Buffer.alloc(159) }),
    /payload length must match/,
  );
});

test("RTP payload extraction returns only raw PCMU bytes", () => {
  const payload = Buffer.from(Array.from({ length: 160 }, (_, index) => index));
  const packet = createRtpPacket({
    sequence: 1,
    timestamp: 2,
    ssrc: 3,
    marker: true,
    payload,
  });

  assert.deepEqual(extractRtpPayload(packet, 0), payload);
  assert.equal(extractRtpPayload(packet, 8), undefined);
});

test("RTP payload extraction skips CSRCs, extensions, and padding", () => {
  const payload = Buffer.from([0x11, 0x22, 0x33]);
  const packet = Buffer.alloc(12 + 4 + 4 + 4 + payload.length + 4);
  packet[0] = 0x80 | 0x20 | 0x10 | 0x01;
  packet[1] = 0x80;
  packet.writeUInt32BE(0x01020304, 12);
  packet.writeUInt16BE(0xbede, 16);
  packet.writeUInt16BE(1, 18);
  packet.writeUInt32BE(0x05060708, 20);
  payload.copy(packet, 24);
  packet[packet.length - 1] = 4;

  assert.deepEqual(extractRtpPayload(packet), payload);
});

test("RTP payload extraction ignores malformed datagrams", () => {
  const valid = createRtpPacket({
    sequence: 1,
    timestamp: 2,
    ssrc: 3,
  });
  const wrongVersion = Buffer.from(valid);
  wrongVersion[0] = 0x40;
  const truncatedCsrc = Buffer.from(valid.subarray(0, 14));
  truncatedCsrc[0] = 0x81;
  const truncatedExtension = Buffer.from(valid.subarray(0, 16));
  truncatedExtension[0] = 0x90;
  truncatedExtension.writeUInt16BE(1, 14);
  const zeroPadding = Buffer.from(valid);
  zeroPadding[0] |= 0x20;
  zeroPadding[zeroPadding.length - 1] = 0;
  const excessivePadding = Buffer.from(valid.subarray(0, 13));
  excessivePadding[0] |= 0x20;
  excessivePadding[excessivePadding.length - 1] = 2;

  for (const packet of [
    Buffer.alloc(11),
    wrongVersion,
    truncatedCsrc,
    truncatedExtension,
    zeroPadding,
    excessivePadding,
  ]) {
    assert.equal(extractRtpPayload(packet), undefined);
  }
  assert.throws(() => extractRtpPayload(valid, 128), /between 0 and 127/);
});
