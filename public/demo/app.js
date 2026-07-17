import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// ---------- DOM ----------
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");
const startBtn = document.getElementById("startBtn");
const switchBtn = document.getElementById("switchBtn");
const testFallBtn = document.getElementById("testFallBtn");
const stateBadge = document.getElementById("stateBadge");
const angleMetric = document.getElementById("angleMetric");
const aspectMetric = document.getElementById("aspectMetric");
const statusDot = document.getElementById("statusDot");
const tgPill = document.getElementById("tgPill");
const alertFlash = document.getElementById("alertFlash");
const alertTitle = document.getElementById("alertTitle");
const alertSub = document.getElementById("alertSub");
const logEl = document.getElementById("log");
const app = document.querySelector(".app");

const log = (msg) => {
  logEl.textContent = msg;
  console.log("[fall-demo]", msg);
};

// ---------- Config from server ----------
// Alerts go to a small Cloudflare Worker relay (not this page's own host):
// some hosts (HF Spaces) block outbound to Telegram from the server, and the
// bot token must never be sent to the browser, so a dedicated relay holds the
// secret and forwards to Telegram. The relay's URL itself isn't sensitive.
const RELAY_URL = "https://fall-alert-relay.jilayouthbank.workers.dev";
let serverTelegramReady = false;
fetch(`${RELAY_URL}/health`)
  .then((r) => r.json())
  .then((cfg) => {
    serverTelegramReady = Boolean(cfg.telegramReady);
    if (serverTelegramReady) {
      tgPill.textContent = "Telegram: ready";
      tgPill.classList.add("ok");
    } else {
      tgPill.textContent = "Telegram: not set";
      tgPill.classList.add("bad");
    }
  })
  .catch(() => {
    tgPill.textContent = "Telegram: relay unreachable";
    tgPill.classList.add("bad");
  });

// ---------- Detection tuning ----------
// Torso "angle" = tilt from vertical. ~0° standing, ~90° lying flat.
const UPRIGHT_ANGLE = 32; // below this = clearly standing
const FALLEN_ANGLE = 55; // above this = body is horizontal
const FALLEN_ASPECT = 1.05; // bounding box wider than tall = on the ground
const UPRIGHT_ASPECT = 0.85; // clearly taller than wide
const FALLEN_HOLD_MS = 600; // must stay down this long to confirm (rejects bending/squatting)
const UPRIGHT_MEMORY_MS = 5000; // must have been upright recently for a real "fall" transition
const ALERT_COOLDOWN_MS = 12000; // don't re-alert for the same incident

// Human-presence gate: only accept a pose when the core torso joints
// (shoulders + hips) are genuinely visible. Rejects hallucinated skeletons
// on furniture/background and ignores partial/ambiguous blobs.
const CORE_POINTS = [11, 12, 23, 24];
const MIN_CORE_VISIBILITY = 0.6; // avg visibility of shoulders+hips to count as a person
const MIN_CORE_VISIBLE_COUNT = 3; // at least this many core joints clearly seen

// Pose landmark indices we rely on (BlazePose 33-point model).
const L = {
  nose: 0,
  lShoulder: 11,
  rShoulder: 12,
  lHip: 23,
  rHip: 24,
  lKnee: 25,
  rKnee: 26,
  lAnkle: 27,
  rAnkle: 28,
};
const BBOX_POINTS = [0, 11, 12, 23, 24, 25, 26, 27, 28];
const SKELETON = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
];

// ---------- State ----------
let poseLandmarker = null;
let stream = null;
let facingMode = "environment";
let running = false;
let lastVideoTime = -1;

let lastUprightAt = 0;
let fallenSince = 0;
let lastAlertAt = 0;
let currentState = "idle"; // idle | absent | upright | falling | fallen

// ---------- Model load ----------
async function loadModel() {
  log("Loading pose model…");
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  poseLandmarker = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
    // Higher gates = only fire on a confident, actually-present human body,
    // so the skeleton stops snapping onto chairs/bags/background.
    minPoseDetectionConfidence: 0.7,
    minPosePresenceConfidence: 0.7,
    minTrackingConfidence: 0.7,
  });
  log("Pose model ready.");
}

// ---------- Camera ----------
async function startCamera() {
  if (!poseLandmarker) await loadModel();
  if (stream) stream.getTracks().forEach((t) => t.stop());

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    log("Camera error: " + err.message + " — is this page on HTTPS?");
    return;
  }

  video.srcObject = stream;
  app.classList.toggle("mirror", facingMode === "user");
  await video.play();

  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  running = true;
  statusDot.classList.add("live");
  switchBtn.disabled = false;
  testFallBtn.disabled = false;
  startBtn.textContent = "Stop";
  log("Camera live. Watching for falls…");
  requestAnimationFrame(renderLoop);
}

function stopCamera() {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  statusDot.classList.remove("live");
  startBtn.textContent = "Start camera";
  setState("idle");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  log("Camera stopped.");
}

// ---------- Detection loop ----------
function renderLoop() {
  if (!running) return;
  if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
    lastVideoTime = video.currentTime;
    const result = poseLandmarker.detectForVideo(video, performance.now());
    processResult(result);
  }
  requestAnimationFrame(renderLoop);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function processResult(result) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  const landmarks = result.landmarks && result.landmarks[0];
  if (!landmarks) {
    noPerson();
    return;
  }

  // --- Human-presence gate ---
  // Require the torso core (shoulders + hips) to be actually visible before we
  // trust this as a person. This is what stops the skeleton/alerts from firing
  // on objects, furniture, or a low-confidence blob.
  let coreVisSum = 0, coreVisCount = 0;
  for (const i of CORE_POINTS) {
    const v = landmarks[i]?.visibility ?? 0;
    coreVisSum += v;
    if (v >= 0.5) coreVisCount++;
  }
  const coreVisAvg = coreVisSum / CORE_POINTS.length;
  if (coreVisAvg < MIN_CORE_VISIBILITY || coreVisCount < MIN_CORE_VISIBLE_COUNT) {
    noPerson();
    return;
  }

  drawSkeleton(landmarks);

  // Torso tilt from vertical.
  const shoulderMid = midpoint(landmarks[L.lShoulder], landmarks[L.rShoulder]);
  const hipMid = midpoint(landmarks[L.lHip], landmarks[L.rHip]);
  const dx = hipMid.x - shoulderMid.x;
  const dy = hipMid.y - shoulderMid.y;
  const angle = (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;

  // Bounding-box aspect ratio (width / height) over visible body points.
  let minX = 1, maxX = 0, minY = 1, maxY = 0, visible = 0;
  for (const i of BBOX_POINTS) {
    const p = landmarks[i];
    if (!p || (p.visibility !== undefined && p.visibility < 0.3)) continue;
    visible++;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const bw = Math.max(maxX - minX, 0.001);
  const bh = Math.max(maxY - minY, 0.001);
  const aspect = bw / bh;

  angleMetric.textContent = `angle ${angle.toFixed(0)}°`;
  aspectMetric.textContent = `aspect ${aspect.toFixed(2)}`;

  if (visible < 4) return; // not enough of the body in frame to judge

  const now = performance.now();
  const looksUpright = angle < UPRIGHT_ANGLE && aspect < UPRIGHT_ASPECT;
  const looksFallen = angle > FALLEN_ANGLE && aspect > FALLEN_ASPECT;

  if (looksUpright) {
    lastUprightAt = now;
    fallenSince = 0;
    setState("upright");
    return;
  }

  if (looksFallen) {
    if (fallenSince === 0) {
      fallenSince = now;
      setState("falling");
    }
    const heldLongEnough = now - fallenSince >= FALLEN_HOLD_MS;
    const wasRecentlyUpright = now - lastUprightAt <= UPRIGHT_MEMORY_MS;
    if (heldLongEnough && wasRecentlyUpright) {
      setState("fallen");
      maybeAlert(angle, aspect);
    }
    return;
  }

  // In-between posture (bending, sitting) — hold current state, reset fall timer.
  fallenSince = 0;
}

function maybeAlert(angle, aspect) {
  const now = performance.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = now;
  // Confidence: how far past the thresholds we are (rough, for demo display).
  const confidence = Math.min(
    1,
    0.6 + (angle - FALLEN_ANGLE) / 90 + (aspect - FALLEN_ASPECT) / 2
  );
  sendAlert({
    title: "🚨 FALL DETECTED",
    event: "Fall detected",
    confidence,
    manual: false,
  });
}

// ---------- Drawing ----------
function drawSkeleton(landmarks) {
  const w = overlay.width, h = overlay.height;
  ctx.lineWidth = 4;
  ctx.strokeStyle = currentState === "fallen" ? "#ef4444" : "#2dd4bf";
  ctx.fillStyle = ctx.strokeStyle;
  for (const [a, b] of SKELETON) {
    const pa = landmarks[a], pb = landmarks[b];
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x * w, pa.y * h);
    ctx.lineTo(pb.x * w, pb.y * h);
    ctx.stroke();
  }
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- State UI ----------
function setState(s) {
  if (s === currentState) return;
  currentState = s;
  const map = {
    idle: ["Idle", ""],
    absent: ["No person", ""],
    upright: ["Upright", "upright"],
    falling: ["Detecting…", "falling"],
    fallen: ["FALLEN", "fallen"],
  };
  const [label, cls] = map[s] || ["—", ""];
  stateBadge.textContent = label;
  stateBadge.className = "badge " + cls;
}

// No trustworthy human in frame: clear overlay + metrics and drop the fall
// timer so a person re-entering while already down doesn't trigger a false alert.
function noPerson() {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  angleMetric.textContent = "angle —";
  aspectMetric.textContent = "aspect —";
  fallenSince = 0;
  setState("absent");
}

// ---------- Alert send ----------
function snapshotJpeg(bannerText, color) {
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const cx = c.getContext("2d");
  cx.drawImage(video, 0, 0, c.width, c.height);
  cx.drawImage(overlay, 0, 0, c.width, c.height);
  cx.fillStyle = color;
  cx.fillRect(0, 0, c.width, 44);
  cx.fillStyle = "#fff";
  cx.font = "bold 24px sans-serif";
  cx.fillText(bannerText + " — " + new Date().toLocaleTimeString(), 12, 31);
  return c.toDataURL("image/jpeg", 0.7);
}

async function sendAlert({ title, event, confidence, manual }) {
  alertTitle.textContent = title || "🚨 FALL DETECTED";

  if (!serverTelegramReady) {
    showFlash("Telegram not configured");
    setTimeout(hideFlash, 2500);
    return;
  }

  showFlash("Sending alert…");
  let imageBase64 = null;
  try {
    if (video.videoWidth) {
      imageBase64 = snapshotJpeg("FALL DETECTED", "rgba(239,68,68,0.9)");
    }
  } catch (_) {}

  try {
    const res = await fetch(`${RELAY_URL}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64,
        event,
        type: "fall",
        confidence,
        manual,
        clientTime: new Date().toISOString(),
      }),
    });
    const data = await res.json();
    if (data.ok) {
      alertSub.textContent = "Alert sent to Telegram ✅";
      log("Alert sent to Telegram.");
    } else if (data.cooldown) {
      alertSub.textContent = "Skipped (cooldown).";
    } else {
      alertSub.textContent = "Send failed: " + (data.error || "unknown");
      log("Send failed: " + (data.error || "unknown"));
    }
  } catch (err) {
    alertSub.textContent = "Network error.";
    log("Network error sending alert: " + err.message);
  }
  setTimeout(hideFlash, 2500);
}

function showFlash(msg) {
  alertSub.textContent = msg;
  alertFlash.classList.add("show");
}
function hideFlash() {
  alertFlash.classList.remove("show");
}

// ---------- Buttons ----------
startBtn.addEventListener("click", () => {
  if (running) stopCamera();
  else startCamera();
});

switchBtn.addEventListener("click", async () => {
  facingMode = facingMode === "environment" ? "user" : "environment";
  if (running) await startCamera();
});

testFallBtn.addEventListener("click", () => {
  lastAlertAt = performance.now();
  sendAlert({
    title: "🚨 FALL DETECTED",
    event: "Fall detected",
    confidence: 0.95,
    manual: true,
  });
});
