import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_INCOMING_AUDIO_FILE,
  incomingAudioFileFromConfig,
  openPcmuRecorder,
} from "../src/pcmu-recording.js";

test("incoming recording configuration is off by default and expands a safe date", () => {
  const now = new Date("2026-07-17T22:14:30.123Z");

  assert.equal(incomingAudioFileFromConfig(false, { ignored: true }, now), undefined);
  assert.equal(
    incomingAudioFileFromConfig(true, undefined, now),
    join("output", "recording-2026-07-17T22-14-30-123Z.ul"),
  );
  assert.equal(DEFAULT_INCOMING_AUDIO_FILE, join("output", "recording-<date>.ul"));
  assert.equal(
    incomingAudioFileFromConfig(true, join("saved", "call-<date>.ul"), now),
    join("saved", "call-2026-07-17T22-14-30-123Z.ul"),
  );
  assert.equal(
    incomingAudioFileFromConfig(true, join("saved", "fixed.ul"), new Date("invalid")),
    join("saved", "fixed.ul"),
  );
});

test("PCMU recorder creates parents, writes bytes in order, flushes, and avoids overwrite", async (t) => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sip-pcmu-recording-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const filePath = join(temporaryDirectory, "nested", "recording.ul");
  const recorder = await openPcmuRecorder(filePath);

  recorder.write(Buffer.from([0x01, 0x02]));
  recorder.write(Uint8Array.from([0x03, 0x04]));
  await Promise.all([recorder.close(), recorder.close()]);

  assert.equal(recorder.bytesWritten, 4);
  assert.deepEqual(await readFile(filePath), Buffer.from([0x01, 0x02, 0x03, 0x04]));
  await assert.rejects(openPcmuRecorder(filePath), /file already exists/);
});
