/**
 * YT Levelr - content.js
 *
 * Strategy:
 * - Gain limits widen over time as confidence in the measurement grows
 * - Cuts are permitted more aggressively than boosts at all stages (asymmetric)
 *   because a sudden loud blast is worse than staying quiet for a few seconds
 * - Gain transitions are faster for cuts than for boosts (asymmetric attack/release)
 * - After 30s the gain locks; a slow drift correction every 3 minutes handles
 *   any remaining long-term level shift
 * - Samples below the noise floor are ignored to avoid silence skewing the median
 *
 * Confidence schedule (elapsed => max cut / max boost):
 *   0s:     -6dB / +3dB  (immediate, low confidence)
 *   10s:    -12dB / +6dB
 *   30s+:   -20dB / +15dB (full range, locked)
 */

const TARGET_RMS = 0.08;        // Target RMS (~-22 dBFS, comfortable speech level)
const NOISE_FLOOR = 0.005;      // Ignore samples quieter than this
const MAX_GAIN = 5.62;          // +15dB absolute ceiling
const MIN_GAIN = 0.1;           // -20dB absolute floor

const LOCK_TC  = 30000;         // ms - full confidence, lock gain
const DRIFT_TC = 3 * 60 * 1000; // ms - slow drift correction period after lock

// At each elapsed ms threshold, permitted range widens.
// First entry applies from t=0, so there is no dead period.
const CONFIDENCE_SCHEDULE = [
  { at: 0,     maxCutDB: 6,  maxBoostDB: 3  },
  { at: 10000, maxCutDB: 12, maxBoostDB: 6  },
  { at: 30000, maxCutDB: 20, maxBoostDB: 15 },
];

// GainNode transition time constants (seconds)
// Cuts apply faster than boosts to protect against sudden loud audio
const TC_CUT   = 0.15;
const TC_BOOST = 1.2;

let audioCtx = null;
let sourceNode = null;
let gainNode = null;
let analyserNode = null;
let compressorNode = null;

// Ring buffer for waveform display -- last 100 samples (~30s at 300ms interval)
const WAVEFORM_SIZE = 100;
const waveformHistory = new Array(WAVEFORM_SIZE).fill(null);
let waveformHead = 0;

let measurementSamples = [];
let playingMs = 0;        // cumulative ms of actual playback (excludes paused time)
let lastTickTime = null;  // wall clock at last tick, for incrementing playingMs
let locked = false;
let currentGain = 1.0;
let intervalId = null;    // setInterval handle for measurementLoop
let lastDriftCorrection = null;

let enabled = true;

// Load enabled state from storage
browser.storage.local.get("enabled").then(result => {
  enabled = result.enabled !== false; // default true
});

// Listen for messages from popup
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "setEnabled") {
    enabled = msg.value;
    if (gainNode) {
      gainNode.gain.setTargetAtTime(enabled ? currentGain : 1.0, audioCtx.currentTime, 0.1);
    }
  }
  if (msg.type === "setTarget") {
    // TARGET_RMS is const but we can work around this via a mutable wrapper
    state.targetRMS = msg.value;
  }
  if (msg.type === "remeasure") {
    resetMeasurement();
  }
  if (msg.type === "getState") {
    // Unroll ring buffer into chronological order
    const waveform = [];
    for (let i = 0; i < WAVEFORM_SIZE; i++) {
      waveform.push(waveformHistory[(waveformHead + i) % WAVEFORM_SIZE]);
    }
    const limits = gainLimitsForElapsed(locked ? LOCK_TC : playingMs);
    sendResponse({
      enabled,
      gain: currentGain,
      locked,
      targetRMS: state.targetRMS,
      elapsed: playingMs,
      waveform,
      gainLimits: limits,
      paused: videoEl ? videoEl.paused : true
    });
    return true; // keeps the message channel open for sendResponse
  }
});

// Mutable state that the popup can adjust
const state = {
  targetRMS: TARGET_RMS
};

function log(msg) {
  console.debug("[YT Levelr]", msg);
}

function setupAudioGraph(videoEl) {
  if (audioCtx) {
    try { audioCtx.close(); } catch(e) {}
  }

  audioCtx = new AudioContext();

  // AudioContext may start suspended if created before a user gesture.
  // resume() is a no-op if already running, so safe to call unconditionally.
  audioCtx.resume().catch(() => {});

  sourceNode = audioCtx.createMediaElementSource(videoEl);

  // Gentle compressor to tame transient peaks before gain adjustment
  compressorNode = audioCtx.createDynamicsCompressor();
  compressorNode.threshold.value = -18;  // dB
  compressorNode.knee.value = 10;
  compressorNode.ratio.value = 3;
  compressorNode.attack.value = 0.05;
  compressorNode.release.value = 0.3;

  gainNode = audioCtx.createGain();
  gainNode.gain.value = enabled ? currentGain : 1.0;

  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 2048;
  analyserNode.smoothingTimeConstant = 0.8;

  // Graph: source -> compressor -> gain -> analyser -> destination
  sourceNode.connect(compressorNode);
  compressorNode.connect(gainNode);
  gainNode.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);

  log("Audio graph connected");
}

function getRMS() {
  if (!analyserNode) return 0;
  const buf = new Float32Array(analyserNode.fftSize);
  analyserNode.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum += buf[i] * buf[i];
  }
  return Math.sqrt(sum / buf.length);
}

function resetMeasurement() {
  measurementSamples = [];
  playingMs = 0;
  lastTickTime = null;
  locked = false;
  lastDriftCorrection = null;
  waveformHistory.fill(null);
  waveformHead = 0;
  log("Measurement reset");
}

// Returns the permitted [minGain, maxGain] for the current elapsed time
function gainLimitsForElapsed(elapsed) {
  let maxCutDB = 0;
  let maxBoostDB = 0;
  for (const step of CONFIDENCE_SCHEDULE) {
    if (elapsed >= step.at) {
      maxCutDB   = step.maxCutDB;
      maxBoostDB = step.maxBoostDB;
    }
  }
  return {
    min: Math.pow(10, -maxCutDB  / 20),  // e.g. -6dB -> 0.501
    max: Math.pow(10,  maxBoostDB / 20),  // e.g. +3dB -> 1.413
  };
}

function applyGain(g, elapsed) {
  const limits = gainLimitsForElapsed(elapsed !== undefined ? elapsed : LOCK_TC);
  const clamped = Math.max(
    Math.max(MIN_GAIN, limits.min),
    Math.min(Math.min(MAX_GAIN, limits.max), g)
  );

  const isCut = clamped < currentGain;
  const tc = isCut ? TC_CUT : TC_BOOST;

  currentGain = clamped;
  if (gainNode && enabled) {
    gainNode.gain.setTargetAtTime(currentGain, audioCtx.currentTime, tc);
  }
  try {
    browser.runtime.sendMessage({ type: "gainUpdate", gain: currentGain, locked });
  } catch(e) {}
}

function measurementLoop() {
  if (!analyserNode || !enabled) return;

  // Resume AudioContext if it was suspended (e.g. browser autoplay policy)
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
    return;
  }

  const now = Date.now();

  // Accumulate playing time only while the video is actually running
  if (videoEl && !videoEl.paused && !videoEl.ended) {
    if (lastTickTime !== null) {
      playingMs += now - lastTickTime;
    }
    lastTickTime = now;
  } else {
    // Paused -- push a null sample so the waveform shows the gap, then stop
    waveformHistory[waveformHead] = null;
    waveformHead = (waveformHead + 1) % WAVEFORM_SIZE;
    lastTickTime = null;
    return;
  }

  const rms = getRMS();

  // Always record to waveform history regardless of noise floor
  waveformHistory[waveformHead] = rms;
  waveformHead = (waveformHead + 1) % WAVEFORM_SIZE;

  // Skip silence
  if (rms < NOISE_FLOOR) return;

  if (!locked) {
    measurementSamples.push(rms);

    // Apply gain on every tick from the first sample onward.
    // The confidence schedule limits how far we can move at each stage,
    // so early corrections are necessarily modest.
    if (measurementSamples.length > 3) {
      const medianRMS = median(measurementSamples);
      const targetGain = state.targetRMS / medianRMS;
      applyGain(targetGain, playingMs);
      log(`Gain update at ${(playingMs/1000).toFixed(1)}s playing: ${currentGain.toFixed(3)}x (median RMS: ${medianRMS.toFixed(4)})`);
    }

    // Lock at 30s of actual playback
    if (playingMs >= LOCK_TC) {
      locked = true;
      lastDriftCorrection = Date.now();
      log(`Locked at gain: ${currentGain.toFixed(3)}x`);
      measurementSamples = [];
    }
  } else {
    // Slow drift correction after lock
    const timeSinceDrift = Date.now() - lastDriftCorrection;
    if (timeSinceDrift >= DRIFT_TC) {
      measurementSamples.push(rms);
      if (measurementSamples.length >= 60) {
        const medianRMS = median(measurementSamples);
        const targetGain = state.targetRMS / medianRMS;
        // Blend 10% toward new target, with full gain range permitted
        const correctedGain = currentGain + (targetGain - currentGain) * 0.1;
        applyGain(correctedGain);
        log(`Drift correction: ${currentGain.toFixed(3)}x`);
        measurementSamples = [];
        lastDriftCorrection = Date.now();
      }
    }
  }
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- YouTube navigation detection ---

let currentUrl = location.href;
let videoEl = null;

function onNewVideo() {
  log(`New video detected: ${location.href}`);
  currentGain = 1.0;
  resetMeasurement();

  // Wait for video element to appear
  waitForVideo().then(el => {
    if (videoEl !== el) {
      videoEl = el;
      setupAudioGraph(videoEl);
    }
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(measurementLoop, 300);
  });
}

function waitForVideo() {
  return new Promise(resolve => {
    const check = () => {
      const el = document.querySelector("video");
      if (el) return resolve(el);
      setTimeout(check, 200);
    };
    check();
  });
}

// YouTube fires this on SPA navigation
window.addEventListener("yt-navigate-finish", () => {
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    onNewVideo();
  }
});

// Also handle initial page load if already on a watch page
if (location.pathname === "/watch") {
  onNewVideo();
}
