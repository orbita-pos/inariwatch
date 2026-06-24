# Visual Report demo

Tiny Next.js app to test `@inariwatch/capture/visual-report` end-to-end.

## Setup (one time)

```powershell
cd capture\demo\visual-report-test
npm install
copy .env.example .env.local
# edit .env.local — paste your iwk_pub_v1_… token + project UUID
```

## Run

```powershell
# Terminal 1 — web app
cd web
npm run dev

# Terminal 2 — demo app
cd capture\demo\visual-report-test
npm run dev   # boots on http://localhost:3001
```

Open `http://localhost:3001`. The floating **Report visual bug** button
appears in the bottom-right.

## Test flow

1. Click the button → modal opens.
2. Type a description ("submit button is outside its container").
3. Click **📸 Attach screenshot** → browser asks permission → approve →
   pick the tab/window showing this page.
4. Click **Send**.
5. DevTools console logs `[demo] ✓ Report uploaded: <reportId>` and the
   alert id.
6. Open Inari Live desktop → the new alert appears in the Inbox with
   source `user_report`.
7. Press `Cmd+\` on the alert → AlertDetailPanel opens with the
   **Visual Report** section showing screenshot + diagnosis + evidence
   chips.

## Troubleshooting

- **Button doesn't appear** → check DevTools console for capture init
  errors. Most likely missing token/projectId in `.env.local`.
- **"Skipping upload — no screenshot attached"** → you didn't click the
  📸 button before submit. The endpoint requires a screenshot.
- **400 on submit** → check Network tab for the response body. Common
  causes: missing token, wrong projectId, payload >500KB.
- **Diagnosis never lands (status stays `diagnosing`)** → the web
  server's `PLATFORM_TOGETHER_KEY` env var is missing. Add it to
  `web/.env.local` and restart.
