import axios from 'axios';
import fs from 'fs';
import path from 'path';

const BOT_URL = 'http://localhost:3001/webhook';
const SESSION_FILE = './sessions.json';

async function send(phone, text) {
  try {
    const res = await axios.post(BOT_URL, {
      phone: phone,
      message: text
    });
    return res.data;
  } catch (e) {
    console.error(`Error sending message: ${e.message}`);
    return null;
  }
}

async function runTests() {
  console.log('--- STARTING BOT V3 REGRESSION TESTS ---');

  // Test 1: Full Flow + Name Validation
  console.log('\n[TEST 1] Full Flow + Name Validation');
  await send('919999999991', 'hi');
  await send('919999999991', 'yes');
  
  // Try invalid name
  console.log('Sending invalid name "yes"...');
  await send('919999999991', 'yes'); 
  
  // After rejection, it should ask for City
  const resCity = await send('919999999991', 'Mumbai');
  console.log('Response after city:', JSON.stringify(resCity));

  // Test 2: State Guard (Knowledge Response Gating)
  console.log('\n[TEST 2] Knowledge Guard (Gating)');
  // We are currently in INSURANCE state for the above user
  const resGuard = await send('919999999991', 'What is the cost of LASIK?');
  if (resGuard && resGuard.reply && resGuard.reply.toLowerCase().includes('insurance')) {
    console.log('✅ Knowledge guard passed (stayed in Insurance flow)');
  } else {
    console.log('❌ Knowledge guard failed (replied with cost info during data collection)');
  }

  // Test 3: Multi-Intent
  console.log('\n[TEST 3] Multi-Intent');
  const resMulti = await send('918888888888', 'Hi, what is the cost and recover time?');
  if (resMulti && resMulti.reply && resMulti.reply.toLowerCase().includes('cost') && resMulti.reply.toLowerCase().includes('recovery')) {
    console.log('✅ Multi-intent passed (combined response)');
  } else {
    console.log('❌ Multi-intent failed');
  }

  // Test 4: Persistence
  console.log('\n[TEST 4] Persistence Check');
  await new Promise(r => setTimeout(r, 500)); // wait for debounce
  if (fs.existsSync(SESSION_FILE)) {
    const sessions = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (sessions['919999999991']) {
      console.log('✅ Persistence passed (session found in file)');
    } else {
      console.log('❌ Persistence failed (session not in file)');
    }
  } else {
    console.log('❌ Persistence failed (file not found)');
  }

  console.log('\n--- TESTS COMPLETE ---');
}

runTests();
