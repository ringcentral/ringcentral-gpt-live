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

function isUsableSocket(socket) {
  return Boolean(socket)
    && typeof socket.on === "function"
    && typeof socket.send === "function"
    && typeof socket.close === "function";
}

function serverErrorText(error) {
  if (!error || typeof error !== "object") return "unknown error";
  return [error.code ?? error.type, error.message].filter(Boolean).join(": ") || "unknown error";
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
  reattachDelaysMs = [250, 1_000, 3_000],
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("A session_id is required for Live sideband monitoring");
  }
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for Live sideband monitoring");

  const url = `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;

  // Everything below is scoped to the session, not to one socket, so it survives a re-attach.
  let socket;
  let closeRequested = false;
  let sessionClosed = false;
  let reattachAttempts = 0;
  let reattachTimer;
  let detached = false;
  const unsent = [];
  const handledToolCalls = new Set();
  let initialGreetingSent = false;
  let toolQueue = Promise.resolve();

  const monitor = {
    get socket() {
      return socket;
    },
    send(event) {
      const message = JSON.stringify(event);
      if (logMessages) logger.log(`[WebSocket OUTBOUND ${sessionId}]\n${loggedMessage(event)}`);
      // Between a drop and the next attach there is no socket to write to; hold the message.
      if (detached) unsent.push(message);
      else socket.send(message);
    },
    close({ code = 1000, reason = "" } = {}) {
      closeRequested = true;
      if (reattachTimer !== undefined) {
        // The old socket is already closed, so no close event will report this.
        clearTimeoutImpl(reattachTimer);
        reattachTimer = undefined;
        onClose(monitor);
        return;
      }
      socket.close(code, reason);
    },
  };

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

  const handleMessage = (data) => {
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
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      logger.error(`Live sideband received a non-object frame for ${sessionId}.`);
      return;
    }
    // Session traffic proves the attach works, so a later drop gets the full retry budget
    // again. An error frame proves nothing: an attach that is only ever refused must run out.
    if (event.type !== "error" && event.type !== "transport.failed") reattachAttempts = 0;

    if (logMessages && event.type === "session.input_transcript.delta") {
      const text = oneLine(event.delta);
      if (text) logger.log(`TEXT>>ME: ${text}`);
    }
    if (logMessages && event.type === "session.output_transcript.delta") {
      const text = oneLine(event.delta);
      if (text) logger.log(`TEXT>>AI: ${text}`);
    }
    if (event.type === "error") {
      logger.error(`Live sideband reported an error for ${sessionId}: ${serverErrorText(event.error)}`);
    }
    if (event.type === "transport.failed") {
      logger.error(`Live transport failed for ${sessionId}: ${serverErrorText(event.error)}`);
    }
    if (event.type === "session.closed") {
      sessionClosed = true;
      logger.log(`Live session ${sessionId} closed (reason: ${oneLine(event.reason) || "unknown"}).`);
    }
    if (event.type === "response.event" && event.event?.type === "response.output_item.done") {
      handleToolCall(event.event.item);
    }
  };

  const handleClose = (code, reason) => {
    const detail = messageText(reason).trim();
    logger.log(
      `Live sideband monitor closed for ${sessionId} (code ${code}${detail ? `: ${detail}` : ""}).`,
    );
    const delay = reattachDelaysMs[reattachAttempts];
    // Close codes are undocumented; only a normal closure is taken to mean the call is over.
    if (closeRequested || sessionClosed || code === 1000 || delay === undefined) {
      // Nothing will deliver held messages now; later sends fail loudly instead of queueing.
      detached = false;
      if (unsent.length > 0) {
        logger.error(`Live sideband monitor for ${sessionId} dropped ${unsent.length} unsent message(s).`);
        unsent.length = 0;
      }
      onClose(monitor);
      return;
    }
    reattachAttempts += 1;
    detached = true;
    logger.error(
      `Live sideband monitor dropped for ${sessionId} while the session is still open; `
        + `re-attaching in ${delay}ms (attempt ${reattachAttempts} of ${reattachDelaysMs.length}).`,
    );
    reattachTimer = setTimeoutImpl(() => {
      reattachTimer = undefined;
      try {
        attach();
      } catch (error) {
        logger.error(`Live sideband monitor could not re-attach for ${sessionId}: ${errorText(error)}`);
        onClose(monitor);
      }
    }, delay);
  };

  function attach() {
    const next = webSocketFactory(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!isUsableSocket(next)) {
      throw new Error("Live sideband WebSocket factory returned an invalid socket");
    }
    socket = next;
    next.on("message", handleMessage);
    next.on("error", (error) => {
      logger.error(`Live sideband monitor error for ${sessionId}: ${errorText(error)}`);
    });
    next.on("open", () => {
      logger.log(`Live sideband monitor connected for ${sessionId}.`);
      detached = false;
      for (const message of unsent.splice(0)) next.send(message);
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
    next.on("close", handleClose);
  }

  attach();
  logger.log(`Opening Live sideband monitor for ${sessionId}...`);
  return monitor;
}
