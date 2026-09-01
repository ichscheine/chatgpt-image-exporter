(() => {
  if (window.__CGPT_IMG_EXPORTER_CONTENT_LOADED__) {
    return;
  }
  window.__CGPT_IMG_EXPORTER_CONTENT_LOADED__ = true;

  const SOURCE = "CGPT_IMAGE_EXPORTER";
  const token = crypto.randomUUID();

  function normalizeMetadataEndpoint(value) {
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== "https://chatgpt.com" || url.pathname !== "/backend-api/my/recent/image_gen") {
        return null;
      }
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }

  function inject() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("injected.js");
    s.dataset.cgptImageExporterToken = token;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  inject();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.source !== SOURCE || msg.token !== token) return;

    if (msg.type === "CGPT_IMG_ENDPOINT") {
      try {
        if (!chrome?.runtime?.id) return;
        const endpoint = normalizeMetadataEndpoint(msg.endpoint);
        if (!endpoint) return;
        const maybePromise = chrome.runtime.sendMessage({
          type: "CGPT_IMG_ENDPOINT",
          endpoint,
          headers: msg.headers || null
        });
        if (maybePromise?.catch) {
          maybePromise.catch(() => {});
        }
      } catch {}
    }
  });
})();
