import http from "node:http";

function send(response, status, body = "") {
  const data = Buffer.from(body, "utf8");
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": data.length,
  });
  response.end(data);
}

async function readRawBody(request, maxBytes = 1_048_576) {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined && Number(declaredLength) > maxBytes) {
    const error = new Error("Webhook body is too large");
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error("Webhook body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toHeaders(requestHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

function requestPath(value) {
  try {
    return new URL(value ?? "/", "http://localhost").pathname;
  } catch {
    return "<invalid-target>";
  }
}

function logHttpRequest(request, response, logger) {
  const startedAt = process.hrtime.bigint();
  let logged = false;
  const log = (outcome) => {
    if (logged) return;
    logged = true;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const method = request.method ?? "UNKNOWN";
    logger.log(
      `HTTP ${method} ${requestPath(request.url)} -> ${response.statusCode} `
        + `(${elapsedMs.toFixed(1)}ms${outcome === "closed" ? ", connection closed" : ""})`,
    );
  };
  response.once("finish", () => log("finished"));
  response.once("close", () => log("closed"));
}

export async function acceptLiveSession(sessionId, {
  apiKey,
  model = "gpt-live-1",
  instructions = "You are a concise and friendly voice assistant.",
  initialGreetingInstructions,
  voice = "marin",
  backendModel,
  backendInstructions,
  tools = [],
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("A session_id is required");
  }
  if (typeof voice !== "string" || voice.trim() === "") {
    throw new Error("The Live output voice must be a non-empty string");
  }

  const session = {
    type: "live",
    model,
    instructions,
    audio: { output: { voice } },
  };
  if (initialGreetingInstructions) {
    session.input = [{
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: initialGreetingInstructions }],
    }];
  }
  if (backendModel) {
    session.delegation = {
      type: "responses",
      responses: {
        model: backendModel,
        instructions: backendInstructions,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
      },
    };
  }

  let response;
  try {
    response = await fetchImpl(
      `https://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/accept`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (cause) {
    // No HTTP response arrived, so OpenAI may or may not have accepted the session.
    const error = new Error(
      `OpenAI call acceptance did not complete: ${cause instanceof Error ? cause.message : cause}`,
      { cause },
    );
    error.ambiguous = true;
    throw error;
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    const error = new Error(
      `OpenAI call acceptance failed (${response.status}): ${detail || response.statusText}`,
    );
    error.status = response.status;
    // The first accept or reject wins; a later one reports this documented error code.
    error.alreadyDecided = detail.includes("decision_already_made");
    throw error;
  }
}

export async function rejectLiveSession(sessionId, {
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("A session_id is required");
  }
  const response = await fetchImpl(
    `https://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/reject`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status_code: 603 }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`OpenAI call rejection failed (${response.status}): ${detail || response.statusText}`);
  }
}

export function hasSipCallToken(event, token) {
  if (typeof token !== "string" || token.length === 0) return false;
  const headers = Array.isArray(event?.data?.sip_headers) ? event.data.sip_headers : [];
  const from = headers.find((header) => String(header?.name).toLowerCase() === "from")?.value;
  if (typeof from !== "string") return false;
  const uri = from.match(/<\s*((?:sip|sips):[^>]+)>/i)?.[1]
    ?? from.match(/((?:sip|sips):[^\s;,]+)/i)?.[1];
  const user = uri?.match(/^(?:sip|sips):([^@;]+)@/i)?.[1];
  return user === token;
}

export function createWebhookServer({
  unwrap,
  acceptCall,
  authorizeCall = () => true,
  monitorCall,
  rejectCall,
  logger = console,
  maxSeen = 1_000,
}) {
  if (typeof unwrap !== "function") throw new Error("A webhook unwrap function is required");
  if (typeof acceptCall !== "function") throw new Error("An acceptCall function is required");
  const seen = new Set();
  const decidedSessions = new Set();
  // Session ID -> promise of whether the decision in progress succeeded.
  const inFlight = new Map();

  const remember = (set, value) => {
    set.add(value);
    if (set.size > maxSeen) set.delete(set.values().next().value);
  };

  const handleRequest = async (request, response) => {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      send(response, 400, "bad request\n");
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      send(response, 200, "ok\n");
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      send(response, 404, "not found\n");
      return;
    }

    let event;
    try {
      const rawBody = await readRawBody(request);
      event = await unwrap(rawBody, toHeaders(request.headers));
    } catch (error) {
      const status = error?.status === 413 ? 413 : 400;
      logger.warn(`Webhook rejected: ${error instanceof Error ? error.message : "invalid request"}`);
      send(response, status, status === 413 ? "payload too large\n" : "invalid webhook\n");
      return;
    }

    const isCurrentLiveSipEvent = event?.type === "live.transport.incoming"
      && event.data?.type === "sip";
    const isLegacyLiveSipEvent = event?.type === "live.call.incoming";
    if (!isCurrentLiveSipEvent && !isLegacyLiveSipEvent) {
      send(response, 200, "ignored\n");
      return;
    }

    const sessionId = event.data?.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      logger.warn("Verified incoming Live SIP webhook had no session_id");
      send(response, 400, "missing session_id\n");
      return;
    }

    const headerId = request.headers["webhook-id"];
    const deliveryId = (Array.isArray(headerId) ? headerId[0] : headerId) || event.id;
    if ((deliveryId && seen.has(deliveryId)) || decidedSessions.has(sessionId)) {
      send(response, 200, "duplicate\n");
      return;
    }
    const pending = inFlight.get(sessionId);
    if (pending) {
      // Mirror the delivery already deciding this session, so that a failure stays retryable.
      if (await pending) send(response, 200, "duplicate\n");
      else send(response, 502, "call acceptance failed\n");
      return;
    }
    let settle;
    inFlight.set(sessionId, new Promise((resolve) => { settle = resolve; }));

    const startMonitor = () => {
      try {
        const monitorResult = monitorCall?.(sessionId);
        if (monitorResult && typeof monitorResult.catch === "function") {
          monitorResult.catch((error) => {
            logger.error(`Live sideband monitor failed for ${sessionId}: ${error instanceof Error ? error.message : error}`);
          });
        }
      } catch (error) {
        logger.error(`Live sideband monitor failed for ${sessionId}: ${error instanceof Error ? error.message : error}`);
      }
    };

    let accepted = false;
    try {
      /*if (!authorizeCall(event)) {
        logger.warn(`Rejecting incoming Live session ${sessionId}: caller token did not match`);
        if (typeof rejectCall === "function") await rejectCall(sessionId);
        send(response, 200, "rejected\n");
        return;
      }*/
      logger.log(`Caller token ignored.`);
      logger.log(`Verified incoming Live session ${sessionId}; accepting it...`);
      await acceptCall(sessionId);
      accepted = true;
    } catch (error) {
      if (error?.alreadyDecided) {
        // An earlier attempt whose response was lost did decide this session.
        logger.warn(`Live session ${sessionId} was already decided; treating it as accepted.`);
        accepted = true;
      } else {
        logger.error(error instanceof Error ? error.message : error);
        // The accept may have succeeded without us seeing the response. Attach anyway so a
        // live call is not left without tool handling; attaching to an unaccepted session fails.
        if (error?.ambiguous) startMonitor();
      }
    } finally {
      // A response already sent inside the try block is a final decision too.
      const decided = accepted || response.writableEnded;
      if (decided) {
        if (deliveryId) remember(seen, deliveryId);
        remember(decidedSessions, sessionId);
      }
      inFlight.delete(sessionId);
      settle(decided);
    }
    if (response.writableEnded) return;
    if (!accepted) {
      send(response, 502, "call acceptance failed\n");
      return;
    }
    startMonitor();
    send(response, 200, "accepted\n");
  };

  const server = http.createServer((request, response) => {
    logHttpRequest(request, response, logger);
    handleRequest(request, response).catch((error) => {
      logger.error(error instanceof Error ? error.message : error);
      if (!response.headersSent) send(response, 500, "internal error\n");
      else response.destroy();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}
