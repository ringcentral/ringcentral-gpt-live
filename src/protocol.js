import { isIPv4 } from "node:net";
import { parseSdesCryptoAttributes, rtpHeaderLength, SDES_SRTP_SUITE } from "./srtp.js";
import { assertPort } from "./validation.js";

const HEADER_END = Buffer.from("\r\n\r\n", "ascii");
const COMPACT_HEADERS = new Map([
  ["c", "content-type"],
  ["f", "from"],
  ["i", "call-id"],
  ["k", "supported"],
  ["l", "content-length"],
  ["m", "contact"],
  ["s", "subject"],
  ["t", "to"],
  ["v", "via"],
]);

function assertSingleLine(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty single line`);
  }
}

function appendHeader(lines, name, value) {
  assertSingleLine(name, "SIP header name");
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    const text = String(item);
    assertSingleLine(text, `SIP ${name} header`);
    lines.push(`${name}: ${text}`);
  }
}

export function serializeSipRequest(method, uri, headers = {}, body = "") {
  assertSingleLine(method, "SIP method");
  assertSingleLine(uri, "SIP request URI");
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const lines = [`${method} ${uri} SIP/2.0`];

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "content-length") {
      appendHeader(lines, name, value);
    }
  }
  lines.push(`Content-Length: ${bodyBuffer.length}`, "", "");

  return Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), bodyBuffer]);
}

export function serializeSipResponse(request, status, reason) {
  if (!Number.isInteger(status) || status < 100 || status > 699) {
    throw new Error("SIP response status must be between 100 and 699");
  }
  assertSingleLine(reason, "SIP response reason");
  const lines = [`SIP/2.0 ${status} ${reason}`];
  for (const value of getHeaders(request, "via")) {
    appendHeader(lines, "Via", value);
  }
  for (const name of ["from", "to", "call-id", "cseq"]) {
    const value = getHeader(request, name);
    if (!value) throw new Error(`Cannot answer SIP request without ${name}`);
    appendHeader(
      lines,
      name === "call-id" ? "Call-ID" : name === "cseq" ? "CSeq" : titleCase(name),
      value,
    );
  }
  lines.push("Content-Length: 0", "", "");
  return Buffer.from(lines.join("\r\n"), "utf8");
}

function titleCase(value) {
  return value[0].toUpperCase() + value.slice(1);
}

export class SipMessageDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages = [];

    while (this.#buffer.length > 0) {
      while (this.#buffer.length >= 2 && this.#buffer[0] === 13 && this.#buffer[1] === 10) {
        this.#buffer = this.#buffer.subarray(2);
      }
      if (this.#buffer.length === 0) break;

      const headerEnd = this.#buffer.indexOf(HEADER_END);
      if (headerEnd === -1) break;
      const headerText = this.#buffer.subarray(0, headerEnd).toString("latin1");
      const contentLength = readContentLength(headerText);
      const messageLength = headerEnd + HEADER_END.length + contentLength;
      if (this.#buffer.length < messageLength) break;

      const raw = this.#buffer.subarray(0, messageLength);
      messages.push(parseSipMessage(raw));
      this.#buffer = this.#buffer.subarray(messageLength);
    }

    return messages;
  }
}

function readContentLength(headerText) {
  const match = headerText.match(/(?:^|\r\n)(?:Content-Length|l)\s*:\s*(\d+)\s*(?:\r\n|$)/i);
  if (!match) return 0;
  const length = Number(match[1]);
  if (!Number.isSafeInteger(length)) throw new Error("Invalid SIP Content-Length");
  return length;
}

export function parseSipMessage(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const headerEnd = buffer.indexOf(HEADER_END);
  if (headerEnd === -1) throw new Error("Incomplete SIP headers");

  const unfolded = buffer
    .subarray(0, headerEnd)
    .toString("latin1")
    .replace(/\r\n[ \t]+/g, " ");
  const lines = unfolded.split("\r\n");
  const startLine = lines.shift();
  const headers = new Map();

  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`Malformed SIP header: ${line}`);
    const parsedName = line.slice(0, colon).trim().toLowerCase();
    const name = COMPACT_HEADERS.get(parsedName) ?? parsedName;
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(name) ?? [];
    existing.push(value);
    headers.set(name, existing);
  }

  const contentLength = Number(getHeader({ headers }, "content-length") ?? 0);
  const bodyStart = headerEnd + HEADER_END.length;
  const body = buffer.subarray(bodyStart, bodyStart + contentLength);
  const responseMatch = startLine.match(/^SIP\/2\.0\s+(\d{3})(?:\s+(.*))?$/);
  const requestMatch = startLine.match(/^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/);

  if (responseMatch) {
    return {
      kind: "response",
      startLine,
      status: Number(responseMatch[1]),
      reason: responseMatch[2] ?? "",
      headers,
      body,
      raw: buffer,
    };
  }
  if (requestMatch) {
    return {
      kind: "request",
      startLine,
      method: requestMatch[1],
      uri: requestMatch[2],
      headers,
      body,
      raw: buffer,
    };
  }
  throw new Error(`Malformed SIP start line: ${startLine}`);
}

export function getHeaders(message, name) {
  return message.headers.get(name.toLowerCase()) ?? [];
}

export function getHeader(message, name) {
  return getHeaders(message, name)[0];
}

export function splitHeaderValues(value) {
  const values = [];
  let start = 0;
  let angleDepth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\" && quoted) {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === "<") {
      angleDepth += 1;
    } else if (!quoted && char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (!quoted && angleDepth === 0 && char === ",") {
      values.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(value.slice(start).trim());
  return values.filter(Boolean);
}

export function parseNameAddressUri(value) {
  const bracketed = value.match(/<\s*([^>]+)\s*>/);
  if (bracketed) return bracketed[1].trim();
  const bare = value.match(/^\s*((?:sip|sips):[^\s;,]+)/i);
  if (!bare) throw new Error(`No SIP URI found in header: ${value}`);
  return bare[1];
}

export function createSdpOffer({
  address,
  port,
  srtp,
  preferOpus = false,
  sessionId = Date.now(),
}) {
  if (!isIPv4(address)) throw new Error("RTP advertised address must be an IPv4 address");
  assertPort(port, "RTP port");
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
    throw new Error("SDP session ID must be a positive integer");
  }
  if (srtp?.suite !== SDES_SRTP_SUITE || typeof srtp.inlineKey !== "string") {
    throw new Error(`SDP offer requires ${SDES_SRTP_SUITE} SDES-SRTP key material`);
  }
  if (typeof preferOpus !== "boolean") throw new Error("Opus preference must be a boolean");
  const payloadTypes = preferOpus ? "111 0" : "0 111";

  return [
    "v=0",
    `o=- ${sessionId} 1 IN IP4 ${address}`,
    "s=Node SIP demo",
    `c=IN IP4 ${address}`,
    "t=0 0",
    `m=audio ${port} RTP/SAVP ${payloadTypes}`,
    `a=crypto:1 ${SDES_SRTP_SUITE} inline:${srtp.inlineKey}`,
    "a=rtpmap:0 PCMU/8000",
    "a=rtpmap:111 opus/48000/2",
    "a=ptime:20",
    "a=sendrecv",
    "",
  ].join("\r\n");
}

export function parseSdpAnswer(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const mediaIndex = lines.findIndex((line) => line.toLowerCase().startsWith("m=audio "));
  if (mediaIndex === -1) throw new Error("SIP answer has no audio media section");
  const nextMediaOffset = lines.slice(mediaIndex + 1).findIndex((line) => line.startsWith("m="));
  const mediaEnd = nextMediaOffset === -1 ? lines.length : mediaIndex + 1 + nextMediaOffset;
  const sessionLines = lines.slice(0, mediaIndex);
  const mediaLines = lines.slice(mediaIndex, mediaEnd);

  const media = mediaLines[0].slice(2).split(/\s+/);
  const portText = media[1]?.split("/")[0];
  const port = Number(portText);
  const protocol = media[2]?.toUpperCase();
  const payloads = media.slice(3);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SIP answer rejected audio or supplied an invalid audio port");
  }
  if (protocol !== "RTP/SAVP") {
    throw new Error(`Unsupported RTP profile in SIP answer: ${protocol ?? "missing"}`);
  }

  if (!payloads.includes("0")) {
    throw new Error("SIP answer did not accept implemented PCMU/8000 payload type 0");
  }
  const pcmuPayload = 0;

  const mediaConnection = mediaLines.find((line) => line.startsWith("c="));
  const sessionConnection = sessionLines.findLast((line) => line.startsWith("c="));
  const connection = mediaConnection ?? sessionConnection;
  const connectionMatch = connection?.match(/^c=IN\s+IP4\s+([^\s/]+)(?:\/.*)?$/i);
  if (!connectionMatch) throw new Error("SIP answer has no supported IPv4 media address");

  const mediaDirection = mediaLines.find((line) => /^a=(?:sendrecv|sendonly|recvonly|inactive)$/i.test(line));
  const sessionDirection = sessionLines.findLast((line) => /^a=(?:sendrecv|sendonly|recvonly|inactive)$/i.test(line));
  const direction = (mediaDirection ?? sessionDirection ?? "a=sendrecv").slice(2).toLowerCase();
  if (direction !== "sendrecv" && direction !== "recvonly") {
    throw new Error(`SIP answer does not permit caller RTP: ${direction}`);
  }

  const srtp = parseSdesCryptoAttributes(mediaLines);
  if (srtp.tag !== 1) {
    throw new Error(`SIP answer selected unoffered SDES-SRTP crypto tag ${srtp.tag}`);
  }

  return { address: connectionMatch[1], port, payloadType: pcmuPayload, direction, srtp };
}

export function createRtpPacket({
  sequence,
  timestamp,
  ssrc,
  payloadType = 0,
  marker = false,
  payload,
  samples = 160,
}) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff) {
    throw new Error("RTP sequence must be an unsigned 16-bit integer");
  }
  for (const [name, value] of [["timestamp", timestamp], ["ssrc", ssrc]]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`RTP ${name} must be an unsigned 32-bit integer`);
    }
  }
  if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 127) {
    throw new Error("RTP payload type must be between 0 and 127");
  }
  if (!Number.isInteger(samples) || samples < 1) throw new Error("RTP sample count must be positive");
  let payloadBuffer;
  if (payload === undefined) {
    payloadBuffer = Buffer.alloc(samples, 0xff);
  } else {
    if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
      throw new Error("RTP payload must be a Buffer or Uint8Array");
    }
    payloadBuffer = Buffer.from(payload);
    if (payloadBuffer.length !== samples) {
      throw new Error("PCMU RTP payload length must match the sample count");
    }
  }

  const packet = Buffer.alloc(12 + payloadBuffer.length);
  packet[0] = 0x80;
  packet[1] = (marker ? 0x80 : 0) | payloadType;
  packet.writeUInt16BE(sequence, 2);
  packet.writeUInt32BE(timestamp, 4);
  packet.writeUInt32BE(ssrc, 8);
  payloadBuffer.copy(packet, 12);
  return packet;
}

export function extractRtpPayload(packet, expectedPayloadType = 0) {
  if (!Number.isInteger(expectedPayloadType) || expectedPayloadType < 0 || expectedPayloadType > 127) {
    throw new Error("Expected RTP payload type must be between 0 and 127");
  }
  if (!Buffer.isBuffer(packet) && !(packet instanceof Uint8Array)) return undefined;

  const bytes = Buffer.isBuffer(packet) ? packet : Buffer.from(packet);
  const payloadStart = rtpHeaderLength(bytes);
  if (payloadStart === undefined) return undefined;
  if ((bytes[1] & 0x7f) !== expectedPayloadType) return undefined;

  const hasPadding = (bytes[0] & 0x20) !== 0;
  let payloadEnd = bytes.length;
  if (hasPadding) {
    const paddingBytes = bytes[bytes.length - 1];
    if (paddingBytes === 0 || paddingBytes > payloadEnd - payloadStart) return undefined;
    payloadEnd -= paddingBytes;
  }
  if (payloadStart >= payloadEnd) return undefined;
  return bytes.subarray(payloadStart, payloadEnd);
}
