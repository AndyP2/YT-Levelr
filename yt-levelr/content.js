/**
 * YT Levelr - content.js
 *
 * Strategy:
 * - On each new video, take a provisional gain reading after 5s
 * - Continue refining with a slow time constant for up to 30s, then effectively lock
 * - After locking, apply a very slow drift correction (minutes-long time constant)
 *   to handle outliers like loud intros followed by quiet speech
 * - Samples below a noise floor threshold are ignored to avoid silence skewing measurement
 */

const TARGET_RMS = 0.08;        // Target RMS amplitude (~-22 dBFS, comfortable speech level)
const NOISE_FLOOR = 0.005;      // Ignore samples quieter than this (silence / room noise)
const MAX_GAIN = 6.0;           // Never boost more than ~15dB to avoid amplifying noise
const MIN_GAIN = 0.1;           // Never cut more than ~20dB

const FAST_TC = 5000;           // ms - provisional measurement window
const LOCK_TC = 30000;          // ms - refine and lock within this window
const DRIFT_TC = 3 * 60 * 1000; // ms - very slow drift correction after lock

let audioCtx = null;
let sourceNode = null;
let gainNode = null;
let analyserNode = null;
let compressorNode = null;

let measurementSamples = [];
let videoStartTime = null;
let locked = false;
let currentGain = 1.0;
let animFrameId = null;
let lastDriftCorrection = null;

let enabled = true;

// Load enabled state from storage
browser.storage.local.get("enabled").then(result => {
  enabled = result.enabled !== false; // default true
});

// Listen for messages from popup
browser.runtime.onMessage.addListener((msg) => {
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
    return Promise.resolve({
      enabled,
      gain: currentGain,
      locked,
      targetRMS: state.targetRMS
    });
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
  videoStartTime = Date.now();
  locked = false;
  lastDriftCorrection = null;
  log("Measurement reset");
}

function applyGain(g) {
  currentGain = Math.max(MIN_GAIN, Math.min(MAX_GAIN, g));
  if (gainNode && enabled) {
    gainNode.gain.setTargetAtTime(currentGain, audioCtx.currentTime, 0.3);
  }
  // Notify popup if open
  try {
    browser.runtime.sendMessage({ type: "gainUpdate", gain: currentGain, locked });
  } catch(e) {}
}

function measurementLoop() {
  animFrameId = requestAnimationFrame(measurementLoop);

  if (!analyserNode || !enabled) return;

  const rms = getRMS();
  const elapsed = Date.now() - videoStartTime;

  // Skip silence
  if (rms < NOISE_FLOOR) return;

  if (!locked) {
    measurementSamples.push(rms);

    // Provisional correction after FAST_TC
    if (elapsed >= FAST_TC && measurementSamples.length > 10) {
      const medianRMS = median(measurementSamples);
      const targetGain = state.targetRMS / medianRMS;
      applyGain(targetGain);
      log(`Provisional gain: ${currentGain.toFixed(3)} (median RMS: ${medianRMS.toFixed(4)})`);
    }

    // Lock after LOCK_TC
    if (elapsed >= LOCK_TC) {
      locked = true;
      lastDriftCorrection = Date.now();
      const medianRMS = median(measurementSamples);
      const targetGain = state.targetRMS / medianRMS;
      applyGain(targetGain);
      log(`Locked gain: ${currentGain.toFixed(3)}`);
      measurementSamples = [];
    }
  } else {
    // Slow drift correction after lock
    const timeSinceDrift = Date.now() - lastDriftCorrection;
    if (timeSinceDrift >= DRIFT_TC) {
      // Collect a fresh short sample window for drift check
      measurementSamples.push(rms);
      if (measurementSamples.length >= 60) {
        const medianRMS = median(measurementSamples);
        const targetGain = state.targetRMS / medianRMS;
        // Blend slowly toward new target (10% correction)
        const correctedGain = currentGain + (targetGain - currentGain) * 0.1;
        applyGain(correctedGain);
        log(`Drift correction: ${currentGain.toFixed(3)}`);
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
    if (animFrameId) cancelAnimationFrame(animFrameId);
    measurementLoop();
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
