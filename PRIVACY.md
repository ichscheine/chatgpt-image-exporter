# Privacy Policy

Last updated: September 1, 2026

ChatGPT Image Exporter has one purpose: exporting images selected by the user from their ChatGPT Images library into a ZIP file on their device.

## Data the extension handles

To provide that feature, the extension handles:

- User-generated ChatGPT images and, when the user enables metadata export, associated prompts, image URLs, identifiers, and timestamps.
- Website content and request information needed to retrieve the user's ChatGPT image list.
- Short-lived ChatGPT authentication headers needed to make the user-requested export.
- Export settings such as ZIP name, image count, start index, concurrency, and metadata preference.

## How data is used and shared

Data is used only to perform the export requested by the user. The extension communicates with ChatGPT and the HTTPS image locations returned by ChatGPT. ChatGPT authentication headers and cookies are only sent to `https://chatgpt.com`; requests to other image hosts omit them.

The extension does not collect analytics or telemetry, use advertising, sell data, transfer data to developer-controlled servers, or share data with third parties for unrelated purposes. It does not load or execute remote code.

## Local storage and retention

Export settings remain in Chrome extension storage until the user changes them or removes the extension. Filtered authentication headers are kept only while an export is active and are cleared when it finishes, stops, or errors.

The ZIP is assembled in Chrome's private on-device storage. The temporary archive is deleted after the browser download finishes, is cancelled, or fails. If Chrome exits unexpectedly, stale temporary exporter archives are deleted when the next export starts. The completed ZIP in Downloads remains under the user's control.

If metadata export is enabled, the completed ZIP can contain account-specific metadata. The extension displays this as an optional setting and leaves it disabled unless the user selects it.

## User control

Users start every export explicitly, can stop an active export from the extension popup, can delete downloaded ZIP files normally, and can remove stored settings and temporary extension data by uninstalling the extension or clearing its site data in Chrome.

## Changes

Material changes to this policy will be reflected in an updated version of this document and, where required, the Chrome Web Store listing.
