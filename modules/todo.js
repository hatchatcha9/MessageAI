/**
 * Todo list module for frog
 * Stores items in todos.json (project root). Graceful on all platforms.
 */
const fs   = require('fs');
const path = require('path');

const TODO_FILE = path.join(__dirname, '..', 'todos.json');

function _load() {
    try { return JSON.parse(fs.readFileSync(TODO_FILE, 'utf8')); }
    catch { return []; }
}

function _save(list) {
    try {
        const tmp = TODO_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
        fs.renameSync(tmp, TODO_FILE);   // atomic on same filesystem
    } catch (e) { console.error('[Todo] Save failed:', e.message); }
}

function addItem(text) {
    const list = _load();
    list.push({ id: Date.now(), text: text.trim(), done: false });
    _save(list);
    const activeCount = list.filter(i => !i.done).length;
    return `Added "${text.trim()}" to your list. You now have ${activeCount} item${activeCount !== 1 ? 's' : ''}.`;
}

function listItems() {
    const active = _load().filter(i => !i.done);
    if (active.length === 0) return 'Your to-do list is empty.';
    const items = active.map((item, i) => `${i + 1}. ${item.text}`).join(', ');
    return `You have ${active.length} item${active.length !== 1 ? 's' : ''}: ${items}.`;
}

function markDone(indexOrText) {
    const list = _load();
    const active = list.filter(i => !i.done);
    if (active.length === 0) return 'Your list is already empty.';

    const n = parseInt(indexOrText);
    let matched = null;
    if (!isNaN(n) && n >= 1 && n <= active.length) {
        matched = active[n - 1];
    } else {
        matched = active.find(i => i.text.toLowerCase().includes(String(indexOrText).toLowerCase()));
    }

    if (!matched) return `I couldn't find that item on your list.`;

    const idx = list.findIndex(i => i.id === matched.id);
    list[idx].done = true;
    _save(list);

    const remaining = list.filter(i => !i.done).length;
    return `Marked "${matched.text}" as done. ${remaining} item${remaining !== 1 ? 's' : ''} remaining.`;
}

function clearDone() {
    const list = _load();
    const kept = list.filter(i => !i.done);
    const removed = list.length - kept.length;
    _save(kept);
    if (removed === 0) return 'No completed items to clear.';
    return `Cleared ${removed} completed item${removed !== 1 ? 's' : ''}.`;
}

module.exports = { addItem, listItems, markDone, clearDone };
