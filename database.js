// database.js
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const dbPath = path.join(__dirname, "game.db");
const db = new Database(dbPath);

const now = () => Date.now();

// --- Init schema ---
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  color TEXT NOT NULL DEFAULT '#5865f2',
  sessionId TEXT,
  lastGames TEXT, -- JSON array of last 10 games [{gameId,color,username}]
  createdAt INTEGER NOT NULL,
  lastSeen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  closedAt INTEGER,
  startPlayers TEXT -- JSON array [{playerId,color,username}]
);

CREATE TABLE IF NOT EXISTS lobby_players (
  lobbyId TEXT,
  playerId TEXT,
  joinedAt INTEGER,
  PRIMARY KEY (lobbyId, playerId)
);
`);

// --- Players ---
function createPlayer(username) {
  const pid = `player_${crypto.randomBytes(5).toString("hex")}`;
  const defaultColor = "#5865f2";
  db.prepare(
    `INSERT INTO players (id, username, color, createdAt, lastSeen, lastGames)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(pid, username, defaultColor, now(), now(), JSON.stringify([]));
  return pid;
}

function getPlayer(playerId) {
  const row = db.prepare(`SELECT * FROM players WHERE id = ?`).get(playerId);
  if (!row) return null;
  return { ...row, lastGames: JSON.parse(row.lastGames || "[]") };
}

function getPlayerByUsername(username) {
  const row = db.prepare(`SELECT * FROM players WHERE LOWER(username) = LOWER(?)`).get(username);
  if (!row) return null;
  return { ...row, lastGames: JSON.parse(row.lastGames || "[]") };
}

function playerExists(playerId) {
  return !!db.prepare("SELECT 1 FROM players WHERE id = ?").get(playerId);
}

function updatePlayerColor(playerId, color) {
  db.prepare(`UPDATE players SET color = ?, lastSeen = ? WHERE id = ?`).run(color, now(), playerId);
}

function updateSession(playerId, sessionId) {
  db.prepare(`UPDATE players SET sessionId = ?, lastSeen = ? WHERE id = ?`).run(sessionId, now(), playerId);
}

function clearSession(playerId) {
  db.prepare(`UPDATE players SET sessionId = NULL, lastSeen = ? WHERE id = ?`).run(now(), playerId);
}

function touchPlayer(playerId) {
  db.prepare(`UPDATE players SET lastSeen = ? WHERE id = ?`).run(now(), playerId);
}

// --- Last games per player ---
function addPlayerGame(playerId, gameId, color) {
  const player = getPlayer(playerId);
  if (!player) return;
  const lastGames = player.lastGames || [];
  lastGames.unshift({ gameId, color, ts: now() }); // newest first
  if (lastGames.length > 10) lastGames.pop(); // keep last 10 only
  db.prepare(`UPDATE players SET lastGames = ?, lastSeen = ? WHERE id = ?`)
    .run(JSON.stringify(lastGames), now(), playerId);
}

function getLastGames(playerId) {
  const player = getPlayer(playerId);
  return player?.lastGames || [];
}

// --- Games ---
function createGame(gameId, startPlayers = []) {
  const jsonPlayers = JSON.stringify(startPlayers); // [{playerId,color,username}]
  db.prepare(`INSERT OR IGNORE INTO games (id, createdAt, startPlayers) VALUES (?, ?, ?)`)
    .run(gameId, now(), jsonPlayers);

  // update each player's lastGames
  startPlayers.forEach(p => addPlayerGame(p.playerId, gameId, p.color));
}

function closeGame(gameId) {
  db.prepare(`UPDATE games SET closedAt = ? WHERE id = ?`).run(now(), gameId);
}

function getGame(gameId) {
  const row = db.prepare(`SELECT * FROM games WHERE id = ?`).get(gameId);
  if (!row) return null;
  return { ...row, startPlayers: JSON.parse(row.startPlayers || "[]") };
}

// --- Lobby players ---
function addPlayerToLobby(lobbyId, playerId) {
  db.prepare(`INSERT OR IGNORE INTO lobby_players (lobbyId, playerId, joinedAt) VALUES (?, ?, ?)`)
    .run(lobbyId, playerId, now());
}

function removePlayerFromLobby(lobbyId, playerId) {
  db.prepare(`DELETE FROM lobby_players WHERE lobbyId = ? AND playerId = ?`).run(lobbyId, playerId);
}

function getLobbyPlayers(lobbyId) {
  return db.prepare(`
    SELECT lp.playerId, p.username, p.color 
    FROM lobby_players lp 
    JOIN players p ON p.id = lp.playerId 
    WHERE lp.lobbyId = ?
  `).all(lobbyId);
}

// --- Per-game hexes (now includes 'upgrade' and upgrade timestamp) ---
function safeHexTable(gameId) {
  return `game_${String(gameId).replace(/[^a-zA-Z0-9_]/g, "_")}_hexes`;
}

function createHexTable(gameId) {
  const table = safeHexTable(gameId);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      q INTEGER,
      r INTEGER,
      playerId TEXT,
      color TEXT,
      upgrade TEXT,
      upgrade_ts INTEGER,
      ts INTEGER,
      PRIMARY KEY (q, r)
    )
  `);
  return table;
}

// setHex: sets owner/color and optional upgrade (if provided).
// If you call with upgrade === undefined, we won't change the upgrade column.
function setHex(gameId, q, r, playerId, color, upgrade) {
  const table = createHexTable(gameId);
  if (typeof upgrade === "undefined") {
    // preserve existing upgrade if present
    db.prepare(`
      INSERT INTO ${table} (q, r, playerId, color, ts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(q, r) DO UPDATE SET
        playerId=excluded.playerId,
        color=excluded.color,
        ts=excluded.ts
    `).run(q, r, playerId, color, now());
  } else {
    db.prepare(`
      INSERT INTO ${table} (q, r, playerId, color, upgrade, upgrade_ts, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(q, r) DO UPDATE SET
        playerId=excluded.playerId,
        color=excluded.color,
        upgrade=excluded.upgrade,
        upgrade_ts=excluded.upgrade_ts,
        ts=excluded.ts
    `).run(q, r, playerId, color, upgrade, now(), now());
  }
}

// set only the upgrade field (keeps owner/color intact)
function setHexUpgrade(gameId, q, r, upgrade) {
  const table = createHexTable(gameId);
  db.prepare(`
    INSERT INTO ${table} (q, r, upgrade, upgrade_ts)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(q, r) DO UPDATE SET
      upgrade=excluded.upgrade,
      upgrade_ts=excluded.upgrade_ts
  `).run(q, r, upgrade, now());
}

// Get the upgrade for a specific hex
function getHexUpgrade(gameId, q, r) {
  const hex = getHexOwner(gameId, q, r);
  return hex?.upgrade || null;
}

// Get all upgrades of a given type (or all if type is null)
function getAllUpgrades(gameId, type = null) {
  const allHexes = getAllHexes(gameId);
  return allHexes
    .filter(h => h.upgrade && (!type || h.upgrade === type))
    .map(h => ({
      q: h.q,
      r: h.r,
      playerId: h.playerId,
      upgrade: h.upgrade,
      upgrade_ts: h.upgrade_ts
    }));
}

function getAllHexes(gameId) {
  const table = safeHexTable(gameId);
  try {
    return db.prepare(`SELECT q, r, playerId, color, upgrade, upgrade_ts, ts FROM ${table}`).all();
  } catch {
    return [];
  }
}

function getHexOwner(gameId, q, r) {
  const table = safeHexTable(gameId);
  try {
    return db.prepare(`SELECT q, r, playerId, color, upgrade, upgrade_ts, ts FROM ${table} WHERE q = ? AND r = ?`).get(q, r);
  } catch {
    return null;
  }
}

function getHexCountForPlayer(gameId, playerId) {
  const hexes = getAllHexes(gameId);
  return hexes.filter(h => h.playerId === playerId).length;
}

// ---------------- Game clicks (legacy history, keep) ----------------
function safeTableName(gameId) {
  return `game_${String(gameId).replace(/[^a-zA-Z0-9_]/g, "_")}`;
}
function createGameTable(gameId) {
  const table = safeTableName(gameId);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id INTEGER PRIMARY KEY,
      playerId TEXT,
      color TEXT,
      x INTEGER,
      y INTEGER,
      ts INTEGER
    )
  `);
  return table;
}
function saveClickToGame(gameId, playerId, color, x, y) {
  const table = createGameTable(gameId);
  db.prepare(`INSERT INTO ${table} (playerId, color, x, y, ts) VALUES (?, ?, ?, ?, ?)`)
    .run(playerId, color, Math.floor(x), Math.floor(y), now());
}
function getClicksForGame(gameId) {
  const table = safeTableName(gameId);
  try {
    return db.prepare(`SELECT playerId, color, x, y, ts FROM ${table} ORDER BY id ASC`).all();
  } catch {
    return [];
  }
}

function safePlayersTableName(gameId) {
  return `game_${String(gameId).replace(/[^a-zA-Z0-9_]/g, "_")}_players`;
}

// new helper: create all per-game tables (hexes, clicks and players)
function createGameTables(gameId) {
  createHexTable(gameId);
  createGameTable(gameId);
  createPlayersTable(gameId);
}

function createPlayersTable(gameId) {
  const table = safePlayersTableName(gameId);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      playerId TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 10,
      maxPoints INTEGER NOT NULL DEFAULT 50, -- 💰 new cap column
      startQ INTEGER,
      startR INTEGER,
      lastUpdate INTEGER NOT NULL
    )
  `);
  return table;
}

function initPlayerInGame(gameId, playerId, startQ, startR) {
  const table = createPlayersTable(gameId);

  db.prepare(`
    INSERT OR IGNORE INTO ${table} (playerId, points, maxPoints, startQ, startR, lastUpdate)
    VALUES (?, 10, 50, ?, ?, ?)
  `).run(playerId, startQ, startR, Date.now());

  // update spawn coords
  db.prepare(`
    UPDATE ${table}
    SET startQ = ?, startR = ?, lastUpdate = ?
    WHERE playerId = ?
  `).run(
    Number.isFinite(startQ) ? startQ : null,
    Number.isFinite(startR) ? startR : null,
    Date.now(),
    playerId
  );

  return db.prepare(`SELECT * FROM ${table} WHERE playerId = ?`).get(playerId);
}


function recalcMaxPoints(gameId, playerId) {
  const upgrades = getPlayerUpgradeCounts(gameId);
  const banks = upgrades[playerId]?.banks || 0;
  const table = safePlayersTableName(gameId);
  const baseCap = 200;
  const perBank = 150;
  const newCap = baseCap + banks * perBank;

  const row = getPlayerPoints(gameId, playerId);
  const clamped = Math.min(row.points, newCap);

  db.prepare(`UPDATE ${table} SET maxPoints = ?, points = ?, lastUpdate = ? WHERE playerId = ?`)
    .run(newCap, clamped, Date.now(), playerId);

  return { points: clamped, maxPoints: newCap };
}

function updatePlayerPoints(gameId, playerId, points) {
  const table = safePlayersTableName(gameId);
  const row = getPlayerPoints(gameId, playerId);
  const capped = Math.min(points, row.maxPoints);
  db.prepare(`UPDATE ${table} SET points = ?, lastUpdate = ? WHERE playerId = ?`)
    .run(capped, Date.now(), playerId);
}

function getPlayerPoints(gameId, playerId) {
  const table = safePlayersTableName(gameId);
  let row = db.prepare(`SELECT * FROM ${table} WHERE playerId = ?`).get(playerId);
  if (!row) {
    db.prepare(`
      INSERT INTO ${table} (playerId, points, maxPoints, startQ, startR, lastUpdate)
      VALUES (?, 10, 50, NULL, NULL, ?)
    `).run(playerId, Date.now());
    row = db.prepare(`SELECT * FROM ${table} WHERE playerId = ?`).get(playerId);
  }
  return row;
}

function getPlayerUpgradeCounts(gameId) {
  const allHexes = getAllHexes(gameId);
  const counts = {};

  allHexes.forEach(h => {
    if (!h.upgrade) return;
    if (!counts[h.playerId]) counts[h.playerId] = { forts: 0, banks: 0, cities: 0};

    if (h.upgrade === "fort") counts[h.playerId].forts += 1;
    if (h.upgrade === "bank") counts[h.playerId].banks += 1;
    if (h.upgrade === "City") counts[h.playerId].cities += 1;
  });

  return counts;
}

function getAllPlayersInGame(gameId) {
  const table = safePlayersTableName(gameId);
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } catch (e) {
    return [];
  }
}

module.exports = {
  createPlayer, getPlayer, getPlayerByUsername, playerExists,
  updatePlayerColor, updateSession, clearSession, touchPlayer,
  addPlayerGame, getLastGames,
  createGame, closeGame, getGame,
  addPlayerToLobby, removePlayerFromLobby, getLobbyPlayers,
  createGameTable, saveClickToGame, getClicksForGame, safePlayersTableName, safeTableName, createPlayersTable, initPlayerInGame,
  updatePlayerPoints, getPlayerPoints, getAllPlayersInGame, createHexTable, setHex, setHexUpgrade: setHexUpgrade, getAllHexes, getHexOwner, getHexCountForPlayer, createGameTables, getHexUpgrade,
  getAllUpgrades, getPlayerUpgradeCounts, recalcMaxPoints
};
