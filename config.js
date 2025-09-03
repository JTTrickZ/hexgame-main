// config.js
module.exports = {
  // Redis Configuration
  redis: {
    host: process.env.REDIS_HOST || '192.168.1.152',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || null,
    db: process.env.REDIS_DB || 0,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3
  },

  // Server Configuration
  server: {
    port: process.env.PORT || 3000,
    hmacSecret: process.env.PLAYER_SECRET || "dev-secret-change-me"
  },

  // Game Constants
  game: {
    // Timing
    startDelay: 5000, // ms
    autoExpandInterval: 10000, // ms
    
    // Hex Values
    hexValue: 10,
    hexMaintenanceCost: 3,
    
    // Expansion
    expGrowth: 5, // how fast expansion escalates (logarithmic)
    
    // Attacking
    occupiedBase: 5, // minimum extra cost when attacking another player
    attackMult: 2.5, // scales based on defender strength
    
    // Economy
    baseIncome: 2, // per turn or per tick income
    startingPoints: 200, // starting points for new players
    startingMaxPoints: 200, // starting max points for new players
    
    // Upgrades
    upgradeBankCost: 100,
    upgradeFortCost: 300,
    upgradeCityCost: 200,
    
    // Auto expansion params
    autoCaptureThreshold: 3, // need >= 4 same-owner neighbors to capture
    
    // Mountain generation params
    mountainChains: 3, // number of mountain chains to generate
    mountainChainLength: 8, // length of each mountain chain
    mountainDensity: 0.15, // density of mountain branching
    
    // Player colors
    playerColors: [
      "#e74c3c", "#3498db", "#2ecc71", "#f1c40f", 
      "#9b59b6", "#e67e22", "#1abc9c", "#c0392b"
    ]
  },

  // Colyseus Configuration
  colyseus: {
    patchRate: 50, // ms - how often to send state updates
    presence: {
      // Redis presence configuration
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || null,
        db: process.env.REDIS_PRESENCE_DB || 1
      }
    }
  }
};
