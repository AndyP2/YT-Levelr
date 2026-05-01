// dBFS <-> RMS conversion
// RMS = 10^(dBFS/20)  (treating full scale as RMS 1.0)
function dbToRMS(db) {
  return Math.pow(10, db / 20);
}

function gainToBarPercent(gain) {
  // Map gain range [0.1 .. 6.0] to [0 .. 100]
  // Use log scale so 1.0 sits at 50%
  const logMin = Math.log(0.1);
  const logMax = Math.log(6.0);
  const logVal = Math.log(Math.max(0.1, Math.min(6.0, gain)));
  return ((logVal - logMin) / (logMax - logMin)) * 100;
}

function gainToDb(gain) {
  return 20 * Math.log10(gain);
}

const toggleEl = document.getElementById("enabled-toggle");
const toggleLabel = document.getElementById("toggle-label");
const gainDisplay = document.getElementById("gain-display");
const gainBar = document.getElementById("gain-bar");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const confidenceBar = document.getElementById("confidence-bar");
const confidencePct = document.getElementById("confidence-pct");
const targetSlider = document.getElementById("target-slider");
const targetVal = document.getElementById("target-val");
const remeasureBtn = document.getElementById("remeasure-btn");

// Confidence ramps from 0 at t=0 to 100 at LOCK_TC (30s)
const LOCK_TC = 30000;

function elapsedToConfidence(elapsed) {
  return Math.min(100, (elapsed / LOCK_TC) * 100);
}

// Load saved settings
browser.storage.local.get(["enabled", "targetDB"]).then(result => {
  const enabled = result.enabled !== false;
  const targetDB = result.targetDB !== undefined ? result.targetDB : -22;

  toggleEl.checked = enabled;
  toggleLabel.textContent = enabled ? "ON" : "OFF";
  document.body.classList.toggle("disabled", !enabled);

  targetSlider.value = targetDB;
  targetVal.textContent = `${targetDB} dBFS`;
});

// Poll content script for state
function pollState() {
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (!tabs[0]) return;
    browser.tabs.sendMessage(tabs[0].id, { type: "getState" }).then(state => {
      if (!state) return;

      const gainDb = gainToDb(state.gain);
      gainDisplay.innerHTML = `${state.gain.toFixed(2)}<span class="unit">x</span>`;
      gainBar.style.width = gainToBarPercent(state.gain) + "%";

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
    }).catch(() => {
      statusDot.className = "status-dot off";
      statusText.textContent = "not on a YouTube video";
      confidenceBar.className = "confidence-bar-fill";
      confidenceBar.style.width = "0%";
      confidencePct.textContent = "—";
    });
  });
}

pollState();
setInterval(pollState, 800);

// Toggle
toggleEl.addEventListener("change", () => {
  const enabled = toggleEl.checked;
  toggleLabel.textContent = enabled ? "ON" : "OFF";
  document.body.classList.toggle("disabled", !enabled);
  browser.storage.local.set({ enabled });
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (tabs[0]) browser.tabs.sendMessage(tabs[0].id, { type: "setEnabled", value: enabled });
  });
});

// Target slider
targetSlider.addEventListener("input", () => {
  const db = parseInt(targetSlider.value);
  targetVal.textContent = `${db} dBFS`;
  const rms = dbToRMS(db);
  browser.storage.local.set({ targetDB: db });
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (tabs[0]) browser.tabs.sendMessage(tabs[0].id, { type: "setTarget", value: rms });
  });
});

// Remeasure
remeasureBtn.addEventListener("click", () => {
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (tabs[0]) browser.tabs.sendMessage(tabs[0].id, { type: "remeasure" });
  });
  statusDot.className = "status-dot measuring";
  statusText.textContent = "sampling…";
  confidenceBar.className = "confidence-bar-fill";
  confidenceBar.style.width = "0%";
  confidencePct.textContent = "—";
});
