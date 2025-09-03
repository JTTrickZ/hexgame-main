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
let cityBtn = null;
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

// --- Client-side action queue and sync system ---
const ACTION_SYNC_INTERVAL = 100; // ms - how often to sync actions to server
const HOVER_SYNC_INTERVAL = 200; // ms - how often to sync hover requests
const POINTS_SYNC_INTERVAL = 2000; // ms - how often to request points updates (increased from 1000)
const OPTIMISTIC_TIMEOUT = 5000; // ms - how long to keep optimistic updates before clearing

let actionQueue = []; // pending actions to send to server
let lastActionSync = 0;
let lastHoverSync = 0;
let lastPointsSync = 0;
let pendingHoverRequest = null; // { q, r } - most recent hover request
let optimisticUpdates = {}; // { "q,r": { color, crown, upgrade, terrain, timestamp } } - client-side optimistic updates
let serverState = {}; // { "q,r": { color, crown, upgrade, terrain } } - authoritative server state
let optimisticTimeouts = {}; // { "q,r": timeoutId } - timeouts to clear stale optimistic updates

// Sync actions to server periodically
function syncActionsToServer() {
  if (actionQueue.length === 0) return;
  
  const now = Date.now();
  if (now - lastActionSync < ACTION_SYNC_INTERVAL) return;
  
  // Group actions by type for efficiency
  const fillActions = actionQueue.filter(a => a.type === 'fillHex');
  const upgradeActions = actionQueue.filter(a => a.type === 'upgradeHex');
  const startActions = actionQueue.filter(a => a.type === 'chooseStart');
  
  // Send grouped actions
  if (fillActions.length > 0) {
    if (window.currentRoom) window.currentRoom.send("batchFillHex", { hexes: fillActions.map(a => ({ q: a.q, r: a.r })) });
  }
  if (upgradeActions.length > 0) {
    if (window.currentRoom) window.currentRoom.send("batchUpgradeHex", { hexes: upgradeActions.map(a => ({ q: a.q, r: a.r, type: a.upgradeType })) });
  }
  if (startActions.length > 0) {
    const startAction = startActions[0]; // Only one start action allowed
    if (window.currentRoom) window.currentRoom.send("chooseStart", { q: startAction.q, r: startAction.r });
  }
  
  // Clear processed actions
  actionQueue = [];
  lastActionSync = now;
}

// Sync hover requests to server periodically
function syncHoverToServer() {
  if (!pendingHoverRequest) return;
  
  const now = Date.now();
  if (now - lastHoverSync < HOVER_SYNC_INTERVAL) return;
  
  if (window.currentRoom) window.currentRoom.send("requestHoverCost", pendingHoverRequest);
  lastHoverSync = now;
}

// Request points updates periodically
function requestPointsUpdate() {
  const now = Date.now();
  if (now - lastPointsSync < POINTS_SYNC_INTERVAL) return;
  
  if (window.currentRoom) window.currentRoom.send("requestPointsUpdate", {});
  lastPointsSync = now;
}

// Apply optimistic update to local state
function applyOptimisticUpdate(q, r, color, crown = false, upgrade = null, terrain = null) {
  const key = `${q},${r}`;
  const now = Date.now();
  
  // Clear any existing timeout for this hex
  if (optimisticTimeouts[key]) {
    clearTimeout(optimisticTimeouts[key]);
  }
  
  optimisticUpdates[key] = { color, crown, upgrade, terrain, timestamp: now };
  
  // Set timeout to clear stale optimistic update
  optimisticTimeouts[key] = setTimeout(() => {
    if (optimisticUpdates[key] && optimisticUpdates[key].timestamp === now) {
      delete optimisticUpdates[key];
      delete optimisticTimeouts[key];
      markDirty();
    }
  }, OPTIMISTIC_TIMEOUT);
  
  markDirty();
}

// Merge optimistic and server state for rendering
function getMergedState(q, r) {
  const key = `${q},${r}`;
  const optimistic = optimisticUpdates[key];
  const server = serverState[key];
  
  // Prefer optimistic updates for immediate feedback, fall back to server state
  return optimistic || server || null;
}

// Clear optimistic update when server confirms
function clearOptimisticUpdate(q, r) {
  const key = `${q},${r}`;
  if (optimisticUpdates[key]) {
    delete optimisticUpdates[key];
    if (optimisticTimeouts[key]) {
      clearTimeout(optimisticTimeouts[key]);
      delete optimisticTimeouts[key];
    }
    markDirty();
  }
}

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
  let terrain = null;
  if (typeof colorArg === "string") color = colorArg;
  else if (colorArg && typeof colorArg === "object") {
    color = colorArg.color || "#0c0f1e";
    crown = !!colorArg.crown;
    upgrade = colorArg.upgrade || null;
    terrain = colorArg.terrain || null;
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
    if (upgrade === "city") emoji = "🏢";
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = Math.max(2, Math.round(fontSize / 6));
    ctx.strokeText(emoji, cx, cy);
    ctx.fillStyle = "#fff";
    ctx.fillText(emoji, cx, cy);
  }

  // draw terrain emoji if present
  if (terrain) {
    const cx = offsetX + x * scale;
    const cy = offsetY + y * scale;
    const fontSize = Math.max(12, Math.round(HEX_SIZE * scale * 0.9));
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let emoji = "❓";
    if (terrain === "mountain") emoji = "⛰️";
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
let filled = {};           // legacy - now using serverState and optimisticUpdates
let previews = {};         // temporary overlays: { "q,r": { type: "x", expiresAt: ts } }
let myColor = "#5865f2";
let myPoints = 0;
let myMaxPoints = 50;
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

// --- Rendering scheduler (non-blocking) ---
let rafRequested = false;
let dirty = false;
let lastRenderTime = 0;
const DRAG_RENDER_THROTTLE = 250; // ms: throttle redraws during drag to avoid interruption
const MAX_OPTIMISTIC_UPDATES = 50; // maximum number of optimistic updates to prevent memory leaks

function markDirty() {
  dirty = true;
  if (!rafRequested) {
    rafRequested = true;
    requestAnimationFrame(renderIfNeeded);
  }
}

function renderIfNeeded(ts) {
  rafRequested = false;
  const now = Date.now();

  if (!dirty) {
    // nothing to do
    return;
  }

  // If user is dragging, throttle how often we actually perform a full redraw
  if (isDragging) {
    if (now - lastRenderTime < DRAG_RENDER_THROTTLE) {
      // schedule a later attempt to draw (coalesce)
      if (!rafRequested) {
        rafRequested = true;
        setTimeout(() => {
          rafRequested = true;
          requestAnimationFrame(renderIfNeeded);
        }, DRAG_RENDER_THROTTLE - (now - lastRenderTime));
      }
      return;
    }
  }

  // Clean up excessive optimistic updates
  const optimisticKeys = Object.keys(optimisticUpdates);
  if (optimisticKeys.length > MAX_OPTIMISTIC_UPDATES) {
    // Remove oldest optimistic updates
    const sortedKeys = optimisticKeys.sort((a, b) => 
      (optimisticUpdates[a].timestamp || 0) - (optimisticUpdates[b].timestamp || 0)
    );
    const toRemove = sortedKeys.slice(0, optimisticKeys.length - MAX_OPTIMISTIC_UPDATES);
    toRemove.forEach(key => {
      delete optimisticUpdates[key];
      if (optimisticTimeouts[key]) {
        clearTimeout(optimisticTimeouts[key]);
        delete optimisticTimeouts[key];
      }
    });
  }

  // perform the actual draw
  drawGrid();
  lastRenderTime = now;
  dirty = false;
}

// drawGrid remains the same but callers should call markDirty() instead of drawGrid()
function drawGrid() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let q = -GRID_RADIUS; q <= GRID_RADIUS; q++) {
    for (let r = Math.max(-GRID_RADIUS, -q - GRID_RADIUS); r <= Math.min(GRID_RADIUS, -q + GRID_RADIUS); r++) {
      const key = `${q},${r}`;
      const cell = getMergedState(q, r);
      const colorVal = (cell && (typeof cell === "object" ? cell.color : cell)) || "#0c0f1e";
      const upgradeVal = cell && cell.upgrade ? cell.upgrade : null;
      const terrainVal = cell && cell.terrain ? cell.terrain : null;
      const crown = cell && cell.crown;
      const isHover = hoverHex && hoverHex.q === q && hoverHex.r === r;
      drawHex(q, r, { color: colorVal, crown, upgrade: upgradeVal, terrain: terrainVal }, isHover, isHover ? hoverCost : null);

      // draw preview overlays on top of the authoritative tile (without changing tile)
      const preview = previews[key];
      if (preview) {
        const { x, y } = hexToPixel(q, r);
        const cx = offsetX + x * scale;
        const cy = offsetY + y * scale;
        const fontSize = Math.max(12, Math.round(HEX_SIZE * scale * 0.9));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = Math.max(2, Math.round(fontSize / 6));
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.fillStyle = "#fff";
        if (preview.type === "x") {
          ctx.strokeText("❌", cx, cy);
          ctx.fillText("❌", cx, cy);
        } else if (preview.type === "mountain") {
          ctx.strokeText("⛰️", cx, cy);
          ctx.fillText("⛰️", cx, cy);
        } else if (preview.type === "preview") {
          // optional different marker if you later add
          ctx.strokeText("•", cx, cy);
          ctx.fillText("•", cx, cy);
        }
      }
    }
  }
  hudPoints.textContent = `Points: ${myPoints} / Max: ${myMaxPoints} :)`;
  hudTiles.textContent = `Tiles: ${myTiles}`;
}

// schedule a draw instead of immediate draw
function scheduleDraw() {
  markDirty();
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

  scheduleDraw();
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
  scheduleDraw();
}, { passive: false });

// --- Modal helpers ---
let currentModalTile = null;
function openUpgradeModal(q, r, currentUpgrade) {
  currentModalTile = { q, r, currentUpgrade };
  if (incomeBtn) incomeBtn.textContent = `💰 Bank (100 pts)`;
  if (fortifyBtn) fortifyBtn.textContent = `🏰 Fort (300 pts)`;
  if (cityBtn) cityBtn.textContent = '🏢 City (200 pts)';
  if (upgradeModal) upgradeModal.classList.remove("hidden");
}
function closeUpgradeModal() {
  currentModalTile = null;
  if (upgradeModal) upgradeModal.classList.add("hidden");
}

// Hover throttle — avoid spamming server
let lastHoverSent = 0;
const HOVER_THROTTLE_MS = 150;

// --- Main flow ---
(async function start() {
  if (!roomId) {
    alert("No roomId to join!");
    return;
  }

  let room = null; // keep room available across handlers

  try {
    room = await client.joinById(roomId, { playerId, token });
    
    // Store room reference globally for sync functions
    window.currentRoom = room;

    // now that room/join succeeded, look up modal elements (DOM should be loaded)
    upgradeModal = document.getElementById("upgradeModal");
    fortifyBtn = document.getElementById("fortifyBtn");
    incomeBtn = document.getElementById("incomeBtn");
    cityBtn = document.getElementById("cityBtn");
    closeModalBtn = document.getElementById("closeModalBtn");

    // Safety: only add listeners if elements exist
    if (fortifyBtn) {
      fortifyBtn.addEventListener("click", () => {
        if (!currentModalTile) return;
        const { q, r } = currentModalTile;
        actionQueue.push({ type: 'upgradeHex', q, r, upgradeType: 'fort' });
        closeUpgradeModal();
      });
    }
    if (incomeBtn) {
      incomeBtn.addEventListener("click", () => {
        if (!currentModalTile) return;
        const { q, r } = currentModalTile;
        actionQueue.push({ type: 'upgradeHex', q, r, upgradeType: 'bank' });
        closeUpgradeModal();
      });
    }
    if (cityBtn) {
      cityBtn.addEventListener("click", () => {
        if (!currentModalTile) return;
        const { q, r} = currentModalTile;
        actionQueue.push({ type: 'upgradeHex', q, r, upgradeType: 'city' });
        closeUpgradeModal();
      })
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
      serverState = {};
      (cells || []).forEach(c => {
        const q = c.q ?? c.x;
        const r = c.r ?? c.y;
        const key = `${q},${r}`;
        serverState[key] = { color: c.color || "#0c0f1e", crown: !!c.crown, upgrade: c.upgrade || null, terrain: c.terrain || null };
      });
      scheduleDraw();
    });

    // server authoritative update: paint/upgrade a tile
    room.onMessage("update", ({ q, r, color, crown, upgrade, terrain }) => {
      const key = `${q},${r}`;
      // apply authoritative state
      serverState[key] = { color: color || "#0c0f1e", crown: !!crown, upgrade: upgrade || null, terrain: terrain || null };
      // clear any previews for this hex (e.g. an X) so we don't show overlays after success
      if (previews[key]) {
        delete previews[key];
      }
      // clear optimistic update since server confirmed
      clearOptimisticUpdate(q, r);

      // If player is actively dragging, coalesce redraws (scheduleDraw handles throttling)
      scheduleDraw();
    });

    room.onMessage("hoverCost", ({ q, r, cost }) => {
      // Only show cost if this is the tile we’re hovering
      if (hoverHex && hoverHex.q === q && hoverHex.r === r) {
        hoverCost = cost;
        scheduleDraw();
      }
    });

    room.onMessage("pointsUpdate", ({ playerId: pid, points, tiles, maxPoints }) => {
      // update local HUD when the message is about this player
      if (pid === playerId) {
        myPoints = points ?? myPoints;
        myTiles = tiles ?? myTiles;
        myMaxPoints = maxPoints ?? myMaxPoints;
        scheduleDraw();
      } else {
        // optionally update others if you show them (not used for HUD right now)
      }
    });

    room.onMessage("lobbyRoster", (list) => { renderRoster(list); scheduleDraw(); });

    room.onMessage("lobbyStartTime", ({ ts }) => {
      lobbyStartTime = ts;
      updateCountdown();
      if (countdownInterval) clearInterval(countdownInterval);
      countdownInterval = setInterval(updateCountdown, 500);
    });

    // Owned tile menu: open upgrade modal
    room.onMessage("openOwnedTileMenu", ({ q, r, upgrade }) => {
      // only allow opening if not in a drag session (deliberate click)
      if (!isDragging && !hadMoveDuringPointer) {
        openUpgradeModal(q, r, upgrade);
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

    // batch fill result
    room.onMessage("batchFillResult", ({ results }) => {
      (results || []).forEach(result => {
        const { q, r, ok, reason } = result;
        const key = `${q},${r}`;
        if (!ok) {
          if (reason === "insufficient") {
            // show a small ❌ overlay for 1s. do NOT mutate server state - that's authoritative.
            previews[key] = { type: "x" };
            scheduleDraw();
            setTimeout(() => {
              if (previews[key]) {
                delete previews[key];
                scheduleDraw();
              }
            }, 1000);
          } else if (reason === "impassable") {
            // show a mountain emoji overlay for 1s
            previews[key] = { type: "mountain" };
            scheduleDraw();
            setTimeout(() => {
              if (previews[key]) {
                delete previews[key];
                scheduleDraw();
              }
            }, 1000);
          } else {
            // other reasons could be handled similarly
            previews[key] = { type: "x" };
            scheduleDraw();
            setTimeout(() => {
              delete previews[key];
              scheduleDraw();
            }, 800);
          }
        }
        // Clear optimistic update regardless of success/failure
        clearOptimisticUpdate(q, r);
      });
    });

    // batch upgrade result
    room.onMessage("batchUpgradeResult", ({ results }) => {
      (results || []).forEach(result => {
        const { q, r, ok, error } = result;
        if (!ok) {
          console.warn("Upgrade failed:", error);
        }
        // Clear optimistic update regardless of success/failure
        clearOptimisticUpdate(q, r);
      });
    });

    // Individual fill result (for clickHex messages)
    room.onMessage("fillResult", ({ q, r, ok, reason }) => {
      const key = `${q},${r}`;
      if (!ok) {
        if (reason === "insufficient") {
          // show a small ❌ overlay for 1s. do NOT mutate server state - that's authoritative.
          previews[key] = { type: "x" };
          scheduleDraw();
          setTimeout(() => {
            if (previews[key]) {
              delete previews[key];
              scheduleDraw();
            }
          }, 1000);
        } else if (reason === "impassable") {
          // show a mountain emoji overlay for 1s
          previews[key] = { type: "mountain" };
          scheduleDraw();
          setTimeout(() => {
            if (previews[key]) {
              delete previews[key];
              scheduleDraw();
            }
          }, 1000);
        } else if (reason === "not_adjacent") {
          // show a ❌ overlay for non-adjacent hexes
          previews[key] = { type: "x" };
          scheduleDraw();
          setTimeout(() => {
            if (previews[key]) {
              delete previews[key];
              scheduleDraw();
            }
          }, 1000);
        } else {
          // other reasons could be handled similarly
          previews[key] = { type: "x" };
          scheduleDraw();
          setTimeout(() => {
            delete previews[key];
            scheduleDraw();
          }, 800);
        }
      }
      // Clear optimistic update regardless of success/failure
      clearOptimisticUpdate(q, r);
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

      // Only send hoverCost occasionally to avoid flooding server.
      // Also don't send hover while dragging (it isn't useful then).
      const now = Date.now();
      if (!isDragging && room && (now - lastHoverSent) >= HOVER_THROTTLE_MS) {
        lastHoverSent = now;
        pendingHoverRequest = { q, r };
      }

      // Visual hover update is cheap; schedule a draw
      scheduleDraw();
    });

    canvas.addEventListener("mouseleave", () => {
      hoverHex = null;
      hoverCost = null;
      scheduleDraw();
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
        const ownedKeys = Object.keys(serverState).filter(k => {
          const v = serverState[k];
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

        // Apply optimistic update for immediate feedback
        applyOptimisticUpdate(q, r, myColor);
        
        // Queue action for periodic sync instead of immediate send
        actionQueue.push({ type: 'fillHex', q, r });
      }

      // update hover coordinates for visuals (cheap)
      hoverHex = { q, r };
      scheduleDraw();
    }, { passive: true });

    canvas.addEventListener("pointerup", (e) => {
      // release pointer capture
      if (pointerIdCaptured !== null) {
        try { canvas.releasePointerCapture(pointerIdCaptured); } catch (_) {}
        pointerIdCaptured = null;
      }

      const rect = canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const { q, r } = pixelToHex(localX, localY);

      if (!hadMoveDuringPointer) {
        // ✅ deliberate click (no drag)
        const nowTs = Date.now();
        if (lobbyStartTime && nowTs <= lobbyStartTime + 5000 && !startChosen) {
          // choose starting tile (optimistic for start)
          applyOptimisticUpdate(q, r, myColor, true);
          scheduleDraw();
          actionQueue.push({ type: 'chooseStart', q, r });
          startChosen = true;
        } else {
          // For deliberate clicks, send individual message to handle modal opening
          if (window.currentRoom) window.currentRoom.send("clickHex", { q, r });
        }
      }

      // cleanup drag state
      isDragging = false;
      hadMoveDuringPointer = false;
      lastSentHex = null;

      // ensure we redraw now that drag ended (so background updates applied during drag appear)
      scheduleDraw();
    });

    // Timer
    setInterval(() => {
      const elapsed = Math.floor((Date.now() - gameStartTime) / 1000);
      if (elapsed < 0) return;
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      hudTime.textContent = `Time: ${mins}:${secs.toString().padStart(2, "0")}`;
    }, 1000);

    // Start periodic sync loop after room is fully initialized
    setInterval(() => {
      syncActionsToServer();
      syncHoverToServer();
      requestPointsUpdate();
    }, 100); // Run sync checks every 50ms

  } catch (e) {
    console.error("Failed to join game room:", e);
    alert("Failed to join game room. Check server logs.");
  }
})();
