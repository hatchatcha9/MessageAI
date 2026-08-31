const fs   = require('fs');
const path = require('path');

const REMINDERS_PATH = path.join(__dirname, '..', 'reminders.json');

// In-memory store: userId -> [{ id, fireAt, message, timeout }]
// Keyed by String(userId): setReminder() gets a numeric sqlite user.id, but
// restoreFromDisk() reads JSON object keys which are always strings — without
// normalizing, reminders restored after a restart became invisible to
// getReminders()/cancelReminder() while still firing in the background.
const reminderStore = new Map();
let nextId = 1;

const _key = (userId) => String(userId);

// setTimeout's delay is a signed 32-bit int (~24.85 days). A larger delay
// silently overflows and fires almost immediately ("in 1000 hours" → now).
// longTimeout() chains max-sized chunks so far-future reminders fire when they
// should; the returned holder is what cancelReminder() clears.
const MAX_DELAY = 2147483647;
function longTimeout(fn, ms) {
    const holder = { _t: null, _cleared: false };
    const arm = (remaining) => {
        if (holder._cleared) return;
        if (remaining <= MAX_DELAY) {
            holder._t = setTimeout(fn, Math.max(0, remaining));
        } else {
            holder._t = setTimeout(() => arm(remaining - MAX_DELAY), MAX_DELAY);
        }
    };
    arm(ms);
    return holder;
}
function clearLongTimeout(holder) {
    if (!holder) return;
    holder._cleared = true;
    if (holder._t) clearTimeout(holder._t);
}

// ── Persistence ───────────────────────────────────────────────────────────────

function _saveToDisk() {
    const serializable = {};
    for (const [key, list] of reminderStore.entries()) {
        serializable[key] = list.map(({ id, fireAt, message }) => ({
            id,
            fireAt: fireAt.toISOString(),
            message,
        }));
    }
    try {
        fs.writeFileSync(REMINDERS_PATH, JSON.stringify(serializable, null, 2));
    } catch (e) {
        console.error('[Reminders] Failed to save:', e.message);
    }
}

function _removeFromStore(userId, id) {
    const k = _key(userId);
    const remaining = (reminderStore.get(k) || []).filter(r => r.id !== id);
    if (remaining.length) reminderStore.set(k, remaining);
    else reminderStore.delete(k);
}

function restoreFromDisk(onFire) {
    let saved;
    try {
        saved = JSON.parse(fs.readFileSync(REMINDERS_PATH, 'utf8'));
    } catch {
        return; // No file yet — normal on first run
    }

    const now = Date.now();
    let restored = 0;

    for (const [userId, list] of Object.entries(saved)) {
        for (const entry of list) {
            const fireAt = new Date(entry.fireAt);
            const msLeft = fireAt.getTime() - now;

            if (msLeft <= 0) continue; // Already past — skip silently

            const id = entry.id;
            if (id >= nextId) nextId = id + 1;

            const timeout = longTimeout(() => {
                onFire(userId, entry.message);
                _removeFromStore(userId, id);
                _saveToDisk();
            }, msLeft);

            const k = _key(userId);
            const userList = reminderStore.get(k) || [];
            userList.push({ id, fireAt, message: entry.message, timeout });
            reminderStore.set(k, userList);
            restored++;
        }
    }

    if (restored > 0) {
        console.log(`[Reminders] Restored ${restored} pending reminder(s) from disk`);
    }
}

// ── Core API ──────────────────────────────────────────────────────────────────

function setReminder(userId, timeStr, message, onFire) {
    const ms = parseToMs(timeStr);
    if (!ms) return {
        success: false,
        error: `I couldn't understand the time "${timeStr}". Try something like "5 minutes" or "2 hours".`,
    };

    const id     = nextId++;
    const fireAt = new Date(Date.now() + ms);

    const timeout = longTimeout(() => {
        onFire(userId, message);
        _removeFromStore(userId, id);
        _saveToDisk();
    }, ms);

    const k = _key(userId);
    const list = reminderStore.get(k) || [];
    list.push({ id, fireAt, message, timeout });
    reminderStore.set(k, list);
    _saveToDisk();

    return { success: true, id, fireAt, readableTime: formatMs(ms) };
}

function cancelReminder(userId, id) {
    const list = reminderStore.get(_key(userId)) || [];
    const reminder = list.find(r => r.id === id);
    if (!reminder) return false;
    clearLongTimeout(reminder.timeout);
    _removeFromStore(userId, id);
    _saveToDisk();
    return true;
}

function getReminders(userId) {
    return reminderStore.get(_key(userId)) || [];
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseToMs(timeStr) {
    timeStr = timeStr.toLowerCase().trim();

    // "X seconds/minutes/hours"
    const relMatch = timeStr.match(/(\d+)\s*(second|sec|minute|min|hour|hr)s?/);
    if (relMatch) {
        const n    = parseInt(relMatch[1]);
        const unit = relMatch[2];
        if (unit.startsWith('sec')) return n * 1000;
        if (unit.startsWith('min')) return n * 60 * 1000;
        if (unit === 'hour' || unit === 'hr') return n * 3600 * 1000;
    }

    // "HH:MM am/pm" or "H:MM"
    const clockMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
    if (clockMatch) {
        let h      = parseInt(clockMatch[1]);
        const m    = parseInt(clockMatch[2]);
        const ampm = clockMatch[3];
        if (ampm === 'pm' && h < 12) h += 12;
        if (ampm === 'am' && h === 12) h = 0;
        const target = new Date();
        target.setHours(h, m, 0, 0);
        if (target <= new Date()) target.setDate(target.getDate() + 1);
        return target - new Date();
    }

    return null;
}

function formatMs(ms) {
    if (ms < 60000)   return `${Math.round(ms / 1000)} seconds`;
    if (ms < 3600000) return `${Math.round(ms / 60000)} minutes`;
    return `${(ms / 3600000).toFixed(1)} hours`;
}

module.exports = { setReminder, cancelReminder, getReminders, restoreFromDisk };
