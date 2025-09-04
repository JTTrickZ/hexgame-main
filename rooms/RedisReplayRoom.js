// rooms/RedisReplayRoom.js
const { Room } = require("colyseus");
const GameData = require("../redis/GameData");

class RedisReplayRoom extends Room {
  onCreate(options) {
    this.gameData = new GameData();
    this.gameId = options.gameId;
    this.playing = false;
    this.playbackTimers = [];

    this.loadGameEvents();
    console.log(`📼 RedisReplayRoom created for gameId=${this.gameId}`);
  }

  async loadGameEvents() {
    try {
      this.events = await this.gameData.getGameEvents(this.gameId) || [];

      // Normalize to relative times
      if (this.events.length > 0) {
        const firstTs = this.events[0].timestamp || 0;
        this.events = this.events.map(ev => ({
          ...ev,
          rel: (ev.timestamp || 0) - firstTs
        }));
      }

      console.log(`📼 Loaded ${this.events.length} events for game ${this.gameId}`);
    } catch (e) {
      console.error("Failed to load game events:", e);
      this.events = [];
    }
  }

  onJoin(client) {
    client.send("replayInfo", {
      gameId: this.gameId,
      totalEvents: this.events.length
    });

    if (!this.playing && this.events.length > 0) {
      this.startPlayback();
    } else if (this.events.length === 0) {
      client.send("replayEnd", {});
    }
  }

  startPlayback() {
    this.playing = true;
    this.events.forEach((ev, idx) => {
      const delay = Math.max(0, ev.rel);
      const timer = this.clock.setTimeout(() => {
        this.broadcast("replayEvent", {
          playerId: ev.playerId,
          color: ev.color,
          q: parseInt(ev.q),
          r: parseInt(ev.r),
          eventType: ev.eventType
        });
        if (idx === this.events.length - 1) {
          this.broadcast("replayEnd", {});
        }
      }, delay);
      this.playbackTimers.push(timer);
    });
  }

  onLeave() {
    if (this.clients.length === 0) {
      this.playbackTimers.forEach(t => t.clear && t.clear());
      this.playbackTimers = [];
      this.playing = false;
      // Let the room dispose naturally instead of calling disconnect immediately
      console.log(`📼 RedisReplayRoom ${this.gameId} empty - will be disposed naturally`);
    }
  }

  onDispose() {
    this.playbackTimers.forEach(t => t.clear && t.clear());
    this.playbackTimers = [];
    this.playing = false;
    try {
      if (this.gameData) {
        // Use setTimeout to defer the disconnect and avoid blocking
        setTimeout(() => {
          this.gameData.disconnect().catch(err => {
            console.warn("Redis disconnect error (ignored):", err.message);
          });
        }, 0);
      }
    } catch (error) {
      console.warn("Error disposing RedisReplayRoom:", error.message);
    }
    console.log(`📼 RedisReplayRoom for ${this.gameId} disposed`);
  }
}

module.exports = { RedisReplayRoom };
