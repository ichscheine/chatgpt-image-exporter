# ChatGPT Image Exporter

Chrome extension for bulk exporting images from your ChatGPT Images library to your local Downloads folder.

## What It Does

- Exports images from `https://chatgpt.com/images`.
- Saves the selected images in one ZIP archive under Downloads.
- Supports an image count and start index for resuming interrupted exports.
- Reads large libraries in bounded metadata pages instead of requesting the full history at once.
- Optionally includes `metadata.json` and `failures.json` inside the ZIP for troubleshooting.
- Does not send telemetry or data to any developer-controlled service.

## Install Locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select this repository folder.
5. Open `https://chatgpt.com/images`, open the extension popup, and start the export.

For example, to export 500 images beginning at index 7,500, enter `500` for
**Number of images** and `7500` for **Start index**.

## Permissions

The extension requests:

- `downloads`: save exported image files.
- `storage`: remember settings and short-lived export state.
- `scripting`: run export helpers on the active ChatGPT Images tab.
- `offscreen`: fetch image blobs and trigger downloads reliably.
- `https://chatgpt.com/*`: access your ChatGPT Images page and related image metadata.

## Privacy And Security

This extension is local-only. It does not include analytics, telemetry, developer-controlled servers, remote code, or bundled third-party code. See [PRIVACY.md](PRIVACY.md) for the full privacy disclosure.

To fetch your image list, the extension reads ChatGPT image metadata from the currently open ChatGPT session. During an export, it may temporarily keep filtered ChatGPT request headers in Chrome extension local storage so downloads can continue reliably. Those headers are only sent to `https://chatgpt.com` and are cleared when the export finishes, stops, or hits an error. Requests to HTTPS image hosts outside ChatGPT omit ChatGPT headers and cookies.

The ZIP is assembled in Chrome's private on-device storage. Its temporary file is removed after the download finishes, is cancelled, or fails. If the browser exits unexpectedly, stale exporter temporary files are removed when the next export starts.

If metadata export is enabled, `metadata.json` can contain account-specific image metadata such as prompts, image URLs, IDs, and timestamps. Only enable metadata export if you want that information saved locally.

## Limitations

- ChatGPT's internal image API can change, which may break export until the extension is updated.
- Keep the ChatGPT Images tab open while exporting.
- Large exports may take time and can be affected by network/session expiry. The
  extension shows indexing progress before downloads begin when it must traverse
  earlier metadata pages.

## Release Checklist

- Confirm `manifest.json` version is correct.
- Confirm icon files exist at 16, 32, 48, and 128 px.
- Review screenshots for personal information before publishing.
- Load the unpacked extension in Chrome and test a small export.
- Run `npm test`.
- Run `npm run build:release` and upload the ZIP produced in `dist/`.
- Review `web-store/privacy-practices.md` against the dashboard declarations.

## License

MIT
