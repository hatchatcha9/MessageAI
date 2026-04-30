const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

// Initialize database — use DB_PATH env var for production (persistent volume)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'messageai.db');
let db;
try {
    db = new Database(DB_PATH);
} catch (err) {
    console.error('[DB] Failed to open database:', err.message);
    process.exit(1);
}

// Encryption key - in production, use a key management service
// For now, we'll generate one and store it in .env
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ALGORITHM = 'aes-256-gcm';

// Encryption helpers
function encrypt(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText) {
    if (!encryptedText) return null;
    try {
        const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
        const decipher = crypto.createDecipheriv(
            ALGORITHM,
            Buffer.from(ENCRYPTION_KEY, 'hex'),
            Buffer.from(ivHex, 'hex')
        );
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error('Decryption error:', error.message);
        return null;
    }
}

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number TEXT UNIQUE NOT NULL,
        pin_hash TEXT,
        address_encrypted TEXT,
        doordash_credentials_encrypted TEXT,
        preferences TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        authenticated INTEGER DEFAULT 0,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

    CREATE TABLE IF NOT EXISTS carts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE NOT NULL,
        restaurant_id TEXT,
        items TEXT DEFAULT '[]',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        restaurant_id TEXT NOT NULL,
        restaurant_name TEXT NOT NULL,
        items TEXT NOT NULL,
        address TEXT NOT NULL,
        subtotal REAL NOT NULL,
        total REAL NOT NULL,
        status TEXT DEFAULT 'placed',
        placed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
`);

// Migration: Add doordash_credentials_encrypted column if it doesn't exist
try {
    db.exec(`ALTER TABLE users ADD COLUMN doordash_credentials_encrypted TEXT`);
    console.log('[DB] Added doordash_credentials_encrypted column');
} catch (e) {}

// Migration: Add order tracking columns
try { db.exec(`ALTER TABLE orders ADD COLUMN doordash_order_id TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN tracking_url TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN last_known_status TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN phone_number TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN restaurant_url TEXT`); } catch (e) {}

// Create DoorDash cache table for real restaurant/menu data
db.exec(`
    CREATE TABLE IF NOT EXISTS doordash_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        cache_type TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, cache_type, cache_key)
    );

    CREATE INDEX IF NOT EXISTS idx_doordash_cache_user ON doordash_cache(user_id);
    CREATE INDEX IF NOT EXISTS idx_doordash_cache_expires ON doordash_cache(expires_at);
`);

// User functions
function getOrCreateUser(phoneNumber) {
    let user = db.prepare('SELECT * FROM users WHERE phone_number = ?').get(phoneNumber);

    if (!user) {
        const result = db.prepare('INSERT INTO users (phone_number) VALUES (?)').run(phoneNumber);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
        console.log(`[DB] New user created: ${phoneNumber}`);
    } else {
        db.prepare('UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    }

    return user;
}

function getUserByPhone(phoneNumber) {
    return db.prepare('SELECT * FROM users WHERE phone_number = ?').get(phoneNumber);
}

function setUserPin(userId, pin) {
    const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(pinHash, userId);
}

function verifyUserPin(userId, pin) {
    const user = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(userId);
    if (!user || !user.pin_hash) return false;
    const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
    return user.pin_hash === pinHash;
}

function setUserAddress(userId, address) {
    const encrypted = encrypt(address);
    db.prepare('UPDATE users SET address_encrypted = ? WHERE id = ?').run(encrypted, userId);
}

function getUserAddress(userId) {
    const user = db.prepare('SELECT address_encrypted FROM users WHERE id = ?').get(userId);
    return user ? decrypt(user.address_encrypted) : null;
}

function setUserPreferences(userId, preferences) {
    db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(preferences), userId);
}

function getUserPreferences(userId) {
    const user = db.prepare('SELECT preferences FROM users WHERE id = ?').get(userId);
    return user ? JSON.parse(user.preferences || '{}') : {};
}

// Conversation functions
function saveMessage(userId, role, content) {
    db.prepare('INSERT INTO conversations (user_id, role, content) VALUES (?, ?, ?)')
        .run(userId, role, content);
}

function getConversationHistory(userId, limit = 20) {
    const messages = db.prepare(`
        SELECT role, content FROM conversations
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `).all(userId, limit);

    return messages.reverse();
}

function clearConversationHistory(userId) {
    db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId);
}

// Session functions
function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

    db.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)')
        .run(userId, token, expiresAt);

    return token;
}

function getSession(token) {
    return db.prepare(`
        SELECT * FROM sessions
        WHERE token = ? AND expires_at > datetime('now')
    `).get(token);
}

function authenticateSession(token) {
    db.prepare('UPDATE sessions SET authenticated = 1 WHERE token = ?').run(token);
}

function deleteExpiredSessions() {
    db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

// Cart functions - supports multiple restaurants
function getCart(userId) {
    let cart = db.prepare('SELECT * FROM carts WHERE user_id = ?').get(userId);
    if (!cart) {
        db.prepare('INSERT INTO carts (user_id, items) VALUES (?, ?)').run(userId, '{}');
        cart = { user_id: userId, restaurant_id: null, items: '{}' };
    }
    // items is now { restaurantId: [items], restaurantId2: [items] }
    let items = {};
    try {
        items = JSON.parse(cart.items || '{}');
        // Handle old format (array) -> convert to new format
        if (Array.isArray(items)) {
            if (items.length > 0 && cart.restaurant_id) {
                items = { [cart.restaurant_id]: items };
            } else {
                items = {};
            }
        }
    } catch (e) {
        items = {};
    }
    return {
        ...cart,
        items: items
    };
}

function setCart(userId, items) {
    db.prepare(`
        INSERT INTO carts (user_id, items, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
            items = excluded.items,
            updated_at = CURRENT_TIMESTAMP
    `).run(userId, JSON.stringify(items));
}

function clearCart(userId) {
    db.prepare('UPDATE carts SET restaurant_id = NULL, items = \'{}\', updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(userId);
}

const _addToCartTx = db.transaction((userId, restaurantId, item) => {
    const cart = getCart(userId);

    if (!cart.items[restaurantId]) {
        cart.items[restaurantId] = [];
    }

    const itemKey = item.name + (item.selectedOptions ? JSON.stringify(item.selectedOptions) : '');
    const existingIndex = cart.items[restaurantId].findIndex(i => {
        const existingKey = i.name + (i.selectedOptions ? JSON.stringify(i.selectedOptions) : '');
        return existingKey === itemKey;
    });

    if (existingIndex >= 0) {
        cart.items[restaurantId][existingIndex].quantity += 1;
    } else {
        cart.items[restaurantId].push({ ...item, quantity: 1 });
    }

    setCart(userId, cart.items);
    return cart.items;
});

function addToCart(userId, restaurantId, item) {
    return _addToCartTx(userId, restaurantId, item);
}

function removeFromCart(userId, restaurantId, itemId) {
    const cart = getCart(userId);
    if (cart.items[restaurantId]) {
        cart.items[restaurantId] = cart.items[restaurantId].filter(i => i.id !== itemId);
        if (cart.items[restaurantId].length === 0) {
            delete cart.items[restaurantId];
        }
    }
    setCart(userId, cart.items);
    return cart.items;
}

// Order functions
function createOrder(userId, restaurantId, restaurantName, items, address, subtotal, total, restaurantUrl = null, trackingUrl = null) {
    const result = db.prepare(`
        INSERT INTO orders (user_id, restaurant_id, restaurant_name, items, address, subtotal, total, restaurant_url, tracking_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, restaurantId, restaurantName, JSON.stringify(items), address, subtotal, total, restaurantUrl, trackingUrl);

    // Clear cart after order
    clearCart(userId);

    return result.lastInsertRowid;
}

function getOrder(orderId) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (order) {
        order.items = JSON.parse(order.items);
    }
    return order;
}

function getUserOrders(userId, limit = 10) {
    const orders = db.prepare(`
        SELECT * FROM orders WHERE user_id = ?
        ORDER BY placed_at DESC LIMIT ?
    `).all(userId, limit);

    return orders.map(order => ({
        ...order,
        items: JSON.parse(order.items)
    }));
}

function updateOrderStatus(orderId, status) {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
}

function saveOrderTrackingInfo(orderId, { doordashOrderId, trackingUrl, phoneNumber } = {}) {
    db.prepare(`
        UPDATE orders SET doordash_order_id = ?, tracking_url = ?, phone_number = ? WHERE id = ?
    `).run(doordashOrderId || null, trackingUrl || null, phoneNumber || null, orderId);
}

function updateOrderLastStatus(orderId, status) {
    db.prepare('UPDATE orders SET last_known_status = ? WHERE id = ?').run(status, orderId);
}

function getActiveOrders() {
    return db.prepare(`
        SELECT o.*, u.phone_number as user_phone
        FROM orders o
        JOIN users u ON o.user_id = u.id
        WHERE o.status NOT IN ('delivered', 'cancelled')
        AND o.placed_at > datetime('now', '-4 hours')
        ORDER BY o.placed_at DESC
    `).all();
}

function getLatestActiveOrderForUser(userId) {
    return db.prepare(`
        SELECT * FROM orders
        WHERE user_id = ?
        AND status NOT IN ('delivered', 'cancelled')
        ORDER BY placed_at DESC LIMIT 1
    `).get(userId);
}

// DoorDash credential functions
function setDoorDashCredentials(userId, email, password) {
    // Store email and password as encrypted JSON
    const credentials = JSON.stringify({ email, password });
    const encrypted = encrypt(credentials);
    db.prepare('UPDATE users SET doordash_credentials_encrypted = ? WHERE id = ?').run(encrypted, userId);
    console.log(`[DB] DoorDash credentials saved for user ${userId}`);
}

function getDoorDashCredentials(userId) {
    const user = db.prepare('SELECT doordash_credentials_encrypted FROM users WHERE id = ?').get(userId);
    if (!user || !user.doordash_credentials_encrypted) return null;

    const decrypted = decrypt(user.doordash_credentials_encrypted);
    if (!decrypted) return null;

    try {
        return JSON.parse(decrypted);
    } catch (e) {
        console.error('[DB] Failed to parse DoorDash credentials');
        return null;
    }
}

function hasDoorDashCredentials(userId) {
    const user = db.prepare('SELECT doordash_credentials_encrypted FROM users WHERE id = ?').get(userId);
    return !!(user && user.doordash_credentials_encrypted);
}

function clearDoorDashCredentials(userId) {
    db.prepare('UPDATE users SET doordash_credentials_encrypted = NULL WHERE id = ?').run(userId);
    console.log(`[DB] DoorDash credentials cleared for user ${userId}`);
}

// DoorDash cache functions
function setDoorDashCache(userId, cacheType, cacheKey, data, ttlMinutes = 30) {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    db.prepare(`
        INSERT INTO doordash_cache (user_id, cache_type, cache_key, data, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, cache_type, cache_key) DO UPDATE SET
            data = excluded.data,
            created_at = CURRENT_TIMESTAMP,
            expires_at = excluded.expires_at
    `).run(userId, cacheType, cacheKey, JSON.stringify(data), expiresAt);
}

function getDoorDashCache(userId, cacheType, cacheKey) {
    const row = db.prepare(`
        SELECT data FROM doordash_cache
        WHERE user_id = ? AND cache_type = ? AND cache_key = ?
        AND expires_at > datetime('now')
    `).get(userId, cacheType, cacheKey);

    if (!row) return null;
    try {
        return JSON.parse(row.data);
    } catch (e) {
        return null;
    }
}

function clearDoorDashCache(userId, cacheType = null) {
    if (cacheType) {
        db.prepare('DELETE FROM doordash_cache WHERE user_id = ? AND cache_type = ?').run(userId, cacheType);
    } else {
        db.prepare('DELETE FROM doordash_cache WHERE user_id = ?').run(userId);
    }
}

function cleanExpiredDoorDashCache() {
    db.prepare("DELETE FROM doordash_cache WHERE expires_at <= datetime('now')").run();
}

// Helper functions for specific cache types
function cacheSearchResults(userId, query, restaurants) {
    setDoorDashCache(userId, 'search', query || 'nearby', restaurants, 15); // 15 min TTL
}

function getCachedSearchResults(userId, query) {
    return getDoorDashCache(userId, 'search', query || 'nearby');
}

function cacheRestaurantMenu(userId, restaurantId, menuData) {
    setDoorDashCache(userId, 'menu', restaurantId, menuData, 30); // 30 min TTL
}

function getCachedRestaurantMenu(userId, restaurantId) {
    return getDoorDashCache(userId, 'menu', restaurantId);
}

function cacheCurrentRestaurant(userId, restaurantData) {
    setDoorDashCache(userId, 'current_restaurant', 'active', restaurantData, 60); // 1 hour TTL
}

function getCachedCurrentRestaurant(userId) {
    return getDoorDashCache(userId, 'current_restaurant', 'active');
}

// Export everything
module.exports = {
    db,
    encrypt,
    decrypt,
    getOrCreateUser,
    getUserByPhone,
    setUserPin,
    verifyUserPin,
    setUserAddress,
    getUserAddress,
    setUserPreferences,
    getUserPreferences,
    saveMessage,
    getConversationHistory,
    clearConversationHistory,
    createSession,
    getSession,
    authenticateSession,
    deleteExpiredSessions,
    getCart,
    setCart,
    clearCart,
    addToCart,
    removeFromCart,
    createOrder,
    getOrder,
    getUserOrders,
    updateOrderStatus,
    saveOrderTrackingInfo,
    updateOrderLastStatus,
    getActiveOrders,
    getLatestActiveOrderForUser,
    setDoorDashCredentials,
    getDoorDashCredentials,
    hasDoorDashCredentials,
    clearDoorDashCredentials,
    // DoorDash cache functions
    setDoorDashCache,
    getDoorDashCache,
    clearDoorDashCache,
    cleanExpiredDoorDashCache,
    cacheSearchResults,
    getCachedSearchResults,
    cacheRestaurantMenu,
    getCachedRestaurantMenu,
    cacheCurrentRestaurant,
    getCachedCurrentRestaurant
};
