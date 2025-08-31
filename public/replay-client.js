// public/replay-client.js
const protocol = location.protocol === "https:" ? "wss" : "ws";
const client = new Colyseus.Client(`${protocol}://${location.hostname}:${location.port}`);

const el = id => document.getElementById(id);

const canvas = el("replayCanvas");
const ctx = canvas.getContext("2d");
const label = el("replayRoomLabel");
const replayInfo = el("replayInfo");
const slider = el("timeSlider");
const playBtn = el("playBtn");
const pauseBtn = el("pauseBtn");
const stepBtn = el("stepBtn");

// --- Hex math (same as game-client.js) ---
const HEX_SIZE = 15;
const SQRT3 = Math.sqrt(3);

function hexToPixel(q, r) {
  const x = HEX_SIZE * (SQRT3 * q + (SQRT3 / 2) * r);
  const y = HEX_SIZE * (1.5 * r);
  return { x, y };
}

function drawHex(q, r, color = "#0c0f1e") {
  const { x, y } = hexToPixel(q, r);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 3 * i + Math.PI / 6; // pointy-top
    const vx = cx + x + HEX_SIZE * Math.cos(angle);
    const vy = cy + y + HEX_SIZE * Math.sin(angle);
    if (i === 0) ctx.moveTo(vx, vy);
    else ctx.lineTo(vx, vy);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// --- Replay state ---
let events = [];   // [{ q, r, color, ts }]
let filled = {};   // "q,r" -> color
let idx = 0;
let playTimer = null;
let playIntervalMs = 200;

// draw grid and filled cells
function drawGrid() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const stepX = SQRT3 * HEX_SIZE;
  const stepY = 1.5 * HEX_SIZE;
  const cols = Math.ceil(canvas.width / stepX) + 2;
  const rows = Math.ceil(canvas.height / stepY) + 2;

  for (let r = -rows; r <= rows; r++) {
    for (let q = -cols; q <= cols; q++) {
      const key = `${q},${r}`;
      const color = filled[key] || "#0c0f1e";
      drawHex(q, r, color);
    }
  }
}

function applyEvent(ev) {
  if (!ev) return;
  const q = ev.q;
  const r = ev.r;
  filled[`${q},${r}`] = ev.color;
}

function goToFrame(n) {
  idx = Math.max(0, Math.min(n, events.length));
  filled = {};
  for (let i = 0; i < idx; i++) applyEvent(events[i]);
  drawGrid();
  slider.value = idx;
  replayInfo.textContent = `${idx}/${events.length}`;
}

function stepForward() {
  if (idx < events.length) {
    applyEvent(events[idx]);
    idx++;
    drawGrid();
    slider.value = idx;
    replayInfo.textContent = `${idx}/${events.length}`;
  }
}

function play() {
  if (playTimer) return;
  playTimer = setInterval(() => {
    if (idx >= events.length) {
      pause();
      return;
    }
    applyEvent(events[idx]);
    idx++;
    drawGrid();
    slider.value = idx;
    replayInfo.textContent = `${idx}/${events.length}`;
  }, playIntervalMs);
}

function pause() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

// resize canvas to full height minus header
function resizeCanvas() {
  const headerHeight = 48;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight - headerHeight;
  drawGrid();
}
window.addEventListener("resize", resizeCanvas);

// Join replay room, obtain gameId from server, fetch history and autostart
(async function init() {
  // prefer replayRoomId (the Colyseus replay room id created by lobby)
  const replayRoomId = localStorage.getItem("replayRoomId");
  const fallbackGameId = localStorage.getItem("replayGameId"); // optional if you stored original game id earlier

  if (!replayRoomId && !fallbackGameId) {
    alert("Missing replayRoomId or replayGameId in localStorage");
    return;
  }

  // If we have replayRoomId, join it to receive the server-sent gameId.
  // If not, we'll use fallbackGameId directly and not join a replay room.
  let joinedRoom = null;
  let gameId = fallbackGameId || null;

  try {
    if (replayRoomId) {
      joinedRoom = await client.joinById(replayRoomId, {}); // anonymous viewer
      // listen for replayInfo which contains the original gameId
      joinedRoom.onMessage("replayInfo", d => {
        if (d && d.gameId) {
          gameId = d.gameId;
          label.textContent = gameId;
          // fetch history after we know gameId
          fetchHistoryAndStart(gameId);
        } else if (typeof d.totalEvents === "number") {
          // if server only sent count, show it
          replayInfo.textContent = `0/${d.totalEvents}`;
        }
      });

      // register for replayEvent to avoid Colyseus warnings; do not auto-apply (we use REST playback)
      joinedRoom.onMessage("replayEvent", ev => {
        // ignore for now (we rely on REST snapshot for scrubbing)
      });

      joinedRoom.onMessage("replayEnd", () => {
        // optional: show finished
      });
    } else if (gameId) {
      // no replay room, we have direct gameId
      label.textContent = gameId;
      await fetchHistoryAndStart(gameId);
    }
  } catch (err) {
    console.error("Failed to join replay room:", err);
    // fallback: if we had a fallbackGameId, try to fetch history
    if (fallbackGameId) {
      gameId = fallbackGameId;
      label.textContent = gameId;
      await fetchHistoryAndStart(gameId);
    }
  }

  // ensure canvas sized correctly
  resizeCanvas();

  // auto-play once we have events loaded (handled by fetchHistoryAndStart)
})().catch(e => console.error(e));

async function fetchHistoryAndStart(gameId) {
  if (!gameId) return;
  label.textContent = gameId;
  try {
    const res = await fetch(`/api/history?lobbyId=${encodeURIComponent(gameId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "history fetch failed");
    // map server clicks -> { q, r, color, ts } (server uses x->q, y->r)
    events = (data.clicks || []).map(c => ({ q: c.x, r: c.y, color: c.color, ts: c.ts }));
    slider.max = events.length;
    goToFrame(0);

    // if events available, auto-play
    if (events.length > 0) {
      // small delay so UI updates before playing
      setTimeout(() => play(), 120);
    }
  } catch (err) {
    console.error("Could not fetch history:", err);
    events = [];
    slider.max = 0;
    goToFrame(0);
  }
}

// controls wiring
if (slider) slider.addEventListener("input", e => goToFrame(parseInt(e.target.value, 10)));
if (playBtn) playBtn.addEventListener("click", play);
if (pauseBtn) pauseBtn.addEventListener("click", pause);
if (stepBtn) stepBtn.addEventListener("click", () => { pause(); stepForward(); });
