// rooms/ReplayRoom.js
const colyseus = require("colyseus");

class ReplayRoom extends colyseus.Room {
  onCreate(options) {
    this.db = options.db;
    this.gameId = options.gameId;
    this.playing = false;
    this.playbackTimers = [];

    // load clicks (array of { playerId, color, x, y, ts })
    this.clicks = this.db.getClicksForGame(this.gameId) || [];

    // normalize to relative times
    if (this.clicks.length > 0) {
      const firstTs = this.clicks[0].ts || 0;
      this.clicks = this.clicks.map(c => ({
        ...c,
        rel: (c.ts || 0) - firstTs
      }));
    }

    console.log(
      `📼 ReplayRoom created for gameId=${this.gameId} with ${this.clicks.length} events`
    );
  }

  onJoin(client) {
    client.send("replayInfo", {
      gameId: this.gameId,
      totalEvents: this.clicks.length
    });

    if (!this.playing && this.clicks.length > 0) {
      this.startPlayback();
    } else if (this.clicks.length === 0) {
      client.send("replayEnd", {});
    }
  }

  startPlayback() {
    this.playing = true;
    this.clicks.forEach((ev, idx) => {
      const delay = Math.max(0, ev.rel);
      const timer = this.clock.setTimeout(() => {
        this.broadcast("replayEvent", {
          playerId: ev.playerId,
          color: ev.color,
          x: ev.x,
          y: ev.y
        });
        if (idx === this.clicks.length - 1) {
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
      this.disconnect();
    }
  }

  onDispose() {
    this.playbackTimers.forEach(t => t.clear && t.clear());
    this.playbackTimers = [];
    this.playing = false;
    console.log(`📼 ReplayRoom for ${this.gameId} disposed`);
  }
}

module.exports = { ReplayRoom };
