# ringcentral-gpt-live

A small Node.js webhook that answers SIP calls with OpenAI's GPT-Live. It runs a fictional shoe-store assistant (Stridewell) that can check inventory, place holds, and more. A raw SIP/SRTP test caller is included so you can try it without a phone number.

For the full walk-through, see **https://gpt-live.labs.ringcentral.com**. This README covers just enough to get it running.

> [!IMPORTANT]
> This is a demo, not a production SIP stack. For real traffic, connect through a SIP trunk provider as OpenAI recommends. See [Limitations](#limitations).

## How it works

```text
test caller --- SIP/TLS + SRTP ---> OpenAI SIP
OpenAI ------- webhook (ngrok) ---> src/server.js
src/server.js - accept + sideband WebSocket -> OpenAI
GPT-Live ----- delegates tool work -> Responses model -> Stridewell tools
```

GPT-Live handles the conversation. A separate Responses model decides which tools to call (store hours, inventory, holds). The tools live in `src/stridewell-agent.js` and keep state in memory per call, so every call starts from a fresh store and nothing carries over between callers. The scenario is described in [`docs/stridewell-store-profile.md`](docs/stridewell-store-profile.md).

## You'll need

- Node.js 22+
- An OpenAI API project with billing and GPT-Live SIP enabled
- [ngrok](https://ngrok.com/) (or any HTTPS tunnel)

## Setup

1. **Install and create your env file**

   ```bash
   npm install
   cp .env.example .env
   ```

2. **Fill in `.env`.** The project ID and API key must come from the same OpenAI project:

   - `OPENAI_PROJECT_ID`: the `proj_...` ID under Settings → Project → General
   - `OPENAI_API_KEY`: a project key from Settings → Project → API Keys
   - `SIP_CALL_TOKEN`: a random string the test caller sends as the user part of its SIP `From` address. Generate one with `openssl rand -hex 16`. The webhook server does not check it and accepts every signature-verified call.

3. **Start a tunnel**

   ```bash
   ngrok http 3000
   ```

4. **Register the webhook.** In Settings → Project → Webhooks, create an endpoint pointing at `https://<your-ngrok-host>/webhook` and subscribe it to `live.transport.incoming`. Copy the signing secret into `.env` as `OPENAI_WEBHOOK_SECRET`.

   OpenAI doesn't follow redirects, and free ngrok URLs change on restart, so update the endpoint whenever yours does.

## Run it

```bash
npm start        # webhook server
npm run call     # in another terminal: places a test call
```

You should see the server verify the webhook, accept the session, and attach its WebSocket. The assistant greets the caller first.

The test caller plays `audio/hello_tell_me_a_joke.ul` and then sends silence. It doesn't play back what it hears. To check that audio is returning, set `RECORD_INCOMING_AUDIO=true` and inspect the `.ul` file it writes to `output/`.

`npm run start:live` and `npm run call:live` do the same thing using `.env.live`, handy for keeping a second project's credentials separate.

## Configuration

The ones you're most likely to touch (the rest are in `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_LIVE_MODEL` | `gpt-live-1` | Voice model |
| `OPENAI_BACKEND_MODEL` | `gpt-6-luna` | Model that picks tools |
| `OPENAI_VOICE` | `marin` | Output voice |
| `LIVE_AGENT_INSTRUCTIONS` | built-in Stridewell prompt | Override the voice prompt |
| `PORT` | `3000` | Webhook port |
| `CALL_DURATION_SECONDS` | `30` | How long the test caller stays on the line |
| `LOG_WEBSOCKET_MESSAGES` | `false` | Log sideband traffic, including `TEXT>>` transcript lines |
| `LOG_SIP_MESSAGES` | `false` | Log raw SIP, including the call token and SRTP keys. Debugging only |
| `RTP_PORT` / `RTP_ADVERTISED_IP` | auto | Media address, if you need to set it yourself |

To watch just the transcript: `npm start | grep 'TEXT>>'` (with `LOG_WEBSOCKET_MESSAGES=true`).

## Limitations

- **Only PCMU audio is implemented.** Opus is advertised in the SDP for negotiation testing but can't be encoded or decoded.
- **ngrok only carries the webhook.** SIP and RTP don't go through it. Behind most NATs the test call connects but you get no return audio. You'll need a reachable public IP with a forwarded UDP port, or a SIP trunk/SBC.
- **No ICE, STUN, TURN, RTCP, SIP auth, or registration.**
- **Text and "connect me to a person" tools are fakes.** They write in-memory records. No SMS is sent and no call is transferred.

## Troubleshooting

- **Webhook never arrives:** check that ngrok and `npm start` are both running, that the dashboard URL ends in `/webhook`, and that the project matches your SIP URI. The ngrok inspector at `localhost:4040` shows what actually came in.
- **`invalid webhook`:** wrong signing secret (it's not the API key), a stale system clock, or a proxy rewriting the body.
- **Session accept fails:** confirm the key belongs to the project, billing and model access are on, and the webhook is subscribed to `live.transport.incoming`.
- **SIP INVITE times out:** usually an accept error upstream, or outbound TCP 5061 is blocked.
- **`insufficient_quota` after 180 Ringing:** add credits to the project that owns the API key.
- **Connected but silent:** see the NAT note above.

## Tests

```bash
npm test
```

Fully offline. No credentials or network needed.

## Layout

| Path | What it does |
| --- | --- |
| `src/server.js` | Webhook server |
| `src/webhook.js` | Verifies events, accepts the session |
| `src/live-monitor.js` | Sideband WebSocket and tool execution |
| `src/stridewell-agent.js` | Prompts, tool schemas, demo store data |
| `src/call.js`, `src/sip-call.js` | Test caller and SIP dialog |
| `src/protocol.js`, `src/srtp.js` | SIP/SDP/RTP helpers and SDES-SRTP |
| `src/pcmu-audio.js`, `src/pcmu-recording.js` | Audio file playback and recording |

## References

[GPT-Live SIP guide](https://developers.openai.com/api/docs/guides/voice-sip?voice-api=realtime) · [Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation) · [Webhooks](https://developers.openai.com/api/docs/guides/webhooks) · [SIP RFC 3261](https://www.rfc-editor.org/rfc/rfc3261) · [SRTP RFC 3711](https://www.rfc-editor.org/rfc/rfc3711)
