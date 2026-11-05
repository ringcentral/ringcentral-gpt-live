import { readFile } from "node:fs/promises";

export const PCMU_BYTES_PER_SECOND = 8_000;
export const PCMU_FRAME_BYTES = 160;
export const PCMU_FRAME_DURATION_MS = 20;
export const PCMU_SILENCE_BYTE = 0xff;

export async function loadPcmuAudio(filePath, readFileImpl = readFile) {
  if (!filePath) return Buffer.alloc(0);

  let audio;
  try {
    audio = await readFileImpl(filePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read PCMU_AUDIO_FILE "${filePath}": ${detail}`);
  }
  if (!Buffer.isBuffer(audio)) audio = Buffer.from(audio);
  if (audio.length === 0) {
    throw new Error(`PCMU_AUDIO_FILE "${filePath}" is empty`);
  }
  return audio;
}

export function createPcmuFrameSource(audio) {
  if (!Buffer.isBuffer(audio)) throw new Error("PCMU audio must be a Buffer");
  let offset = 0;

  return () => {
    const frame = Buffer.alloc(PCMU_FRAME_BYTES, PCMU_SILENCE_BYTE);
    const byteCount = Math.min(PCMU_FRAME_BYTES, audio.length - offset);
    if (byteCount > 0) {
      audio.copy(frame, 0, offset, offset + byteCount);
      offset += byteCount;
    }
    return frame;
  };
}
