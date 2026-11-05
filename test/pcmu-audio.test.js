import assert from "node:assert/strict";
import test from "node:test";
import {
  createPcmuFrameSource,
  loadPcmuAudio,
  PCMU_FRAME_BYTES,
  PCMU_SILENCE_BYTE,
} from "../src/pcmu-audio.js";

test("PCMU frame source plays raw bytes once, pads the tail, then sends silence", () => {
  const audio = Buffer.from(Array.from({ length: PCMU_FRAME_BYTES + 120 }, (_, index) => index & 0xff));
  const nextFrame = createPcmuFrameSource(audio);

  assert.deepEqual(nextFrame(), audio.subarray(0, PCMU_FRAME_BYTES));
  const tail = nextFrame();
  assert.deepEqual(tail.subarray(0, 120), audio.subarray(PCMU_FRAME_BYTES));
  assert.ok(tail.subarray(120).every((byte) => byte === PCMU_SILENCE_BYTE));
  assert.ok(nextFrame().every((byte) => byte === PCMU_SILENCE_BYTE));
});

test("configured PCMU audio is loaded as unchanged raw bytes", async () => {
  const expected = Buffer.from([0x01, 0x02, 0xff]);
  let receivedPath;
  const audio = await loadPcmuAudio("audio/example.ul", async (filePath) => {
    receivedPath = filePath;
    return expected;
  });

  assert.equal(receivedPath, "audio/example.ul");
  assert.deepEqual(audio, expected);
  assert.deepEqual(await loadPcmuAudio(undefined), Buffer.alloc(0));
});

test("configured PCMU audio reports unreadable and empty files before calling", async () => {
  await assert.rejects(
    loadPcmuAudio("missing.ul", async () => { throw new Error("not found"); }),
    /Could not read PCMU_AUDIO_FILE "missing\.ul": not found/,
  );
  await assert.rejects(
    loadPcmuAudio("empty.ul", async () => Buffer.alloc(0)),
    /PCMU_AUDIO_FILE "empty\.ul" is empty/,
  );
});
