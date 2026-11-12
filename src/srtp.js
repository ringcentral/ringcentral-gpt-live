import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const SDES_SRTP_SUITE = "AES_CM_128_HMAC_SHA1_80";
export const SRTP_AUTH_TAG_BYTES = 10;

const MASTER_KEY_BYTES = 16;
const MASTER_SALT_BYTES = 14;

function requireBytes(value, length, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`${label} must be a Buffer or Uint8Array`);
  }
  const bytes = Buffer.from(value);
  if (bytes.length !== length) throw new Error(`${label} must be ${length} bytes`);
  return bytes;
}

function deriveSessionKey(masterKey, masterSalt, label, length) {
  const iv = Buffer.alloc(16);
  masterSalt.copy(iv);
  iv[7] ^= label;
  const cipher = createCipheriv("aes-128-ctr", masterKey, iv);
  return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]).subarray(0, length);
}

export function deriveSrtpSessionKeys({ masterKey, masterSalt }) {
  const key = requireBytes(masterKey, MASTER_KEY_BYTES, "SRTP master key");
  const salt = requireBytes(masterSalt, MASTER_SALT_BYTES, "SRTP master salt");
  return {
    encryptionKey: deriveSessionKey(key, salt, 0x00, 16),
    authenticationKey: deriveSessionKey(key, salt, 0x01, 20),
    saltingKey: deriveSessionKey(key, salt, 0x02, 14),
  };
}

export function rtpHeaderLength(packet, packetEnd = packet.length) {
  if (packetEnd < 12 || (packet[0] >> 6) !== 2) return undefined;
  let length = 12 + ((packet[0] & 0x0f) * 4);
  if (length > packetEnd) return undefined;
  if ((packet[0] & 0x10) !== 0) {
    if (length + 4 > packetEnd) return undefined;
    length += 4 + (packet.readUInt16BE(length + 2) * 4);
    if (length > packetEnd) return undefined;
  }
  return length;
}

function packetIv(sessionSalt, ssrc, roc, sequence) {
  const iv = Buffer.alloc(16);
  sessionSalt.copy(iv);
  iv[4] ^= ssrc >>> 24;
  iv[5] ^= ssrc >>> 16;
  iv[6] ^= ssrc >>> 8;
  iv[7] ^= ssrc;
  iv[8] ^= roc >>> 24;
  iv[9] ^= roc >>> 16;
  iv[10] ^= roc >>> 8;
  iv[11] ^= roc;
  iv[12] ^= sequence >>> 8;
  iv[13] ^= sequence;
  return iv;
}

function cryptPayload(packet, headerLength, sessionKey, iv, decrypt = false) {
  const transform = decrypt
    ? createDecipheriv("aes-128-ctr", sessionKey, iv)
    : createCipheriv("aes-128-ctr", sessionKey, iv);
  const payload = packet.subarray(headerLength);
  const crypted = Buffer.concat([transform.update(payload), transform.final()]);
  return Buffer.concat([packet.subarray(0, headerLength), crypted]);
}

function authenticationTag(packet, roc, authenticationKey) {
  const rocBytes = Buffer.alloc(4);
  rocBytes.writeUInt32BE(roc);
  return createHmac("sha1", authenticationKey)
    .update(packet)
    .update(rocBytes)
    .digest()
    .subarray(0, SRTP_AUTH_TAG_BYTES);
}

function estimateRoc(state, sequence) {
  if (!state.initialized) return 0;
  if (state.sequence < 0x8000) {
    return sequence - state.sequence > 0x8000 ? Math.max(0, state.roc - 1) : state.roc;
  }
  return state.sequence - 0x8000 > sequence ? state.roc + 1 : state.roc;
}

function updateHighestIndex(state, sequence, roc) {
  const index = (roc * 0x10000) + sequence;
  if (!state.initialized || index > state.highestIndex) {
    state.initialized = true;
    state.sequence = sequence;
    state.roc = roc;
    state.highestIndex = index;
  }
  return index;
}

export function createSdesKeyMaterial() {
  const masterKey = randomBytes(MASTER_KEY_BYTES);
  const masterSalt = randomBytes(MASTER_SALT_BYTES);
  return {
    suite: SDES_SRTP_SUITE,
    masterKey,
    masterSalt,
    inlineKey: Buffer.concat([masterKey, masterSalt]).toString("base64"),
  };
}

export function parseSdesCryptoAttributes(lines) {
  for (const line of lines) {
    const match = line.match(/^a=crypto:(\d+)\s+(\S+)\s+inline:([^\s|]+)(\|\S+)?(?:\s|$)/i);
    if (!match || match[2].toUpperCase() !== SDES_SRTP_SUITE) continue;
    if (match[4]) {
      throw new Error("SIP answer selected unsupported SDES-SRTP lifetime or MKI parameters");
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(match[3])) {
      throw new Error("SIP answer contains malformed SDES-SRTP key material");
    }
    const keyMaterial = Buffer.from(match[3], "base64");
    if (keyMaterial.length !== MASTER_KEY_BYTES + MASTER_SALT_BYTES) {
      throw new Error("SIP answer SDES-SRTP key material must decode to 30 bytes");
    }
    return {
      tag: Number(match[1]),
      suite: SDES_SRTP_SUITE,
      masterKey: keyMaterial.subarray(0, MASTER_KEY_BYTES),
      masterSalt: keyMaterial.subarray(MASTER_KEY_BYTES),
    };
  }
  throw new Error(`SIP answer did not select ${SDES_SRTP_SUITE} SDES-SRTP`);
}

export class SrtpContext {
  constructor({ masterKey, masterSalt }) {
    const keys = deriveSrtpSessionKeys({ masterKey, masterSalt });
    this.sessionKey = keys.encryptionKey;
    this.authenticationKey = keys.authenticationKey;
    this.sessionSalt = keys.saltingKey;
    this.streams = new Map();
  }

  protectRtp(value) {
    const packet = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const headerLength = rtpHeaderLength(packet);
    if (headerLength === undefined) throw new Error("Cannot protect malformed RTP packet");
    const sequence = packet.readUInt16BE(2);
    const ssrc = packet.readUInt32BE(8);
    const state = this.streams.get(ssrc) ?? { initialized: false, roc: 0 };
    const roc = estimateRoc(state, sequence);
    const encrypted = cryptPayload(
      packet,
      headerLength,
      this.sessionKey,
      packetIv(this.sessionSalt, ssrc, roc, sequence),
    );
    const tag = authenticationTag(encrypted, roc, this.authenticationKey);
    updateHighestIndex(state, sequence, roc);
    this.streams.set(ssrc, state);
    return Buffer.concat([encrypted, tag]);
  }

  unprotectRtp(value) {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return undefined;
    const packet = Buffer.from(value);
    const authenticatedLength = packet.length - SRTP_AUTH_TAG_BYTES;
    const headerLength = rtpHeaderLength(packet, authenticatedLength);
    if (headerLength === undefined || headerLength >= authenticatedLength) return undefined;
    const sequence = packet.readUInt16BE(2);
    const ssrc = packet.readUInt32BE(8);
    const state = this.streams.get(ssrc) ?? { initialized: false, roc: 0 };
    const roc = estimateRoc(state, sequence);
    const encrypted = packet.subarray(0, authenticatedLength);
    const actualTag = packet.subarray(authenticatedLength);
    const expectedTag = authenticationTag(encrypted, roc, this.authenticationKey);
    if (!timingSafeEqual(actualTag, expectedTag)) return undefined;

    const index = (roc * 0x10000) + sequence;
    if (state.initialized && index <= state.highestIndex - 64) return undefined;
    if (state.received?.has(index)) return undefined;
    const plain = cryptPayload(
      encrypted,
      headerLength,
      this.sessionKey,
      packetIv(this.sessionSalt, ssrc, roc, sequence),
      true,
    );
    updateHighestIndex(state, sequence, roc);
    state.received ??= new Set();
    state.received.add(index);
    const replayFloor = state.highestIndex - 64;
    for (const receivedIndex of state.received) {
      if (receivedIndex < replayFloor) state.received.delete(receivedIndex);
    }
    this.streams.set(ssrc, state);
    return plain;
  }
}
