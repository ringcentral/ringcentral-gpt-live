import OpenAI from "openai";
import { booleanFromEnvironment } from "./environment.js";
import { monitorLiveSession } from "./live-monitor.js";
import {
  createStridewellStore,
  STRIDEWELL_BACKEND_INSTRUCTIONS,
  STRIDEWELL_LIVE_INSTRUCTIONS,
  STRIDEWELL_TOOLS,
} from "./stridewell-agent.js";
import {
  acceptLiveSession,
  createWebhookServer,
  hasSipCallToken,
  rejectLiveSession,
} from "./webhook.js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; copy .env.example to .env and fill it in`);
  return value;
}

function readPort() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be between 1 and 65535");
  }
  return port;
}

try {
  const apiKey = required("OPENAI_API_KEY");
  const webhookSecret = required("OPENAI_WEBHOOK_SECRET");
  const callToken = required("SIP_CALL_TOKEN");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(callToken)) {
    throw new Error("SIP_CALL_TOKEN must contain 16-64 letters, digits, underscores, or hyphens");
  }
  const client = new OpenAI({ apiKey, webhookSecret });
  const activeMonitors = new Map();
  const stridewellStore = createStridewellStore();
  const logWebSocketMessages = booleanFromEnvironment("LOG_WEBSOCKET_MESSAGES");
  const server = createWebhookServer({
    unwrap: (rawBody, headers) => client.webhooks.unwrap(rawBody, headers),
    acceptCall: (sessionId) => acceptLiveSession(sessionId, {
      apiKey,
      model: process.env.OPENAI_LIVE_MODEL || "gpt-live-1",
      instructions: process.env.LIVE_AGENT_INSTRUCTIONS || STRIDEWELL_LIVE_INSTRUCTIONS,
      initialGreetingInstructions:
        "Greet the caller now in English. Identify Stridewell Santa Clara and yourself as its AI assistant. Ask how you can help, then pause and listen.",
      voice: process.env.OPENAI_VOICE || "marin",
      backendModel: process.env.OPENAI_BACKEND_MODEL || "gpt-6-luna",
      backendInstructions: STRIDEWELL_BACKEND_INSTRUCTIONS,
      tools: STRIDEWELL_TOOLS,
    }),
    authorizeCall: (event) => hasSipCallToken(event, callToken),
    monitorCall: (sessionId) => {
      if (activeMonitors.has(sessionId)) return activeMonitors.get(sessionId);
      const monitor = monitorLiveSession(sessionId, {
        apiKey,
        initialSpokenGreeting:
          "Welcome to Stridewell Santa Clara. I'm the store's AI assistant. How can I help you today?",
        toolExecutor: (name, args) => stridewellStore.execute(name, args),
        logMessages: logWebSocketMessages,
        onClose: (closedMonitor) => {
          if (activeMonitors.get(sessionId) === closedMonitor) activeMonitors.delete(sessionId);
        },
      });
      activeMonitors.set(sessionId, monitor);
      return monitor;
    },
    rejectCall: (sessionId) => rejectLiveSession(sessionId, { apiKey }),
  });
  server.on("close", () => {
    for (const monitor of activeMonitors.values()) {
      monitor.close({ code: 1001, reason: "Webhook server shutting down" });
    }
    activeMonitors.clear();
  });
  const host = process.env.HOST || "localhost";
  const port = readPort();
  server.on("error", (error) => {
    console.error(`Webhook server error: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Webhook server listening on http://${host}:${port}/webhook`);
    console.log(`Health check: http://${host}:${port}/health`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
