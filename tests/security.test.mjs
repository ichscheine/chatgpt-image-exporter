import assert from "node:assert/strict";
import test from "node:test";

import {
  buildImageRequest,
  filterChatGptHeaders,
  normalizeMetadataEndpoint
} from "../security.mjs";

test("metadata endpoints are restricted to the exact ChatGPT API path", () => {
  assert.equal(
    normalizeMetadataEndpoint("/backend-api/my/recent/image_gen?limit=100#ignored"),
    "https://chatgpt.com/backend-api/my/recent/image_gen?limit=100"
  );
  assert.equal(normalizeMetadataEndpoint("https://evil.example/backend-api/my/recent/image_gen"), null);
  assert.equal(normalizeMetadataEndpoint("https://chatgpt.com.evil.example/backend-api/my/recent/image_gen"), null);
  assert.equal(normalizeMetadataEndpoint("https://chatgpt.com/backend-api/account"), null);
});

test("captured headers are normalized and limited to the allowlist", () => {
  assert.deepEqual(filterChatGptHeaders({
    Authorization: "Bearer secret",
    "OAI-Language": "en-US",
    Cookie: "not-allowed",
    Referer: "not-allowed"
  }), {
    authorization: "Bearer secret",
    "oai-language": "en-US"
  });
});

test("ChatGPT image requests may use filtered authentication", () => {
  const request = buildImageRequest("https://chatgpt.com/backend-api/files/image.png", {
    Authorization: "Bearer secret",
    Cookie: "not-allowed"
  });
  assert.equal(request.init.credentials, "include");
  assert.deepEqual(request.init.headers, { authorization: "Bearer secret" });
});

test("external image requests omit ChatGPT credentials and headers", () => {
  const request = buildImageRequest("https://cdn.example/image.png", {
    authorization: "Bearer secret",
    "oai-device-id": "device"
  });
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.headers, undefined);
});

test("non-HTTPS and malformed image URLs are rejected", () => {
  assert.throws(() => buildImageRequest("http://cdn.example/image.png", null), /Only HTTPS/);
  assert.throws(() => buildImageRequest("not a URL", null), /invalid/);
});
