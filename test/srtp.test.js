import assert from "node:assert/strict";
import test from "node:test";
import { createRtpPacket } from "../src/protocol.js";
import {
  createSdesKeyMaterial,
  deriveSrtpSessionKeys,
  parseSdesCryptoAttributes,
  SDES_SRTP_SUITE,
  SRTP_AUTH_TAG_BYTES,
  SrtpContext,
} from "../src/srtp.js";

const RFC_MASTER_KEY = Buffer.from("E1F97A0D3E018BE0D64FA32C06DE4139", "hex");
const RFC_MASTER_SALT = Buffer.from("0EC675AD498AFEEBB6960B3AABE6", "hex");

test("SRTP key derivation matches RFC 3711 Appendix B.3", () => {
  const keys = deriveSrtpSessionKeys({
    masterKey: RFC_MASTER_KEY,
    masterSalt: RFC_MASTER_SALT,
  });
  assert.equal(keys.encryptionKey.toString("hex"), "c61e7a93744f39ee10734afe3ff7a087");
  assert.equal(
    keys.authenticationKey.toString("hex"),
    "cebe321f6ff7716b6fd4ab49af256a156d38baa4",
  );
  assert.equal(keys.saltingKey.toString("hex"), "30cbbc08863d8c85d49db34a9ae1");
});

test("SDES key material is fresh, correctly sized, and parseable", () => {
  const one = createSdesKeyMaterial();
  const two = createSdesKeyMaterial();
  assert.equal(one.suite, SDES_SRTP_SUITE);
  assert.equal(Buffer.from(one.inlineKey, "base64").length, 30);
  assert.notEqual(one.inlineKey, two.inlineKey);

  const parsed = parseSdesCryptoAttributes([
    `a=crypto:9 ${SDES_SRTP_SUITE} inline:${one.inlineKey}`,
  ]);
  assert.equal(parsed.tag, 9);
  assert.deepEqual(parsed.masterKey, one.masterKey);
  assert.deepEqual(parsed.masterSalt, one.masterSalt);
  assert.throws(
    () => parseSdesCryptoAttributes([
      `a=crypto:9 ${SDES_SRTP_SUITE} inline:${one.inlineKey}|2^20|1:4`,
    ]),
    /unsupported SDES-SRTP lifetime or MKI/,
  );
});

test("SRTP protects and authenticates RTP in both directions", () => {
  const keyMaterial = createSdesKeyMaterial();
  const sender = new SrtpContext(keyMaterial);
  const receiver = new SrtpContext(keyMaterial);
  const plain = createRtpPacket({
    sequence: 1234,
    timestamp: 5678,
    ssrc: 0xdecafbad,
    marker: true,
    payload: Buffer.alloc(160, 0x5a),
  });

  const protectedPacket = sender.protectRtp(plain);
  assert.equal(protectedPacket.length, plain.length + SRTP_AUTH_TAG_BYTES);
  assert.deepEqual(protectedPacket.subarray(0, 12), plain.subarray(0, 12));
  assert.notDeepEqual(protectedPacket.subarray(12, -SRTP_AUTH_TAG_BYTES), plain.subarray(12));
  assert.deepEqual(receiver.unprotectRtp(protectedPacket), plain);
  assert.equal(receiver.unprotectRtp(protectedPacket), undefined, "replayed packet");
});

test("SRTP rejects tampering and handles sequence rollover", () => {
  const keyMaterial = createSdesKeyMaterial();
  const sender = new SrtpContext(keyMaterial);
  const receiver = new SrtpContext(keyMaterial);
  for (const sequence of [0xfffe, 0xffff, 0, 1]) {
    const plain = createRtpPacket({
      sequence,
      timestamp: sequence,
      ssrc: 42,
      payload: Buffer.alloc(160, sequence & 0xff),
    });
    const protectedPacket = sender.protectRtp(plain);
    assert.deepEqual(receiver.unprotectRtp(protectedPacket), plain);
  }

  const packet = sender.protectRtp(createRtpPacket({
    sequence: 2,
    timestamp: 2,
    ssrc: 42,
  }));
  packet[20] ^= 1;
  assert.equal(receiver.unprotectRtp(packet), undefined);
});
