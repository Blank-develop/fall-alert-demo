// Browser-side Telegram client. The page calls the Bot API directly (Telegram
// sends CORS headers), because some hosts (HF Spaces) block server->Telegram.
// It sends alerts AND polls getUpdates to handle the Accept/Denied taps.

let BOT = null;
let CHAT = null;
let LABEL = "Demo Camera";
let onTally = null;

const incidents = new Map(); // id -> { verdict }
const tally = { alerts: 0, confirmed: 0, dismissed: 0 };
let offset = 0;
let polling = false;

const api = (method) => `https://api.telegram.org/bot${BOT}/${method}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function telegramReady() {
  return Boolean(BOT && CHAT);
}

export function initTelegram({ botToken, chatId, cameraLabel, onTallyChange }) {
  BOT = botToken;
  CHAT = chatId;
  LABEL = cameraLabel || LABEL;
  onTally = onTallyChange;
  if (telegramReady() && !polling) {
    polling = true;
    pollLoop();
  }
}

function newId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
}

export async function sendTelegramAlert({ type, event, confidence, manual, blob }) {
  if (!telegramReady()) throw new Error("Telegram not configured");

  const id = newId();
  const icon = type === "stranger" ? "🕵️" : "🚨";
  const heading = type === "stranger" ? "SECURITY ALERT" : "ACCIDENT ALERT";
  const lines = [
    `${icon} ${heading}`,
    "",
    `Event: ${event}`,
    `Location: ${LABEL}`,
    `Time: ${new Date().toLocaleString()}`,
  ];
  if (typeof confidence === "number")
    lines.push(`Confidence: ${Math.round(confidence * 100)}%`);
  if (manual) lines.push("(manual test trigger)");
  const caption = lines.join("\n");

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ Accept (real)", callback_data: `v|accept|${id}` },
        { text: "❌ Denied (false)", callback_data: `v|deny|${id}` },
      ],
    ],
  };

  let data;
  if (blob) {
    const form = new FormData();
    form.append("chat_id", CHAT);
    form.append("caption", caption);
    form.append("reply_markup", JSON.stringify(inlineKeyboard));
    form.append("photo", blob, "alert.jpg");
    const r = await fetch(api("sendPhoto"), { method: "POST", body: form });
    data = await r.json();
  } else {
    const r = await fetch(api("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text: caption, reply_markup: inlineKeyboard }),
    });
    data = await r.json();
  }
  if (!data.ok) throw new Error(data.description || "Telegram send failed");

  incidents.set(id, { verdict: null });
  tally.alerts++;
  onTally?.({ ...tally });
  return id;
}

// --- poll for Accept/Denied taps ---
async function pollLoop() {
  while (polling) {
    try {
      const r = await fetch(api("getUpdates") + `?timeout=25&offset=${offset}`);
      const d = await r.json();
      if (d.ok) {
        for (const u of d.result) {
          offset = u.update_id + 1;
          if (u.callback_query) await handleCallback(u.callback_query);
        }
      } else {
        await sleep(2000);
      }
    } catch (_) {
      await sleep(3000);
    }
  }
}

async function handleCallback(cb) {
  const [, decision, id] = String(cb.data || "").split("|");
  const inc = incidents.get(id);
  const confirmed = decision === "accept";
  const who = cb.from?.first_name || "reviewer";
  const verdictLabel = confirmed
    ? "✅ CONFIRMED — real event"
    : "❌ DISMISSED — false alarm";

  if (inc && !inc.verdict) {
    inc.verdict = confirmed ? "confirmed" : "dismissed";
    if (confirmed) tally.confirmed++;
    else tally.dismissed++;
    onTally?.({ ...tally });
  }

  await fetch(api("answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: cb.id,
      text: confirmed ? "Marked as real ✅" : "Marked as false alarm ❌",
    }),
  });

  const baseText = cb.message?.caption ?? cb.message?.text ?? "Alert";
  const newText = `${baseText}\n\n${verdictLabel}\nby ${who}`;
  const isCaption = cb.message?.caption != null;
  const body = {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    reply_markup: { inline_keyboard: [] },
  };
  body[isCaption ? "caption" : "text"] = newText;
  await fetch(api(isCaption ? "editMessageCaption" : "editMessageText"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
