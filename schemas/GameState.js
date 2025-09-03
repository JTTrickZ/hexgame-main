// schemas/GameState.js
const { Schema, type, MapSchema } = require("@colyseus/schema");

class Hex extends Schema {
  constructor() {
    super();
    this.q = "";
    this.r = "";
    this.color = "";
    this.playerId = "";
    this.upgrade = "";
    this.terrain = "";
    this.isCrown = false;
    this.captureTime = 0;
  }
}

// Define schema types for Hex
type(Hex, {
  q: "string",
  r: "string", 
  color: "string",
  playerId: "string",
  upgrade: "string",
  terrain: "string",
  isCrown: "boolean",
  captureTime: "number"
});

class Player extends Schema {
  constructor() {
    super();
    this.id = "";
    this.username = "";
    this.color = "";
    this.points = 0;
    this.maxPoints = 0;
    this.tiles = 0;
    this.startQ = "";
    this.startR = "";
    this.started = false;
    this.lastSeen = 0;
  }
}

// Define schema types for Player
type(Player, {
  id: "string",
  username: "string",
  color: "string",
  points: "number",
  maxPoints: "number",
  tiles: "number",
  startQ: "string",
  startR: "string",
  started: "boolean",
  lastSeen: "number"
});

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.hexes = new MapSchema();
    this.lobbyStartTime = 0;
    this.countdown = 0;
    this.gameId = "";
    this.gameStarted = false;
    this.lastUpdateTime = 0;
  }
}

// Define schema types for GameState
type(GameState, {
  players: { map: Player },
  hexes: { map: Hex },
  lobbyStartTime: "number",
  countdown: "number",
  gameId: "string",
  gameStarted: "boolean",
  lastUpdateTime: "number"
});

module.exports = { GameState, Player, Hex };
