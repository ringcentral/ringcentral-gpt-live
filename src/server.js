import OpenAI from "openai";
import { booleanFromEnvironment } from "./environment.js";
import { createSessionMonitors } from "./live-session.js";
import {
  STRIDEWELL_BACKEND_INSTRUCTIONS,
  STRIDEWELL_LIVE_INSTRUCTIONS,
  STRIDEWELL_TOOLS,
} from "./stridewell-agent.js";
import { assertPort, assertSipCallToken } from "./validation.js";
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
  return assertPort(Number(process.env.PORT || 3000), "PORT");
}

try {
  const apiKey = required("OPENAI_API_KEY");
  const webhookSecret = required("OPENAI_WEBHOOK_SECRET");
  const callToken = assertSipCallToken(required("SIP_CALL_TOKEN"));
  const client = new OpenAI({ apiKey, webhookSecret });
  const sessionMonitors = createSessionMonitors({
    apiKey,
    initialSpokenGreeting:
      "Welcome to Stridewell Santa Clara. I'm the store's AI assistant. How can I help you today?",
    logMessages: booleanFromEnvironment("LOG_WEBSOCKET_MESSAGES"),
  });
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
    monitorCall: (sessionId) => sessionMonitors.monitorCall(sessionId),
    rejectCall: (sessionId) => rejectLiveSession(sessionId, { apiKey }),
  });
  server.on("close", () => {
    sessionMonitors.closeAll({ code: 1001, reason: "Webhook server shutting down" });
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
