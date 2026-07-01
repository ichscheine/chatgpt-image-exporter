let offscreenReady = false;
const DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/my/recent/image_gen?limit=25";

function normalizeEndpointToLimit(endpoint, limit) {
  const u = new URL(endpoint);
  u.searchParams.set("limit", String(limit));
  u.searchParams.delete("after");
  return u.toString();
}

async function fetchMetadataInTab(tabId, endpoint, headers, limit) {
  const url = normalizeEndpointToLimit(endpoint, limit);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [url, headers || null],
    func: async (endpointUrl, reqHeaders) => {
      const normalize = (h) => {
        const out = {};
        if (!h || typeof h !== "object") return out;
        for (const [k, v] of Object.entries(h)) {
          out[String(k).toLowerCase()] = String(v);
        }
        return out;
      };

      const getTokenFromSession = async () => {
        try {
          const r = await fetch("/api/auth/session", { credentials: "include" });
          if (!r.ok) return null;
          const j = await r.json().catch(() => null);
          return j?.accessToken || j?.access_token || null;
        } catch {
          return null;
        }
      };

      try {
        const hdrs = normalize(reqHeaders);
        if (!hdrs.authorization) {
          const token = await getTokenFromSession();
          if (token) hdrs.authorization = `Bearer ${token}`;
        }

        const res = await fetch(endpointUrl, {
          method: "GET",
          headers: Object.keys(hdrs).length ? hdrs : undefined,
          credentials: "include"
        });
        const text = await res.text();
        if (!res.ok) {
          return {
            ok: false,
            status: res.status,
            error: text || `HTTP ${res.status}`,
            headersUsed: hdrs
          };
        }
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          return { ok: false, status: 0, error: "Invalid JSON response.", headersUsed: hdrs };
        }
        return { ok: true, status: res.status, data, headersUsed: hdrs };
      } catch (e) {
        return { ok: false, status: 0, error: String(e), headersUsed: null };
      }
    }
  });

  return result?.result || { ok: false, status: 0, error: "No result from tab fetch." };
}

async function setState(patch) {
  const { state } = await chrome.storage.local.get(["state"]);
  const next = { ...(state || {}), ...patch };
  await chrome.storage.local.set({ state: next });
  chrome.runtime.sendMessage({ type: "STATE_UPDATE" }).catch(() => {});
}

async function getState() {
  const { state } = await chrome.storage.local.get(["state"]);
  return state || {};
}

async function clearSensitiveHeaders() {
  const state = await getState();
  if (!state.headers) return;
  const { headers, ...rest } = state;
  await chrome.storage.local.set({ state: rest });
  chrome.runtime.sendMessage({ type: "STATE_UPDATE" }).catch(() => {});
}

async function ensureOffscreen() {
  if (offscreenReady) return;
  const exists = await chrome.offscreen.hasDocument?.();
  if (!exists) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Fetch image blobs and trigger downloads reliably."
    });
  }
  offscreenReady = true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== "object") return;

    // From content/injected: endpoint discovery
    if (msg.type === "CGPT_IMG_ENDPOINT") {
      const st = await getState();
      const endpoint = msg.endpoint || st.endpoint;

      // Capture authorization if present (best case)
      // If not present, we still store endpoint and later re-capture from another call.
      let headers = msg.headers || st.headers || null;

      // Normalize + keep only safe/needed headers
      if (headers) {
        const keep = {};
        for (const k of ["authorization", "oai-client-version", "oai-client-build-number", "oai-device-id", "oai-language"]) {
          if (headers[k]) keep[k] = headers[k];
        }
        headers = Object.keys(keep).length ? keep : null;
      }

      await setState({ endpoint, headers });
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === "DETECT_ENDPOINT") {
      await setState({ running: false, authError: null });
      // Force reinject to ensure hooks are present
      await chrome.scripting.executeScript({
        target: { tabId: msg.tabId },
        files: ["content.js"]
      });
      // Give injected hooks a moment to report; then fall back to known endpoint.
      await new Promise((r) => setTimeout(r, 1400));
      const st = await getState();
      if (!st.endpoint) {
        await setState({ endpoint: DEFAULT_ENDPOINT });
      }
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === "START_EXPORT") {
      await ensureOffscreen();

      const st = await getState();
      if (!st.endpoint) {
        // Attempt to re-inject + wait a moment for endpoint capture
        await chrome.scripting.executeScript({
          target: { tabId: msg.tabId },
          files: ["content.js"]
        });
        // small delay
        await new Promise(r => setTimeout(r, 1200));
      }

      const st2 = await getState();
      if (!st2.endpoint) {
        await setState({ endpoint: DEFAULT_ENDPOINT });
      }
      const st3 = await getState();

      await setState({
        running: true,
        authError: null,
        progress: { current: 0, total: 0, ok: 0, fail: 0 },
        stopRequested: false
      });

      const limit = Number(msg.settings?.maxImages || 0) > 0 ? Number(msg.settings.maxImages) : 10000;
      const tabFetch = await fetchMetadataInTab(msg.tabId, st3.endpoint, st3.headers || null, limit);
      if (!tabFetch.ok) {
        await setState({
          running: false,
          headers: null,
          authError: `Metadata fetch failed (${tabFetch.status || "error"}). ${tabFetch.error || "Unknown error."}`
        });
        sendResponse?.({ ok: false, error: "Metadata fetch failed in tab context" });
        return;
      }

      if (tabFetch.headersUsed && typeof tabFetch.headersUsed === "object") {
        const mergedHeaders = { ...(st3.headers || {}), ...tabFetch.headersUsed };
        await setState({ headers: mergedHeaders });
      }
      const st4 = await getState();

      chrome.runtime.sendMessage({
        type: "OFFSCREEN_START",
        tabId: msg.tabId,
        settings: msg.settings,
        endpoint: st3.endpoint,
        headers: st4.headers || st3.headers || null,
        metadata: tabFetch.data
      });

      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === "STOP_EXPORT") {
      await setState({ stopRequested: true, running: false });
      await clearSensitiveHeaders();
      chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" }).catch(() => {});
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === "DOWNLOAD_URL") {
      try {
        const id = await chrome.downloads.download({
          url: msg.url,
          filename: msg.filename,
          conflictAction: msg.conflictAction || "uniquify",
          saveAs: !!msg.saveAs
        });
        sendResponse?.({ ok: true, id });
      } catch (e) {
        sendResponse?.({ ok: false, error: String(e) });
      }
      return;
    }

    // Progress updates from offscreen
    if (msg.type === "EXPORT_PROGRESS") {
      await setState({ progress: msg.progress });
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === "EXPORT_DONE") {
      await setState({ running: false, progress: msg.progress, lastRun: Date.now() });
      await clearSensitiveHeaders();
      sendResponse?.({ ok: true });
      return;
    }

    if (msg.type === "EXPORT_NEED_AUTH") {
      await setState({ running: false, authError: msg.error || "Missing/expired auth." });
      await clearSensitiveHeaders();
      sendResponse?.({ ok: true });
      return;
    }
  })();

  return true; // keep message channel alive
});
