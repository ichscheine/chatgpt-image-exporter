# Chrome Web Store Privacy Practices

Use this checklist when completing the dashboard for version 1.0.3. Keep the dashboard answers consistent with `PRIVACY.md` and the extension behavior.

## Single purpose

Export images selected by the user from their ChatGPT Images library into one ZIP archive downloaded to their device.

## Permission justifications

- `downloads`: Saves the completed ZIP selected by the user and observes its completion so temporary local data can be deleted safely.
- `storage`: Remembers export settings and short-lived export progress. Filtered authentication headers are retained only during an active export and cleared afterward.
- `scripting`: Runs the metadata request in the active ChatGPT Images tab using the user's existing session.
- `offscreen`: Fetches image blobs and assembles the ZIP in an offscreen extension document because a Manifest V3 service worker cannot create persistent Blob download URLs reliably.
- `https://chatgpt.com/*`: Restricts page and authenticated metadata access to ChatGPT.

## Data disclosures

Declare the handling of:

- Website content and resources.
- User-generated content, including images and optional prompts/metadata.
- Authentication information used transiently for the requested export.

Purpose: app functionality only.

Confirm all Limited Use statements: data is not sold, is not used for advertising or credit decisions, is not transferred for unrelated purposes, and is not used for human review outside the user's requested feature.

## Remote code

Select **No, I am not using remote code**. All executable logic is packaged with the extension. Remote image and JSON responses are treated only as data.

## Privacy policy

Publish `PRIVACY.md` at a stable public HTTPS URL and enter that URL in the dashboard. Update the listing text from “folder” wording to “ZIP archive” wherever it appears.
