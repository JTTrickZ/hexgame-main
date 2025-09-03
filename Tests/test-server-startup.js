// test-server-startup.js
const { Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { RedisDriver } = require("@colyseus/redis-driver");
const http = require("http");
const config = require("./config");

console.log('🔍 Testing Colyseus server startup...');

// Create a simple HTTP server
const server = http.createServer();

// Create Redis driver
console.log('Creating Redis driver...');
const redisDriver = new RedisDriver({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db,
  connectTimeout: 10000,
  commandTimeout: 5000,
  lazyConnect: false,
  keepAlive: 30000,
  family: 4,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  maxLoadingTimeout: 10000
});

console.log('Redis driver created successfully');

// Create Colyseus server
console.log('Creating Colyseus server...');
const gameServer = new Server({
  transport: new WebSocketTransport({ 
    server,
    pingInterval: config.colyseus.server.pingInterval,
    pingMaxRetries: config.colyseus.server.pingMaxRetries,
    maxPayloadLength: config.colyseus.server.maxPayloadLength,
  }),
  driver: redisDriver,
  server: {
    healthCheckInterval: config.colyseus.server.healthCheckInterval,
    healthCheckTimeout: config.colyseus.server.healthCheckTimeout,
    roomCleanupInterval: config.colyseus.server.roomCleanupInterval,
    connectTimeout: config.colyseus.server.connectTimeout,
    disconnectTimeout: config.colyseus.server.disconnectTimeout,
  }
});

console.log('Colyseus server created successfully');

// Define a simple room
gameServer.define("testRoom", class {
  onCreate() {
    console.log('Test room created');
  }
  onJoin() {
    console.log('Player joined test room');
  }
});

// Start the server
server.listen(3001, () => {
  console.log('✅ Test server running on port 3001');
  console.log('✅ Redis driver configured successfully');
  console.log('✅ Colyseus server ready');
  
  // Graceful shutdown
  setTimeout(() => {
    console.log('Shutting down test server...');
    gameServer.gracefullyShutdown().then(() => {
      server.close();
      process.exit(0);
    });
  }, 5000);
});
