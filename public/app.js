import {
  PoseLandmarker,
  FaceDetector,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { initTelegram, sendTelegramAlert, telegramReady } from "./telegram.js";

// ---------- DOM ----------
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");
const startBtn = document.getElementById("startBtn");
const switchBtn = document.getElementById("switchBtn");
const testFallBtn = document.getElementById("testFallBtn");
const testStrangerBtn = document.getElementById("testStrangerBtn");
const stateBadge = document.getElementById("stateBadge");
const angleMetric = document.getElementById("angleMetric");
const aspectMetric = document.getElementById("aspectMetric");
const faceMetric = document.getElementById("faceMetric");
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
let cameraLabel = "Demo Camera";
fetch("/config")
  .then((r) => r.json())
  .then((cfg) => {
    cameraLabel = cfg.cameraLabel || cameraLabel;
    // The browser sends alerts to Telegram directly (host may block server->TG).
    initTelegram({
      botToken: cfg.botToken,
      chatId: cfg.chatId,
      cameraLabel,
      onTallyChange: (t) =>
        log(
          `Review tally — ✅ ${t.confirmed} real · ❌ ${t.dismissed} false · ${t.alerts} alerts`
        ),
    });
    if (telegramReady()) {
      tgPill.textContent = "Telegram: ready";
      tgPill.classList.add("ok");
    } else {
      tgPill.textContent = "Telegram: not set";
      tgPill.classList.add("bad");
    }
  })
  .catch(() => {});

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

// --- Stranger / concealed-identity demo ---
// A real face DETECTOR (BlazeFace) is run on the pixels. Pose keypoint
// "visibility" can't see occlusion — it reports 1.00 even for a masked/hooded
// face because it just predicts where the point *should* be. The detector, by
// contrast, needs an actual visible face, so hood+mask makes its score drop or
// find no face at all. That low score is our "identity concealed" signal.
const FACE_DET_THRESHOLD = 0.55; // face-detector score at/above this = face clearly visible
const CONCEAL_HOLD_MS = 1000; // face must stay hidden/low this long before flagging
const STRANGER_COOLDOWN_MS = 20000; // don't re-flag the same person constantly

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
let faceDetector = null;
let lastFaceScore = 0;
let stream = null;
let facingMode = "environment";
let running = false;
let lastVideoTime = -1;

let lastUprightAt = 0;
let fallenSince = 0;
let lastAlertAt = 0;
let currentState = "idle"; // idle | absent | upright | falling | fallen
let faceHiddenSince = 0;
let lastStrangerAt = 0;

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

  log("Loading face detector…");
  faceDetector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    // Keep this low so we still SEE weak/partial faces and can read their score,
    // rather than the detector silently dropping them. The concealed-identity
    // decision uses FACE_DET_THRESHOLD, not this.
    minDetectionConfidence: 0.2,
  });
  log("Models ready.");
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
  testStrangerBtn.disabled = false;
  startBtn.textContent = "Stop";
  log("Camera live. Watching for falls & concealed identities…");
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
    const ts = performance.now();

    // Real face detector on the pixels: best detection score, 0 if no face.
    let faceScore = 0;
    if (faceDetector) {
      const fr = faceDetector.detectForVideo(video, ts);
      for (const d of fr.detections || []) {
        const s = d.categories?.[0]?.score ?? 0;
        if (s > faceScore) faceScore = s;
      }
    }
    lastFaceScore = faceScore;

    const result = poseLandmarker.detectForVideo(video, ts + 0.1);
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

  // --- Stranger / concealed-identity check ---
  // Person is confirmed present (passed the core gate). Use the real face
  // DETECTOR score (from renderLoop): a clear face scores high, a hood+mask
  // covered face scores low or isn't found at all. Suppressed during a fall,
  // where the face is naturally hidden face-down.
  faceMetric.textContent = `face ${lastFaceScore.toFixed(2)}`;

  const tNow = performance.now();
  if (currentState !== "fallen" && lastFaceScore < FACE_DET_THRESHOLD) {
    if (faceHiddenSince === 0) faceHiddenSince = tNow;
    if (tNow - faceHiddenSince >= CONCEAL_HOLD_MS) maybeStrangerAlert(lastFaceScore);
  } else {
    faceHiddenSince = 0;
  }

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
    type: "fall",
    title: "🚨 FALL DETECTED",
    event: "Fall detected",
    confidence,
    manual: false,
  });
}

function maybeStrangerAlert(faceScore) {
  const now = performance.now();
  if (now - lastStrangerAt < STRANGER_COOLDOWN_MS) return;
  lastStrangerAt = now;
  // Lower face-detector score => higher concealment confidence.
  const confidence = Math.min(1, 0.7 + (FACE_DET_THRESHOLD - faceScore) * 0.5);
  sendAlert({
    type: "stranger",
    title: "🕵️ STRANGER DETECTED",
    event: "Stranger detected — face/identity concealed (hood + mask)",
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
  faceMetric.textContent = "face —";
  fallenSince = 0;
  faceHiddenSince = 0;
  setState("absent");
}

// ---------- Alert send ----------
// Returns a JPEG Blob of the current frame with the skeleton + a banner burned in.
function snapshotBlob(bannerText, color) {
  return new Promise((resolve, reject) => {
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
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.7);
  });
}

async function sendAlert({ type = "fall", title, event, confidence, manual }) {
  const isStranger = type === "stranger";
  alertTitle.textContent = title || (isStranger ? "🕵️ STRANGER DETECTED" : "🚨 FALL DETECTED");

  if (!telegramReady()) {
    alertTitle.textContent = title;
    showFlash("Telegram not configured");
    setTimeout(hideFlash, 2500);
    return;
  }

  showFlash("Sending alert…");
  let blob = null;
  try {
    if (video.videoWidth) {
      blob = await snapshotBlob(
        isStranger ? "STRANGER DETECTED" : "FALL DETECTED",
        isStranger ? "rgba(245,158,11,0.9)" : "rgba(239,68,68,0.9)"
      );
    }
  } catch (_) {}

  try {
    await sendTelegramAlert({ type, event, confidence, manual, blob });
    alertSub.textContent = "Alert sent to Telegram ✅";
    log("Alert sent to Telegram.");
  } catch (err) {
    alertSub.textContent = "Send failed: " + err.message;
    log("Send failed: " + err.message);
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
    type: "fall",
    title: "🚨 FALL DETECTED",
    event: "Fall detected",
    confidence: 0.95,
    manual: true,
  });
});

testStrangerBtn.addEventListener("click", () => {
  lastStrangerAt = performance.now();
  sendAlert({
    type: "stranger",
    title: "🕵️ STRANGER DETECTED",
    event: "Stranger detected — face/identity concealed (hood + mask)",
    confidence: 0.92,
    manual: true,
  });
});
