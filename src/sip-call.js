import dgram from "node:dgram";
import { EventEmitter, once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";
import tls from "node:tls";
import {
  createPcmuFrameSource,
  PCMU_BYTES_PER_SECOND,
  PCMU_FRAME_BYTES,
  PCMU_FRAME_DURATION_MS,
} from "./pcmu-audio.js";
import {
  SipMessageDecoder,
  createRtpPacket,
  createSdpOffer,
  extractRtpPayload,
  getHeader,
  getHeaders,
  parseNameAddressUri,
  parseSdpAnswer,
  serializeSipRequest,
  serializeSipResponse,
  splitHeaderValues,
} from "./protocol.js";
import { openPcmuRecorder } from "./pcmu-recording.js";
import { createSdesKeyMaterial, SrtpContext } from "./srtp.js";
import { assertPort, assertSipCallToken } from "./validation.js";

const USER_AGENT = "openai-sip-minimal/1.0";
const MAX_SIP_DIAGNOSTIC_LENGTH = 1_000;
const CANCEL_WAIT_MS = 3_000;

export function logSipMessage(logger, enabled, direction, raw) {
  if (!enabled) return;
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  logger.log(`[SIP ${direction}]\n${text}`);
}

function randomHex(bytes = 12) {
  return randomBytes(bytes).toString("hex");
}

function randomUInt32() {
  return randomBytes(4).readUInt32BE(0);
}

function randomNonzeroUInt32() {
  let value = 0;
  while (value === 0) value = randomUInt32();
  return value;
}

function singleLineDiagnostic(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SIP_DIAGNOSTIC_LENGTH);
}

export function formatInviteFailure(response) {
  const reason = singleLineDiagnostic(response.reason ?? "");
  const status = `SIP INVITE failed: ${response.status}${reason ? ` ${reason}` : ""}`;
  const details = [];
  for (const name of ["warning", "reason"]) {
    for (const value of getHeaders(response, name)) {
      const detail = singleLineDiagnostic(value);
      if (detail) details.push(`${name[0].toUpperCase()}${name.slice(1)}: ${detail}`);
    }
  }
  const body = singleLineDiagnostic(response.body?.toString("utf8") ?? "");
  if (body) details.push(`Body: ${body}`);
  const detail = singleLineDiagnostic(details.join("; "));
  return detail ? `${status} (${detail})` : status;
}

function validateHost(host) {
  if (typeof host !== "string" || host.length > 253 || !/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error("SIP_HOST must be a DNS name or IPv4 address");
  }
  return host;
}

function getCSeq(message) {
  const value = getHeader(message, "cseq") ?? "";
  const match = value.match(/^(\d+)\s+([A-Z]+)$/i);
  return match ? { number: Number(match[1]), method: match[2].toUpperCase() } : undefined;
}

function routeDialogRequest(remoteTarget, routeSet) {
  if (routeSet.length === 0 || /(?:^|[;?])lr(?:[=;?>]|$)/i.test(routeSet[0])) {
    return { requestUri: remoteTarget, routes: routeSet };
  }
  return {
    requestUri: parseNameAddressUri(routeSet[0]),
    routes: [...routeSet.slice(1), `<${remoteTarget}>`],
  };
}

export class SipCall {
  constructor({
    projectId,
    callToken,
    sipHost = "sip.api.openai.com",
    sipPort = 5061,
    rtpPort = 0,
    advertisedRtpAddress,
    durationSeconds = 30,
    inviteTimeoutMs = 60_000,
    logSipMessages = false,
    preferOpus = false,
    logger = console,
    pcmuAudio = Buffer.alloc(0),
    incomingAudioFile,
    recordingFactory = openPcmuRecorder,
    tlsConnect = tls.connect,
  }) {
    if (typeof projectId !== "string" || !/^proj_[A-Za-z0-9_-]+$/.test(projectId)) {
      throw new Error("OPENAI_PROJECT_ID must be a proj_... project ID");
    }
    this.projectId = projectId;
    this.callToken = assertSipCallToken(callToken);
    this.sipHost = validateHost(sipHost);
    this.sipPort = assertPort(Number(sipPort), "SIP_PORT");
    this.rtpPort = Number(rtpPort);
    if (
      !Number.isInteger(this.rtpPort)
      || this.rtpPort < 0
      || this.rtpPort > 65534
      || (this.rtpPort !== 0 && this.rtpPort % 2 !== 0)
    ) {
      throw new Error("RTP_PORT must be 0 or an even port between 2 and 65534");
    }
    if (advertisedRtpAddress && !isIPv4(advertisedRtpAddress)) {
      throw new Error("RTP_ADVERTISED_IP must be an IPv4 address");
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("CALL_DURATION_SECONDS must be positive");
    }
    if (typeof preferOpus !== "boolean") throw new Error("PREFER_OPUS must be true or false");
    if (!Buffer.isBuffer(pcmuAudio)) throw new Error("PCMU audio must be a Buffer");
    if (
      incomingAudioFile !== undefined
      && (typeof incomingAudioFile !== "string" || incomingAudioFile.trim() === "")
    ) {
      throw new Error("INCOMING_AUDIO_FILE must be a non-empty path");
    }
    if (typeof recordingFactory !== "function") {
      throw new Error("Recording factory must be a function");
    }
    this.advertisedRtpAddress = advertisedRtpAddress;
    this.durationMs = Math.round(durationSeconds * 1000);
    this.inviteTimeoutMs = inviteTimeoutMs;
    this.logSipMessages = logSipMessages;
    this.preferOpus = preferOpus;
    this.logger = logger;
    this.pcmuAudio = pcmuAudio;
    this.incomingAudioFile = incomingAudioFile?.trim();
    this.recordingFactory = recordingFactory;
    if (typeof tlsConnect !== "function") throw new Error("TLS connect must be a function");
    this.tlsConnect = tlsConnect;
    this.events = new EventEmitter();
    this.decoder = new SipMessageDecoder();
    this.state = "new";
    this.stopPromise = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
  }

  async run() {
    try {
      if (this.stopRequested) throw new Error("Call stopped by user");
      await this.#openIncomingAudioRecording();
      if (this.stopRequested) throw new Error("Call stopped by user");
      await this.#bindRtp();
      if (this.stopRequested) throw new Error("Call stopped by user");
      await this.#connectTls();
      this.#createDialogIdentifiers();
      const finalResponse = await this.#invite();

      if (finalResponse.status < 200 || finalResponse.status >= 300) {
        this.#sendFailureAck(finalResponse);
        throw new Error(formatInviteFailure(finalResponse));
      }

      this.#establishDialog(finalResponse);
      this.#writeSipMessage(this.ackBytes);
      this.state = "established";

      // From here the remote session exists, so every way out of this block ends it with a BYE.
      try {
        this.#startRtp(parseSdpAnswer(finalResponse.body));
        if (this.pcmuAudio.length > 0) {
          const audioSeconds = (this.pcmuAudio.length / PCMU_BYTES_PER_SECOND).toFixed(3);
          this.logger.log(
            `Call established; sending ${audioSeconds}s of PCMU audio, then silence, `
              + `for up to ${this.durationMs / 1000}s total.`,
          );
        } else {
          this.logger.log(`Call established; sending PCMU silence for up to ${this.durationMs / 1000}s.`);
        }
        await this.#waitForDurationOrStop();

        if (this.fatalError) throw this.fatalError;
      } finally {
        if (!this.remoteEnded && this.socket && !this.socket.destroyed) {
          try {
            await this.#sendBye();
          } catch (error) {
            this.logger.warn(`Could not send SIP BYE: ${error instanceof Error ? error.message : error}`);
          }
        }
      }
      this.logger.log(`Call ended. RTP packets sent: ${this.rtpSent}; received: ${this.rtpReceived}.`);
    } finally {
      await this.#cleanup();
    }
  }

  stop() {
    this.stopRequested = true;
    this.resolveStop();
    if (this.state === "connecting") {
      this.#fail(new Error("Call stopped by user"));
    } else if (this.state === "inviting") {
      // The INVITE is on the wire; give it up in a way that lets us CANCEL it first.
      const error = new Error("Call stopped by user");
      error.abandoned = true;
      this.events.emit("abandon", error);
    }
  }

  async #openIncomingAudioRecording() {
    if (!this.incomingAudioFile) return;
    const recorder = await this.recordingFactory(this.incomingAudioFile, {
      onError: (error) => this.#fail(error),
    });
    if (
      !recorder
      || typeof recorder.write !== "function"
      || typeof recorder.close !== "function"
    ) {
      if (typeof recorder?.close === "function") await recorder.close();
      throw new Error("Recording factory returned an invalid recorder");
    }
    this.incomingAudioRecorder = recorder;
    this.logger.log(
      `Recording incoming PCMU audio to ${recorder.path ?? this.incomingAudioFile}.`,
    );
  }

  async #bindRtp() {
    const maxAttempts = this.rtpPort === 0 ? 32 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const socket = dgram.createSocket("udp4");
      try {
        socket.bind(this.rtpPort, "0.0.0.0");
        await once(socket, "listening");
      } catch (error) {
        try {
          socket.close();
        } catch {
          // The socket never reached a bound state.
        }
        throw error;
      }
      const port = socket.address().port;
      if (port % 2 === 0) {
        this.rtpSocket = socket;
        this.boundRtpPort = port;
        break;
      }
      await new Promise((resolve) => socket.close(resolve));
    }
    if (!this.rtpSocket) {
      throw new Error("Could not allocate an even UDP port for RTP");
    }
    this.rtpSocket.on("message", (packet) => {
      this.rtpReceived = (this.rtpReceived ?? 0) + 1;
      if (!this.inboundSrtp) return;
      const plainPacket = this.inboundSrtp.unprotectRtp(packet);
      if (!plainPacket || !this.incomingAudioRecorder || this.incomingPayloadType === undefined) return;
      const payload = extractRtpPayload(plainPacket, this.incomingPayloadType);
      if (!payload) return;
      try {
        this.incomingAudioRecorder.write(payload);
      } catch (error) {
        this.#fail(error);
      }
    });
    this.rtpSocket.on("error", (error) => this.#fail(error));
  }

  async #connectTls() {
    this.state = "connecting";
    this.logger.log(`Connecting to ${this.sipHost}:${this.sipPort} with SIP over TLS...`);
    this.socket = this.tlsConnect({
      host: this.sipHost,
      port: this.sipPort,
      servername: isIPv4(this.sipHost) ? undefined : this.sipHost,
      family: 4,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    });
    this.socket.setKeepAlive(true);
    this.socket.on("data", (chunk) => {
      try {
        for (const message of this.decoder.push(chunk)) {
          logSipMessage(this.logger, this.logSipMessages, "INBOUND", message.raw);
          this.#handleSipMessage(message);
        }
      } catch (error) {
        this.#fail(error);
      }
    });
    this.socket.on("error", (error) => this.#fail(error));
    this.socket.on("close", () => {
      if (this.state !== "closed" && this.state !== "terminating") {
        this.#fail(new Error("SIP TLS connection closed unexpectedly"));
      }
    });
    await new Promise((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onFatal = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.socket.off("secureConnect", onConnect);
        this.events.off("fatal", onFatal);
      };
      this.socket.on("secureConnect", onConnect);
      this.events.on("fatal", onFatal);
    });
    if (!isIPv4(this.socket.localAddress)) {
      throw new Error(`SIP TLS connection did not select IPv4: ${this.socket.localAddress}`);
    }
  }

  #createDialogIdentifiers() {
    this.localAddress = this.socket.localAddress;
    this.localPort = this.socket.localPort;
    this.targetUri = `sip:${this.projectId}@${this.sipHost};transport=tls`;
    this.fromTag = randomHex(8);
    this.inviteBranch = `z9hG4bK-${randomHex()}`;
    this.callId = `${randomUUID()}@${this.localAddress}`;
    this.from = `"Node RTP demo" <sip:${this.callToken}@${this.localAddress}>;tag=${this.fromTag}`;
    this.initialTo = `<sip:${this.projectId}@${this.sipHost}>`;
    this.contact = `<sip:node-demo@${this.localAddress}:${this.localPort};transport=tls>`;
    this.advertisedRtpAddress ??= this.localAddress;
  }

  #baseHeaders(branch) {
    return {
      Via: `SIP/2.0/TLS ${this.localAddress}:${this.localPort};branch=${branch};rport;alias`,
      "Max-Forwards": "70",
      From: this.from,
      To: this.to ?? this.initialTo,
      "Call-ID": this.callId,
      Contact: this.contact,
      "User-Agent": USER_AGENT,
    };
  }

  async #invite() {
    this.localSrtpKeyMaterial = createSdesKeyMaterial();
    const sdp = createSdpOffer({
      address: this.advertisedRtpAddress,
      port: this.boundRtpPort,
      srtp: this.localSrtpKeyMaterial,
      preferOpus: this.preferOpus,
    });
    const headers = {
      ...this.#baseHeaders(this.inviteBranch),
      CSeq: "1 INVITE",
      Accept: "application/sdp",
      "Content-Type": "application/sdp",
    };
    const bytes = serializeSipRequest("INVITE", this.targetUri, headers, sdp);
    const isFinalInviteResponse = (message) => {
      const cseq = getCSeq(message);
      return message.kind === "response"
        && getHeader(message, "call-id") === this.callId
        && cseq?.number === 1
        && cseq.method === "INVITE"
        && message.status >= 200;
    };
    const responsePromise = this.#waitForMessage(
      isFinalInviteResponse,
      this.inviteTimeoutMs,
      "Timed out waiting for a final SIP INVITE response. Check the webhook and /accept logs.",
      (message) => {
        const cseq = getCSeq(message);
        if (message.kind === "response" && cseq?.method === "INVITE" && message.status < 200) {
          this.provisionalSeen = true;
          this.logger.log(`SIP ${message.status} ${message.reason}`.trim());
        }
      },
    );
    this.state = "inviting";
    this.#writeSipMessage(bytes);
    this.logger.log(
      `SRTP offer: ${this.advertisedRtpAddress}:${this.boundRtpPort} `
        + `(codec preference: ${this.preferOpus ? "unimplemented Opus PT 111, then PCMU PT 0" : "PCMU PT 0, then unimplemented Opus PT 111"}).`,
    );
    this.logger.log(`INVITE sent to ${this.targetUri}. Waiting for the signed webhook to accept it...`);
    try {
      return await responsePromise;
    } catch (error) {
      // Giving up on our side does not stop the server: without a CANCEL the webhook could
      // still accept the session and leave it running with no caller.
      if (error?.abandoned || error?.timedOut) await this.#cancelInvite(isFinalInviteResponse);
      throw error;
    }
  }

  async #cancelInvite(isFinalInviteResponse) {
    // A CANCEL is only valid once the server has answered the INVITE provisionally.
    if (!this.provisionalSeen || !this.socket || this.socket.destroyed) return;
    try {
      this.logger.log("Cancelling the pending INVITE...");
      const finalResponse = this.#waitForMessage(
        isFinalInviteResponse,
        CANCEL_WAIT_MS,
        "Timed out waiting for the cancelled SIP INVITE to end",
      ).catch((error) => {
        this.logger.warn(error.message);
      });
      this.#writeSipMessage(serializeSipRequest("CANCEL", this.targetUri, {
        ...this.#baseHeaders(this.inviteBranch),
        CSeq: "1 CANCEL",
      }));
      const response = await finalResponse;
      if (!response) return;
      if (response.status >= 300) {
        this.#sendFailureAck(response);
        return;
      }
      // The call was answered before the CANCEL took effect, so it has to be hung up instead.
      this.#establishDialog(response);
      this.#writeSipMessage(this.ackBytes);
      await this.#sendBye();
    } catch (error) {
      this.logger.warn(`Could not cancel the SIP INVITE: ${error instanceof Error ? error.message : error}`);
    }
  }

  #establishDialog(response) {
    this.to = getHeader(response, "to");
    if (!this.to || !/;\s*tag=/i.test(this.to)) {
      throw new Error("SIP 2xx response did not contain a To tag");
    }
    const contact = getHeader(response, "contact");
    if (!contact) throw new Error("SIP 2xx response did not contain a Contact header");
    this.remoteTarget = parseNameAddressUri(contact);
    this.routeSet = getHeaders(response, "record-route")
      .flatMap(splitHeaderValues)
      .reverse();
    const routed = routeDialogRequest(this.remoteTarget, this.routeSet);
    this.dialogRequestUri = routed.requestUri;
    this.dialogRoutes = routed.routes;
    this.ackBytes = serializeSipRequest("ACK", this.dialogRequestUri, {
      ...this.#baseHeaders(`z9hG4bK-${randomHex()}`),
      ...(this.dialogRoutes.length ? { Route: this.dialogRoutes } : {}),
      CSeq: "1 ACK",
    });
  }

  #sendFailureAck(response) {
    const to = getHeader(response, "to") ?? this.initialTo;
    const bytes = serializeSipRequest("ACK", this.targetUri, {
      ...this.#baseHeaders(this.inviteBranch),
      To: to,
      CSeq: "1 ACK",
    });
    this.#writeSipMessage(bytes);
  }

  #startRtp(media) {
    this.rtpSent = 0;
    this.rtpReceived = 0;
    this.incomingPayloadType = media.payloadType;
    this.outboundSrtp = new SrtpContext(this.localSrtpKeyMaterial);
    this.inboundSrtp = new SrtpContext(media.srtp);
    let sequence = randomBytes(2).readUInt16BE(0);
    let timestamp = randomUInt32();
    const ssrc = randomNonzeroUInt32();
    const nextPcmuFrame = createPcmuFrameSource(this.pcmuAudio);

    const sendPacket = () => {
      if (!this.rtpSocket) return;
      const plainPacket = createRtpPacket({
        sequence,
        timestamp,
        ssrc,
        payloadType: media.payloadType,
        marker: this.rtpSent === 0,
        payload: nextPcmuFrame(),
        samples: PCMU_FRAME_BYTES,
      });
      const packet = this.outboundSrtp.protectRtp(plainPacket);
      this.rtpSocket.send(packet, media.port, media.address);
      this.rtpSent += 1;
      sequence = (sequence + 1) & 0xffff;
      timestamp = (timestamp + PCMU_FRAME_BYTES) >>> 0;
    };

    this.logger.log(`SRTP destination from SDP: ${media.address}:${media.port} (PCMU PT ${media.payloadType}).`);
    sendPacket();
    this.rtpTimer = setInterval(sendPacket, PCMU_FRAME_DURATION_MS);
  }

  async #sendBye() {
    if (!this.remoteTarget || this.state === "terminating") return;
    this.state = "terminating";
    if (this.rtpTimer) clearInterval(this.rtpTimer);
    const branch = `z9hG4bK-${randomHex()}`;
    const bytes = serializeSipRequest("BYE", this.dialogRequestUri, {
      ...this.#baseHeaders(branch),
      ...(this.dialogRoutes.length ? { Route: this.dialogRoutes } : {}),
      CSeq: "2 BYE",
      Reason: 'SIP;cause=200;text="Demo complete"',
    });
    const responsePromise = this.#waitForMessage(
      (message) => {
        const cseq = getCSeq(message);
        return message.kind === "response"
          && getHeader(message, "call-id") === this.callId
          && cseq?.number === 2
          && cseq.method === "BYE"
          && message.status >= 200;
      },
      3_000,
      "Timed out waiting for SIP BYE response",
    ).catch((error) => {
      this.logger.warn(error.message);
    });
    this.#writeSipMessage(bytes);
    await responsePromise;
  }

  #writeSipMessage(bytes) {
    logSipMessage(this.logger, this.logSipMessages, "OUTBOUND", bytes);
    return this.socket.write(bytes);
  }

  #handleSipRequest(message) {
    if (message.method === "ACK") return;
    const respond = (status, reason) => {
      try {
        this.#writeSipMessage(serializeSipResponse(message, status, reason));
      } catch (error) {
        this.logger.warn(
          `Could not answer SIP ${message.method}: ${error instanceof Error ? error.message : error}`,
        );
      }
    };
    if (getHeader(message, "call-id") !== this.callId) {
      respond(481, "Call/Transaction Does Not Exist");
      return;
    }
    if (message.method === "BYE") {
      this.state = "terminating";
      respond(200, "OK");
      this.remoteEnded = true;
      if (this.rtpTimer) clearInterval(this.rtpTimer);
      this.resolveStop();
    } else if (message.method === "OPTIONS" || (message.method === "UPDATE" && message.body.length === 0)) {
      respond(200, "OK");
    } else if (message.method === "INVITE" || message.method === "UPDATE") {
      // Renegotiation is not implemented; refusing it leaves the current media session in place.
      respond(488, "Not Acceptable Here");
    } else {
      respond(501, "Not Implemented");
    }
  }

  #handleSipMessage(message) {
    if (message.kind === "request") {
      this.#handleSipRequest(message);
      return;
    }

    const cseq = getCSeq(message);
    if (
      this.state === "established"
      && message.kind === "response"
      && message.status >= 200
      && message.status < 300
      && cseq?.number === 1
      && cseq.method === "INVITE"
      && getHeader(message, "call-id") === this.callId
    ) {
      this.#writeSipMessage(this.ackBytes);
    }
    this.events.emit("message", message);
  }

  #waitForDurationOrStop() {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.durationMs);
      this.stopPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #fail(error) {
    this.fatalError ??= error;
    this.events.emit("fatal", error);
    this.resolveStop();
  }

  #waitForMessage(predicate, timeoutMs, timeoutMessage, observer = () => {}) {
    return new Promise((resolve, reject) => {
      const onMessage = (message) => {
        observer(message);
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      };
      const onFatal = (error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        const error = new Error(timeoutMessage);
        error.timedOut = true;
        reject(error);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off("message", onMessage);
        this.events.off("fatal", onFatal);
        this.events.off("abandon", onFatal);
      };
      this.events.on("message", onMessage);
      this.events.on("fatal", onFatal);
      this.events.on("abandon", onFatal);
    });
  }

  async #cleanup() {
    this.state = "closed";
    if (this.rtpTimer) clearInterval(this.rtpTimer);
    const recorder = this.incomingAudioRecorder;
    this.incomingAudioRecorder = undefined;
    this.incomingPayloadType = undefined;
    this.inboundSrtp = undefined;
    this.outboundSrtp = undefined;
    this.localSrtpKeyMaterial = undefined;
    if (this.rtpSocket) {
      try {
        this.rtpSocket.close();
      } catch {
        // The socket is already closed.
      }
      this.rtpSocket = undefined;
    }
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.events.removeAllListeners();
    if (recorder) {
      await recorder.close();
      this.logger.log(
        `Saved ${recorder.bytesWritten ?? 0} raw PCMU bytes to ${recorder.path ?? this.incomingAudioFile}.`,
      );
    }
  }
}
