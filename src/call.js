import { SipCall } from "./sip-call.js";
import { booleanFromEnvironment } from "./environment.js";
import { loadPcmuAudio, PCMU_BYTES_PER_SECOND } from "./pcmu-audio.js";
import { incomingAudioFileFromConfig } from "./pcmu-recording.js";

function numberFromEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

try {
  const incomingAudioFile = incomingAudioFileFromConfig(
    booleanFromEnvironment("RECORD_INCOMING_AUDIO"),
    process.env.INCOMING_AUDIO_FILE,
  );
  const pcmuAudioPath = process.env.PCMU_AUDIO_FILE || undefined;
  const pcmuAudio = await loadPcmuAudio(pcmuAudioPath);
  if (pcmuAudioPath) {
    console.log(
      `Loaded ${pcmuAudio.length} raw PCMU bytes from ${pcmuAudioPath} `
        + `(${(pcmuAudio.length / PCMU_BYTES_PER_SECOND).toFixed(3)}s).`,
    );
  }
  const call = new SipCall({
    projectId: process.env.OPENAI_PROJECT_ID,
    callToken: process.env.SIP_CALL_TOKEN,
    sipHost: process.env.SIP_HOST || "sip.api.openai.com",
    sipPort: numberFromEnvironment("SIP_PORT", 5061),
    rtpPort: numberFromEnvironment("RTP_PORT", 0),
    advertisedRtpAddress: process.env.RTP_ADVERTISED_IP || undefined,
    durationSeconds: numberFromEnvironment("CALL_DURATION_SECONDS", 30),
    logSipMessages: booleanFromEnvironment("LOG_SIP_MESSAGES"),
    preferOpus: booleanFromEnvironment("PREFER_OPUS"),
    pcmuAudio,
    incomingAudioFile,
  });
  process.once("SIGINT", () => {
    console.log("Stopping the call...");
    call.stop();
  });
  await call.run();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
