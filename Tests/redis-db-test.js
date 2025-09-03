// redis-db-test.js
const Redis = require("ioredis");

async function testRedisConnection(config, description) {
  console.log(`\n🔍 Testing Redis connection: ${description}`);
  console.log('Config:', config);
  
  return new Promise((resolve) => {
    const redis = new Redis(config);
    
    redis.on('error', (error) => {
      console.error(`❌ ${description} - Redis error:`, error.message);
      redis.disconnect();
      resolve(false);
    });
    
    redis.on('connect', () => {
      console.log(`✅ ${description} - Redis connected`);
    });
    
    redis.on('ready', async () => {
      console.log(`✅ ${description} - Redis ready`);
      
      try {
        const result = await redis.ping();
        console.log(`✅ ${description} - Ping successful: ${result}`);
        
        // Test basic operations
        await redis.set('test:key', 'test:value');
        const value = await redis.get('test:key');
        await redis.del('test:key');
        
        console.log(`✅ ${description} - Read/write test successful`);
        redis.disconnect();
        resolve(true);
      } catch (error) {
        console.error(`❌ ${description} - Operation failed:`, error.message);
        redis.disconnect();
        resolve(false);
      }
    });
    
    // Timeout after 5 seconds
    setTimeout(() => {
      console.error(`❌ ${description} - Connection timeout`);
      redis.disconnect();
      resolve(false);
    }, 5000);
  });
}

async function runTests() {
  console.log('🔍 Testing various Redis configurations...');
  
  const configs = [
    {
      host: '192.168.150.51',
      port: 6379,
      password: null,
      db: 0,
      connectTimeout: 10000,
      commandTimeout: 5000,
      lazyConnect: false,
      keepAlive: 30000,
      family: 4,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      maxLoadingTimeout: 10000
    },
    {
      host: '192.168.150.51',
      port: 6379,
      password: null,
      db: 1,
      connectTimeout: 10000,
      commandTimeout: 5000,
      lazyConnect: false,
      keepAlive: 30000,
      family: 4,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      maxLoadingTimeout: 10000
    },
    {
      host: '192.168.150.51',
      port: 6379,
      password: null,
      connectTimeout: 10000,
      commandTimeout: 5000,
      lazyConnect: false,
      keepAlive: 30000,
      family: 4,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      maxLoadingTimeout: 10000
    }
  ];
  
  const results = await Promise.all([
    testRedisConnection(configs[0], 'Database 0'),
    testRedisConnection(configs[1], 'Database 1'),
    testRedisConnection(configs[2], 'No database specified')
  ]);
  
  console.log('\n📊 Test Results:');
  console.log('Database 0:', results[0] ? '✅ PASS' : '❌ FAIL');
  console.log('Database 1:', results[1] ? '✅ PASS' : '❌ FAIL');
  console.log('No database:', results[2] ? '✅ PASS' : '❌ FAIL');
  
  if (results.some(r => r)) {
    console.log('\n✅ At least one configuration works!');
  } else {
    console.log('\n❌ All configurations failed');
  }
}

runTests();
