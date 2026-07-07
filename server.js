import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { PORT = 3000 } = process.env;

// This server only serves the static camera/detection page. All Telegram
// traffic goes through a separate Cloudflare Worker relay (see public/app.js,
// RELAY_URL) — some hosts (e.g. HF Spaces) block outbound to Telegram from
// the server, and the bot token must never touch this app's own responses.
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  Fall-alert demo serving on port ${PORT}\n`);
});
