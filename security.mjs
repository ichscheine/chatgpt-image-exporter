export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const DEFAULT_METADATA_ENDPOINT = `${CHATGPT_ORIGIN}/backend-api/my/recent/image_gen?limit=25`;

const ALLOWED_METADATA_PATH = "/backend-api/my/recent/image_gen";
const ALLOWED_REQUEST_HEADERS = new Set([
  "authorization",
  "oai-client-version",
  "oai-client-build-number",
  "oai-device-id",
  "oai-language"
]);

export function normalizeMetadataEndpoint(value) {
  try {
    const url = new URL(String(value || ""), CHATGPT_ORIGIN);
    if (url.origin !== CHATGPT_ORIGIN || url.pathname !== ALLOWED_METADATA_PATH) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function filterChatGptHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;

  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = String(key).toLowerCase();
    if (ALLOWED_REQUEST_HEADERS.has(normalizedKey) && value !== undefined && value !== null) {
      filtered[normalizedKey] = String(value);
    }
  }
  return Object.keys(filtered).length ? filtered : null;
}

export function buildImageRequest(urlValue, headers) {
  let url;
  try {
    url = new URL(String(urlValue || ""));
  } catch {
    throw new TypeError("Image URL is invalid.");
  }

  if (url.protocol !== "https:") {
    throw new TypeError("Only HTTPS image URLs are allowed.");
  }

  const isChatGpt = url.origin === CHATGPT_ORIGIN;
  const trustedHeaders = isChatGpt ? filterChatGptHeaders(headers) : null;
  return {
    url: url.toString(),
    init: {
      method: "GET",
      headers: trustedHeaders || undefined,
      credentials: isChatGpt ? "include" : "omit"
    }
  };
}
