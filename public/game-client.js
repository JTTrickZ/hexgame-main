// public/game-client.js
const protocol = location.protocol === "https:" ? "wss" : "ws";
const port = location.port ? `:${location.port}` : "";
const client = new Colyseus.Client(`${protocol}://${location.hostname}${port}`);

const el = id => document.getElementById(id);

const LS_PLAYER_ID = "playerId";
const LS_TOKEN = "playerToken";

const playerId = localStorage.getItem(LS_PLAYER_ID);
const token = localStorage.getItem(LS_TOKEN);
const roomId = localStorage.getItem("currentRoomId");

const canvas = el("gameCanvas");
const ctx = canvas.getContext("2d");
const roster = el("roster");

const hudTime = el("hudTime");
const hudPoints = el("hudPoints");
const hudTiles = el("hudTiles");

// modal elements will be looked up later (after DOM is guaranteed present)
let upgradeModal = null;
let fortifyBtn = null;
let incomeBtn = null;
let closeModalBtn = null;

if (el("roomIdLabel")) el("roomIdLabel").textContent = roomId || "—";

// --- Hex math ---
let HEX_SIZE = 15;
const SQRT3 = Math.sqrt(3);
const GRID_RADIUS = 40;

// Camera / zoom
let offsetX = 0;
let offsetY = 0;
let scale = 1;
let minScale = 1;
const maxScale = 3;

function hexToPixel(q, r) {
  const x = HEX_SIZE * (SQRT3 * q + (SQRT3 / 2) * r);
  const y = HEX_SIZE * 1.5 * r;
  return { x, y };
}
function pixelToHex(x, y) {
  const scaledX = (x - offsetX) / scale;
  const scaledY = (y - offsetY) / scale;
  const q = (SQRT3 / 3 * scaledX - scaledY / 3) / HEX_SIZE;
  const r = (2 / 3 * scaledY) / HEX_SIZE;
  return hexRound(q, r);
}
function hexRound(q, r) {
  let x = q, z = r, y = -x - z;
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const x_diff = Math.abs(rx - x), y_diff = Math.abs(ry - y), z_diff = Math.abs(rz - z);
  if (x_diff > y_diff && x_diff > z_diff) rx = -ry - rz;
  else if (y_diff > z_diff) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

// Neighbors
const HEX_DIRS = [
  {q: 1, r: 0}, {q: 1, r: -1}, {q: 0, r: -1},
  {q: -1, r: 0}, {q: -1, r: 1}, {q: 0, r: 1},
];
function getNeighbors(q, r) {
  return HEX_DIRS.map(d => ({ q: q + d.q, r: r + d.r }));
}

// draw hex
function drawHex(q, r, colorArg = "#0c0f1e", hover = false, cost = null) {
  const { x, y } = hexToPixel(q, r);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 3 * i + Math.PI / 6;
    const vx = offsetX + (x + HEX_SIZE * Math.cos(angle)) * scale;
    const vy = offsetY + (y + HEX_SIZE * Math.sin(angle)) * scale;
    if (i === 0) ctx.moveTo(vx, vy);
    else ctx.lineTo(vx, vy);
  }
  ctx.closePath();

  let color = "#0c0f1e";
  let crown = false;
  let upgrade = null;
  if (typeof colorArg === "string") color = colorArg;
  else if (colorArg && typeof colorArg === "object") {
    color = colorArg.color || "#0c0f1e";
    crown = !!colorArg.crown;
    upgrade = colorArg.upgrade || null;
  }

  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = hover ? "red" : "#333";
  ctx.lineWidth = hover ? 3 : 1;
  ctx.stroke();

  if (crown) {
    const cx = offsetX + x * scale;
    const cy = offsetY + y * scale;
    const fontSize = Math.max(12, Math.round(HEX_SIZE * scale * 0.9));
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(2, Math.round(fontSize / 6));
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.strokeText("👑", cx, cy);
    ctx.fillStyle = "#fff";
    ctx.fillText("👑", cx, cy);
  }

  // draw upgrade emoji if present
  if (upgrade) {
    const cx = offsetX + x * scale;
    const cy = offsetY + y * scale;
    const fontSize = Math.max(12, Math.round(HEX_SIZE * scale * 0.9));
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let emoji = "❓";
    if (upgrade === "bank") emoji = "💰";
    if (upgrade === "fort") emoji = "🏰";
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = Math.max(2, Math.round(fontSize / 6));
    ctx.strokeText(emoji, cx, cy);
    ctx.fillStyle = "#fff";
    ctx.fillText(emoji, cx, cy);
  }

  if (hover && cost !== null) {
    const cx = offsetX + x * scale;
    const cy = offsetY + y * scale;
    const fontSize = Math.max(10, Math.round(HEX_SIZE * scale * 0.5));
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "red";
    ctx.fillText(cost, cx, cy);
  }
}

// Roster
function renderRoster(list) {
  roster.innerHTML = "";
  (list || []).forEach(p => {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.style.border = `2px solid ${p.color}`;
    pill.textContent = p.username || p.playerId;
    roster.appendChild(pill);
  });
}

// Canvas + grid
let filled = {};
let myColor = "#5865f2";
let myPoints = 0;
let myTiles = 0;
let gameStartTime = Date.now();

let lobbyStartTime = null;
let countdownInterval = null;
let startChosen = false;

// Hover
let hoverHex = null;
let hoverCost = null;

// Dragging / dedupe state
let isDragging = false;
let hadMoveDuringPointer = false;
let lastSentHex = null; // { q, r } last hex we sent to server in this drag session
let pointerIdCaptured = null;

function drawGrid() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let q = -GRID_RADIUS; q <= GRID_RADIUS; q++) {
    for (let r = Math.max(-GRID_RADIUS, -q - GRID_RADIUS); r <= Math.min(GRID_RADIUS, -q + GRID_RADIUS); r++) {
      const key = `${q},${r}`;
      const cell = filled[key];
      const colorVal = (cell && (typeof cell === "object" ? cell.color : cell)) || "#0c0f1e";
      const upgradeVal = cell && cell.upgrade ? cell.upgrade : null;
      const crown = cell && cell.crown;
      const isHover = hoverHex && hoverHex.q === q && hoverHex.r === r;
      drawHex(q, r, { color: colorVal, crown, upgrade: upgradeVal }, isHover, isHover ? hoverCost : null);
    }
  }
  hudPoints.textContent = `Points: ${myPoints}`;
  hudTiles.textContent = `Tiles: ${myTiles}`;
}

function resizeCanvas() {
  const headerHeight = 48;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight - headerHeight;

  const width = HEX_SIZE * SQRT3 * (2 * GRID_RADIUS + 1);
  const height = HEX_SIZE * 1.5 * (2 * GRID_RADIUS + 1);

  minScale = Math.min(canvas.width / (width + 40), canvas.height / (height + 40));
  if (scale < minScale) scale = minScale;

  offsetX = canvas.width / 2;
  offsetY = canvas.height / 2;

  drawGrid();
}
window.addEventListener("resize", resizeCanvas);

// Zoom
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const mouseX = e.offsetX;
  const mouseY = e.offsetY;
  const delta = e.deltaY < 0 ? 1.1 : 0.9;
  let newScale = scale * delta;

  if (newScale < minScale) newScale = minScale;
  if (newScale > maxScale) newScale = maxScale;

  offsetX = mouseX - ((mouseX - offsetX) / scale) * newScale;
  offsetY = mouseY - ((mouseY - offsetY) / scale) * newScale;

  scale = newScale;
  drawGrid();
}, { passive: false });

// --- Modal helpers ---
let currentModalTile = null;
function openUpgradeModal(q, r, currentUpgrade) {
  currentModalTile = { q, r, currentUpgrade };
  if (incomeBtn) incomeBtn.textContent = `💰 Bank (100 pts)`;
  if (fortifyBtn) fortifyBtn.textContent = `🏰 Fort (200 pts)`;
  if (upgradeModal) upgradeModal.classList.remove("hidden");
}
function closeUpgradeModal() {
  currentModalTile = null;
  if (upgradeModal) upgradeModal.classList.add("hidden");
}

// --- Main flow ---
(async function start() {
  if (!roomId) {
    alert("No roomId to join!");
    return;
  }

  let room = null; // keep room available across handlers

  try {
    room = await client.joinById(roomId, { playerId, token });

    // now that room/join succeeded, look up modal elements (DOM should be loaded)
    upgradeModal = document.getElementById("upgradeModal");
    fortifyBtn = document.getElementById("fortifyBtn");
    incomeBtn = document.getElementById("incomeBtn");
    closeModalBtn = document.getElementById("closeModalBtn");

    // Safety: only add listeners if elements exist
    if (fortifyBtn) {
      fortifyBtn.addEventListener("click", () => {
        if (!currentModalTile) return;
        const { q, r } = currentModalTile;
        room.send("upgradeHex", { q, r, type: "fort" });
      });
    }
    if (incomeBtn) {
      incomeBtn.addEventListener("click", () => {
        if (!currentModalTile) return;
        const { q, r } = currentModalTile;
        room.send("upgradeHex", { q, r, type: "bank" });
      });
    }
    if (closeModalBtn) closeModalBtn.addEventListener("click", () => closeUpgradeModal());

    room.onLeave(code => {
      if (code === 1000) {
        localStorage.clear();
        alert("Your saved identity is no longer valid. Please register again.");
        window.location.href = "/";
      }
    });

    room.onMessage("assignedColor", ({ color }) => { myColor = color; });

    room.onMessage("history", (cells) => {
      filled = {};
      (cells || []).forEach(c => {
        const q = c.q ?? c.x;
        const r = c.r ?? c.y;
        const key = `${q},${r}`;
        filled[key] = { color: c.color || "#0c0f1e", crown: !!c.crown, upgrade: c.upgrade || null };
      });
      drawGrid();
    });

    room.onMessage("update", ({ q, r, color, crown, upgrade }) => {
      const key = `${q},${r}`;
      filled[key] = { color: color || "#0c0f1e", crown: !!crown, upgrade: upgrade || null };
      drawGrid();
    });

    room.onMessage("pointsUpdate", ({ playerId: pid, points, tiles }) => {
      if (pid === playerId) {
        myPoints = points;
        myTiles = tiles;
        drawGrid();
      } else {
        // optionally update others if you show them
      }
    });

    room.onMessage("lobbyRoster", (list) => renderRoster(list));

    room.onMessage("lobbyStartTime", ({ ts }) => {
      lobbyStartTime = ts;
      updateCountdown();
      if (countdownInterval) clearInterval(countdownInterval);
      countdownInterval = setInterval(updateCountdown, 500);
    });

    room.onMessage("hoverCost", ({ q, r, cost }) => {
      if (hoverHex && hoverHex.q === q && hoverHex.r === r) {
        hoverCost = cost;
        drawGrid();
      }
    });

    // Owned tile menu: open upgrade modal
    room.onMessage("openOwnedTileMenu", ({ q, r, upgrade }) => {
      openUpgradeModal(q, r, upgrade);
    });

    room.onMessage("fillResult", ({ q, r, ok, reason }) => {
      if (!ok) {
        if (reason === "insufficient") {
          const key = `${q},${r}`;
          // temporarily mark with red hover/cost warning
          filled[key] = { color: "#0c0f1e", cost: "❌" };
          drawGrid();
          setTimeout(() => {
            delete filled[key]?.cost;
            drawGrid();
          }, 1000); // clear after 1s
        }
      }
    });

    // upgrade result
    room.onMessage("upgradeResult", (res) => {
      if (!res) return;
      if (res.ok) {
        // server already broadcasted full 'update' and 'pointsUpdate'
        closeUpgradeModal();
      } else {
        alert("Upgrade failed: " + (res.error || "unknown"));
      }
    });

    function updateCountdown() {
      if (!lobbyStartTime) return;
      const nowTs = Date.now();
      const remaining = Math.max(0, Math.ceil((lobbyStartTime + 5000 - nowTs) / 1000));
      if (remaining > 0 && !startChosen) {
        hudTime.textContent = `Choose start: ${remaining}`;
      } else {
        if (countdownInterval) clearInterval(countdownInterval);
        gameStartTime = lobbyStartTime + 5000;
      }
    }

    resizeCanvas();

    // --- Hover detection ---
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const { q, r } = pixelToHex(localX, localY);
      hoverHex = { q, r };

      if (room) {
        room.send("requestHoverCost", { q, r });
      }

      drawGrid();
    });

    canvas.addEventListener("mouseleave", () => {
      hoverHex = null;
      hoverCost = null;
      drawGrid();
    });

    // --- Pointer-based drag & click handling ---
    canvas.addEventListener("pointerdown", (e) => {
      // only left button / primary pointer
      if (e.button !== 0 && e.pointerType === "mouse") return;
      isDragging = true;
      hadMoveDuringPointer = false;
      lastSentHex = null;

      try {
        canvas.setPointerCapture(e.pointerId);
        pointerIdCaptured = e.pointerId;
      } catch (_) { /* ignore */ }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      const rect = canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const { q, r } = pixelToHex(localX, localY);

      // if it's a new hex compared to last sent during this drag, attempt send
      if (!lastSentHex || lastSentHex.q !== q || lastSentHex.r !== r) {
        // check start stage: if still in choose-start window and not chosen, behave as single pick (no drag painting)
        const nowTs = Date.now();
        if (lobbyStartTime && nowTs <= lobbyStartTime + 5000 && !startChosen) {
          // ignore drag during start phase
          return;
        }

        // adjacency check (same logic as click): don't allow painting if not adjacent and they already have tiles
        const ownedKeys = Object.keys(filled).filter(k => {
          const v = filled[k];
          return (typeof v === "string" ? v : v.color) === myColor;
        });
        const isAdjacent = ownedKeys.length === 0 || ownedKeys.some(k => {
          const [oq, or] = k.split(",").map(Number);
          return getNeighbors(oq, or).some(n => n.q === q && n.r === r);
        });

        if (!isAdjacent && ownedKeys.length > 0) {
          // disallow sending to non-adjacent hex
          return;
        }

        // dedupe: don't send same hex twice
        lastSentHex = { q, r };
        hadMoveDuringPointer = true;

        // optimistic visual update so the player sees progress immediately
        const key = `${q},${r}`;
        filled[key] = { color: myColor, upgrade: filled[key]?.upgrade || null };

        // send to server
        if (room) {
          room.send("fillHex", { q, r });
        }
        drawGrid();
      }
    }, { passive: true });

    canvas.addEventListener("pointerup", (e) => {
      // release pointer capture
      if (pointerIdCaptured !== null) {
        try { canvas.releasePointerCapture(pointerIdCaptured); } catch (_) {}
        pointerIdCaptured = null;
      }

      // if we never had a move during this pointer session, treat as a click/tap
      const rect = canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const { q, r } = pixelToHex(localX, localY);

      if (!hadMoveDuringPointer) {
        // single click behavior (chooseStart or single fill)
        const nowTs = Date.now();
        if (lobbyStartTime && nowTs <= lobbyStartTime + 5000 && !startChosen) {
          filled[`${q},${r}`] = { color: myColor, crown: true };
          drawGrid();
          if (room) room.send("chooseStart", { q, r });
          startChosen = true;
        } else {
          // adjacency check for single click
          const ownedKeys = Object.keys(filled).filter(k => {
            const v = filled[k];
            return (typeof v === "string" ? v : v.color) === myColor;
          });
          const isAdjacent = ownedKeys.length === 0 || ownedKeys.some(k => {
            const [oq, or] = k.split(",").map(Number);
            return getNeighbors(oq, or).some(n => n.q === q && n.r === r);
          });
          if (!isAdjacent && ownedKeys.length > 0) {
            // ignore
          } else {
            // optimistic update & send single fill
            const key = `${q},${r}`;
        
            if (room) room.send("fillHex", { q, r });
            
          }
        }
      }

      // cleanup drag state
      isDragging = false;
      hadMoveDuringPointer = false;
      lastSentHex = null;
    });

    // Timer
    setInterval(() => {
      const elapsed = Math.floor((Date.now() - gameStartTime) / 1000);
      if (elapsed < 0) return;
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      hudTime.textContent = `Time: ${mins}:${secs.toString().padStart(2, "0")}`;
    }, 1000);

  } catch (e) {
    console.error("Failed to join game room:", e);
    alert("Failed to join game room. Check server logs.");
  }
})();
