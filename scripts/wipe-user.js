#!/usr/bin/env node
// One-off: fully wipe a single SMS user so their next text starts new-user
// onboarding from scratch. Clears conversation history, cart, sessions, DoorDash
// cache, order records, saved delivery address, linked DoorDash login, PIN, and
// resets preferences.
//
// Usage:   node scripts/wipe-user.js +18018006072
// Railway: railway run node scripts/wipe-user.js +18018006072
//
// Pass --keep-orders to leave the orders table alone (note: onboarding only
// re-triggers when the user has zero orders).

require('dotenv').config();
const db = require('./../db');

const phone = process.argv[2];
const keepOrders = process.argv.includes('--keep-orders');

if (!phone || !/^\+\d{8,15}$/.test(phone)) {
  console.error('Usage: node scripts/wipe-user.js +1XXXXXXXXXX [--keep-orders]');
  process.exit(1);
}

const raw = db.db;
const user = raw.prepare('SELECT id FROM users WHERE phone_number = ?').get(phone);
if (!user) {
  console.log(`No user row for ${phone} — already clean, nothing to do.`);
  process.exit(0);
}
const uid = user.id;

const before = {
  conversations: raw.prepare('SELECT COUNT(*) c FROM conversations WHERE user_id = ?').get(uid).c,
  carts: raw.prepare('SELECT COUNT(*) c FROM carts WHERE user_id = ?').get(uid).c,
  sessions: raw.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(uid).c,
  orders: raw.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(uid).c,
  doordash_cache: raw.prepare('SELECT COUNT(*) c FROM doordash_cache WHERE user_id = ?').get(uid).c,
  has_address: !!raw.prepare('SELECT address_encrypted FROM users WHERE id = ?').get(uid).address_encrypted,
  has_dd_login: !!raw.prepare('SELECT doordash_credentials_encrypted FROM users WHERE id = ?').get(uid).doordash_credentials_encrypted,
};
console.log(`user ${phone} (id ${uid}) — before:`, JSON.stringify(before));

const wipe = raw.transaction(() => {
  raw.prepare('DELETE FROM conversations WHERE user_id = ?').run(uid);
  raw.prepare('DELETE FROM carts WHERE user_id = ?').run(uid);
  raw.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
  raw.prepare('DELETE FROM doordash_cache WHERE user_id = ?').run(uid);
  if (!keepOrders) raw.prepare('DELETE FROM orders WHERE user_id = ?').run(uid);
  raw.prepare(`
    UPDATE users
       SET address_encrypted = NULL,
           doordash_credentials_encrypted = NULL,
           pin_hash = NULL,
           preferences = '{}',
           last_active = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(uid);
});
wipe();

const after = {
  conversations: raw.prepare('SELECT COUNT(*) c FROM conversations WHERE user_id = ?').get(uid).c,
  carts: raw.prepare('SELECT COUNT(*) c FROM carts WHERE user_id = ?').get(uid).c,
  sessions: raw.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(uid).c,
  orders: raw.prepare('SELECT COUNT(*) c FROM orders WHERE user_id = ?').get(uid).c,
  doordash_cache: raw.prepare('SELECT COUNT(*) c FROM doordash_cache WHERE user_id = ?').get(uid).c,
  has_address: !!raw.prepare('SELECT address_encrypted FROM users WHERE id = ?').get(uid).address_encrypted,
  has_dd_login: !!raw.prepare('SELECT doordash_credentials_encrypted FROM users WHERE id = ?').get(uid).doordash_credentials_encrypted,
};
console.log(`after: `, JSON.stringify(after));
console.log(keepOrders ? 'Done (kept orders).' : 'Done — full wipe. Next text from this number runs onboarding.');
