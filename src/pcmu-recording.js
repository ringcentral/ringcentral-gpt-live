import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_INCOMING_AUDIO_FILE = join("output", "recording-<date>.ul");

function timestampForFile(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error("Recording date must be valid");
  }
  return date.toISOString().replace(/[:.]/g, "-");
}

export function incomingAudioFileFromConfig(enabled, configuredPath, now = new Date()) {
  if (!enabled) return undefined;
  if (configuredPath !== undefined && typeof configuredPath !== "string") {
    throw new Error("INCOMING_AUDIO_FILE must be a path");
  }

  const template = configuredPath?.trim() || DEFAULT_INCOMING_AUDIO_FILE;
  if (template.includes("\0")) throw new Error("INCOMING_AUDIO_FILE contains an invalid character");
  return template.includes("<date>")
    ? template.replaceAll("<date>", timestampForFile(now))
    : template;
}

function recordingError(action, filePath, error) {
  const detail = error?.code === "EEXIST"
    ? "file already exists"
    : error instanceof Error ? error.message : String(error);
  return new Error(`Could not ${action} incoming PCMU recording "${filePath}": ${detail}`, {
    cause: error,
  });
}

async function writeAll(fileHandle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await fileHandle.write(bytes, offset, bytes.length - offset, null);
    if (!result || result.bytesWritten <= 0) throw new Error("the file write made no progress");
    offset += result.bytesWritten;
  }
}

export async function openPcmuRecorder(filePath, { onError = () => {} } = {}) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("An incoming PCMU recording path is required");
  }
  if (typeof onError !== "function") throw new Error("Recording onError must be a function");

  const absolutePath = resolve(filePath);
  let fileHandle;
  try {
    await mkdir(dirname(absolutePath), { recursive: true });
    fileHandle = await open(absolutePath, "wx");
  } catch (error) {
    throw recordingError("create", absolutePath, error);
  }

  let bytesWritten = 0;
  let closed = false;
  let closePromise;
  let writeFailure;
  let writeQueue = Promise.resolve();

  const reportFailure = (action, error) => {
    if (writeFailure) return;
    writeFailure = recordingError(action, absolutePath, error);
    try {
      onError(writeFailure);
    } catch {
      // The original file error remains available from close().
    }
  };

  return {
    path: absolutePath,
    get bytesWritten() {
      return bytesWritten;
    },
    write(payload) {
      if (closed || writeFailure) return;
      if (!Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)) {
        throw new Error("Incoming PCMU payload must be a Buffer or Uint8Array");
      }
      const bytes = Buffer.from(payload);
      if (bytes.length === 0) return;
      writeQueue = writeQueue
        .then(async () => {
          if (writeFailure) return;
          await writeAll(fileHandle, bytes);
          bytesWritten += bytes.length;
        })
        .catch((error) => reportFailure("write", error));
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await writeQueue;
        try {
          await fileHandle.close();
        } catch (error) {
          reportFailure("close", error);
        }
        if (writeFailure) throw writeFailure;
      })();
      return closePromise;
    },
  };
}
