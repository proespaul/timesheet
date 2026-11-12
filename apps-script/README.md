# Timesheet backend (Google Apps Script)

This folder is the backend that runs the timesheet web app
(Apps Script project `1uYwfyq9i11DTFMPUMFTpLuZkPZlhfPDXI7PLNpYCYG2xMhmrzRjohyre`, owned by admin@proes.ca).

**Change the backend here, not in the Apps Script editor.** Every push to `main`
that touches this folder runs **Deploy backend to Apps Script** (in the Actions tab):
it checks the code parses, pushes it to the Apps Script project, and moves the
existing web app deployment (ID in `.github/apps-script-deployment-id`) onto a new
version. The `/exec` URL the phones use never changes. Anything edited directly in
the Apps Script editor is overwritten by the next push.

To copy whatever is in the Apps Script editor onto the `live-snapshot` branch, run
**Apps Script snapshot** from the Actions tab (or change `.github/snapshot-request`).

This repo is public, so **no keys or passwords in this code.** Keys live in the Apps
Script project's Script Properties (Project Settings → Script properties), e.g.
`GEMINI_API_KEY`, and the code reads them with
`PropertiesService.getScriptProperties().getProperty(...)`. The snapshot refuses
to publish code that looks like it contains a key.
