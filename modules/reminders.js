// In-memory reminder store: userId -> [{ id, fireAt, message, timeout }]
const reminderStore = new Map();
let nextId = 1;

function setReminder(userId, timeStr, message, onFire) {
    const ms = parseToMs(timeStr);
    if (!ms) return { success: false, error: `I couldn't understand the time "${timeStr}". Try something like "5 minutes" or "2 hours".` };

    const id = nextId++;
    const fireAt = new Date(Date.now() + ms);

    const timeout = setTimeout(() => {
        onFire(userId, message);
        const list = reminderStore.get(userId) || [];
        reminderStore.set(userId, list.filter(r => r.id !== id));
    }, ms);

    const list = reminderStore.get(userId) || [];
    list.push({ id, fireAt, message, timeout });
    reminderStore.set(userId, list);

    return { success: true, id, fireAt, readableTime: formatMs(ms) };
}

function cancelReminder(userId, id) {
    const list = reminderStore.get(userId) || [];
    const reminder = list.find(r => r.id === id);
    if (!reminder) return false;
    clearTimeout(reminder.timeout);
    reminderStore.set(userId, list.filter(r => r.id !== id));
    return true;
}

function getReminders(userId) {
    return reminderStore.get(userId) || [];
}

function parseToMs(timeStr) {
    timeStr = timeStr.toLowerCase().trim();

    // "X seconds/minutes/hours"
    const relMatch = timeStr.match(/(\d+)\s*(second|sec|minute|min|hour|hr)s?/);
    if (relMatch) {
        const n = parseInt(relMatch[1]);
        const unit = relMatch[2];
        if (unit.startsWith('sec')) return n * 1000;
        if (unit.startsWith('min')) return n * 60 * 1000;
        if (unit === 'hour' || unit === 'hr') return n * 3600 * 1000;
    }

    // "HH:MM am/pm" or "H:MM"
    const clockMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
    if (clockMatch) {
        let h = parseInt(clockMatch[1]);
        const m = parseInt(clockMatch[2]);
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
    if (ms < 60000) return `${Math.round(ms / 1000)} seconds`;
    if (ms < 3600000) return `${Math.round(ms / 60000)} minutes`;
    return `${(ms / 3600000).toFixed(1)} hours`;
}

module.exports = { setReminder, cancelReminder, getReminders };
