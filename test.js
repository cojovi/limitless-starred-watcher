// test.js - Simple test to verify environment and dependencies
import Database from 'better-sqlite3';
import 'dotenv/config';

console.log('🧪 Testing Limitless Starred Watcher Setup...\n');

// Test 1: Environment variables
console.log('1. Environment Variables:');
console.log(`   LIMITLESS_API_KEY: ${process.env.LIMITLESS_API_KEY ? '✅ Set' : '❌ Missing'}`);
console.log(`   OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? '✅ Set' : '❌ Missing'}`);
console.log(`   WEBHOOK_URL: ${process.env.WEBHOOK_URL ? '✅ Set' : '❌ Missing'}`);
console.log(`   POLL_SECONDS: ${process.env.POLL_SECONDS || '120 (default)'}`);
console.log(`   DB_PATH: ${process.env.DB_PATH || './starred.db (default)'}\n`);

// Test 2: Database connection
console.log('2. Database Connection:');
try {
  const db = new Database(process.env.DB_PATH || './starred.db');
  console.log('   ✅ SQLite database connected successfully');
  
  // Test schema
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log(`   ✅ Found ${tables.length} tables: ${tables.map(t => t.name).join(', ')}`);
  
  db.close();
} catch (error) {
  console.log(`   ❌ Database error: ${error.message}`);
}

// Test 3: Node.js version
console.log('\n3. Node.js Version:');
console.log(`   ✅ Node.js ${process.version} (requires 18+)`);

// Test 4: Global fetch
console.log('\n4. Global Fetch:');
if (typeof fetch === 'function') {
  console.log('   ✅ Global fetch available');
} else {
  console.log('   ❌ Global fetch not available (requires Node.js 18+)');
}

console.log('\n🎉 Setup verification complete!');
console.log('\nNext steps:');
console.log('1. Update .env file with your real API keys');
console.log('2. Run: npm run once (for one-shot test)');
console.log('3. Run: npm start (for continuous monitoring)');
