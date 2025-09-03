// redis/RedisManager.js
const Redis = require("ioredis");
const config = require("../config");

// Parse -local flag
const useLocalRedis = process.argv.includes('-local');
const redisConfig = useLocalRedis ? config.redisLocal : config.redis;

class RedisManager {
  constructor() {
    if (RedisManager.instance) {
      return RedisManager.instance;
    }
    
    this.connections = new Map();
    this.connectionPool = [];
    this.maxConnections = 10;
    this.currentConnections = 0;
    this.redisConfig = redisConfig;
    
    RedisManager.instance = this;
  }

  // Get a Redis connection from the pool
  async getConnection() {
    if (this.connectionPool.length > 0) {
      return this.connectionPool.pop();
    }
    
    if (this.currentConnections < this.maxConnections) {
      const connection = this.createConnection();
      this.currentConnections++;
      return connection;
    }
    
    // Wait for a connection to become available
    return new Promise((resolve) => {
      const checkPool = () => {
        if (this.connectionPool.length > 0) {
          resolve(this.connectionPool.pop());
        } else {
          setTimeout(checkPool, 100);
        }
      };
      checkPool();
    });
  }

  // Return a connection to the pool
  returnConnection(connection) {
    if (connection && !connection.closed) {
      this.connectionPool.push(connection);
    }
  }

  // Create a new Redis connection
  createConnection() {
    const redis = new Redis(this.redisConfig);
    
    redis.on('error', (error) => {
      console.error('❌ Redis connection error:', error.message);
    });
    
    redis.on('close', () => {
      console.warn('⚠️ Redis connection closed');
      this.currentConnections--;
    });
    
    redis.on('end', () => {
      console.warn('⚠️ Redis connection ended');
      this.currentConnections--;
    });
    
    return redis;
  }

  // Get a connection for a specific room
  async getRoomConnection(roomId) {
    if (!this.connections.has(roomId)) {
      const connection = await this.getConnection();
      this.connections.set(roomId, connection);
    }
    return this.connections.get(roomId);
  }

  // Release a room's connection
  releaseRoomConnection(roomId) {
    const connection = this.connections.get(roomId);
    if (connection) {
      this.returnConnection(connection);
      this.connections.delete(roomId);
    }
  }

  // Test connection health
  async testConnection() {
    try {
      const connection = await this.getConnection();
      const start = Date.now();
      await connection.ping();
      const latency = Date.now() - start;
      this.returnConnection(connection);
      console.log(`✅ Redis connection test successful (${latency}ms latency)`);
      return true;
    } catch (error) {
      console.error('❌ Redis connection test failed:', error.message);
      return false;
    }
  }

  // Cleanup all connections
  async cleanup() {
    console.log('🧹 Cleaning up Redis connections...');
    
    for (const [roomId, connection] of this.connections) {
      if (connection && !connection.closed) {
        await connection.disconnect();
      }
    }
    
    for (const connection of this.connectionPool) {
      if (connection && !connection.closed) {
        await connection.disconnect();
      }
    }
    
    this.connections.clear();
    this.connectionPool = [];
    this.currentConnections = 0;
    
    console.log('✅ Redis connections cleaned up');
  }
}

module.exports = new RedisManager();
