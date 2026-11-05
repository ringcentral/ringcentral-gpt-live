import { randomUUID } from "node:crypto";
import WebSocket from "ws";

function messageText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
  }
  return String(value);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, " ").trim();
}

function redactAudioPayloads(value) {
  if (Array.isArray(value)) return value.map(redactAudioPayloads);
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const isInputAudio = key === "audio" && typeof item === "string";
    const isOutputAudio = key === "delta"
      && value.type === "session.output_audio.delta"
      && typeof item === "string";
    result[key] = isInputAudio || isOutputAudio
      ? `[audio omitted: ${item.length} base64 characters]`
      : redactAudioPayloads(item);
  }
  return result;
}

function loggedMessage(event) {
  return JSON.stringify(redactAudioPayloads(event));
}

export function monitorLiveSession(sessionId, {
  apiKey,
  initialSpokenGreeting,
  logger = console,
  logMessages = false,
  webSocketFactory = (url, options) => new WebSocket(url, options),
  eventIdFactory = randomUUID,
  toolExecutor,
  onClose = () => {},
} = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("A session_id is required for Live sideband monitoring");
  }
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for Live sideband monitoring");

  const url = `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;
  const socket = webSocketFactory(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (
    !socket
    || typeof socket.on !== "function"
    || typeof socket.send !== "function"
    || typeof socket.close !== "function"
  ) {
    throw new Error("Live sideband WebSocket factory returned an invalid socket");
  }

  const monitor = {
    socket,
    send(event) {
      const message = JSON.stringify(event);
      if (logMessages) logger.log(`[WebSocket OUTBOUND ${sessionId}]\n${loggedMessage(event)}`);
      socket.send(message);
    },
    close({ code = 1000, reason = "" } = {}) {
      socket.close(code, reason);
    },
  };
  const handledToolCalls = new Set();
  let initialGreetingSent = false;
  let toolQueue = Promise.resolve();

  const handleToolCall = (item) => {
    if (!toolExecutor || item?.type !== "function_call" || handledToolCalls.has(item.call_id)) return;
    handledToolCalls.add(item.call_id);
    toolQueue = toolQueue.then(async () => {
      let output;
      try {
        const args = JSON.parse(item.arguments || "{}");
        output = await toolExecutor(item.name, args, { sessionId });
      } catch (error) {
        output = { status: "error", message: errorText(error) };
        logger.error(`Stridewell tool ${item.name || "<unknown>"} failed: ${errorText(error)}`);
      }
      monitor.send({
        type: "response.item.create",
        event_id: eventIdFactory(),
        item: {
          type: "function_call_output",
          call_id: item.call_id,
          output: JSON.stringify(output),
        },
      });
      monitor.send({ type: "response.create", event_id: eventIdFactory() });
    }).catch((error) => {
      logger.error(`Could not return a tool result for ${sessionId}: ${errorText(error)}`);
    });
  };

  socket.on("message", (data) => {
    const raw = messageText(data);

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      if (logMessages) logger.log(`[WebSocket INBOUND ${sessionId}]\n${raw}`);
      logger.error(`Live sideband received invalid JSON for ${sessionId}.`);
      return;
    }
    if (logMessages) {
      logger.log(`[WebSocket INBOUND ${sessionId}]\n${loggedMessage(event)}`);
    }

    if (logMessages && event.type === "session.input_transcript.delta") {
      const text = oneLine(event.delta);
      if (text) logger.log(`TEXT>>ME: ${text}`);
    }
    if (logMessages && event.type === "session.output_transcript.delta") {
      const text = oneLine(event.delta);
      if (text) logger.log(`TEXT>>AI: ${text}`);
    }
    if (event.type === "response.event" && event.event?.type === "response.output_item.done") {
      handleToolCall(event.event.item);
    }
  });
  socket.on("error", (error) => {
    logger.error(`Live sideband monitor error for ${sessionId}: ${errorText(error)}`);
  });
  socket.on("open", () => {
    logger.log(`Live sideband monitor connected for ${sessionId}.`);
    if (initialSpokenGreeting && !initialGreetingSent) {
      initialGreetingSent = true;
      monitor.send({
        type: "session.commentary.append",
        event_id: eventIdFactory(),
        delegation_id: null,
        content: initialSpokenGreeting,
      });
    }
  });
  socket.on("close", (code, reason) => {
    const detail = messageText(reason).trim();
    logger.log(
      `Live sideband monitor closed for ${sessionId} (code ${code}${detail ? `: ${detail}` : ""}).`,
    );
    onClose(monitor);
  });

  logger.log(`Opening Live sideband monitor for ${sessionId}...`);
  return monitor;
}
