import { migrateSettings, SETTINGS_VERSION } from "./export-range.mjs";

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  folder: "ChatGPT_Images",
  maxImages: 0,
  startIndex: 0,
  delayMs: 900,
  jitterMs: 300,
  retries: 3,
  downloadMetadata: false,
  settingsVersion: SETTINGS_VERSION
};

async function loadSettings() {
  const { settings } = await chrome.storage.local.get(["settings"]);
  const migrated = migrateSettings(settings, DEFAULTS);
  if (!settings || settings.settingsVersion !== migrated.settingsVersion) {
    await saveSettings(migrated);
  }
  return migrated;
}

async function saveSettings(s) {
  await chrome.storage.local.set({ settings: s });
}

async function getState() {
  const { state } = await chrome.storage.local.get(["state"]);
  return state || {};
}

function applyToUI(s) {
  $("folder").value = s.folder;
  $("maxImages").value = s.maxImages;
  $("startIndex").value = s.startIndex;
  $("downloadMetadata").checked = !!s.downloadMetadata;
}

function readFromUI() {
  return {
    folder: $("folder").value.trim() || DEFAULTS.folder,
    maxImages: parseInt($("maxImages").value || "0", 10),
    startIndex: parseInt($("startIndex").value || "0", 10),
    delayMs: DEFAULTS.delayMs,
    jitterMs: DEFAULTS.jitterMs,
    retries: DEFAULTS.retries,
    downloadMetadata: $("downloadMetadata").checked,
    settingsVersion: SETTINGS_VERSION
  };
}

function setStatusText(t) { $("statusText").textContent = t; }

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "--";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function refreshStatus() {
  const st = await getState();
  $("progressText").textContent = `${st.progress?.current || 0} / ${st.progress?.total || 0}`;
  $("estimatedTimeText").textContent = formatDuration(st.progress?.estimatedTotalMs);
  $("remainingTimeText").textContent = formatDuration(st.progress?.remainingMs);
  $("okText").textContent = st.progress?.ok || 0;
  $("failText").textContent = st.progress?.fail || 0;

  if (st.running) {
    if (st.phase === "indexing") {
      const scanned = st.indexProgress?.scanned || 0;
      const selected = st.indexProgress?.selected || 0;
      setStatusText(`Indexing library… ${scanned} scanned, ${selected} selected`);
    } else {
      setStatusText("Building ZIP");
    }
  } else if (st.authError) {
    setStatusText(st.authError);
  } else {
    setStatusText("Idle");
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "STATE_UPDATE") {
    refreshStatus();
  }
});

async function ensureImagesTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://chatgpt.com/images")) {
    setStatusText("Open https://chatgpt.com/images first.");
    throw new Error("Not on chatgpt.com/images");
  }
  return tab;
}

$("btnStart").addEventListener("click", async () => {
  try {
    const tab = await ensureImagesTab();
    const s = readFromUI();
    await saveSettings(s);

    setStatusText("Preparing…");
    await chrome.runtime.sendMessage({ type: "DETECT_ENDPOINT", tabId: tab.id });
    await refreshStatus();

    setStatusText("Starting…");
    const res = await chrome.runtime.sendMessage({ type: "START_EXPORT", tabId: tab.id, settings: s });
    if (!res?.ok) {
      throw new Error(res?.error || "Start request failed.");
    }
    await refreshStatus();
  } catch (e) {
    const message = e?.message || String(e);
    setStatusText(`Start failed: ${message}`);
    console.error("Start failed:", e);
  }
});

$("btnStop").addEventListener("click", async () => {
  setStatusText("Stopping…");
  await chrome.runtime.sendMessage({ type: "STOP_EXPORT" });
  await refreshStatus();
});

(async () => {
  const s = await loadSettings();
  applyToUI(s);
  await refreshStatus();
})();
