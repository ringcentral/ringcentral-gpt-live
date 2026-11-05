# Minimal Node.js SIP webhook for OpenAI GPT-Live

This example receives OpenAI's signed GPT-Live incoming-session webhook and runs the fictional Stridewell store assistant described in [`docs/stridewell-store-profile.md`](docs/stridewell-store-profile.md). GPT-Live handles the spoken conversation while a dedicated Responses model chooses application-owned tools for inventory and store actions. A server-side Live WebSocket executes those tools and returns their results.

The official `openai` package verifies webhook signatures, and `ws` provides the Live sideband transport.

The bundled `npm run call` raw SIP/SRTP test caller offers PCMU and advertises Opus over SDES-SRTP using `AES_CM_128_HMAC_SHA1_80`. Only PCMU media is implemented; Opus payload type 111 is present in SDP for negotiation testing. The caller creates fresh media key material for every call and validates the secure SDP answer before sending media.

> [!IMPORTANT]
> OpenAI documents SIP trunking providers as the normal way to connect calls. This raw user agent is an educational, endpoint-specific demo—not a production SIP stack. OpenAI does not document custom-UAC codec, NAT, or packetization guarantees. See [Network and NAT limitations](#network-and-nat-limitations).

## What happens

```text
SIP provider   -- SIP/TLS + SRTP --------------------------> OpenAI SIP
Local webhook <-- HTTPS live.transport.incoming -- tunnel -- OpenAI
Local webhook -- POST /live/sessions/{session_id}/accept -> OpenAI API
Local webhook -- WSS /live/sessions/{session_id}/attach <-> OpenAI API
GPT-Live      -- delegates store work --------------------> Responses model
Responses     -- function calls --> in-memory Stridewell tools --> results
```

## Stridewell agent

The responsibilities are intentionally split:

- GPT-Live introduces itself as the Santa Clara store's AI assistant, keeps spoken turns short, handles interruptions, asks one question at a time, and enforces conversational policies such as no payment or size guessing.
- The backend Responses model uses tools instead of guessing store facts. It can retrieve store addresses and hours, check known inventory quantities, find the nearest store with known stock, place a 24-hour hold, record a text confirmation, and record a request for a human connection.
- `src/stridewell-agent.js` owns the fictional catalog and mutable demo state. Restarting `npm start` resets inventory, holds, text records, and connection requests.

Every store/product/size combination starts with a randomly selected 1–4 pairs for each server run. The scenario then overrides the Veloce Glide 4 in size 10 to 0 pairs in Santa Clara and San Jose, leaving Palo Alto stocked for the hero flow. Holds decrement quantities one pair at a time. Store addresses are deliberately fictional and live in the same in-memory table as names, hours, and phone numbers.

The text and human-connection tools create in-memory demo records. They do not send SMS or issue a SIP transfer because the scenario supplies fictional phone numbers and no carrier integrations. Tool results state that limitation so the voice agent does not claim an external action succeeded.

The documentation URL in `REQUIREMENTS.md` describes this flow; it is not itself the call destination. The SIP destination is:

```text
sip:<your-proj_ID>@sip.api.openai.com;transport=tls
```

## Prerequisites

- Node.js 22 or newer (a currently supported LTS release; Node 24 is recommended)
- An OpenAI API Platform account and a project with API billing/model access
- [ngrok](https://ngrok.com/) for a public HTTPS webhook URL

ChatGPT subscriptions and API billing are separate. Confirm that GPT-Live SIP is enabled for the project and that it has API billing/model access. See the [`gpt-live-1` model page](https://developers.openai.com/api/docs/models/gpt-live-1).

## 1. Create the OpenAI project and credentials

All three values must belong to the same OpenAI API project.

1. Sign in at the [OpenAI API Platform](https://platform.openai.com/).
2. Open the project switcher in the upper-left.
3. Select an existing project, or choose **Create project**, enter a name, and create it. If **Create project** is unavailable, use the Default project or ask an organization owner to create one. See [Managing projects](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform).
4. With that project selected, open **Settings → Project → API Keys**.
5. Select **Create new secret key**, create a project key, and copy it immediately. It is shown only once. This is `OPENAI_API_KEY`.
6. Open **Settings → Project → General** and copy the ID beginning with `proj_`. This is `OPENAI_PROJECT_ID`; do not use an organization ID.
7. Install the project and create its local environment file:

   ```powershell
   npm install
   Copy-Item .env.example .env
   ```

8. Generate a private token used to correlate the SIP caller with its webhook, then put it in `.env` as `SIP_CALL_TOKEN`:

   ```powershell
   [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLower()
   ```

9. Edit `.env` and set the project ID, API key, and generated call token. Leave the webhook secret placeholder for the next section.

Never commit `.env`. The API key authorizes REST calls; the webhook signing secret proves that an incoming HTTP request came from OpenAI. They are different credentials.

## 2. Expose the webhook without a public IP

An outbound tunnel lets OpenAI reach the local HTTP server even when the PC is behind NAT and has no public IP.

1. In a terminal, authenticate ngrok if this machine has not used it before:

   ```powershell
   ngrok config add-authtoken <YOUR_NGROK_AUTHTOKEN>
   ```

2. Start a tunnel to the example's HTTP port:

   ```powershell
   ngrok http --url=<your-domain>.ngrok-free.dev 3000
   ```

3. Copy the forwarding HTTPS URL shown by ngrok, such as `https://example.ngrok-free.app`.
4. In the same OpenAI project, open **Settings → Project → Webhooks** and select **Create**.
5. Give the endpoint a name and set its URL to the final URL, including the path:

   ```text
   https://example.ngrok-free.app/webhook
   ```

6. Subscribe it to `live.transport.incoming`, then create the webhook. During a staged migration you may also temporarily subscribe to the deprecated `live.call.incoming`; the server safely deduplicates both event types by `session_id`.
7. Copy the webhook signing secret immediately and put it in `.env` as `OPENAI_WEBHOOK_SECRET`.

OpenAI does not follow webhook redirects, so use the final HTTPS URL. A free ngrok URL usually changes when ngrok restarts; update the webhook URL in the dashboard whenever it changes. OpenAI's [webhook guide](https://developers.openai.com/api/docs/guides/webhooks) describes the same local-testing setup.

## 3. Start the webhook and place the call

Keep ngrok running. In a second terminal, start the verified webhook server:

```powershell
npm start
```

Optional local health check:

```powershell
Invoke-WebRequest http://localhost:3000/health
```

Every HTTP request reaching the server is logged after completion with its method, path, response status, and duration. Query strings, request bodies, and headers are omitted so webhook signatures and other sensitive values are not written to the access log.

In a third terminal, place the SIP call:

```powershell
npm run call
```

For a compatible inbound SIP call, the webhook terminal should report that it verified and accepted a Live session, then that its sideband WebSocket connected. The acceptance request seeds `session.input` with a developer message asking GPT-Live to open the conversation. When the sideband connects, the server also sends a one-shot `session.commentary.append` containing the spoken welcome so the caller does not need to speak first.

`npm run call` launches the raw PCMU test caller. It negotiates `RTP/SAVP` with SDES-SRTP, encrypts and authenticates outgoing media, and authenticates and decrypts incoming media. Its offer includes Opus (`opus/48000/2`, payload type 111), but it cannot encode or decode Opus and therefore requires the answer to retain PCMU payload type 0.

The bundled `audio/hello_tell_me_a_joke.ul` is headerless, mono, 8 kHz G.711 PCMU. The caller sends 160 raw bytes every 20 ms, pads the final partial frame with PCMU silence (`0xff`), and then sends silence without looping the file. It does not play received RTP, so it is not an audible softphone; received PCMU can optionally be recorded to a raw `.ul` file.

## Configuration

| Environment variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENAI_PROJECT_ID` | Yes | — | Project ID beginning with `proj_`; used in the SIP URI |
| `OPENAI_API_KEY` | Webhook server | — | Project API key used to accept the verified call |
| `OPENAI_WEBHOOK_SECRET` | Webhook server | — | Verifies the untouched webhook body and headers |
| `SIP_CALL_TOKEN` | Yes | — | Private 16-64 character token placed in SIP `From` and checked before acceptance |
| `OPENAI_LIVE_MODEL` | No | `gpt-live-1` | Model sent to the Live session-accept endpoint |
| `OPENAI_BACKEND_MODEL` | No | `gpt-6-luna` | Dedicated Responses model that selects Stridewell tools |
| `OPENAI_VOICE` | No | `marin` | GPT-Live output voice selected at session acceptance |
| `LIVE_AGENT_INSTRUCTIONS` | No | Built-in Stridewell prompt | Optional GPT-Live conversation-prompt override |
| `PORT` | No | `3000` | Local HTTP webhook port |
| `CALL_DURATION_SECONDS` | No | `30` | Total time the RTP sender runs, including file playback and trailing silence |
| `PCMU_AUDIO_FILE` | No | No file (silence only) | Raw headerless 8 kHz mono G.711 PCMU file sent before silence |
| `PREFER_OPUS` | No | `false` | Put unimplemented Opus PT 111 before PCMU PT 0 in the SDP offer |
| `RECORD_INCOMING_AUDIO` | No | `false` | Write incoming PCMU RTP payloads to a raw `.ul` file |
| `INCOMING_AUDIO_FILE` | No | `output/recording-<date>.ul` | Recording path used only when incoming recording is enabled |
| `LOG_SIP_MESSAGES` | No | `false` | Log every inbound/outbound SIP message in the `npm run call` terminal |
| `LOG_WEBSOCKET_MESSAGES` | No | `false` | Log inbound/outbound Live sideband messages with Base64 audio payloads redacted |
| `SIP_HOST` | No | `sip.api.openai.com` | SIP TLS host |
| `SIP_PORT` | No | `5061` | Conventional SIP TLS port used by this demo |
| `RTP_PORT` | No | OS-assigned even port | Local UDP RTP port; an explicit value must be even |
| `RTP_ADVERTISED_IP` | No | TLS connection's local IPv4 | Address written into SDP |

The voice model is configurable, but this application uses the Live session contract and therefore defaults to `gpt-live-1`. The separately configurable Responses backend is registered through `session.delegation.responses`, and custom function results are returned on the sideband connection. See the current [GPT-Live telephony and SIP guide](https://developers.openai.com/api/docs/guides/voice-sip?voice-api=realtime) and [delegation and tools guide](https://developers.openai.com/api/docs/guides/live-delegation).

`PCMU_AUDIO_FILE` may be absolute or relative to the directory where `npm run call` is started. A configured file must exist and be non-empty or the caller exits before opening the network connection. `CALL_DURATION_SECONDS` is the total media duration, so a file longer than that duration is truncated when the call ends.

Set `PREFER_OPUS=true` to advertise payload types as `111 0` instead of the default `0 111`. This changes only SDP ordering. The caller still requires PCMU in the answer and does not encode, decode, packetize, play, or record Opus media. An Opus-only answer therefore fails before media starts.

### Optional incoming audio recording

Incoming recording is off by default. To enable it, set these values and restart `npm run call`:

```dotenv
RECORD_INCOMING_AUDIO=true
INCOMING_AUDIO_FILE=output/recording-<date>.ul
```

`<date>` expands to a filename-safe UTC timestamp such as `2026-07-17T22-14-30-123Z`. A relative path is resolved from the directory where `npm run call` starts, and missing parent directories are created. The recorder refuses to overwrite an existing file. When `RECORD_INCOMING_AUDIO=false`, the path is ignored and no output file or directory is created.

The resulting file is headerless 8 kHz mono G.711 PCMU: RTP headers, CSRCs, extensions, and padding are removed, and valid payload bytes are written in packet-arrival order. A call that receives no valid PCMU RTP produces an empty file. Recordings may contain sensitive voice data; `output/` is excluded from Git.

### Optional protocol logging

Set either logging flag to `true` in `.env`, then restart the corresponding process. The flags are independent: SIP logging applies to `npm run call`, while WebSocket logging applies to `npm start`. The monitoring WebSocket still connects when its message logging is disabled; connection, close, and error notices are always shown.

To include transcript fragments in the WebSocket log, enable WebSocket logging, then restart `npm start`:

```dotenv
LOG_WEBSOCKET_MESSAGES=true
```

GPT-Live emits transcript deltas for both speakers. The monitor prints each non-empty fragment on one line and labels it separately from the raw WebSocket message:

```text
TEXT>>AI: Hi! You've reached Stridewell Santa Clara. I'm the store's AI assistant. How can I help?
TEXT>>ME: Do you have the Glide 4 in a 10?
TEXT>>AI: Santa Clara is out, but Palo Alto has it. That's about 14 miles away.
```

In PowerShell, filter the server output to just those dialogue lines with:

```powershell
npm start | Select-String 'TEXT>>'
```

Caller and assistant transcript fragments can overlap because GPT-Live is full duplex. Preserve their `start_ms` and `end_ms` fields in applications that need to assemble captions; see [Managing GPT-Live sessions](https://developers.openai.com/api/docs/guides/live-conversations).

SIP logs are complete, unredacted protocol messages intended for short debugging sessions. They include the private `SIP_CALL_TOKEN`, addressing, headers, and SDP—including SDES media keys that can decrypt captured audio. Live WebSocket logs redact Base64 values from `session.input_audio.append` and `session.output_audio.delta`, recording only their encoded lengths; conversation text, transcripts, instructions, and delegation traffic remain visible. Do not share or retain these logs as ordinary application logs.

## Network and NAT limitations

The ngrok command solves only this path:

```text
OpenAI HTTPS webhook → ngrok → localhost:3000
```

It does not tunnel SIP or UDP SRTP. SIP responses normally return on the outbound TLS connection, and outbound SRTP can leave through most NATs, but a private SDP address is not generally reachable for return audio. The demo also has no ICE, STUN, TURN, RTCP, SIP authentication, registration, Opus encoder/decoder, or full SIP extension support. Opus is advertised only; PCMU remains the sole implemented codec.

If you control a public IPv4 address and router, a basic test can use a fixed `RTP_PORT`, forward that UDP port to the PC, allow it through the host firewall, and set `RTP_ADVERTISED_IP` to the public address. Do not set a public value unless that forwarding really exists. This will not work behind carrier-grade NAT.

For reliable two-way audio, remotely initiated hangup, phone numbers, and production use, follow OpenAI's documented approach and use a SIP trunk/SBC or media relay with public media reachability. A small VPS can also host this example, but it still is not a production SIP implementation.

Media uses SDES-SRTP with the `AES_CM_128_HMAC_SHA1_80` suite. TLS protects SIP signaling and the SDP key exchange; do not enable SIP logging outside a controlled debugging session.

The webhook also checks an unguessable `SIP_CALL_TOKEN` in the verified event's SIP `From` header before spending API resources. Unexpected callers are rejected with SIP status 603. Keep this token secret and rotate it if exposed.

## Troubleshooting

### The webhook never arrives

- Confirm ngrok and `npm start` are both running.
- Open the ngrok inspection UI and check for `POST /webhook`.
- Confirm the dashboard URL includes `/webhook` and has no redirect.
- Confirm the webhook and SIP URI use the same `proj_...` project.
- Restarting ngrok may have changed the public URL.

### `invalid webhook`

- Copy the current endpoint's signing secret again by rotating it in the dashboard if necessary.
- Do not use the API key as the webhook secret.
- Check the PC clock; signature verification rejects stale timestamps.
- The server verifies the raw request text before JSON parsing. Do not put a body-transforming proxy in front of it.

### Live session acceptance fails

- Confirm the API key belongs to the selected project and has sufficient permissions.
- Confirm API billing, `gpt-live-1` access, and GPT-Live SIP enablement for the project.
- Confirm the webhook is subscribed to `live.transport.incoming`, not only `realtime.call.incoming`.
- Read the webhook-terminal error; the app returns a non-2xx webhook response so OpenAI can retry a transient failure.

### The SIP INVITE times out

- First resolve any webhook or `/accept` error—the SIP call cannot complete until the webhook accepts it.
- Check whether the local network permits outbound TCP 5061.
- Confirm `OPENAI_PROJECT_ID` starts with `proj_`.
- A custom UAC is outside OpenAI's documented trunk-provider interoperability path; try a supported SIP trunk if the raw call is rejected.

### SIP reaches `180 Ringing`, then fails

The test caller includes any bounded `Warning`, `Reason`, and response-body details in the final error. If it reports `insufficient_quota`, add API billing or credits to the project that owns `OPENAI_API_KEY`; changing SIP headers or the webhook will not fix an account quota failure.

For media-related errors, use an even fixed `RTP_PORT` and a genuinely reachable `RTP_ADVERTISED_IP`, or use a SIP trunk/SBC. Ngrok exposes the HTTP webhook only; it does not carry UDP RTP.

### SIP connects, but there is no return audio

That is expected behind many NATs and is not fixed by an HTTP tunnel. This example does not play received RTP; it sends the configured PCMU file followed by silence. Enable `RECORD_INCOMING_AUDIO` to check whether return PCMU packets reach the caller. An empty recording means no valid return media arrived. Use public media routing or a SIP trunk for a real conversation.

## Tests

The test suite is fully offline; it needs no OpenAI credentials, tunnel, or network:

```powershell
npm test
```

It covers raw OpenAI SDK webhook signature verification, duplicate delivery handling, the `/accept` request and Responses delegation configuration, tool-call execution/continuation, Stridewell state transitions, monitor startup/error isolation, WebSocket message logging, strict feature flags, PCMU file loading/framing/tail padding, incoming recording path/file behavior, TLS-style SIP stream fragmentation/coalescing, SIP logging, secure SDP checks, SIP BYE responses, RTP packet creation/payload extraction, RFC SRTP key derivation, encryption, authentication, replay rejection, tamper rejection, and sequence rollover.

## Implementation scope

- `src/server.js` starts the signed webhook receiver.
- `src/webhook.js` verifies/deduplicates events and invokes the call-accept endpoint.
- `src/live-monitor.js` attaches an authenticated sideband WebSocket to each accepted Live session.
- `src/stridewell-agent.js` defines the voice/backend prompts, function schemas, fictional store data, and in-memory actions.
- `src/call.js` starts one outbound demo call.
- `src/pcmu-audio.js` loads and frames the configured raw PCMU audio.
- `src/pcmu-recording.js` resolves recording paths and writes incoming raw PCMU audio.
- `src/sip-call.js` implements the small SIP dialog and RTP timer.
- `src/protocol.js` contains SIP framing, SDP parsing, and RTP packet helpers.
- `src/srtp.js` implements the caller's SDES-SRTP key exchange and `AES_CM_128_HMAC_SHA1_80` packet protection.

Protocol references: [SIP (RFC 3261)](https://www.rfc-editor.org/rfc/rfc3261), [RTP (RFC 3550)](https://www.rfc-editor.org/rfc/rfc3550), [RTP audio profiles (RFC 3551)](https://www.rfc-editor.org/rfc/rfc3551), [SRTP (RFC 3711)](https://www.rfc-editor.org/rfc/rfc3711), [SDES for SRTP (RFC 4568)](https://www.rfc-editor.org/rfc/rfc4568), and [SDP (RFC 8866)](https://www.rfc-editor.org/rfc/rfc8866).
