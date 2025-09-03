// test-redis-connectivity.js
const Redis = require("ioredis");
const config = require("./config");

console.log('🔍 Testing Redis connectivity...');
console.log('Redis config:', {
  host: config.redis.host,
  port: config.redis.port,
  db: config.redis.db
});

const redis = new Redis(config.redis);

redis.on('error', (error) => {
  console.error('❌ Redis connection error:', error.message);
  console.error('Error details:', {
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    address: error.address,
    port: error.port
  });
  process.exit(1);
});

redis.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

redis.on('ready', async () => {
  console.log('✅ Redis ready for commands');
  
  try {
    const start = Date.now();
    const result = await redis.ping();
    const latency = Date.now() - start;
    
    console.log(`✅ Redis ping successful: ${result} (${latency}ms latency)`);
    
    // Test basic operations
    await redis.set('test:key', 'test:value');
    const value = await redis.get('test:key');
    await redis.del('test:key');
    
    console.log('✅ Redis read/write test successful');
    console.log('✅ Redis connectivity test completed successfully');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Redis operation test failed:', error.message);
    process.exit(1);
  }
});

// Timeout after 10 seconds
setTimeout(() => {
  console.error('❌ Redis connection timeout after 10 seconds');
  process.exit(1);
}, 10000);
