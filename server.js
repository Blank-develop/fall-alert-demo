import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PORT = 3000,
  CAMERA_LABEL = "Demo Camera (Phone)",
} = process.env;

const app = express();
// Snapshots arrive as base64 data URLs, so allow a generous JSON body.
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

const telegramReady = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ---- helpers ----
async function tg(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ---- incident tracking + live tally (great to show judges) ----
const incidents = new Map(); // id -> { event, type, when, messageId, verdict }
const stats = { alerts: 0, confirmed: 0, dismissed: 0 };

function newId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

// Per-event-type rate guard so a "fall" and a "stranger" can both fire close
// together, while still preventing spam from a burst of frames of the same type.
const lastAlertByType = {};
const MIN_ALERT_INTERVAL_MS = 8000;

app.get("/config", (_req, res) => {
  res.json({ cameraLabel: CAMERA_LABEL, telegramReady });
});

app.get("/health", (_req, res) => res.json({ ok: true, telegramReady }));

app.get("/stats", (_req, res) => {
  const reviewed = stats.confirmed + stats.dismissed;
  res.json({
    ...stats,
    reviewed,
    precisionPct: reviewed ? Math.round((stats.confirmed / reviewed) * 100) : null,
  });
});

app.post("/notify", async (req, res) => {
  try {
    if (!telegramReady) {
      return res.status(500).json({
        ok: false,
        error:
          "Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env",
      });
    }

    const {
      imageBase64,
      event = "Fall detected",
      type = "fall",
      confidence,
      clientTime,
      manual = false,
    } = req.body || {};

    const now = Date.now();
    if (now - (lastAlertByType[type] || 0) < MIN_ALERT_INTERVAL_MS) {
      return res.status(429).json({ ok: false, error: "Rate limited", cooldown: true });
    }
    lastAlertByType[type] = now;

    const when = clientTime ? new Date(clientTime) : new Date();
    const whenStr = when.toLocaleString();
    const id = newId();

    const icon = type === "stranger" ? "🕵️" : "🚨";
    const captionLines = [
      `${icon} *${type === "stranger" ? "SECURITY ALERT" : "ACCIDENT ALERT"}*`,
      "",
      `*Event:* ${event}`,
      `*Location:* ${CAMERA_LABEL}`,
      `*Time:* ${whenStr}`,
    ];
    if (typeof confidence === "number") {
      captionLines.push(`*Confidence:* ${Math.round(confidence * 100)}%`);
    }
    if (manual) captionLines.push("_(manual test trigger)_");
    const caption = captionLines.join("\n");

    // Human-in-the-loop review buttons.
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Accept (real)", callback_data: `v|accept|${id}` },
          { text: "❌ Denied (false)", callback_data: `v|deny|${id}` },
        ],
      ],
    };

    let result;
    if (imageBase64) {
      const base64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64, "base64");
      const form = new FormData();
      form.append("chat_id", TELEGRAM_CHAT_ID);
      form.append("caption", caption);
      form.append("parse_mode", "Markdown");
      form.append("reply_markup", JSON.stringify(replyMarkup));
      form.append("photo", new Blob([buffer], { type: "image/jpeg" }), "alert.jpg");

      const tgRes = await fetch(`${API}/sendPhoto`, { method: "POST", body: form });
      const data = await tgRes.json();
      if (!data.ok) throw new Error(data.description || "Telegram sendPhoto failed");
      result = data.result;
    } else {
      const data = await tg("sendMessage", {
        chat_id: TELEGRAM_CHAT_ID,
        text: caption,
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
      });
      if (!data.ok) throw new Error(data.description || "Telegram sendMessage failed");
      result = data.result;
    }

    incidents.set(id, {
      event,
      type,
      when: whenStr,
      messageId: result?.message_id,
      hasPhoto: Boolean(imageBase64),
      verdict: null,
    });
    stats.alerts++;

    res.json({ ok: true, id });
  } catch (err) {
    // Roll back the cooldown so a failed send doesn't block the next real alert.
    lastAlertByType[req.body?.type || "fall"] = 0;
    console.error("[notify] error:", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ---- Telegram callback polling (handles Accept / Denied taps) ----
async function handleCallback(cb) {
  const [, decision, id] = String(cb.data || "").split("|");
  const inc = incidents.get(id);
  const who = cb.from?.first_name || "reviewer";

  const confirmed = decision === "accept";
  const verdictLabel = confirmed
    ? "✅ CONFIRMED — real event"
    : "❌ DISMISSED — false alarm";

  // Tally once per incident (ignore double-taps).
  if (inc && !inc.verdict) {
    inc.verdict = confirmed ? "confirmed" : "dismissed";
    if (confirmed) stats.confirmed++;
    else stats.dismissed++;
  }

  // Acknowledge the tap (removes the loading spinner on the button).
  await tg("answerCallbackQuery", {
    callback_query_id: cb.id,
    text: confirmed ? "Marked as real ✅" : "Marked as false alarm ❌",
  });

  // Rewrite the message: append the verdict, drop the buttons.
  const baseText = cb.message?.caption ?? cb.message?.text ?? "Alert";
  const newText = `${baseText}\n\n${verdictLabel}\nby ${who}`;
  const editMethod = cb.message?.caption ? "editMessageCaption" : "editMessageText";
  await tg(editMethod, {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    [cb.message?.caption ? "caption" : "text"]: newText,
    reply_markup: { inline_keyboard: [] },
  });

  console.log(`[verdict] ${id} -> ${verdictLabel} by ${who}`);
}

let updateOffset = 0;
async function pollUpdates() {
  while (true) {
    try {
      const data = await tg("getUpdates", { offset: updateOffset, timeout: 25 });
      if (data.ok) {
        for (const u of data.result) {
          updateOffset = u.update_id + 1;
          if (u.callback_query) await handleCallback(u.callback_query);
        }
      } else {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error("[poll] error:", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Fall-alert demo running on http://localhost:${PORT}`);
  console.log(
    `  Telegram: ${telegramReady ? "configured ✅" : "NOT configured ⚠️  (edit .env)"}`
  );
  console.log(
    `\n  Phone needs HTTPS for the camera. In another terminal run:` +
      `\n    cloudflared tunnel --config /dev/null --url http://localhost:${PORT}` +
      `\n  then open the https://...trycloudflare.com link on your phone.\n`
  );
  if (telegramReady) {
    pollUpdates();
    console.log("  Listening for Accept/Denied taps on alerts…\n");
  }
});
