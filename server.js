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
app.use(express.static(path.join(__dirname, "public")));

const telegramReady = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

// The browser talks to Telegram directly (some hosts, e.g. HF Spaces, block
// outbound to api.telegram.org). So the client needs the bot token + chat id.
// These come from server env/secrets — NOT committed to git — but they ARE
// served to anyone who opens the page. Use a throwaway demo bot and revoke it
// after the event.
// Named .json so the exact same client code also works served as a static
// file (e.g. GitHub Pages backup, which has no server to run this route).
app.get("/config.json", (_req, res) => {
  res.json({
    cameraLabel: CAMERA_LABEL,
    telegramReady,
    botToken: TELEGRAM_BOT_TOKEN || null,
    chatId: TELEGRAM_CHAT_ID || null,
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, telegramReady }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Fall-alert demo serving on port ${PORT}`);
  console.log(
    `  Telegram config: ${telegramReady ? "present ✅ (sent to client)" : "MISSING ⚠️  set TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID"}`
  );
  console.log("  Note: the browser sends alerts to Telegram directly.\n");
});
