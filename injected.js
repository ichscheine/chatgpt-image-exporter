(() => {
  if (window.__CGPT_IMG_EXPORTER_INJECTED__) {
    return;
  }
  window.__CGPT_IMG_EXPORTER_INJECTED__ = true;

  const SOURCE = "CGPT_IMAGE_EXPORTER";
  const token = document.currentScript?.dataset?.cgptImageExporterToken || "";

  const isLikelyImagesList = (url) => {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.origin === "https://chatgpt.com" &&
        parsed.pathname === "/backend-api/my/recent/image_gen";
    } catch {
      return false;
    }
  };

  const normalizeHeaders = (h) => {
    try {
      if (!h) return null;
      if (h instanceof Headers) {
        const o = {};
        h.forEach((v, k) => o[k.toLowerCase()] = v);
        return o;
      }
      if (typeof h === "object") {
        const o = {};
        for (const [k, v] of Object.entries(h)) o[String(k).toLowerCase()] = String(v);
        return o;
      }
      return null;
    } catch {
      return null;
    }
  };

  const post = (endpoint, headers) => {
    window.postMessage({
      source: SOURCE,
      token,
      type: "CGPT_IMG_ENDPOINT",
      endpoint,
      headers
    }, window.location.origin);
  };

  // Patch fetch
  if (!window.__CGPT_IMG_EXPORTER_FETCH_PATCHED__) {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : (input?.url || "");
        if (isLikelyImagesList(url)) {
          const headers = normalizeHeaders(init?.headers);
          post(url, headers);
        }
      } catch {}
      return origFetch.apply(this, arguments);
    };
    window.__CGPT_IMG_EXPORTER_FETCH_PATCHED__ = true;
  }

  if (!XMLHttpRequest.prototype.__CGPT_IMG_EXPORTER_OPEN_PATCHED__) {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (isLikelyImagesList(url)) {
          // XHR headers are set later via setRequestHeader; hard to capture here
          post(url, null);
        }
      } catch {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.__CGPT_IMG_EXPORTER_OPEN_PATCHED__ = true;
  }

  if (!window.__CGPT_IMG_EXPORTER_CANONICAL_POSTED__) {
    setTimeout(() => {
      post("https://chatgpt.com/backend-api/my/recent/image_gen?limit=25", null);
      window.__CGPT_IMG_EXPORTER_CANONICAL_POSTED__ = true;
    }, 1200);
  }
})();
