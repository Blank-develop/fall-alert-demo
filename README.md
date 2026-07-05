# Fall Alert — Live CCTV/Phone Demo

Phone (or laptop) camera → **in-browser MediaPipe pose detection** → when an
incident is detected, the app snapshots the frame and pushes a **Telegram alert**
with the photo, timestamp, event name, and camera label.

No app install, no cloud ML. The pose model runs on the device's GPU in the browser;
a tiny Node server just relays the alert to Telegram.

```
Phone browser ──getUserMedia──▶ MediaPipe Pose ──event?──▶ POST /notify ──▶ Telegram
   (camera)        (on-device)     (state machine)         (Node server)   (photo + ✅/❌ buttons)
```

## Detection cases

| Case | How it's detected | Alert |
|---|---|---|
| **Fall** | torso goes horizontal + body bounding box wider than tall, held ~0.6 s after being upright | 🚨 ACCIDENT ALERT |
| **Stranger / concealed identity** | body clearly present, but **face keypoints hidden** (hood over head + mask over face → eyes/nose/mouth read low-confidence), held ~1 s | 🕵️ SECURITY ALERT |

Every alert carries **✅ Accept (real)** / **❌ Denied (false)** buttons. Tapping
one records the verdict, rewrites the message with the decision + who made it, and
updates a live tally at **`GET /stats`** (`confirmed`, `dismissed`, `precisionPct`)
— handy to show judges a real human-in-the-loop feedback signal.

---

## Pitch-day deploy (no laptop needed) — Render

Runs the whole app in the cloud so on the day you only open a URL on the phone
and Telegram on the laptop. Repo: https://github.com/Blank-develop/fall-alert-demo

1. Go to **https://render.com** → sign up / log in **with GitHub**.
2. **New +** → **Blueprint** → pick the **`fall-alert-demo`** repo → Render reads
   `render.yaml` automatically.
3. When prompted, set the two secret env vars:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   *(`CAMERA_LABEL` is already set; you can edit it.)*
4. **Apply / Create** → wait ~2–3 min for the first build. You get a URL like
   `https://fall-alert-demo.onrender.com`.
5. Open that URL **on your phone** (HTTPS, so the camera works). Open Telegram on
   the laptop to show alerts arriving.

**Important for the day:**
- Free tier **sleeps after ~15 min idle** (cold start ~1 min). Open the URL a few
  minutes before you present so it's warm.
- Only **one** process may poll the bot. Don't run the local `npm start` while the
  Render service is live, or Telegram returns "409 Conflict".
- Redeploy after code changes: `git push` (Render auto-deploys).

---

## 1. Set up the Telegram bot (~3 min)

1. In Telegram, message **@BotFather** → `/newbot` → pick a name → copy the **token**.
2. Send any message ("hi") to your new bot so it can message you back.
3. Open this URL in a browser (paste your token):
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   Find `"chat":{"id":<NUMBER>}` — that number is your **chat id**.
   *(For a group alert: add the bot to a group, send a message there, use the negative id.)*

Then:

```bash
cd fall-alert-demo
cp .env.example .env
# edit .env — paste TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
```

## 2. Install & run the server

```bash
npm install
npm start
```

You'll see `Fall-alert demo running on http://localhost:3000` and
`Telegram: configured ✅`.

## 3. Get an HTTPS link for the phone

Phone camera access **requires HTTPS**. Easiest is a Cloudflare quick tunnel
(no account needed):

```bash
# macOS
brew install cloudflared
# then, in a second terminal — NOTE the --config /dev/null:
cloudflared tunnel --config /dev/null --url http://localhost:3000
```

It prints a `https://something.trycloudflare.com` link. **Open that on your phone.**
Each restart prints a NEW random URL — always copy the current one.

> ⚠️ **`--config /dev/null` is required if you have a `~/.cloudflared/config.yml`.**
> A plain `cloudflared tunnel --url …` auto-loads that config; if it has a
> catch-all `service: http_status:404` ingress rule, every request to the quick
> tunnel returns a hardcoded **404** (looks like the app "isn't there").
> `--config /dev/null` ignores the config and gives you a clean quick tunnel.

> If the phone says "can't be found" on a URL you've verified returns 200 from
> the laptop, it's phone-side DNS: turn off iCloud Private Relay / any VPN,
> toggle Airplane mode, or put the phone on the same Wi-Fi.

> Alternative: `ngrok http 3000` if you already use ngrok.
> On your laptop you can skip the tunnel and just use `http://localhost:3000`
> (localhost is treated as a secure context) — good for rehearsing.

## 4. Run the demo

1. Open the HTTPS link on the phone.
2. Tap **Start camera** → allow camera access.
3. Point it at the "scene". Stand in frame → the skeleton turns teal (**Upright**).
4. Demonstrate a fall (lie down / drop to the floor). Badge goes
   **Detecting… → FALLEN**, the screen flashes red, and a Telegram alert fires
   with the snapshot.
5. **Test alert** button sends a real Telegram message on demand — your
   safety net if the room is cramped or the lighting is bad during the pitch.

---

## Tuning the detector

All thresholds live at the top of `public/app.js`:

| Constant | Meaning | Raise it to… |
|---|---|---|
| `FALLEN_ANGLE` | torso tilt from vertical to count as "down" (deg) | require flatter falls (fewer false alarms) |
| `FALLEN_ASPECT` | body bounding box width/height to count as "down" | require more clearly-horizontal posture |
| `FALLEN_HOLD_MS` | how long they must stay down before alerting | ignore quick squats/bends |
| `UPRIGHT_MEMORY_MS` | must have been standing within this window | only fire on a real standing→down transition |
| `ALERT_COOLDOWN_MS` | min gap between alerts | reduce repeat alerts per incident |

**How detection works:** it tracks torso tilt (shoulders→hips vector vs. vertical)
and the body's bounding-box aspect ratio. A "fall" = *was upright recently* **and**
*now horizontal* **and** *stays down* for `FALLEN_HOLD_MS`. This rejects sitting,
bending, and tying shoelaces.

## Notes / limitations (good to know for Q&A)

- Single-person demo (`numPoses: 1`). Bump it in `app.js` for multi-person, then
  run the state machine per detected pose.
- Needs decent lighting and the person's torso + hips visible in frame.
- The model + wasm load from a CDN, so the **first** load needs internet. After
  that it's on-device inference. For a fully offline pitch, vendor the
  `@mediapipe/tasks-vision` assets locally and point the URLs at your server.
- Real CCTV: swap `getUserMedia` for an RTSP→WebRTC/HLS feed; the detection and
  alerting stay identical.
```
