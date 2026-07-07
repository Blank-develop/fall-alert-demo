import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import dns from "node:dns";
import { fileURLToPath } from "node:url";

dotenv.config();

// Containers sometimes lack an IPv6 route; force IPv4-first resolution so
// outbound calls to api.telegram.org don't pick an unreachable AAAA record.
dns.setDefaultResultOrder("ipv4first");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PORT = 3000,
  CAMERA_LABEL = "Demo Camera (Phone)",
} = process.env;

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

const telegramReady = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function tg(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// The bot token NEVER leaves the server — the client only learns whether
// Telegram is configured, not the credentials themselves.
app.get("/config.json", (_req, res) => {
  res.json({ cameraLabel: CAMERA_LABEL, telegramReady });
});

app.get("/health", (_req, res) => res.json({ ok: true, telegramReady }));

const incidents = new Map();
const stats = { alerts: 0, confirmed: 0, dismissed: 0 };
function newId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

app.get("/stats", (_req, res) => {
  const reviewed = stats.confirmed + stats.dismissed;
  res.json({
    ...stats,
    reviewed,
    precisionPct: reviewed ? Math.round((stats.confirmed / reviewed) * 100) : null,
  });
});

const lastAlertByType = {};
const MIN_ALERT_INTERVAL_MS = 8000;

app.post("/notify", async (req, res) => {
  try {
    if (!telegramReady) {
      return res.status(500).json({
        ok: false,
        error: "Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.",
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
    const id = newId();
    const icon = type === "stranger" ? "🕵️" : "🚨";
    const lines = [
      `${icon} *${type === "stranger" ? "SECURITY ALERT" : "ACCIDENT ALERT"}*`,
      "",
      `*Event:* ${event}`,
      `*Location:* ${CAMERA_LABEL}`,
      `*Time:* ${when.toLocaleString()}`,
    ];
    if (typeof confidence === "number") {
      lines.push(`*Confidence:* ${Math.round(confidence * 100)}%`);
    }
    if (manual) lines.push("_(manual test trigger)_");
    const caption = lines.join("\n");

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

    incidents.set(id, { verdict: null });
    stats.alerts++;
    res.json({ ok: true, id });
  } catch (err) {
    lastAlertByType[req.body?.type || "fall"] = 0;
    console.error("[notify] error:", err.message, err.cause?.code || "");
    res.status(502).json({ ok: false, error: err.message });
  }
});

async function handleCallback(cb) {
  const [, decision, id] = String(cb.data || "").split("|");
  const inc = incidents.get(id);
  const confirmed = decision === "accept";
  const who = cb.from?.first_name || "reviewer";
  const verdictLabel = confirmed ? "✅ CONFIRMED — real event" : "❌ DISMISSED — false alarm";

  if (inc && !inc.verdict) {
    inc.verdict = confirmed ? "confirmed" : "dismissed";
    if (confirmed) stats.confirmed++;
    else stats.dismissed++;
  }

  await tg("answerCallbackQuery", {
    callback_query_id: cb.id,
    text: confirmed ? "Marked as real ✅" : "Marked as false alarm ❌",
  });

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

// Safe long-poll loop: getUpdates itself blocks server-side for up to
// `timeout` seconds waiting for new updates, so a healthy connection makes
// very few requests per minute. Failures back off exponentially (capped) so a
// broken/blocked connection NEVER turns into a tight retry loop — that tight
// loop is what triggered HF's abuse detector on the first deploy.
let updateOffset = 0;
async function pollUpdates() {
  let backoffMs = 2000;
  const MAX_BACKOFF_MS = 60000;
  while (true) {
    try {
      const data = await tg("getUpdates", { offset: updateOffset, timeout: 25 });
      if (data.ok) {
        backoffMs = 2000; // reset after a success
        for (const u of data.result) {
          updateOffset = u.update_id + 1;
          if (u.callback_query) await handleCallback(u.callback_query);
        }
      } else {
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    } catch (err) {
      console.error("[poll] error:", err.message, err.cause?.code || "");
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Fall-alert demo running on port ${PORT}`);
  console.log(`  Telegram: ${telegramReady ? "configured ✅" : "NOT configured ⚠️"}`);
  if (telegramReady) {
    pollUpdates();
    console.log("  Listening for Accept/Denied taps (backed-off long-poll)…\n");
  }
});
