// ---- Conversion utilities ----

function dbToRMS(db) {
  return Math.pow(10, db / 20);
}

function rmsToDb(rms) {
  if (rms <= 0) return -96;
  return 20 * Math.log10(rms);
}

function gainToDb(gain) {
  return 20 * Math.log10(gain);
}

function gainToBarPercent(gain) {
  // Log scale: gain 1.0 sits at 50%, range 0.1..6.0
  const logMin = Math.log(0.1);
  const logMax = Math.log(6.0);
  const logVal = Math.log(Math.max(0.1, Math.min(6.0, gain)));
  return ((logVal - logMin) / (logMax - logMin)) * 100;
}

// ---- Canvas setup ----

const canvas = document.getElementById("waveform-canvas");
const waveformWrap = document.getElementById("waveform-wrap");
const ctx = canvas.getContext("2d");
const CW = canvas.width;   // 228
const CH = canvas.height;  // 88

// Y axis: -48dBFS (bottom) to 0dBFS (top), linear in dB
const DB_MIN = -48;
const DB_MAX = 0;

function dbToY(db) {
  const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db));
  return CH - ((clamped - DB_MIN) / (DB_MAX - DB_MIN)) * CH;
}

const GRID_LINES = [-48, -36, -24, -12, 0];

// Colours matching CSS vars
const C_BG            = "#1a1a1a";
const C_GRID          = "#242424";
const C_GRID_TEXT     = "#444";
const C_WAVEFORM      = "rgba(200,240,96,0.25)";
const C_WAVEFORM_LINE = "rgba(200,240,96,0.55)";
const C_TARGET        = "rgba(200,240,96,0.3)";
const C_BAND          = "rgba(200,240,96,0.07)";
const C_BAND_EDGE     = "rgba(200,240,96,0.2)";
const C_GAIN_LINE     = "#c8f060";
const C_NULL          = "rgba(255,255,255,0.04)";

function drawWaveform(state) {
  ctx.clearRect(0, 0, CW, CH);

  // Background
  ctx.fillStyle = C_BG;
  ctx.fillRect(0, 0, CW, CH);

  // Grid lines
  ctx.font = "9px 'DM Mono', monospace";
  ctx.textAlign = "right";
  for (const db of GRID_LINES) {
    const y = dbToY(db);
    ctx.strokeStyle = C_GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(CW, y);
    ctx.stroke();
    ctx.fillStyle = C_GRID_TEXT;
    ctx.fillText(db === 0 ? "0" : db, CW - 3, y - 2);
  }

  const waveform = state.waveform || [];
  const N = waveform.length;
  const colW = CW / N;

  // Paused gap shading
  for (let i = 0; i < N; i++) {
    if (waveform[i] === null) {
      ctx.fillStyle = C_NULL;
      ctx.fillRect(i * colW, 0, colW, CH);
    }
  }

  // Target level line (dashed)
  if (state.targetRMS) {
    const targetDb = rmsToDb(state.targetRMS);
    const ty = dbToY(targetDb);
    ctx.strokeStyle = C_TARGET;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(0, ty);
    ctx.lineTo(CW, ty);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Adjustment band -- shows permitted gain range from confidence schedule
  if (state.gainLimits && state.targetRMS) {
    const targetDb = rmsToDb(state.targetRMS);
    const cutDB    = gainToDb(1 / state.gainLimits.min);
    const boostDB  = gainToDb(state.gainLimits.max);
    const bandTop  = dbToY(targetDb + boostDB);
    const bandBot  = dbToY(targetDb - cutDB);

    ctx.fillStyle = C_BAND;
    ctx.fillRect(0, bandTop, CW, bandBot - bandTop);

    ctx.strokeStyle = C_BAND_EDGE;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(0, bandTop); ctx.lineTo(CW, bandTop);
    ctx.moveTo(0, bandBot); ctx.lineTo(CW, bandBot);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Waveform filled envelope
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < N; i++) {
    if (waveform[i] === null) { started = false; continue; }
    const db = rmsToDb(waveform[i]);
    const x = i * colW;
    const y = dbToY(db);
    if (!started) {
      ctx.moveTo(x, CH);
      ctx.lineTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.lineTo((N - 1) * colW, CH);
  ctx.closePath();
  ctx.fillStyle = C_WAVEFORM;
  ctx.fill();

  // Waveform top line
  ctx.beginPath();
  started = false;
  for (let i = 0; i < N; i++) {
    if (waveform[i] === null) { started = false; continue; }
    const db = rmsToDb(waveform[i]);
    const x = i * colW + colW / 2;
    const y = dbToY(db);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = C_WAVEFORM_LINE;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Gain line -- effective source level the extension is calibrated to
  if (state.gain && state.targetRMS) {
    const effectiveSourceDb = rmsToDb(state.targetRMS / state.gain);
    const gy = dbToY(effectiveSourceDb);
    ctx.strokeStyle = C_GAIN_LINE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(CW, gy);
    ctx.stroke();

    ctx.fillStyle = C_GAIN_LINE;
    ctx.font = "bold 9px 'DM Mono', monospace";
    ctx.textAlign = "right";
    const gainDb = gainToDb(state.gain);
    ctx.fillText(`${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)}dB`, CW - 3, gy - 3);
  }
}

// ---- DOM elements ----

const toggleEl      = document.getElementById("enabled-toggle");
const toggleLabel   = document.getElementById("toggle-label");
const gainDisplay   = document.getElementById("gain-display");
const gainBar       = document.getElementById("gain-bar");
const statusDot     = document.getElementById("status-dot");
const statusText    = document.getElementById("status-text");
const confidenceBar = document.getElementById("confidence-bar");
const confidencePct = document.getElementById("confidence-pct");
const targetSlider  = document.getElementById("target-slider");
const targetVal     = document.getElementById("target-val");
const remeasureBtn  = document.getElementById("remeasure-btn");

// ---- Confidence ----

const LOCK_TC = 30000; // must match content.js

function elapsedToConfidence(elapsed) {
  return Math.min(100, (elapsed / LOCK_TC) * 100);
}

// ---- Load saved settings ----

browser.storage.local.get(["enabled", "targetDB"]).then(result => {
  const enabled  = result.enabled !== false;
  const targetDB = result.targetDB !== undefined ? result.targetDB : -22;

  toggleEl.checked = enabled;
  toggleLabel.textContent = enabled ? "ON" : "OFF";
  document.body.classList.toggle("disabled", !enabled);

  targetSlider.value = targetDB;
  targetVal.textContent = `${targetDB} dBFS`;
});

// ---- Poll content script ----

function pollState() {
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (!tabs[0]) return;
    browser.tabs.sendMessage(tabs[0].id, { type: "getState" }).then(state => {
      if (!state) return;

      const gainDb = gainToDb(state.gain);
      gainDisplay.textContent = state.gain.toFixed(2);
      // Restore the unit span safely
      const unitSpan = document.createElement("span");
      unitSpan.className = "unit";
      unitSpan.textContent = "x";
      gainDisplay.appendChild(unitSpan);
      gainBar.style.width = gainToBarPercent(state.gain) + "%";

      waveformWrap.classList.toggle("paused", !!state.paused);

      if (!state.enabled) {
        statusDot.className = "status-dot off";
        statusText.textContent = "disabled";
        confidenceBar.className = "confidence-bar-fill";
        confidenceBar.style.width = "0%";
        confidencePct.textContent = "—";
      } else if (state.locked) {
        statusDot.className = "status-dot locked";
        statusText.textContent = `locked · ${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)} dB`;
        confidenceBar.className = "confidence-bar-fill locked";
        confidencePct.textContent = "locked";
      } else {
        const pct = elapsedToConfidence(state.elapsed);
        statusDot.className = "status-dot measuring";
        statusText.textContent = "measuring…";
        confidenceBar.className = "confidence-bar-fill";
        confidenceBar.style.width = pct + "%";
        confidencePct.textContent = Math.round(pct) + "%";
      }

      drawWaveform(state);

    }).catch(err => {
      console.log("[YT Levelr popup] sendMessage failed:", err);
      statusDot.className = "status-dot off";
      statusText.textContent = "not on a YouTube video";
      confidenceBar.className = "confidence-bar-fill";
      confidenceBar.style.width = "0%";
      confidencePct.textContent = "—";
      waveformWrap.classList.remove("paused");
      drawWaveform({ waveform: new Array(100).fill(null) });
    });
  });
}

pollState();
setInterval(pollState, 800);

// ---- Controls ----

toggleEl.addEventListener("change", () => {
  const enabled = toggleEl.checked;
  toggleLabel.textContent = enabled ? "ON" : "OFF";
  document.body.classList.toggle("disabled", !enabled);
  browser.storage.local.set({ enabled });
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (tabs[0]) browser.tabs.sendMessage(tabs[0].id, { type: "setEnabled", value: enabled });
  });
});

targetSlider.addEventListener("input", () => {
  const db = parseInt(targetSlider.value);
  targetVal.textContent = `${db} dBFS`;
  const rms = dbToRMS(db);
  browser.storage.local.set({ targetDB: db });
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (tabs[0]) browser.tabs.sendMessage(tabs[0].id, { type: "setTarget", value: rms });
  });
});

remeasureBtn.addEventListener("click", () => {
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (tabs[0]) browser.tabs.sendMessage(tabs[0].id, { type: "remeasure" });
  });
  statusDot.className = "status-dot measuring";
  statusText.textContent = "measuring…";
  confidenceBar.className = "confidence-bar-fill";
  confidenceBar.style.width = "0%";
  confidencePct.textContent = "—";
});
