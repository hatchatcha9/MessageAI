/**
 * DoorDash Browser Automation Module
 * Uses Playwright to automate real orders on DoorDash
 * Restaurant search uses the internal HTTP API (no browser needed).
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// API module for search (bypasses Cloudflare CAPTCHA)
const doordashApi = require('./doordash-api');

// Configuration
const DOORDASH_URL = 'https://www.doordash.com';
const BROWSER_DATA_DIR = process.env.BROWSER_DATA_DIR || path.join(__dirname, 'browser-data');
// If DISPLAY is set (Xvfb running), force headed mode regardless of DOORDASH_HEADLESS env var.
// Railway's dashboard env var DOORDASH_HEADLESS=true otherwise overrides everything.
const HEADLESS = process.env.DISPLAY ? false : (process.env.DOORDASH_HEADLESS !== 'false');

// Selectors - abstracted for easy updates if DoorDash UI changes
const SELECTORS = {
    // Login page
    login: {
        emailInput: 'input[data-anchor-id="EmailLoginInput"], input[name="email"], input[type="email"]',
        passwordInput: 'input[data-anchor-id="PasswordInput"], input[name="password"], input[type="password"]',
        submitButton: 'button[data-anchor-id="PasswordSubmitButton"], button[type="submit"]',
        continueButton: 'button[data-anchor-id="SubmitEmailButton"]',
        loginLink: '[data-anchor-id="SignInLink"], a[href*="login"]'
    },
    // Address / location
    address: {
        input: 'input[data-anchor-id="AddressInput"], input[placeholder*="address"], input[placeholder*="Enter delivery address"]',
        suggestion: '[data-anchor-id="AddressSuggestion"], [role="option"]',
        confirmButton: 'button[data-anchor-id="AddressConfirmButton"]'
    },
    // Search and restaurant
    search: {
        input: 'input[data-anchor-id="SearchInput"], input[placeholder*="Search"], input[aria-label*="Search"]',
        results: '[data-anchor-id="StoreCard"], [data-testid="store-card"]',
        restaurantName: '[data-anchor-id="StoreName"], h2, h3'
    },
    // Menu and items
    menu: {
        item: '[data-anchor-id="MenuItem"], [data-testid="menu-item"]',
        itemName: '[data-anchor-id="MenuItemName"], h3, span',
        itemPrice: '[data-anchor-id="MenuItemPrice"], [data-testid="menu-item-price"]',
        addButton: 'button[data-anchor-id="AddToCartButton"], button:has-text("Add to Cart"), button:has-text("Add")'
    },
    // Item customization modal
    customization: {
        modal: '[data-anchor-id="ItemModal"], [role="dialog"]',
        optionGroup: '[data-anchor-id="OptionGroup"], [data-testid="option-group"]',
        optionItem: '[data-anchor-id="OptionItem"], [role="radio"], [role="checkbox"]',
        quantityIncrease: 'button[data-anchor-id="IncreaseQuantity"], button[aria-label*="Increase"]',
        quantityDecrease: 'button[data-anchor-id="DecreaseQuantity"], button[aria-label*="Decrease"]',
        addToOrder: 'button[data-anchor-id="AddItemButton"], button:has-text("Add to Order")'
    },
    // Cart and checkout
    cart: {
        viewCart: 'button[data-anchor-id="CartButton"], [data-testid="cart-button"]',
        cartItems: '[data-anchor-id="CartItem"], [data-testid="cart-item"]',
        checkout: 'button[data-anchor-id="CheckoutButton"], button:has-text("Checkout")',
        subtotal: '[data-anchor-id="CartSubtotal"]',
        total: '[data-anchor-id="CartTotal"]'
    },
    // Checkout page
    checkout: {
        tipButtons: '[data-anchor-id="TipButton"], button[data-testid*="tip"]',
        paymentMethod: '[data-anchor-id="PaymentMethod"]',
        placeOrder: 'button[data-anchor-id="PlaceOrderButton"], button:has-text("Place Order"), button:has-text("place order"), button[aria-label*="Place order" i], button[aria-label*="place your order" i]',
        deliveryInstructions: 'textarea[data-anchor-id="DeliveryInstructions"]',
        // Payment method selectors
        paymentSection: '[data-anchor-id="PaymentSection"], [data-testid="payment-method"], [data-testid="payment-section"]',
        paymentCard: '[data-anchor-id="PaymentCard"], [data-testid="saved-card"], [data-testid="payment-card"]',
        addPayment: 'button:has-text("Add payment"), button:has-text("Add Payment Method")',
        selectedPayment: '[data-testid="selected-payment"], [aria-selected="true"][data-testid*="payment"]',
        // Address update prompts
        updateAddress: 'button:has-text("Update address"), button:has-text("Change address")',
        addressError: '[data-testid="address-error"], text="doesn\'t deliver"'
    },
    // Confirmation
    confirmation: {
        orderNumber: '[data-anchor-id="OrderNumber"], [data-testid="order-number"]',
        eta: '[data-anchor-id="DeliveryETA"], [data-testid="delivery-eta"]',
        restaurantName: '[data-anchor-id="OrderRestaurantName"]',
        // Additional confirmation selectors
        confirmationPage: '[data-testid="order-confirmation"], [data-anchor-id="OrderConfirmation"]',
        orderStatus: '[data-testid="order-status"], [data-anchor-id="OrderStatus"]',
        trackOrder: 'button:has-text("Track Order"), a:has-text("Track")'
    },
    // Common
    common: {
        closeModal: 'button[aria-label="Close"], button[data-anchor-id="CloseButton"]',
        dismissPopup: 'button[data-anchor-id="DismissButton"], button:has-text("Not now"), button:has-text("No thanks")'
    }
};

// Browser instance management
let browser = null;
let context = null;
let page = null;

// Pre-fetched menu items from in-context API (fetched on search page before navigating away)
let _preloadedMenuItems = null;

// Intercepted DoorDash API responses captured during search page load.
// DoorDash's own JavaScript makes API calls that pass CF — we capture those responses.
// keyed by store ID (string) → array of {name, price} items from featured_items / popular items
let _capturedStoreMenus = {};

// Restaurant listings captured from network responses during search page load.
// Avoids needing DOM extraction (which OOMs Chrome on Railway).
let _capturedRestaurants = [];

// Auth headers captured from DoorDash's own successful GraphQL requests.
// Reused for our own in-browser menu fetch (same headers = passes CF).
let _capturedDoorDashHeaders = null;
let _capturedSearchQueryFired = false; // true when searchWithFilterFacetFeed is intercepted
let _preWarmPromise = null;
let _preWarmUrl = null;

/**
 * Parse a DoorDash API response and cache any menu items found for each store ID.
 * Handles search response shapes, store detail shapes, and GraphQL wrappers.
 */
function _extractAndCacheMenuData(data) {
    if (!data || typeof data !== 'object') return;

    // Walk the object tree looking for store_id + items/menus
    function walk(obj, depth) {
        if (depth > 8 || !obj || typeof obj !== 'object') return;

        // Shape: { id: "12345", menus: [...] } or { store_id: "12345", menus: [...] }
        const storeId = String(obj.id || obj.store_id || '');
        const menus = obj.menus || obj.menu || [];
        if (storeId && storeId.length >= 5 && Array.isArray(menus) && menus.length > 0) {
            const items = [];
            for (const menu of menus) {
                for (const cat of (menu.menu_categories || menu.categories || [])) {
                    for (const item of (cat.items || cat.menu_items || [])) {
                        const name = item.name || item.title || '';
                        const rawPrice = item.price || item.display_price || item.displayPrice || 0;
                        const price = typeof rawPrice === 'number'
                            ? (rawPrice > 200 ? rawPrice / 100 : rawPrice)
                            : parseFloat(String(rawPrice).replace(/[^0-9.]/g, ''));
                        if (name && price > 0) items.push({ name, price, description: item.description || '' });
                    }
                }
            }
            if (items.length > 0) {
                _capturedStoreMenus[storeId] = items;
                console.log(`[DoorDash] Intercepted ${items.length} menu items for store ${storeId}`);
                return;
            }
        }

        // Shape: { featured_items: [{name, price}] } (search result cards)
        const storeId2 = String(obj.id || obj.store_id || '');
        const featured = obj.featured_items || obj.featuredItems || obj.popularItems || [];
        if (storeId2 && storeId2.length >= 5 && Array.isArray(featured) && featured.length > 0) {
            const items = featured.map(item => ({
                name: item.name || item.title || '',
                price: typeof item.price === 'number' ? (item.price > 200 ? item.price / 100 : item.price) : parseFloat(String(item.price || 0)),
                description: item.description || ''
            })).filter(i => i.name && i.price > 0);
            if (items.length > 0) {
                _capturedStoreMenus[storeId2] = (_capturedStoreMenus[storeId2] || []).concat(items);
                console.log(`[DoorDash] Intercepted ${items.length} featured items for store ${storeId2}`);
                return;
            }
        }

        // Recurse into arrays and objects
        if (Array.isArray(obj)) {
            for (const el of obj) walk(el, depth + 1);
        } else {
            for (const key of Object.keys(obj)) walk(obj[key], depth + 1);
        }
    }

    walk(data, 0);
}

/**
 * Walk a DoorDash API response and cache any restaurant/store listings found.
 * Looks for objects with a numeric store ID and a name but no price (to avoid menu items).
 * Results are stored in _capturedRestaurants for use by extractRestaurantList().
 */
function _extractAndCacheRestaurantList(data, opName = '') {
    if (!data || typeof data !== 'object') return;
    const DOORDASH_BASE = 'https://www.doordash.com';
    function walk(obj, depth) {
        if (depth > 10 || !obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { for (const el of obj) walk(el, depth + 1); return; }
        const id = String(obj.id || obj.store_id || obj.storeId || '');
        const name = typeof obj.name === 'string' ? obj.name.trim() : '';
        if (/^\d{5,}$/.test(id) && name.length >= 3 && !obj.price && !obj.menus && !obj.menu) {
            if (!_capturedRestaurants.find(r => r.id === id)) {
                const rating = String(obj.rating || obj.averageRating || obj.average_rating || '');
                const dt = obj.deliveryTime || obj.delivery_time || obj.estimatedDeliveryTime || '';
                // Prefer slug-based URL — DoorDash now 404s on ID-only URLs
                const slug = obj.url_key || obj.urlKey || obj.slug || obj.url_slug || obj.urlSlug || '';
                const url = slug
                    ? `${DOORDASH_BASE}/store/${slug}/${id}/`
                    : `${DOORDASH_BASE}/store/${id}/`;
                const address = typeof obj.address === 'string' ? obj.address.trim() : '';
                _capturedRestaurants.push({ id, name, rating, deliveryTime: String(dt), url, address });
                console.log(`[DoorDash] Network store [${opName || 'unknown'}]: ${name} (${id}) → ${url}`);
            }
        }
        for (const v of Object.values(obj)) walk(v, depth + 1);
    }
    walk(data, 0);
}

// Session state tracking
const sessionState = {
    launched: false,
    loggedIn: false,
    currentRestaurantPage: null,
    currentRestaurantUrl: null,
    lastSearchUrl: null,
    lastActivity: null,
    loginEmail: null
};

// Serial operation lock — prevents concurrent browser requests that trigger CF rate-limiting
let _opLockPromise = Promise.resolve();

/**
 * Run an async function serially (one at a time). If another op is in flight,
 * this queues behind it. This prevents concurrent DoorDash requests that confuse
 * the shared browser page and trigger CF bot detection.
 */
function withOpLock(fn) {
    const next = _opLockPromise.then(() => fn()).catch(e => { throw e; });
    // Allow the queue to drain even if an individual op throws
    _opLockPromise = next.catch(() => {});
    return next;
}

/**
 * Get current session state
 */
function getSessionState() {
    return {
        ...sessionState,
        hasPage: !!page,
        hasContext: !!context
    };
}

/**
 * Update session state
 */
function updateSessionState(updates) {
    Object.assign(sessionState, updates, { lastActivity: Date.now() });
}

/**
 * Reset session state
 */
function resetSessionState() {
    sessionState.launched = false;
    sessionState.loggedIn = false;
    sessionState.currentRestaurantPage = null;
    sessionState.lastActivity = null;
    sessionState.loginEmail = null;
}

/**
 * Validate if current session is still active
 */
async function validateSession() {
    if (!page || !context) {
        return { valid: false, reason: 'no_browser' };
    }

    try {
        // Check if page is still responsive
        const url = page.url();
        if (!url) {
            return { valid: false, reason: 'page_unresponsive' };
        }

        // Navigate to DoorDash if not already there
        if (!url.includes('doordash.com')) {
            console.log('[DoorDash] Not on DoorDash, navigating...');
            await page.goto(DOORDASH_URL, { waitUntil: 'domcontentloaded' });
            await delay(2000);
        }

        // Check for logged-in indicators - updated for current DoorDash UI
        const accountIndicators = [
            // Sidebar account link
            'a[href*="/account"]',
            'a:has-text("Account")',
            'text="Account"',
            // Top nav account elements
            '[data-anchor-id="AccountMenu"]',
            '[data-testid="account-button"]',
            'button[aria-label="Account"]',
            '[aria-label="Account menu"]',
            // Orders link (only visible when logged in)
            'a[href*="/orders"]',
            'a:has-text("Orders")',
            // User avatar
            'img[alt*="avatar"]',
            'img[alt*="profile"]'
        ];

        for (const selector of accountIndicators) {
            try {
                const element = await page.$(selector);
                if (element) {
                    const isVisible = await element.isVisible().catch(() => false);
                    if (isVisible) {
                        console.log(`[DoorDash] Found logged-in indicator: ${selector}`);
                        return { valid: true, loggedIn: true };
                    }
                }
            } catch (e) {
                // Continue checking
            }
        }

        // Also check page content for account-related text
        try {
            const pageContent = await page.content();
            if (pageContent.includes('href="/account"') || pageContent.includes('/orders')) {
                console.log('[DoorDash] Found account link in page content');
                return { valid: true, loggedIn: true };
            }
        } catch (e) {
            // Content check failed
        }

        return { valid: true, loggedIn: false };

    } catch (error) {
        console.error('[DoorDash] Session validation error:', error.message);
        return { valid: false, reason: 'error', error: error.message };
    }
}

/**
 * Initialize browser with persistent context
 */
async function launchBrowser(headless = HEADLESS, rotateProxy = false) {
    // Check if browser is already running and valid
    if (context && page) {
        try {
            const validation = await validateSession();
            if (validation.valid) {
                console.log('[DoorDash] Reusing existing browser session');
                updateSessionState({ launched: true, loggedIn: validation.loggedIn });
                return page;
            }
        } catch (e) {
            // Session invalid, will launch new browser
            console.log('[DoorDash] Existing session invalid, launching new browser');
        }
    }

    // Close any stale context
    if (context) {
        try {
            await context.close();
        } catch (e) {
            // Already closed
        }
        context = null;
        page = null;
        resetSessionState();
    }

    // Ensure browser data directory exists
    if (!fs.existsSync(BROWSER_DATA_DIR)) {
        fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
    }

    // Use real Chrome if available (local dev), otherwise fall back to bundled Chromium (Railway)
    const CHROME_INSTALLED = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
        || fs.existsSync('/usr/bin/google-chrome-stable')
        || fs.existsSync('/usr/bin/google-chrome');
    const BOT_PROFILE_DIR = CHROME_INSTALLED
        ? (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
            ? 'C:\\Users\\hatch\\AppData\\Local\\MessageAI\\ChromeProfile'
            : path.join(BROWSER_DATA_DIR, 'ChromeProfile'))
        : path.join(BROWSER_DATA_DIR, 'ChromeProfile');

    if (!fs.existsSync(BOT_PROFILE_DIR)) {
        fs.mkdirSync(BOT_PROFILE_DIR, { recursive: true });
    }

    // Remove Chrome's profile lock files left by a previous container/process.
    // On Railway, each deployment runs on a potentially different host so Chrome
    // sees the lock as belonging to "another computer" and refuses to start.
    for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const lockPath = path.join(BOT_PROFILE_DIR, lockFile);
        try { fs.unlinkSync(lockPath); console.log(`[DoorDash] Removed stale lock: ${lockFile}`); } catch (e) {}
    }

    const launchOptions = {
        headless,
        channel: CHROME_INSTALLED ? 'chrome' : undefined,
        locale: 'en-US',
        timezoneId: 'America/Denver',
        // Hide automation flags so DoorDash/Cloudflare doesn't detect bot
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-infobars',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            '--window-size=1280,720',
            '--lang=en-US',
            '--disable-setuid-sandbox',
            // Memory-saving flags for Railway's 512 MB RAM limit
            '--disable-background-networking',     // no background data sync
            '--disable-background-timer-throttling',
            '--disable-features=IsolateOrigins,site-per-process', // share renderer process = less RAM
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            // --no-zygote is headless-only (causes issues in headed+Xvfb).
            // --use-gl=swiftshader is needed in BOTH modes:
            //   headless: no display, must use software GL
            //   headed+Xvfb: Railway has no GPU; Mesa's llvmpipe crashes on GL_CLOSE_PATH_NV
            //                (NV path extension) during screenshot ReadPixels. SwiftShader is
            //                stable Google-maintained software GL that doesn't trigger this.
            '--use-gl=swiftshader',
            ...(headless ? ['--no-zygote'] : []),
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    };

    if (!CHROME_INSTALLED) {
        launchOptions.viewport = { width: 1280, height: 720 };
        // UA must match actual Chromium version — CF cross-checks UA vs browser capabilities.
        // Playwright's bundled Chromium is v145; using Chrome/131 was a detectable mismatch.
        launchOptions.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
    }

    // If a residential proxy is configured, use it to bypass CF's datacenter IP block
    // on DoorDash store pages. Set PROXY_URL=http://user:pass@host:port in Railway env vars.
    // Playwright requires credentials as separate fields, not embedded in the server URL.
    if (process.env.PROXY_URL) {
        try {
            const pu = new URL(process.env.PROXY_URL);
            launchOptions.proxy = { server: `${pu.protocol}//${pu.host}` };
            if (pu.username) launchOptions.proxy.username = decodeURIComponent(pu.username);
            if (pu.password) launchOptions.proxy.password = decodeURIComponent(pu.password);
            // IPRoyal residential proxies auto-rotate IP on each new browser connection —
            // no session suffix needed; rotateProxy flag is now a no-op but kept for compat.
        } catch (e) {
            launchOptions.proxy = { server: process.env.PROXY_URL };
        }
        console.log(`[DoorDash] Using proxy: ${process.env.PROXY_URL.replace(/:([^:@]+)@/, ':***@')}`);
    }

    console.log(`[DoorDash] Launching ${CHROME_INSTALLED ? 'real Chrome' : 'bundled Chromium'} with dedicated MessageAI profile (headless=${headless}, DISPLAY=${process.env.DISPLAY || 'unset'})`);
    context = await chromium.launchPersistentContext(BOT_PROFILE_DIR, launchOptions);

    // Remove webdriver property so sites can't detect automation
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Set headers that match a real Chrome browser — CF checks sec-ch-ua to verify the UA string
    if (!CHROME_INSTALLED) {
        await context.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'sec-ch-ua': '"Google Chrome";v="145", "Chromium";v="145", "Not_A Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        });
    }

    page = context.pages()[0] || await context.newPage();

    // Block heavy resources to reduce memory usage on Railway.
    // Stylesheets are safe to block — DOM scraping doesn't need CSS rendering.
    await page.route('**/*', (route) => {
        const rt = route.request().resourceType();
        if (rt === 'image' || rt === 'media' || rt === 'font' || rt === 'stylesheet') {
            route.abort();
        } else {
            route.continue();
        }
    });

    // Set default timeout
    page.setDefaultTimeout(30000);

    updateSessionState({ launched: true });
    console.log('[DoorDash] Browser launched');

    // Auto-import DoorDash auth cookies (skip Cloudflare cookies — they're fingerprint-specific)
    if (process.env.DOORDASH_COOKIES) {
        try {
            const allCookies = JSON.parse(process.env.DOORDASH_COOKIES);
            const CF_COOKIES = new Set(['cf_clearance', '__cf_bm', '_cfuvid', '__cfwaitingroom']);
            const authCookies = allCookies.filter(c => !CF_COOKIES.has(c.name));
            await context.addCookies(authCookies);
            console.log(`[DoorDash] Auto-imported ${authCookies.length} auth cookies (skipped CF cookies)`);
        } catch (e) {
            console.error('[DoorDash] Failed to auto-import cookies:', e.message);
        }
    }

    return page;
}

/**
 * Probe DoorDash homepage and retry with new proxy IPs until CF doesn't challenge.
 * IPRoyal rotates residential IPs on each browser reconnect.
 * "Please confirm your reservation" = interactive Turnstile (won't auto-solve, need new IP).
 * "Performing security verification" = invisible JS-only check (may auto-solve with more time).
 */
async function ensureCleanProxyIP(maxRetries = 4) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (!context || !page) await launchBrowser();

        try {
            await page.goto(DOORDASH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
            console.log(`[DoorDash] IP probe nav error (attempt ${attempt + 1}): ${e.message}`);
        }

        const resolved = await waitForCFChallenge(25000);
        const body = await page.evaluate(() => document.body?.innerText.substring(0, 150) || '').catch(() => '');
        const cfBlocked = !resolved
            || body.includes('security verification')
            || body.includes('Verifying you are human')
            || body.includes('confirm your reservation')
            || body.includes('Just a moment');

        if (!cfBlocked) {
            console.log(`[DoorDash] Clean proxy IP confirmed on attempt ${attempt + 1}`);
            return true;
        }

        console.log(`[DoorDash] IP attempt ${attempt + 1}/${maxRetries + 1} blocked by CF ("${body.substring(0, 60).trim()}") — getting new IP...`);
        if (attempt < maxRetries) {
            await closeBrowser();
            await delay(1500);
        }
    }
    console.log('[DoorDash] Could not get clean proxy IP after all retries — proceeding anyway');
    return false;
}

/**
 * Close browser and clean up
 */
async function closeBrowser() {
    if (context) {
        try {
            await context.close();
        } catch (e) {
            // Already closed
        }
        context = null;
        page = null;
        resetSessionState();
        console.log('[DoorDash] Browser closed');
    }
}

/**
 * Ensure user is logged in, reusing existing session if valid
 */
async function ensureLoggedIn(email, password) {
    try {
        // Launch browser if needed
        if (!page) {
            await launchBrowser();
        }

        // Check if already logged in with correct account
        const validation = await validateSession();
        console.log('[DoorDash] Session validation result:', validation);

        if (validation.valid && validation.loggedIn) {
            console.log('[DoorDash] Already logged in, reusing session');
            updateSessionState({ loggedIn: true, loginEmail: email });
            return { success: true, message: 'Session reused' };
        }

        // Need to login
        console.log('[DoorDash] Attempting login...');
        const loginResult = await login(email, password);
        if (loginResult.success) {
            updateSessionState({ loggedIn: true, loginEmail: email });
            return loginResult;
        }

        // Login reported failure - but double-check if we're actually logged in
        // (sometimes the login flow succeeds but returns an error)
        console.log('[DoorDash] Login reported failure, double-checking session...');
        const recheck = await validateSession();
        if (recheck.valid && recheck.loggedIn) {
            console.log('[DoorDash] Actually logged in despite error!');
            updateSessionState({ loggedIn: true, loginEmail: email });
            return { success: true, message: 'Session valid after recheck' };
        }

        return loginResult;

    } catch (error) {
        console.error('[DoorDash] ensureLoggedIn error:', error.message);

        // Even on exception, check if we're actually logged in
        try {
            const recheck = await validateSession();
            if (recheck.valid && recheck.loggedIn) {
                console.log('[DoorDash] Logged in despite exception!');
                updateSessionState({ loggedIn: true, loginEmail: email });
                return { success: true, message: 'Session valid despite error' };
            }
        } catch (e) {
            // Recheck also failed
        }

        return { success: false, error: error.message };
    }
}

/**
 * Handle common popups and modals
 */
async function handlePopups() {
    try {
        // Click any visible dismiss/close buttons in a single evaluate (avoids page.$$() element handles)
        await Promise.race([
            page.evaluate(() => {
                const DISMISS_TEXTS = ['accept', 'accept all', 'accept cookies', 'got it', 'i accept',
                    'not now', 'no thanks', 'skip', 'maybe later', 'close', 'dismiss'];
                const DISMISS_SELECTORS = [
                    'button#onetrust-accept-btn-handler',
                    '[data-testid="accept-cookies"]',
                    '[data-anchor-id="CloseButton"]',
                    '[data-testid="modal-close"]',
                    '[data-testid="close-button"]',
                    '[aria-label="Close"]',
                    '[aria-label="close"]',
                    'div[role="dialog"] button',
                ];
                const rect = (el) => el.getBoundingClientRect();
                const visible = (el) => { const r = rect(el); return r.width > 0 && r.height > 0; };

                for (const sel of DISMISS_SELECTORS) {
                    try {
                        const el = document.querySelector(sel);
                        if (el && visible(el)) { el.click(); return; }
                    } catch (_) {}
                }
                // Fallback: any button whose text matches dismiss keywords
                for (const btn of document.querySelectorAll('button')) {
                    if (!visible(btn)) continue;
                    const t = (btn.textContent || '').trim().toLowerCase();
                    if (DISMISS_TEXTS.some(d => t === d || t.startsWith(d))) { btn.click(); return; }
                }
            }),
            new Promise((resolve) => setTimeout(resolve, 3000))
        ]).catch(() => {});

        // Also try Escape
        await page.keyboard.press('Escape').catch(() => {});
        await delay(200);

    } catch (error) {
        // Ignore popup handling errors
    }
}

/**
 * Wait for element with multiple selector fallbacks
 */
async function waitForElement(selectors, options = {}) {
    const selectorList = Array.isArray(selectors) ? selectors : selectors.split(', ');
    const timeout = options.timeout || 15000;

    for (const selector of selectorList) {
        try {
            await page.waitForSelector(selector.trim(), { timeout: timeout / selectorList.length, state: 'visible' });
            return await page.$(selector.trim());
        } catch (error) {
            continue;
        }
    }

    throw new Error(`None of the selectors found: ${selectorList.join(', ')}`);
}

/**
 * Take a debug screenshot
 */
async function takeScreenshot(name) {
    // Screenshots crash Chrome on Railway (Mesa/llvmpipe GL_CLOSE_PATH_NV SIGSEGV).
    // They're debug-only — disable on Railway entirely.
    if (process.env.RAILWAY_ENVIRONMENT) return null;
    if (!page) {
        console.log(`[DoorDash] Screenshot skipped (page not ready): ${name}`);
        return null;
    }
    const screenshotDir = path.join(BROWSER_DATA_DIR, 'screenshots');
    if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const filename = `${name}-${Date.now()}.png`;
    await page.screenshot({ path: path.join(screenshotDir, filename), fullPage: true });
    console.log(`[DoorDash] Screenshot saved: ${filename}`);
    return filename;
}

/**
 * Human-like delay
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms + Math.random() * 500));
}

// Debug screenshot interval - captures screenshots every N seconds during item selection
let debugScreenshotInterval = null;
let debugScreenshotCounter = 0;

function startDebugScreenshots(intervalMs = 3000) {
    if (!process.env.DEBUG_SCREENSHOTS) return; // disabled by default — too memory-intensive on Railway
    if (debugScreenshotInterval) return;
    debugScreenshotCounter = 0;
    console.log(`[DoorDash] Starting debug screenshots every ${intervalMs}ms`);
    debugScreenshotInterval = setInterval(async () => {
        try {
            if (page) {
                debugScreenshotCounter++;
                await takeScreenshot(`debug-${debugScreenshotCounter}`);
            }
        } catch (e) {
            console.log('[DoorDash] Debug screenshot failed:', e.message);
        }
    }, intervalMs);
}

function stopDebugScreenshots() {
    if (debugScreenshotInterval) {
        clearInterval(debugScreenshotInterval);
        debugScreenshotInterval = null;
        console.log(`[DoorDash] Stopped debug screenshots (took ${debugScreenshotCounter} screenshots)`);
    }
}

/**
 * Read Windows clipboard to find verification code
 */
async function getCodeFromClipboard() {
    return new Promise((resolve) => {
        exec('powershell -Command "Get-Clipboard"', { timeout: 5000 }, (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            const text = stdout.trim();
            // Look for 6-digit code
            const match = text.match(/\b(\d{6})\b/);
            if (match) {
                console.log(`[DoorDash] Found code in clipboard: ${match[1]}`);
                resolve(match[1]);
            } else {
                resolve(null);
            }
        });
    });
}

/**
 * Read Windows notifications to find DoorDash verification code
 * Uses PowerShell to access Windows notification history
 */
async function getVerificationCodeFromNotifications() {
    // First check clipboard - most reliable
    const clipboardCode = await getCodeFromClipboard();
    if (clipboardCode) {
        return clipboardCode;
    }

    return new Promise((resolve) => {
        // PowerShell script to read notification database
        const psScript = `
$code = $null
try {
    $dbPath = "$env:LOCALAPPDATA\\Microsoft\\Windows\\Notifications\\wpndatabase.db"
    if (Test-Path $dbPath) {
        $bytes = [System.IO.File]::ReadAllBytes($dbPath)
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
        if ($text -match '(\\d{6})') {
            $code = $matches[1]
        }
    }
} catch {}
if ($code) { Write-Output $code } else { Write-Output "" }
`;

        exec(`powershell -NoProfile -Command "${psScript.replace(/\r?\n/g, ' ')}"`,
            { timeout: 10000 },
            (error, stdout, stderr) => {
                if (error) {
                    resolve(null);
                    return;
                }
                const code = stdout.trim();
                if (code && /^\d{6}$/.test(code)) {
                    console.log(`[DoorDash] Found code in notifications: ${code}`);
                    resolve(code);
                } else {
                    resolve(null);
                }
            }
        );
    });
}

/**
 * Monitor for verification code from notifications
 * Polls every few seconds looking for new codes
 */
async function waitForVerificationCode(maxWaitSeconds = 60) {
    console.log('[DoorDash] Monitoring for verification code from notifications...');

    const startTime = Date.now();
    const maxWaitMs = maxWaitSeconds * 1000;

    while (Date.now() - startTime < maxWaitMs) {
        const code = await getVerificationCodeFromNotifications();
        if (code) {
            return code;
        }
        await delay(3000); // Check every 3 seconds
    }

    return null;
}

/**
 * Type with human-like delays
 */
async function humanType(element, text) {
    for (const char of text) {
        await element.type(char);
        await delay(50 + Math.random() * 100);
    }
}

/**
 * Check if already logged in
 */
async function isLoggedIn() {
    try {
        // Don't navigate if we're already on DoorDash
        const currentUrl = page.url();
        if (!currentUrl.includes('doordash.com')) {
            await page.goto(DOORDASH_URL, { waitUntil: 'domcontentloaded' });
        }
        // Already on DoorDash — only need a short settle; skip the long navigation wait
        await delay(currentUrl.includes('doordash.com') ? 300 : 1000);
        await handlePopups();

        // Use evaluate to check multiple signals at once, with a timeout.
        // Old selector-based approach missed the current DoorDash UI.
        const result = await Promise.race([
            page.evaluate(() => {
                const body = document.body?.innerText || '';
                const html = document.documentElement?.innerHTML || '';
                // Logged-IN signals
                const hasGreeting = /happy (sunday|monday|tuesday|wednesday|thursday|friday|saturday)|good (morning|afternoon|evening)|welcome back/i.test(body.substring(0, 2000));
                const hasUserCookie = document.cookie.includes('dd_cx_logged_in=true') || document.cookie.includes('dd_session_id');
                const hasAccountEl = !!(
                    document.querySelector('[data-anchor-id="AccountMenu"]') ||
                    document.querySelector('[data-anchor-id="UserAvatar"]') ||
                    document.querySelector('[data-testid="account-button"]') ||
                    document.querySelector('[aria-label*="account" i]') ||
                    document.querySelector('[aria-label*="profile" i]')
                );
                // Logged-OUT signal
                const hasSignInBtn = !!(
                    document.querySelector('a[href*="/consumer/login"]') ||
                    document.querySelector('button[data-anchor-id*="SignIn"]')
                );
                return { hasGreeting, hasUserCookie, hasAccountEl, hasSignInBtn };
            }),
            new Promise(r => setTimeout(() => r(null), 5000))
        ]);

        if (!result) {
            console.log('[DoorDash] isLoggedIn timed out');
            return false;
        }

        console.log('[DoorDash] Login check:', JSON.stringify(result));
        // Logged in if any positive signal, and no sign-in button
        return (result.hasGreeting || result.hasUserCookie || result.hasAccountEl) && !result.hasSignInBtn;
    } catch (error) {
        return false;
    }
}

/**
 * Login to DoorDash
 */
async function login(email, password) {
    try {
        console.log('[DoorDash] Starting login...');

        // Check if already logged in
        if (await isLoggedIn()) {
            return { success: true, message: 'Already logged in' };
        }

        // Navigate to login page
        await page.goto(`${DOORDASH_URL}/consumer/login`, { waitUntil: 'domcontentloaded' });
        await delay(2000);

        // Aggressively handle popups before login
        await handlePopups();
        await delay(500);
        await handlePopups(); // Try again in case more appeared

        // Wait for and fill email using JavaScript to bypass overlays
        await page.waitForSelector('input[type="email"], input[name="email"], input[data-anchor-id="EmailLoginInput"]', { timeout: 10000 });

        // Step 1: Fill email using Playwright's fill method (more reliable)
        const emailInput = await page.waitForSelector('input[type="email"], input[name="email"], input[id*="email"]', { timeout: 10000 });
        await emailInput.click({ force: true });
        await emailInput.fill(email);
        await delay(1000);

        // Step 2: Click "Continue to Sign In" button (DoorDash two-step login)
        console.log('[DoorDash] Clicking Continue to Sign In...');
        const continueSelectors = [
            'button:has-text("Continue to Sign In")',
            'button:has-text("Continue")',
            'button[data-anchor-id="SubmitEmailButton"]',
            'button[type="submit"]'
        ];

        let continueClicked = false;
        for (const selector of continueSelectors) {
            try {
                const btn = await page.$(selector);
                if (btn && await btn.isVisible()) {
                    await btn.click({ force: true });
                    continueClicked = true;
                    console.log(`[DoorDash] Clicked continue button: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!continueClicked) {
            // Try pressing Enter as fallback
            await page.keyboard.press('Enter');
        }

        // Wait for next page to load
        await delay(3000);
        await handlePopups();

        // Step 3: Wait for either password field or "Use password instead" link
        console.log('[DoorDash] Waiting for password field or OTP page...');
        let passwordInput = null;

        // Race: password field vs OTP/verification page
        try {
            await Promise.race([
                page.waitForSelector('input[type="password"]', { timeout: 8000 }),
                page.waitForSelector(':text("password instead"), :text("Password instead"), :text("Use password")', { timeout: 8000 }),
            ]);
        } catch (e) {
            console.log('[DoorDash] Neither password nor OTP page detected yet, continuing...');
        }

        // If no password field, try to find and click "Use password instead"
        passwordInput = await page.$('input[type="password"]');
        if (!passwordInput) {
            await takeScreenshot('looking-for-password');
            console.log('[DoorDash] No password field — looking for "Use password instead" link...');

            // Search all links/buttons for any text containing "password"
            const clicked = await page.evaluate(() => {
                const els = [...document.querySelectorAll('a, button, span, div')];
                for (const el of els) {
                    const text = (el.textContent || '').toLowerCase();
                    if (text.includes('password instead') || text.includes('use password')) {
                        el.click();
                        return true;
                    }
                }
                return false;
            });

            if (clicked) {
                console.log('[DoorDash] Clicked "Use password instead"');
                await delay(2000);
                passwordInput = await page.$('input[type="password"]');
            } else {
                console.log('[DoorDash] "Use password instead" not found on page');
                await takeScreenshot('password-field-not-found');
            }
        }

        if (!passwordInput) {
            await takeScreenshot('password-field-not-found');
            console.log('[DoorDash] Password field not found');
        }

        if (passwordInput) {
            console.log('[DoorDash] Filling password...');
            await passwordInput.click({ force: true });
            await passwordInput.fill(password);
            await delay(1000);

            // Step 4: Click Sign In / Submit button (the RED button, not the tab)
            console.log('[DoorDash] Clicking Sign In button...');

            // Target the red submit button specifically - it's usually larger and styled differently
            let signInClicked = false;

            // First try: Find the red/primary colored button with "Sign In" text
            try {
                // Look for buttons that are likely the submit button (not tabs)
                const buttons = await page.$$('button');
                for (const btn of buttons) {
                    const text = await btn.textContent();
                    const isVisible = await btn.isVisible();

                    if (isVisible && text && text.trim() === 'Sign In') {
                        // Check if it looks like a submit button (has background color, larger size)
                        const box = await btn.boundingBox();
                        if (box && box.width > 100) { // Submit buttons are usually wider
                            await btn.click({ force: true });
                            signInClicked = true;
                            console.log('[DoorDash] Clicked Sign In submit button');
                            break;
                        }
                    }
                }
            } catch (e) {
                console.log('[DoorDash] Error finding submit button:', e.message);
            }

            // Fallback: Try specific selectors for submit button
            if (!signInClicked) {
                const submitSelectors = [
                    'button[type="submit"]',
                    'form button:has-text("Sign In")',
                    'button[data-anchor-id="PasswordSubmitButton"]',
                    'button.submit-button',
                    'button[class*="submit"]',
                    'button[class*="primary"]'
                ];

                for (const selector of submitSelectors) {
                    try {
                        const btn = await page.$(selector);
                        if (btn && await btn.isVisible()) {
                            await btn.click({ force: true });
                            signInClicked = true;
                            console.log(`[DoorDash] Clicked submit button: ${selector}`);
                            break;
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }

            // Final fallback: Press Enter
            if (!signInClicked) {
                console.log('[DoorDash] Using Enter key as fallback');
                await page.keyboard.press('Enter');
            }

            // Wait for login to complete - must end up on doordash.com (not identity.doordash.com)
            console.log('[DoorDash] Waiting for login to complete...');

            // Check for CAPTCHA and wait for user to solve it
            await delay(2000);
            const captchaSelectors = [
                'iframe[src*="challenges.cloudflare.com"]',
                'iframe[src*="recaptcha"]',
                'iframe[title*="captcha" i]',
                'iframe[title*="challenge" i]',
                '[id*="captcha" i]',
                '[class*="captcha" i]',
                '[class*="challenge" i]'
            ];
            let captchaFound = false;
            for (const sel of captchaSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el && await el.isVisible()) {
                        captchaFound = true;
                        break;
                    }
                } catch (e) {}
            }
            if (captchaFound) {
                console.log('[DoorDash] CAPTCHA detected - waiting 60 seconds for user to solve it...');
                await delay(60000);
                console.log('[DoorDash] Continuing after CAPTCHA wait...');
            }

            // Wait for redirect back to doordash.com (not identity server)
            try {
                await page.waitForURL((url) => {
                    const urlStr = url.toString();
                    return urlStr.includes('www.doordash.com') && !urlStr.includes('/login');
                }, { timeout: 30000 });
                console.log('[DoorDash] Redirected to doordash.com');
            } catch (e) {
                console.log('[DoorDash] Waiting for redirect timed out, checking current state...');
                await takeScreenshot('login-stuck');

                // If stuck on identity.doordash.com, try navigating to homepage
                const currentUrl = page.url();
                if (currentUrl.includes('identity.doordash.com')) {
                    console.log('[DoorDash] Stuck on identity server, navigating to homepage...');
                    await page.goto(DOORDASH_URL, { waitUntil: 'domcontentloaded' });
                    await delay(3000);
                }
            }

            await delay(2000);

            // Verify we're actually logged in by checking the page
            const currentUrl = page.url();
            console.log(`[DoorDash] Current URL after login: ${currentUrl}`);

            // Check for logged-in indicators on current page
            const loggedInIndicators = await page.$$('[data-anchor-id="AccountMenu"], [aria-label="Account"], img[alt*="avatar"], button[aria-label*="account"], text="Account"');
            if (loggedInIndicators.length > 0) {
                console.log('[DoorDash] Login verified - found account indicator');
                return { success: true, message: 'Login successful' };
            }

        } else {
            console.log('[DoorDash] No password field - will check for 2FA code entry');
        }

        // Wait for page to settle
        await delay(3000);

        // Check current URL - if we're not on login page, likely success
        const finalUrl = page.url();
        console.log(`[DoorDash] Final URL: ${finalUrl}`);

        if (!finalUrl.includes('/login') && !finalUrl.includes('/consumer/login')) {
            console.log('[DoorDash] No longer on login page - assuming success');
            await takeScreenshot('login-complete');
            return { success: true, message: 'Login successful' };
        }

        // Check for login errors on the page
        const errorSelectors = [
            '[data-anchor-id="LoginError"]',
            '[role="alert"]',
            '.error-message',
            'text="Invalid"',
            'text="incorrect"'
        ];

        for (const selector of errorSelectors) {
            try {
                const error = await page.$(selector);
                if (error && await error.isVisible()) {
                    const errorText = await error.textContent();
                    if (errorText && (errorText.toLowerCase().includes('invalid') || errorText.toLowerCase().includes('incorrect') || errorText.toLowerCase().includes('error'))) {
                        await takeScreenshot('login-error');
                        return { success: false, error: `Login failed: ${errorText}` };
                    }
                }
            } catch (e) {}
        }

        // If still on login page without errors, something went wrong
        await takeScreenshot('login-unknown-state');
        console.log('[DoorDash] Still on login page but no errors found');

        // Check for 2FA / verification code screen
        const twoFASelectors = [
            'input[data-anchor-id="VerificationCodeInput"]',
            'input[placeholder*="code"]',
            'input[placeholder*="Code"]',
            '[data-testid="verification-input"]',
            'input[name="code"]',
            'input[type="tel"][maxlength="6"]',
            'input[autocomplete="one-time-code"]'
        ];

        let twoFAInput = null;
        for (const selector of twoFASelectors) {
            const input = await page.$(selector);
            if (input && await input.isVisible()) {
                twoFAInput = input;
                break;
            }
        }

        if (twoFAInput) {
            console.log('[DoorDash] 2FA code required - attempting to auto-read from notifications...');
            await takeScreenshot('2fa-waiting');

            // Try to automatically get the code from Windows notifications
            const maxAttempts = 20; // Try for about 60 seconds
            let codeEntered = false;

            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                // First check if we're already logged in (user entered code manually)
                const stillOn2FA = await page.$('input[placeholder*="code"], input[placeholder*="Code"], input[name="code"], input[type="tel"][maxlength="6"]');
                if (!stillOn2FA || !(await stillOn2FA.isVisible())) {
                    await delay(2000);
                    console.log('[DoorDash] 2FA screen gone - checking login status...');
                    // Give it a moment to settle
                    await delay(2000);
                    return { success: true, message: '2FA completed' };
                }

                // Try to get code from notifications
                console.log(`[DoorDash] Checking for verification code (attempt ${attempt + 1}/${maxAttempts})...`);
                const code = await getVerificationCodeFromNotifications();

                if (code && !codeEntered) {
                    console.log(`[DoorDash] Found code: ${code} - entering it now...`);

                    // DoorDash uses 6 separate input boxes - find them all
                    const codeInputs = await page.$$('input[type="tel"], input[maxlength="1"], input[data-testid*="code"], input[name*="code"]');

                    if (codeInputs.length >= 6) {
                        // Enter each digit in separate boxes
                        console.log(`[DoorDash] Found ${codeInputs.length} code input boxes`);
                        for (let i = 0; i < 6 && i < codeInputs.length; i++) {
                            await codeInputs[i].click({ force: true });
                            await codeInputs[i].fill(code[i]);
                            await delay(100);
                        }
                    } else if (twoFAInput) {
                        // Single input field
                        await twoFAInput.click({ force: true });
                        await twoFAInput.fill('');
                        await twoFAInput.fill(code);
                    }
                    await delay(1000);

                    // Try to submit the code
                    const submitSelectors = [
                        'button:has-text("Verify")',
                        'button:has-text("Submit")',
                        'button:has-text("Continue")',
                        'button[type="submit"]'
                    ];

                    for (const selector of submitSelectors) {
                        try {
                            const btn = await page.$(selector);
                            if (btn && await btn.isVisible()) {
                                await btn.click({ force: true });
                                console.log('[DoorDash] Submitted verification code');
                                codeEntered = true;
                                break;
                            }
                        } catch (e) {}
                    }

                    // If no submit button, try pressing Enter
                    if (!codeEntered) {
                        await page.keyboard.press('Enter');
                        codeEntered = true;
                    }

                    // Wait for result
                    await delay(3000);
                }

                // Check for error messages
                const errorEl = await page.$('[role="alert"], .error-message');
                if (errorEl && await errorEl.isVisible()) {
                    const errorText = await errorEl.textContent();
                    if (errorText && (errorText.toLowerCase().includes('invalid') || errorText.toLowerCase().includes('incorrect'))) {
                        console.log('[DoorDash] Code was invalid, waiting for new code...');
                        codeEntered = false; // Reset to try again with new code
                    }
                }

                await delay(3000); // Wait before next check
            }

            // Check final state
            const finalCheck = await page.$('input[placeholder*="code"], input[placeholder*="Code"], input[name="code"]');
            if (!finalCheck || !(await finalCheck.isVisible())) {
                return { success: true, message: '2FA completed' };
            }

            // Timeout - code was not found or entered incorrectly
            await takeScreenshot('2fa-timeout');
            return {
                success: false,
                error: '2FA_TIMEOUT',
                message: 'Could not automatically enter verification code. Please try again or enter manually.'
            };
        }

        await takeScreenshot('login-unknown');
        return { success: false, error: 'Login status unknown' };

    } catch (error) {
        console.error('[DoorDash] Login error:', error.message);
        await takeScreenshot('login-exception');
        return { success: false, error: error.message };
    }
}

/**
 * Set delivery address with validation
 */
async function setAddress(address) {
    try {
        console.log(`[DoorDash] Setting address: ${address}`);

        // Look for address input
        const addressInput = await waitForElement(SELECTORS.address.input);
        await addressInput.click();
        await addressInput.fill('');
        await humanType(addressInput, address);
        await delay(1500);

        // Wait for suggestions
        let suggestion;
        try {
            suggestion = await waitForElement(SELECTORS.address.suggestion);
        } catch (e) {
            // No suggestions found - check for "no results" message
            const noResults = await page.$('text="No results found", text="Address not found"');
            if (noResults && await noResults.isVisible()) {
                return {
                    success: false,
                    error: DoorDashErrors.ADDRESS_NOT_FOUND,
                    message: 'Address not found. Please check the address and try again.'
                };
            }
            throw e;
        }

        await suggestion.click();
        await delay(1000);

        // Confirm address if needed
        try {
            const confirmBtn = await page.$(SELECTORS.address.confirmButton);
            if (confirmBtn && await confirmBtn.isVisible()) {
                await confirmBtn.click();
                await delay(1000);
            }
        } catch (e) {
            // Confirm button may not be needed
        }

        // Check for address errors after setting
        await delay(500);
        const addressErrors = [
            'text="doesn\'t deliver here"',
            'text="does not deliver"',
            'text="outside delivery area"',
            'text="We don\'t deliver"',
            '[data-testid="address-error"]'
        ];

        for (const selector of addressErrors) {
            try {
                const errorEl = await page.$(selector);
                if (errorEl && await errorEl.isVisible()) {
                    const errorText = await errorEl.textContent();
                    console.log(`[DoorDash] Address error detected: ${errorText}`);
                    return {
                        success: false,
                        error: DoorDashErrors.ADDRESS_NOT_SERVICEABLE,
                        message: errorText || 'This address is not serviceable'
                    };
                }
            } catch (e) {
                continue;
            }
        }

        console.log('[DoorDash] Address set successfully');
        return { success: true };

    } catch (error) {
        console.error('[DoorDash] Set address error:', error.message);
        await takeScreenshot('address-error');
        return { success: false, error: error.message };
    }
}

/**
 * Search for a restaurant
 */
async function searchRestaurant(name, address = null) {
    try {
        console.log(`[DoorDash] Searching for: ${name}`);

        // Set address if provided
        if (address) {
            const addressResult = await setAddress(address);
            if (!addressResult.success) {
                return addressResult;
            }
        }

        // Navigate to search or use existing page
        await page.goto(`${DOORDASH_URL}/search/store/${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded' });
        await delay(2000);
        await handlePopups();

        // Wait for results
        const results = await page.$$(SELECTORS.search.results);

        if (results.length === 0) {
            await takeScreenshot('no-results');
            return { success: false, error: `No restaurants found for "${name}"` };
        }

        // Get first matching result
        const firstResult = results[0];
        const restaurantName = await firstResult.$eval(SELECTORS.search.restaurantName, el => el.textContent);

        console.log(`[DoorDash] Found restaurant: ${restaurantName}`);

        // Click to open restaurant
        await firstResult.click();
        await delay(2000);

        return {
            success: true,
            restaurant: restaurantName,
            resultsCount: results.length
        };

    } catch (error) {
        console.error('[DoorDash] Search error:', error.message);
        await takeScreenshot('search-error');
        return { success: false, error: error.message };
    }
}

/**
 * Add item to cart
 */
async function addItemToCart(itemName, options = {}) {
    try {
        console.log(`[DoorDash] Adding item: ${itemName}`);

        // Find menu item by name
        const menuItems = await page.$$(SELECTORS.menu.item);
        let targetItem = null;

        for (const item of menuItems) {
            try {
                const name = await item.$eval(SELECTORS.menu.itemName, el => el.textContent);
                if (name.toLowerCase().includes(itemName.toLowerCase())) {
                    targetItem = item;
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!targetItem) {
            return { success: false, error: `Item "${itemName}" not found on menu` };
        }

        // Click the item to open customization modal
        await targetItem.click();
        await delay(1500);

        // Handle required options
        if (options.protein || options.size || options.customizations) {
            const optionValue = options.protein || options.size || options.customizations;

            // Find and select the option
            const optionItems = await page.$$(SELECTORS.customization.optionItem);
            for (const optItem of optionItems) {
                try {
                    const optText = await optItem.textContent();
                    if (optText.toLowerCase().includes(optionValue.toLowerCase())) {
                        await optItem.click();
                        await delay(500);
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        // Handle quantity
        if (options.quantity && options.quantity > 1) {
            for (let i = 1; i < options.quantity; i++) {
                const increaseBtn = await page.$(SELECTORS.customization.quantityIncrease);
                if (increaseBtn) {
                    await increaseBtn.click();
                    await delay(300);
                }
            }
        }

        // Click Add to Order/Cart
        const addButton = await waitForElement(SELECTORS.customization.addToOrder + ', ' + SELECTORS.menu.addButton);
        await addButton.click();
        await delay(1500);

        console.log(`[DoorDash] Added ${itemName} to cart`);
        return { success: true, item: itemName };

    } catch (error) {
        console.error('[DoorDash] Add item error:', error.message);
        await takeScreenshot('add-item-error');
        return { success: false, error: error.message };
    }
}

/**
 * Proceed to checkout with payment validation
 */
async function checkout(tipPercent = 15, deliveryInstructions = '') {
    try {
        console.log('[DoorDash] Starting checkout...');

        // Click cart button
        const cartButton = await waitForElement(SELECTORS.cart.viewCart);
        await cartButton.click();
        await delay(2000);

        // Check for any errors before proceeding
        const preCheckoutErrors = await detectPageErrors();
        if (preCheckoutErrors.hasError) {
            return {
                success: false,
                error: preCheckoutErrors.errorType,
                message: preCheckoutErrors.message
            };
        }

        // Click checkout
        const checkoutBtn = await waitForElement(SELECTORS.cart.checkout);
        await checkoutBtn.click();
        await delay(3000);
        await handlePopups();

        // Check for minimum order not met
        const minOrderError = await page.$('text="Minimum order", text="minimum"');
        if (minOrderError && await minOrderError.isVisible()) {
            const errorText = await minOrderError.textContent();
            return {
                success: false,
                error: DoorDashErrors.MINIMUM_NOT_MET,
                message: errorText || 'Minimum order not met'
            };
        }

        // Select tip
        const tipButtons = await page.$$(SELECTORS.checkout.tipButtons);
        for (const btn of tipButtons) {
            try {
                const text = await btn.textContent();
                if (text.includes(`${tipPercent}%`) || text.includes(`$`)) {
                    await btn.click();
                    await delay(500);
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        // Verify/select payment method
        console.log('[DoorDash] Checking payment method...');
        const paymentResult = await verifyPaymentMethod();
        if (!paymentResult.success) {
            return paymentResult;
        }

        // Add delivery instructions if provided
        if (deliveryInstructions) {
            try {
                const instructionsInput = await page.$(SELECTORS.checkout.deliveryInstructions);
                if (instructionsInput) {
                    await instructionsInput.fill(deliveryInstructions);
                    await delay(500);
                }
            } catch (e) {
                // Instructions field may not be visible
            }
        }

        // Check for address update prompts during checkout
        const addressPrompt = await page.$(SELECTORS.checkout.updateAddress);
        if (addressPrompt && await addressPrompt.isVisible()) {
            console.log('[DoorDash] Address update prompt detected');
            // Could potentially handle this, but for now report it
            await takeScreenshot('checkout-address-prompt');
        }

        // Final error check before returning success
        const checkoutErrors = await detectPageErrors();
        if (checkoutErrors.hasError) {
            return {
                success: false,
                error: checkoutErrors.errorType,
                message: checkoutErrors.message
            };
        }

        return { success: true, message: 'Ready to place order' };

    } catch (error) {
        console.error('[DoorDash] Checkout error:', error.message);
        await takeScreenshot('checkout-error');
        return { success: false, error: error.message };
    }
}

/**
 * Verify payment method is available and selected
 */
async function verifyPaymentMethod() {
    try {
        // Look for payment section
        const paymentSection = await page.$(SELECTORS.checkout.paymentSection);

        if (!paymentSection) {
            console.log('[DoorDash] Payment section not found - may be pre-selected');
            // Payment might already be selected if user has default card
            return { success: true, message: 'Payment assumed selected' };
        }

        // Check if a payment card is already selected
        const selectedCard = await page.$(SELECTORS.checkout.paymentCard);
        if (selectedCard && await selectedCard.isVisible()) {
            console.log('[DoorDash] Payment card found');
            return { success: true, message: 'Payment method selected' };
        }

        // Check for "Add payment" button (means no payment on file)
        const addPaymentBtn = await page.$(SELECTORS.checkout.addPayment);
        if (addPaymentBtn && await addPaymentBtn.isVisible()) {
            await takeScreenshot('no-payment-method');
            return {
                success: false,
                error: DoorDashErrors.NO_PAYMENT_METHOD,
                message: 'No payment method on file. Please add a card in the DoorDash app.'
            };
        }

        // Click on payment section to expand/select if needed
        try {
            const isClickable = await paymentSection.isVisible();
            if (isClickable) {
                await paymentSection.click();
                await delay(1000);

                // After clicking, check for available cards
                const cards = await page.$$('[data-testid="saved-card"], [data-anchor-id="PaymentCard"]');
                if (cards.length > 0) {
                    // Select first card
                    await cards[0].click();
                    await delay(500);
                    console.log('[DoorDash] Selected first available payment card');
                    return { success: true, message: 'Payment method selected' };
                }
            }
        } catch (e) {
            console.log('[DoorDash] Could not interact with payment section:', e.message);
        }

        // If we got here and couldn't verify payment, assume it's okay
        // (DoorDash will block place order if there's an issue)
        console.log('[DoorDash] Payment verification inconclusive - proceeding');
        return { success: true, message: 'Payment assumed valid' };

    } catch (error) {
        console.error('[DoorDash] Payment verification error:', error.message);
        return { success: true, message: 'Payment check skipped due to error' };
    }
}

/**
 * Place the order with confirmation verification
 */
async function placeOrder() {
    try {
        console.log('[DoorDash] Placing order...');

        const DRY_RUN = process.env.DOORDASH_DRY_RUN === 'true';
        if (DRY_RUN) {
            console.log('[DoorDash] DRY RUN — skipping Place Order click (placeOrder)');
            return { success: true, dryRun: true, message: 'Dry run — place order skipped.' };
        }

        // Check for any errors before attempting to place order
        const preOrderErrors = await detectPageErrors();
        if (preOrderErrors.hasError) {
            return {
                success: false,
                error: preOrderErrors.errorType,
                message: preOrderErrors.message
            };
        }

        // Click Place Order button
        let placeOrderBtn;
        try {
            placeOrderBtn = await waitForElement(SELECTORS.checkout.placeOrder);
        } catch (e) {
            await takeScreenshot('place-order-button-not-found');
            return {
                success: false,
                error: DoorDashErrors.UNKNOWN,
                message: 'Could not find Place Order button'
            };
        }

        await placeOrderBtn.click();
        console.log('[DoorDash] Clicked Place Order button');

        // Wait for response - either confirmation or error
        await delay(3000);

        // Check for immediate errors (payment declined, etc.)
        const immediateErrors = await detectPageErrors();
        if (immediateErrors.hasError) {
            await takeScreenshot('place-order-error-detected');
            return {
                success: false,
                error: immediateErrors.errorType,
                message: immediateErrors.message
            };
        }

        // Wait for confirmation page URL pattern
        let confirmationDetected = false;
        const maxWaitTime = 30000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            const currentUrl = page.url();

            // Check for confirmation URL patterns
            if (currentUrl.includes('/orders/') ||
                currentUrl.includes('/confirmation') ||
                currentUrl.includes('/tracking') ||
                currentUrl.includes('/order-status')) {
                confirmationDetected = true;
                console.log('[DoorDash] Confirmation page detected');
                break;
            }

            // Check for confirmation page elements
            const confirmationEl = await page.$(SELECTORS.confirmation.confirmationPage);
            if (confirmationEl && await confirmationEl.isVisible()) {
                confirmationDetected = true;
                console.log('[DoorDash] Confirmation element detected');
                break;
            }

            // Check for Track Order button (strong confirmation indicator)
            const trackBtn = await page.$('button:has-text("Track"), a:has-text("Track Order")');
            if (trackBtn && await trackBtn.isVisible()) {
                confirmationDetected = true;
                console.log('[DoorDash] Track Order button detected');
                break;
            }

            // Check for errors that appeared
            const errorCheck = await detectPageErrors();
            if (errorCheck.hasError) {
                await takeScreenshot('order-failed-error');
                return {
                    success: false,
                    error: errorCheck.errorType,
                    message: errorCheck.message
                };
            }

            // Check if Place Order button is still visible (order didn't go through)
            const stillOnCheckout = await page.$(SELECTORS.checkout.placeOrder);
            if (stillOnCheckout && await stillOnCheckout.isVisible()) {
                // Button still there - try clicking again
                if (Date.now() - startTime > 5000) {
                    console.log('[DoorDash] Place Order button still visible, retrying click...');
                    await stillOnCheckout.click();
                    await delay(2000);
                }
            }

            await delay(1000);
        }

        if (!confirmationDetected) {
            await takeScreenshot('order-confirmation-timeout');
            // Even if we don't detect confirmation, check the page state
            const finalUrl = page.url();
            console.log('[DoorDash] Final URL after order attempt:', finalUrl);

            // If URL changed from checkout, assume success
            if (!finalUrl.includes('/checkout')) {
                console.log('[DoorDash] No longer on checkout page - assuming success');
                confirmationDetected = true;
            }
        }

        // Get order confirmation details
        await delay(2000);
        const confirmation = await getOrderConfirmation();

        if (confirmationDetected || confirmation.orderNumber) {
            return {
                success: true,
                ...confirmation
            };
        }

        // Couldn't confirm - return uncertain state
        await takeScreenshot('order-status-unknown');
        return {
            success: false,
            error: DoorDashErrors.UNKNOWN,
            message: 'Could not confirm order status. Please check DoorDash app.',
            ...confirmation
        };

    } catch (error) {
        console.error('[DoorDash] Place order error:', error.message);
        await takeScreenshot('place-order-error');
        return { success: false, error: error.message };
    }
}

/**
 * Get order confirmation details
 */
async function getOrderConfirmation() {
    try {
        const details = {};

        // Try to get order number
        try {
            const orderNumEl = await page.$(SELECTORS.confirmation.orderNumber);
            if (orderNumEl) {
                details.orderNumber = await orderNumEl.textContent();
            }
        } catch (e) {}

        // Try to get ETA
        try {
            const etaEl = await page.$(SELECTORS.confirmation.eta);
            if (etaEl) {
                details.eta = await etaEl.textContent();
            }
        } catch (e) {}

        // Try to get restaurant name
        try {
            const restaurantEl = await page.$(SELECTORS.confirmation.restaurantName);
            if (restaurantEl) {
                details.restaurant = await restaurantEl.textContent();
            }
        } catch (e) {}

        // Take confirmation screenshot
        await takeScreenshot('order-confirmed');

        return details;

    } catch (error) {
        console.error('[DoorDash] Get confirmation error:', error.message);
        return {};
    }
}

/**
 * Full order flow - combines all steps
 * @param {Object} credentials - { email, password }
 * @param {Object} orderDetails - { restaurantName, items, address, tipPercent, deliveryInstructions }
 * @param {Object} options - { keepBrowserOpen: boolean, isAdditionalOrder: boolean }
 */
async function placeFullOrder(credentials, orderDetails, options = {}) {
    const { email, password } = credentials;
    const {
        restaurantName,
        items,
        address,
        tipPercent = 15,
        deliveryInstructions = ''
    } = orderDetails;
    const { keepBrowserOpen = false, isAdditionalOrder = false } = options;

    const result = {
        success: false,
        steps: [],
        error: null,
        errorType: null,
        completedSteps: [],
        failedStep: null
    };

    // Helper to record step failure
    const recordFailure = async (stepName, error, errorType = null) => {
        result.failedStep = stepName;
        result.error = error;
        result.errorType = errorType || DoorDashErrors.UNKNOWN;
        try {
            await takeScreenshot(`failed-${stepName}`);
        } catch (e) {
            // Screenshot failed
        }
    };

    try {
        // Step 1: Ensure browser is launched and logged in (with retry)
        console.log('[DoorDash] Step 1: Login');
        let loginResult;
        try {
            loginResult = await withRetry(async () => {
                return await ensureLoggedIn(email, password);
            }, 2, 2000);
        } catch (e) {
            loginResult = { success: false, error: e.message };
        }

        result.steps.push({ step: 'login', ...loginResult });
        if (!loginResult.success) {
            await recordFailure('login', loginResult.error, DoorDashErrors.LOGIN_FAILED);
            return result;
        }
        result.completedSteps.push('login');

        // Step 2: Search restaurant (with retry for network issues)
        console.log('[DoorDash] Step 2: Search restaurant');
        let searchResult;
        try {
            searchResult = await withRetry(async () => {
                return await searchRestaurant(restaurantName, address);
            }, 2, 2000);
        } catch (e) {
            searchResult = { success: false, error: e.message };
        }

        result.steps.push({ step: 'search', ...searchResult });
        if (!searchResult.success) {
            // Check for specific error types
            const errorType = searchResult.error?.includes('address')
                ? DoorDashErrors.ADDRESS_NOT_SERVICEABLE
                : DoorDashErrors.RESTAURANT_NOT_FOUND;
            await recordFailure('search', searchResult.error, errorType);
            return result;
        }
        result.completedSteps.push('search');
        updateSessionState({ currentRestaurantPage: restaurantName });

        // Check page for errors before adding items
        const pageErrors = await detectPageErrors();
        if (pageErrors.hasError) {
            await recordFailure('page_check', pageErrors.message, pageErrors.errorType);
            return result;
        }

        // Step 3: Add items (with individual retry)
        console.log('[DoorDash] Step 3: Add items');
        for (const item of items) {
            let addResult;
            try {
                addResult = await withRetry(async () => {
                    return await addItemToCart(item.name, item.options || {});
                }, 2, 1000);
            } catch (e) {
                addResult = { success: false, error: e.message };
            }

            result.steps.push({ step: 'add_item', item: item.name, ...addResult });
            if (!addResult.success) {
                const errorType = addResult.error?.includes('sold out')
                    ? DoorDashErrors.ITEM_SOLD_OUT
                    : DoorDashErrors.ITEM_NOT_FOUND;
                await recordFailure(`add_item:${item.name}`, addResult.error, errorType);
                return result;
            }
            result.completedSteps.push(`add_item:${item.name}`);
        }

        // Step 4: Checkout
        console.log('[DoorDash] Step 4: Checkout');
        let checkoutResult;
        try {
            checkoutResult = await checkout(tipPercent, deliveryInstructions);
        } catch (e) {
            checkoutResult = { success: false, error: e.message };
        }

        result.steps.push({ step: 'checkout', ...checkoutResult });
        if (!checkoutResult.success) {
            const errorType = checkoutResult.error || checkoutResult.errorType || DoorDashErrors.UNKNOWN;
            await recordFailure('checkout', checkoutResult.message || checkoutResult.error, errorType);
            return result;
        }
        result.completedSteps.push('checkout');

        // Step 5: Place order
        console.log('[DoorDash] Step 5: Place order');
        let orderResult;
        try {
            orderResult = await placeOrder();
        } catch (e) {
            orderResult = { success: false, error: e.message };
        }

        result.steps.push({ step: 'place_order', ...orderResult });
        if (!orderResult.success) {
            const errorType = orderResult.errorType || orderResult.error || DoorDashErrors.UNKNOWN;
            await recordFailure('place_order', orderResult.message || orderResult.error, errorType);
            return result;
        }
        result.completedSteps.push('place_order');

        result.success = true;
        result.orderNumber = orderResult.orderNumber;
        result.eta = orderResult.eta;
        updateSessionState({ currentRestaurantPage: null });

        console.log('[DoorDash] Order completed successfully');
        return result;

    } catch (error) {
        console.error('[DoorDash] Unexpected error in placeFullOrder:', error.message);
        result.error = error.message;
        result.errorType = DoorDashErrors.UNKNOWN;
        try {
            await takeScreenshot('full-order-unexpected-error');
        } catch (e) {
            // Screenshot failed
        }

        // Try to recover browser state for future orders
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
            console.log('[DoorDash] Browser crashed, resetting state...');
            resetSessionState();
            context = null;
            page = null;
        }

        return result;

    } finally {
        // Only close browser if not keeping open for more orders
        if (!keepBrowserOpen && HEADLESS) {
            await closeBrowser();
        }
    }
}

/**
 * Place an additional order reusing the existing session
 * Use this for multi-restaurant orders to avoid re-login
 */
async function placeAdditionalOrder(credentials, orderDetails) {
    // Validate we have an active session
    if (!sessionState.launched || !page) {
        console.log('[DoorDash] No active session, using full order flow');
        return placeFullOrder(credentials, orderDetails, { keepBrowserOpen: true });
    }

    // Check session is still valid
    const validation = await validateSession();
    if (!validation.valid) {
        console.log('[DoorDash] Session invalid, restarting');
        await closeBrowser();
        return placeFullOrder(credentials, orderDetails, { keepBrowserOpen: true });
    }

    // Use full order flow with session reuse flag
    return placeFullOrder(credentials, orderDetails, {
        keepBrowserOpen: true,
        isAdditionalOrder: true
    });
}

/**
 * Checkout with items already in the DoorDash cart
 * This is simpler than placeFullOrder - it assumes items are already added
 */
// Select a scheduled delivery time in DoorDash checkout.
// targetTime: "HH:MM" 24-hour or "H:MM PM" string.
// Returns { success, selectedSlot } — success=false means couldn't pick a slot (caller falls back to ASAP).
async function selectScheduledDeliveryTime(targetTime) {
    console.log(`[DoorDash] Selecting scheduled delivery time: ${targetTime}`);
    try {
        // Parse target into minutes-since-midnight for comparison
        const parseMinutes = (str) => {
            const m = str.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
            if (!m) return null;
            let h = parseInt(m[1]), min = parseInt(m[2]);
            const period = (m[3] || '').toLowerCase();
            if (period === 'pm' && h < 12) h += 12;
            if (period === 'am' && h === 12) h = 0;
            return h * 60 + min;
        };
        const targetMins = parseMinutes(targetTime);

        // Step 1: find and click the delivery time picker (looks like "ASAP" or a time display)
        const timePickerSelectors = [
            '[data-anchor-id*="DeliveryTime"]',
            '[data-testid*="delivery-time"]',
            '[data-testid*="DeliveryTime"]',
        ];
        let opened = false;
        for (const sel of timePickerSelectors) {
            const loc = page.locator(sel).first();
            if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                await loc.click();
                await delay(1500);
                opened = true;
                console.log(`[DoorDash] Opened time picker via ${sel}`);
                break;
            }
        }
        if (!opened) {
            // Try text-based: button/div showing "ASAP" or "Schedule for later"
            const asapLoc = page.locator('button, [role="button"], div[tabindex]')
                .filter({ hasText: /^asap$|schedule.*later|delivery time/i }).first();
            if (await asapLoc.count() > 0) {
                await asapLoc.click();
                await delay(1500);
                opened = true;
                console.log('[DoorDash] Opened time picker via ASAP text');
            }
        }
        if (!opened) {
            console.log('[DoorDash] Could not find delivery time picker');
            return { success: false };
        }

        // Step 2: switch from ASAP to "Schedule" tab if present
        const scheduleTab = page.locator('button, [role="tab"], [role="button"]')
            .filter({ hasText: /schedule|later|pick a time/i }).first();
        if (await scheduleTab.count() > 0 && await scheduleTab.isVisible().catch(() => false)) {
            await scheduleTab.click();
            await delay(1500);
            console.log('[DoorDash] Switched to Schedule tab');
        }

        // Step 3: pick the time slot closest to the target
        const slots = await page.locator('[role="option"], [role="radio"], label').all();
        console.log(`[DoorDash] Found ${slots.length} time slots`);

        let bestSlot = null, bestDiff = Infinity, bestText = '';
        for (const slot of slots) {
            const text = (await slot.textContent().catch(() => '')).trim();
            if (!text) continue;
            const slotMins = parseMinutes(text);
            if (slotMins === null) continue;
            const diff = targetMins !== null ? Math.abs(slotMins - targetMins) : slotMins; // if no target, pick first
            if (diff < bestDiff) { bestDiff = diff; bestSlot = slot; bestText = text; }
        }

        if (!bestSlot) {
            // Fallback: just click the first available option that isn't "ASAP"
            const firstNonAsap = page.locator('[role="option"], [role="radio"], label')
                .filter({ hasNotText: /asap/i }).first();
            if (await firstNonAsap.count() > 0) {
                bestSlot = firstNonAsap;
                bestText = (await firstNonAsap.textContent().catch(() => '')).trim();
            }
        }

        if (!bestSlot) {
            console.log('[DoorDash] No selectable time slots found');
            return { success: false };
        }

        await bestSlot.scrollIntoViewIfNeeded().catch(() => {});
        await bestSlot.click();
        await delay(1000);

        // Step 4: confirm selection (some DoorDash modals have a "Save" or "Confirm" button)
        const confirmBtn = page.locator('button, [role="button"]')
            .filter({ hasText: /save|confirm|done|apply/i }).first();
        if (await confirmBtn.count() > 0 && await confirmBtn.isVisible().catch(() => false)) {
            await confirmBtn.click();
            await delay(1500);
            console.log('[DoorDash] Confirmed time slot selection');
        }

        console.log(`[DoorDash] Selected delivery slot: "${bestText}"`);
        return { success: true, selectedSlot: bestText };
    } catch (e) {
        console.log('[DoorDash] selectScheduledDeliveryTime error:', e.message);
        return { success: false };
    }
}

async function checkoutCurrentCart(options = {}) {
    const { scheduledTime = null } = options;
    console.log('[DoorDash] === CHECKING OUT CURRENT CART ===');

    try {
        if (!page) {
            return { success: false, error: 'Browser not open' };
        }

        // Close any open modals
        const closeModalBtn = await page.$('[role="dialog"] button[aria-label*="close"], [aria-modal="true"] button[aria-label*="close"]');
        if (closeModalBtn) {
            console.log('[DoorDash] Closing open modal first...');
            await closeModalBtn.click();
            await delay(1000);
        }
        await page.keyboard.press('Escape');
        await delay(500);

        // Use Playwright locators (not coordinate math) to find and click checkout button.
        // Locators handle scrollIntoView + stable clicking internally.
        const tryClickCheckout = async (label) => {
            // Priority 1: data-anchor-id attribute
            const byAnchor = page.locator('[data-anchor-id*="checkout" i], [data-anchor-id*="CartCheckout" i]').first();
            if (await byAnchor.count() > 0 && await byAnchor.isVisible().catch(() => false)) {
                const text = (await byAnchor.textContent().catch(() => '')).trim().substring(0, 50);
                console.log(`[DoorDash] ${label}: found by anchor-id, text="${text}"`);
                await byAnchor.scrollIntoViewIfNeeded();
                await byAnchor.click();
                return true;
            }
            // Priority 2: text match
            const phrases = ['Go to checkout', 'Checkout', 'Continue to checkout', 'Place order', 'View cart'];
            for (const phrase of phrases) {
                const loc = page.locator('button, a').filter({ hasText: new RegExp(phrase, 'i') }).first();
                if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
                    const text = (await loc.textContent().catch(() => '')).trim().substring(0, 50);
                    console.log(`[DoorDash] ${label}: found by text="${text}"`);
                    await loc.scrollIntoViewIfNeeded();
                    await loc.click();
                    return true;
                }
            }
            // Debug: return button list from evaluate (not console.log inside it — that goes to browser console)
            const btnTexts = await page.evaluate(() =>
                Array.from(document.querySelectorAll('button, a'))
                    .filter(b => { const r = b.getBoundingClientRect(); return r.width > 40 && r.height > 20; })
                    .map(b => (b.textContent || '').trim().substring(0, 40))
                    .filter(t => t)
                    .slice(0, 20)
            );
            console.log(`[DoorDash] ${label}: no checkout button found. Visible: ${JSON.stringify(btnTexts)}`);
            return false;
        };

        // Step 1: current page (restaurant page has sidebar cart with checkout button)
        await page.evaluate(() => window.scrollTo(0, 0));
        await delay(800);
        let clicked = await tryClickCheckout('current page');

        if (!clicked) {
            // Step 2: open cart drawer via cart icon (skip if CF overlay is blocking)
            const cartIcon = page.locator('[aria-label*="cart" i], [data-anchor-id*="cart" i]').first();
            if (await cartIcon.count() > 0 && await cartIcon.isVisible().catch(() => false)) {
                console.log('[DoorDash] Opening cart drawer...');
                try {
                    await cartIcon.click({ timeout: 5000 });
                    await delay(1500);
                    clicked = await tryClickCheckout('after cart open');
                } catch (e) {
                    console.log('[DoorDash] Cart icon click blocked (CF overlay?) — skipping to /cart/ nav');
                }
            }
        }

        if (clicked) {
            await delay(3000);
        } else {
            // Step 3: navigate to /cart/
            console.log('[DoorDash] Navigating to /cart/...');
            await page.goto('https://www.doordash.com/cart/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(2000);
            console.log('[DoorDash] URL after /cart/ nav:', page.url());

            // Detect empty cart state: DoorDash shows "Go home" and "0 items in cart"
            const isEmptyCart = await page.evaluate(() => {
                const pageText = document.body.innerText || '';
                const hasGoHome = Array.from(document.querySelectorAll('button, a'))
                    .some(b => (b.textContent || '').trim().toLowerCase() === 'go home');
                const hasZeroItems = /\b0\s*items?\s*in\s*cart\b/i.test(pageText);
                return hasGoHome || hasZeroItems;
            });
            if (isEmptyCart) {
                console.log('[DoorDash] DoorDash cart is empty (browser session reset). User must re-add items.');
                return { success: false, error: 'EMPTY_CART' };
            }

            clicked = await tryClickCheckout('/cart/ page');
            if (clicked) await delay(3000);
        }

        let pageUrl = page.url();
        console.log(`[DoorDash] Current URL: ${pageUrl}`);

        if (!pageUrl.includes('checkout')) {
            // Step 4: navigate to store page as last resort
            const storeUrl = sessionState.currentRestaurantUrl || sessionState.currentRestaurantPage;
            if (storeUrl && storeUrl.includes('doordash.com')) {
                console.log('[DoorDash] Trying store page:', storeUrl);
                await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await delay(2000);
                await page.evaluate(() => window.scrollTo(0, 0));
                await delay(500);
                const clicked2 = await tryClickCheckout('store page');
                if (clicked2) await delay(3000);
                pageUrl = page.url();
                console.log('[DoorDash] URL after store page retry:', pageUrl);
            }
        }

        if (!pageUrl.includes('checkout')) {
            return { success: false, error: 'Could not reach checkout page' };
        }

        // If a scheduled delivery time was requested, interact with DoorDash's time picker now
        let selectedSlot = null;
        if (scheduledTime) {
            await delay(2000); // let checkout fully render before touching the time picker
            const slotResult = await selectScheduledDeliveryTime(scheduledTime);
            if (slotResult.success) {
                selectedSlot = slotResult.selectedSlot;
                console.log(`[DoorDash] Scheduled delivery slot set: ${selectedSlot}`);
            } else {
                console.log('[DoorDash] Could not select scheduled time — proceeding ASAP');
            }
        }

        // Wait up to 12s for the Place Order button to appear (vogue=t1 checkout renders slowly)
        let orderBtn = null;
        for (let attempt = 0; attempt < 4 && !orderBtn; attempt++) {
            if (attempt > 0) await delay(3000);
            const placeOrderLoc = page.locator('button, [role="button"]')
                .filter({ hasText: /place order|submit order/i })
                .first();
            const placeOrderByAttr = page.locator('[data-testid="PlaceOrderButton"], [data-anchor-id="CheckoutButton"]').first();
            if (await placeOrderLoc.count() > 0 && await placeOrderLoc.isVisible().catch(() => false)) {
                orderBtn = placeOrderLoc;
            } else if (await placeOrderByAttr.count() > 0 && await placeOrderByAttr.isVisible().catch(() => false)) {
                orderBtn = placeOrderByAttr;
            } else {
                const submitBtn = page.locator('button[type="submit"]').first();
                if (await submitBtn.count() > 0 && await submitBtn.isVisible().catch(() => false)) {
                    orderBtn = submitBtn;
                }
            }
            if (!orderBtn) console.log(`[DoorDash] Place Order button not found yet (attempt ${attempt + 1}/4)...`);
        }

        if (!orderBtn) {
            const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500)).catch(() => '');
            console.log('[DoorDash] Checkout page text at failure:', pageText);
            return { success: false, error: 'Could not find Place Order button' };
        }

        const btnText = (await orderBtn.textContent().catch(() => '')).trim();
        console.log(`[DoorDash] Found order button: "${btnText}"`);

        let isDisabled = await orderBtn.getAttribute('disabled').catch(() => null);
        if (isDisabled !== null) {
            console.log('[DoorDash] Order button is disabled — checking why...');
            const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
            console.log('[DoorDash] Checkout page text (first 1000):', pageText.substring(0, 1000));

            // "Order unavailable at selected time" — scheduled time is invalid, switch to ASAP
            if (pageText.includes('unavailable at selected time') || pageText.includes('Order unavailable')) {
                console.log('[DoorDash] Scheduled time is unavailable — switching to ASAP delivery');
                try {
                    // Click the "Change" button next to the unavailable time
                    const changeBtn = page.locator('button, [role="button"]').filter({ hasText: /^change$/i }).first();
                    if (await changeBtn.count() > 0) {
                        await changeBtn.click();
                        await delay(2000);
                        // Select ASAP / As soon as possible
                        const asapBtn = page.locator('button, [role="button"], [role="option"], label').filter({ hasText: /asap|as soon as possible|now/i }).first();
                        if (await asapBtn.count() > 0) {
                            console.log('[DoorDash] Clicking ASAP option');
                            await asapBtn.click();
                            await delay(1500);
                        } else {
                            // Try clicking the first available time option
                            const firstOption = page.locator('[role="option"], [role="radio"]').first();
                            if (await firstOption.count() > 0) {
                                console.log('[DoorDash] Clicking first available time option');
                                await firstOption.click();
                                await delay(1500);
                            }
                        }
                        // Confirm if there's a confirm/save button
                        const confirmBtn = page.locator('button').filter({ hasText: /confirm|save|done|apply/i }).first();
                        if (await confirmBtn.count() > 0) {
                            await confirmBtn.click();
                            await delay(1500);
                        }
                    }
                } catch(e) {
                    console.log('[DoorDash] ASAP switch error:', e.message);
                }
            }

            // Wait up to 8s for button to become enabled
            for (let i = 0; i < 8; i++) {
                await delay(1000);
                isDisabled = await orderBtn.getAttribute('disabled').catch(() => null);
                if (isDisabled === null) { console.log('[DoorDash] Order button became enabled!'); break; }
            }

            if (isDisabled !== null) {
                await takeScreenshot('checkout-disabled');
                return { success: false, error: 'Checkout button disabled. Check payment method and address in DoorDash app.' };
            }
        }

        const DRY_RUN = process.env.DOORDASH_DRY_RUN === 'true';
        if (DRY_RUN) {
            console.log('[DoorDash] DRY RUN — skipping Place Order click');
            return { success: true, dryRun: true, message: 'Dry run complete — checkout page loaded, Place Order button found.' };
        }

        console.log('[DoorDash] Clicking Place Order...');
        await orderBtn.click();

        // Wait up to 20s for DoorDash to navigate away from checkout to confirmation
        let currentUrl = page.url();
        for (let i = 0; i < 10; i++) {
            await delay(2000);
            currentUrl = page.url();
            console.log(`[DoorDash] Post-order URL (${i + 1}): ${currentUrl}`);
            if (!currentUrl.includes('/consumer/checkout/') && !currentUrl.includes('/cart/')) break;
        }

        let pageText = '';
        try { pageText = await page.evaluate(() => document.body.innerText); } catch(e) {
            console.log('[DoorDash] page.evaluate error:', e.message);
        }

        const isConfirmedUrl = currentUrl.includes('confirmation') || currentUrl.includes('order-status') || currentUrl.includes('/order/');
        const isConfirmedText = pageText.includes('Order confirmed') || pageText.includes('Order placed') ||
                                pageText.includes('Your order is on') || pageText.includes('Thanks for your order') ||
                                pageText.includes('Track your order') || pageText.includes('order has been placed');

        console.log(`[DoorDash] Confirmation: url=${isConfirmedUrl} text=${isConfirmedText} url="${currentUrl.substring(0, 80)}"`);

        if (isConfirmedUrl || isConfirmedText) {
            console.log('[DoorDash] Order confirmed!');
            return { success: true, message: 'Order placed!', orderUrl: currentUrl, scheduledSlot: selectedSlot };
        }

        // Still on checkout page — check for error messages
        const errorText = pageText.match(/(payment.*failed|card.*declined|error placing|couldn.t place|order failed)/i)?.[0];
        if (errorText) {
            console.log('[DoorDash] Order error detected:', errorText);
            return { success: false, error: errorText };
        }

        // Clicked Place Order but no confirmation — assume it went through (DoorDash sometimes stays on checkout briefly)
        console.log('[DoorDash] Place Order clicked — no clear confirmation page, assuming success');
        return { success: true, message: 'Order submitted - check DoorDash app to confirm', orderUrl: currentUrl, scheduledSlot: selectedSlot };

    } catch (error) {
        console.error('[DoorDash] Checkout error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Search for restaurants near an address (returns list of real restaurants)
 * Tries the internal HTTP API first (no browser, no CAPTCHA).
 * Falls back to browser automation if API fails.
 */
async function searchRestaurantsNearAddress(credentials, address, query = '') {
    const { email, password } = credentials;

    console.log(`[DoorDash] === STARTING SEARCH ===`);
    console.log(`[DoorDash] Query: ${query || 'all'}`);
    console.log(`[DoorDash] Address: ${address}`);
    let _browserRestartedThisSearch = false;
    let _reqInterceptor = null;
    let _apiInterceptor = null;
    const _cleanupInterceptors = () => {
        if (_reqInterceptor) { try { page.off('request', _reqInterceptor); } catch(e) {} _reqInterceptor = null; }
        if (_apiInterceptor) { try { page.off('response', _apiInterceptor); } catch(e) {} _apiInterceptor = null; }
    };

    // API search is blocked by DoorDash WAF (GraphQL 403, REST 404) and launches extra
    // browser instances that consume memory on Railway — skip it, go straight to browser.

    // Browser automation
    try {
        console.log(`[DoorDash] === BROWSER SEARCH ===`);

        // Step 1: Make sure browser is open (and not crashed)
        if (!page || !context) {
            console.log('[DoorDash] Launching browser...');
            await launchBrowser();
        } else {
            // Verify page is still alive — a crashed page won't throw on .url() but will on evaluate()
            try {
                await page.evaluate(() => 1);
            } catch (e) {
                console.log('[DoorDash] Existing page crashed/closed, restarting browser...');
                await closeBrowser();
                await launchBrowser();
            }
        }

        // Set up network response interceptor to capture DoorDash's own API responses.
        // DoorDash's JavaScript makes authenticated API calls that pass CF — we intercept those.
        _capturedStoreMenus = {}; // clear old data for this search
        _capturedRestaurants = []; // clear restaurant list from previous search
        _capturedDoorDashHeaders = null; // reset headers cache
        _capturedSearchQueryFired = false; // reset search-specific query flag

        // Capture DoorDash's own GraphQL request headers so we can reuse them.
        // Their requests pass CF because they include auth tokens (x-chk-token etc.).
        _reqInterceptor = (request) => {
            try {
                const url = request.url();
                if (!url.includes('doordash.com/graphql') || request.method() !== 'POST') return;
                const headers = request.headers();
                // Only capture if it has DoorDash-specific auth headers
                if (headers['x-chk-token'] || headers['apollographql-client-name'] || headers['x-experience-id']) {
                    _capturedDoorDashHeaders = headers;
                }
            } catch (e) {}
        };
        page.on('request', _reqInterceptor);

        _apiInterceptor = async (response) => {
            const url = response.url();
            if (!url.includes('doordash.com')) return;
            const status = response.status();
            const ct = response.headers()['content-type'] || '';
            if (!ct.includes('json')) return;
            // Log ALL DoorDash API responses (any status) to diagnose what's happening
            if (url.includes('/api/') || url.includes('/graphql') || url.includes('/v2/') || url.includes('consumer-')) {
                console.log(`[DoorDash Intercept] ${status} ${url.replace('https://www.doordash.com', '').substring(0, 100)}`);
            }
            if (status !== 200) return;
            try {
                const data = await response.json().catch(() => null);
                if (!data) return;
                // Extract menu items for store pages
                _extractAndCacheMenuData(data);
                // Extract restaurant listings — but skip operations that return order history or
                // unrelated data (they contain past store names that pollute the search results).
                const opName = new URL(url).searchParams.get('operation') || '';
                const SKIP_OPS = ['getConsumerOrdersWithDetails', 'getHasNewNotifications',
                    'getAvailableAddresses', 'campaignDetails', 'getConsumerSubscription',
                    'getConsumerProfile', 'getConsumerAddresses'];
                if (!SKIP_OPS.some(op => opName.includes(op))) {
                    // Mark when the actual search results query fires (not just nearby stores)
                    if (opName === 'searchWithFilterFacetFeed') {
                        _capturedSearchQueryFired = true;
                        console.log('[DoorDash] searchWithFilterFacetFeed intercepted — actual search results');
                    }
                    // Log a sample store object from externalStores to see available URL fields
                    if (opName === 'externalStores') {
                        try {
                            const stores = data?.data?.externalStores || [];
                            const sample = Array.isArray(stores) ? stores[0] : (typeof stores === 'object' ? Object.values(stores)[0] : null);
                            if (sample) {
                                const sampleStore = sample?.store || sample;
                                console.log('[DoorDash] externalStores full sample:', JSON.stringify(sampleStore));
                                const urlFields = Object.entries(sampleStore || {}).filter(([k]) => /url|slug|path|href/i.test(k));
                                if (urlFields.length > 0) console.log('[DoorDash] externalStores URL fields:', JSON.stringify(urlFields));
                            }
                        } catch (e) {}
                    }
                    _extractAndCacheRestaurantList(data, opName);
                }
            } catch (e) {}
        };
        page.on('response', _apiInterceptor);

        // Step 2: Load homepage to warm up the CF session, then navigate to search.
        // Going cold to the search URL triggers CF Turnstile (even with fresh cookies).
        // Homepage load is lightweight (images/css blocked) and establishes a legit session.
        const hasCookieEnv = !!process.env.DOORDASH_COOKIES;
        const searchUrl = `${DOORDASH_URL}/search/store/${encodeURIComponent(query)}/`;

        // Skip homepage warmup if already on DoorDash (saves ~20s per search after first).
        // But still do warmup if Chrome seems unresponsive (e.g. after heavy add-item flow).
        const _preSearchUrl = page.url();
        const _alreadyOnDD = _preSearchUrl.startsWith('https://www.doordash.com') && !_preSearchUrl.includes('/login');
        const _quickPing = _alreadyOnDD ? await Promise.race([
            page.evaluate(() => true).then(() => true).catch(() => false),
            new Promise(r => setTimeout(() => r(false), 2000))
        ]) : true;
        if (_alreadyOnDD && _quickPing) {
            console.log('[DoorDash] Already on DoorDash and responsive, skipping homepage warmup');
        } else {
            if (_alreadyOnDD && !_quickPing) {
                console.log('[DoorDash] On DoorDash but unresponsive — restarting browser for fresh warmup...');
                await closeBrowser().catch(() => {});
                await launchBrowser();
            }
            console.log('[DoorDash] Navigating to DoorDash homepage (CF warmup)...');
            await page.goto(DOORDASH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(1000);
            await waitForCFChallenge(20000);
            console.log('[DoorDash] Homepage loaded, URL:', page.url());
        }

        // Always check login state — even with DOORDASH_COOKIES set, they can expire.
        // Expired cookies allow page loads but DoorDash API calls return 4xx (no results).
        const loggedIn = await isLoggedIn();
        console.log('[DoorDash] Logged in:', loggedIn);
        if (!loggedIn) {
            if (hasCookieEnv) {
                console.log('[DoorDash] Cookie env present but session expired — attempting email/password login...');
            }
            const loginResult = await login(email, password);
            if (!loginResult.success) {
                const recheckOk = await isLoggedIn();
                if (!recheckOk) {
                    return { success: false, error: `Login failed: ${loginResult.error || 'unknown'}`, restaurants: [] };
                }
            }
        }

        // Step 3: Set up raw HTML capture BEFORE navigating, so we get the server's initial
        // HTML response. Regex-parsed in Node.js — avoids page.evaluate() OOM.
        let _searchPageHtml = '';
        const _htmlCapture = async (resp) => {
            try {
                if (resp.url().includes('/search/store/') && resp.status() === 200 &&
                    (resp.headers()['content-type'] || '').includes('text/html')) {
                    _searchPageHtml = await resp.text().catch(() => '');
                    console.log(`[DoorDash] Captured search page HTML (${_searchPageHtml.length} bytes)`);
                }
            } catch (e) {}
        };
        page.on('response', _htmlCapture);

        console.log('[DoorDash] Navigating to search URL...');
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
            console.log('[DoorDash] Search page goto error (continuing):', e.message);
        });
        page.off('response', _htmlCapture);

        // Wait for searchWithFilterFacetFeed (actual query-specific results) to fire.
        // externalStores fires at ~3s with general nearby stores regardless of query —
        // don't rely on that. Wait for the real search results (up to 8s total).
        {
            const waitStart = Date.now();
            while (!_capturedSearchQueryFired && Date.now() - waitStart < 8000) {
                await delay(500);
            }
            console.log(`[DoorDash] Waited ${Date.now() - waitStart}ms: ${_capturedRestaurants.length} captured (searchQueryFired=${_capturedSearchQueryFired})`);
            // If only externalStores fired (not the query-specific call), clear the results
            // so DOM extraction runs instead — externalStores returns general nearby stores
            // unrelated to the search query (e.g. nearby Mexican places for "costa vida").
            if (!_capturedSearchQueryFired && _capturedRestaurants.length > 0) {
                console.log('[DoorDash] searchWithFilterFacetFeed did not fire — discarding externalStores results, using DOM extraction');
                _capturedRestaurants = [];
            }
        }
        await waitForCFChallenge(30000);
        await handlePopups();
        console.log('[DoorDash] Current URL:', page.url());

        // Step 5b: Extract DoorDash's Apollo Client cache — it stores all fetched data
        // including restaurant search results and featured menu items.
        // Wrapped in Promise.race: page.evaluate can hang if Playwright has a pending navigation
        // (e.g. DoorDash SPA does pushState after domcontentloaded). Skip gracefully on timeout.
        try {
            const apolloResult = await Promise.race([
                page.evaluate(() => {
                    const client = window.__APOLLO_CLIENT__;
                    if (!client) return { found: false };
                    const cache = client.cache.extract();
                    const keys = Object.keys(cache);
                    // Sample the key types to understand structure
                    const keyTypes = {};
                    for (const k of keys) {
                        const type = k.split(':')[0];
                        keyTypes[type] = (keyTypes[type] || 0) + 1;
                    }
                    return {
                        found: true,
                        totalKeys: keys.length,
                        keyTypes,
                        // Return full cache as string (might be large, but we need it)
                        cacheJson: JSON.stringify(cache)
                    };
                }),
                new Promise((resolve) => setTimeout(() => {
                    console.log('[DoorDash] Apollo cache evaluate timed out (10s) — skipping');
                    resolve({ found: false });
                }, 10000))
            ]);

            if (apolloResult.found) {
                console.log(`[DoorDash] Apollo cache: ${apolloResult.totalKeys} keys, types: ${JSON.stringify(apolloResult.keyTypes)}`);
                // Parse the Apollo cache and extract store/menu data
                try {
                    const apolloCache = JSON.parse(apolloResult.cacheJson);

                    // Log first ExternalStore object to find slug fields
                    const firstExtKey = Object.keys(apolloCache).find(k => k.startsWith('ExternalStore:'));
                    if (firstExtKey) {
                        console.log(`[DoorDash] ExternalStore sample (${firstExtKey}): ${JSON.stringify(apolloCache[firstExtKey])}`);
                    }

                    // Resolve Apollo's __ref pointers (normalized cache uses refs for related objects)
                    function resolveRef(obj, cache, depth = 0) {
                        if (depth > 5 || !obj || typeof obj !== 'object') return obj;
                        if (obj.__ref) return resolveRef(cache[obj.__ref], cache, depth + 1);
                        if (Array.isArray(obj)) return obj.map(el => resolveRef(el, cache, depth + 1));
                        const out = {};
                        for (const [k, v] of Object.entries(obj)) out[k] = resolveRef(v, cache, depth + 1);
                        return out;
                    }

                    // NOTE: Apollo cache ROOT_QUERY.searchWithFilterFacetFeed is intentionally
                    // skipped here. The Apollo cache persists across searches in the browser
                    // profile and returns STALE results from the previous search query.
                    // Only network-intercepted responses (current request) are reliable.
                    const rootQuery = apolloCache['ROOT_QUERY'] || {};
                    const searchKey = Object.keys(rootQuery).find(k => k.startsWith('searchWithFilterFacetFeed'));
                    if (searchKey) {
                        console.log(`[DoorDash] Apollo searchWithFilterFacetFeed key found (skipping — may be stale from previous search)`);
                    }

                    // Extract featured menu items from ExternalStore / Store objects
                    for (const [cacheKey, rawVal] of Object.entries(apolloCache)) {
                        const typeName = cacheKey.split(':')[0];
                        if (!['ExternalStore', 'Store', 'Business', 'Restaurant'].includes(typeName)) continue;
                        const val = resolveRef(rawVal, apolloCache);
                        const storeId = String(val.storeId || val.store_id || val.id || '');
                        if (!storeId || storeId.length < 4) continue;
                        const featured = val.featuredItems || val.featured_items || val.popularItems || val.popular_items || val.items || [];
                        if (!Array.isArray(featured) || featured.length === 0) continue;
                        const items = featured.map(item => ({
                            name: item.name || item.title || '',
                            price: typeof item.price === 'number'
                                ? (item.price > 200 ? item.price / 100 : item.price)
                                : parseFloat(String(item.price || item.displayPrice || 0).replace(/[^0-9.]/g, '')),
                            description: item.description || ''
                        })).filter(i => i.name && i.price > 0);
                        if (items.length > 0) {
                            _capturedStoreMenus[storeId] = (_capturedStoreMenus[storeId] || []).concat(items);
                        }
                    }

                    // Fallback: generic deep walk for other response shapes
                    _extractAndCacheMenuData(apolloCache);

                    const capturedIds = Object.keys(_capturedStoreMenus);
                    if (capturedIds.length > 0) console.log(`[DoorDash] Apollo cache menu stores: ${capturedIds.join(', ')}`);
                } catch (e) {
                    console.log('[DoorDash] Apollo cache parse error:', e.message);
                }
            } else {
                console.log('[DoorDash] __APOLLO_CLIENT__ not found or has no cache');
            }
        } catch (e) {
            console.log('[DoorDash] Apollo extraction error:', e.message);
        }

        // Step 5c: Extract real navigable store URLs from DOM carousel links.
        // externalStores returns chain-level selection_intel_store IDs that 404 when navigated to.
        // The DOM carousel has real individual store links with slug + real store ID, e.g.:
        //   /store/pizza-hut-draper/34015879?cursor=...
        // We match these to _capturedRestaurants by position (DOM order = externalStores order).
        try {
            await delay(3000); // wait for React to render carousels
            const domStoreLinks = await Promise.race([
                page.evaluate(() => {
                    const PROMO_STARTS = ['enjoy', 'get ', 'save ', 'free ', 'order ', 'up to', 'top deal'];
                    const slugged = [];
                    const idOnly = [];
                    const seen = new Set();
                    for (const link of document.querySelectorAll('a[href*="/store/"]')) {
                        const href = link.getAttribute('href') || '';
                        // Name element is a sibling of the link, not a child — walk up to container
                        let name = '';
                        try {
                            let el = link.parentElement;
                            while (el && el !== document.body) {
                                const nameEl = el.querySelector('[data-telemetry-id="store.name"]');
                                if (nameEl) { name = nameEl.textContent.trim(); break; }
                                el = el.parentElement;
                            }
                        } catch(e) {}
                        if (PROMO_STARTS.some(p => name.toLowerCase().startsWith(p))) name = '';
                        const slugMatch = href.match(/\/store\/([a-z0-9][a-z0-9-]+[a-z0-9])\/(\d{5,})/);
                        if (slugMatch) {
                            const key = `${slugMatch[1]}/${slugMatch[2]}`;
                            if (!seen.has(key)) { seen.add(key); slugged.push({ slug: slugMatch[1], realId: slugMatch[2], fullHref: link.href, name }); }
                        } else {
                            const idMatch = href.match(/\/store\/(\d{5,})/);
                            if (idMatch && !seen.has(idMatch[1])) { seen.add(idMatch[1]); idOnly.push({ id: idMatch[1], fullHref: link.href, name }); }
                        }
                    }
                    const firstLink = document.querySelector('a[href*="/store/"]');
                    const nameEls = document.querySelectorAll('[data-telemetry-id="store.name"]');
                    const nameDebug = {
                        firstInnerText: firstLink ? (firstLink.innerText || '').substring(0, 150) : '',
                        firstTextContent: firstLink ? (firstLink.textContent || '').substring(0, 150) : '',
                        telemetryNameCount: nameEls.length,
                        telemetryNames: [...nameEls].slice(0, 5).map(el => el.textContent.trim()),
                    };
                    return { slugged, idOnly: idOnly.slice(0, 10), sampleHrefs: [...document.querySelectorAll('a[href*="/store/"]')].slice(0, 5).map(a => a.getAttribute('href')), nameDebug };
                }),
                new Promise(r => setTimeout(() => r({ slugged: [], idOnly: [], sampleHrefs: [] }), 5000))
            ]).catch(() => ({ slugged: [], idOnly: [], sampleHrefs: [] }));

            console.log(`[DoorDash] DOM store links: ${domStoreLinks.slugged.length} slugged, ${domStoreLinks.idOnly.length} id-only`);
            console.log(`[DoorDash] DOM sample hrefs: ${JSON.stringify(domStoreLinks.sampleHrefs)}`);
            console.log(`[DoorDash] DOM name debug: ${JSON.stringify(domStoreLinks.nameDebug || {})}`);

            if (domStoreLinks.slugged.length > 0) {
                // Real slug URLs — match by position to _capturedRestaurants
                for (let i = 0; i < _capturedRestaurants.length && i < domStoreLinks.slugged.length; i++) {
                    const r = _capturedRestaurants[i];
                    const dom = domStoreLinks.slugged[i];
                    r.url = dom.fullHref || `https://www.doordash.com/store/${dom.slug}/${dom.realId}/`;
                    r.id = dom.realId;
                    console.log(`[DoorDash] Resolved ${r.name}: chain-level → /store/${dom.slug}/${dom.realId}/`);
                }
            } else if (domStoreLinks.idOnly.length > 0) {
                // ID-only DOM links — these may be different (real) store IDs vs chain-level externalStores IDs
                console.log(`[DoorDash] ID-only DOM links: ${domStoreLinks.idOnly.map(l => l.id).join(', ')}`);
                console.log(`[DoorDash] externalStores IDs: ${_capturedRestaurants.map(r => r.id).join(', ')}`);
                // Update by position if IDs differ
                for (let i = 0; i < _capturedRestaurants.length && i < domStoreLinks.idOnly.length; i++) {
                    const r = _capturedRestaurants[i];
                    const dom = domStoreLinks.idOnly[i];
                    if (dom.id !== r.id) {
                        console.log(`[DoorDash] Replacing chain ID ${r.id} with DOM ID ${dom.id} for ${r.name}`);
                        r.url = dom.fullHref || `https://www.doordash.com/store/${dom.id}/`;
                        r.id = dom.id;
                    }
                }
            } else {
                console.log('[DoorDash] No store links found in DOM');
            }

            // If network results were discarded (externalStores mismatch), populate from DOM
            if (_capturedRestaurants.length === 0) {
                const domLinks = [...domStoreLinks.slugged, ...domStoreLinks.idOnly];
                const named = domLinks.filter(l => l.name && l.name.length >= 3);
                if (named.length > 0) {
                    console.log(`[DoorDash] Populating ${named.length} restaurants from DOM links`);
                    _capturedRestaurants = named.map(l => ({
                        id: l.realId || l.id,
                        name: l.name,
                        url: l.fullHref,
                        rating: '',
                        deliveryTime: '',
                    }));
                    console.log(`[DoorDash] DOM restaurants: ${_capturedRestaurants.map(r => r.name).join(', ')}`);
                }
            }
        } catch (e) {
            console.log('[DoorDash] DOM slug extraction error:', e.message);
        }

        // Step 6: Extract restaurants
        console.log('[DoorDash] Extracting restaurants...');
        const restaurants = await extractRestaurantList(_searchPageHtml);
        console.log(`[DoorDash] Extracted ${restaurants.length} restaurants`);

        // If nothing found, try a retry (likely CF challenge or session stale)
        if (restaurants.length === 0) {
            const currentUrl = page.url();
            console.log(`[DoorDash] 0 restaurants — URL: ${currentUrl} | HTML bytes: ${_searchPageHtml.length}`);

            // Retry by navigating directly to the search URL again
            if (!_browserRestartedThisSearch) {
                console.log('[DoorDash] 0 restaurants — retrying search...');
                _browserRestartedThisSearch = true;
                try {
                    _capturedRestaurants = [];
                    _capturedSearchQueryFired = false;

                    // Check if browser is responsive. If evaluates timed out above, Chrome is likely
                    // frozen (CF challenge JS, OOM, stuck navigation). Restart before retrying.
                    const isResponsive = await Promise.race([
                        page.evaluate(() => true).then(() => true).catch(() => false),
                        new Promise(r => setTimeout(() => r(false), 3000))
                    ]);
                    if (!isResponsive) {
                        console.log('[DoorDash] Browser unresponsive — restarting before retry...');
                        await closeBrowser().catch(() => {});
                        await launchBrowser();
                        console.log('[DoorDash] Browser restarted for search retry');
                    }

                    // Re-warmup homepage first to clear any CF challenge before searching again
                    console.log('[DoorDash] Retry: re-warming up homepage...');
                    await page.goto(`${DOORDASH_URL}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                    await waitForCFChallenge(20000);
                    await delay(2000);
                    const retrySearchUrl = `${DOORDASH_URL}/search/store/${encodeURIComponent(query)}/`;
                    await page.goto(retrySearchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                    {
                        const waitStart = Date.now();
                        while (!_capturedSearchQueryFired && Date.now() - waitStart < 8000) {
                            await delay(500);
                        }
                        console.log(`[DoorDash] Retry waited ${Date.now() - waitStart}ms: ${_capturedRestaurants.length} captured (searchQueryFired=${_capturedSearchQueryFired})`);
                        if (!_capturedSearchQueryFired && _capturedRestaurants.length > 0) {
                            console.log('[DoorDash] Retry: searchWithFilterFacetFeed did not fire — discarding externalStores, using DOM');
                            _capturedRestaurants = [];
                        }
                    }
                    await waitForCFChallenge(20000);
                    await handlePopups();
                    // If still no network results, do a DOM scan to populate before extracting
                    if (_capturedRestaurants.length === 0) {
                        await delay(2000);
                        const retryDomLinks = await Promise.race([
                            page.evaluate(() => {
                                const PROMO_STARTS = ['enjoy', 'get ', 'save ', 'free ', 'order ', 'up to', 'top deal'];
                                const results = [];
                                const seen = new Set();
                                for (const link of document.querySelectorAll('a[href*="/store/"]')) {
                                    const href = link.getAttribute('href') || '';
                                    const idMatch = href.match(/\/store\/[^/?#]*?\/(\d{5,})/) || href.match(/\/store\/(\d+)/);
                                    if (!idMatch || seen.has(idMatch[1])) continue;
                                    seen.add(idMatch[1]);
                                    let name = '';
                                    try { let el = link.parentElement; while (el && el !== document.body) { const n = el.querySelector('[data-telemetry-id="store.name"]'); if (n) { name = n.textContent.trim(); break; } el = el.parentElement; } } catch(e) {}
                                    if (!name || name.length < 3 || PROMO_STARTS.some(p => name.toLowerCase().startsWith(p))) continue;
                                    results.push({ id: idMatch[1], name, url: link.href });
                                }
                                return results.slice(0, 10);
                            }),
                            new Promise(r => setTimeout(() => r([]), 5000))
                        ]).catch(() => []);
                        if (retryDomLinks.length > 0) {
                            console.log(`[DoorDash] Retry DOM scan: ${retryDomLinks.map(r => r.name).join(', ')}`);
                            _capturedRestaurants = retryDomLinks;
                        }
                    }
                    const retryRestaurants = await extractRestaurantList();
                    console.log(`[DoorDash] After retry: extracted ${retryRestaurants.length} restaurants`);
                    if (retryRestaurants.length > 0) {
                        _cleanupInterceptors();
                        const sorted = sortRestaurantsByRelevance(retryRestaurants, query).slice(0, 5);
                        return { success: true, restaurants: sorted };
                    }
                } catch (retryErr) {
                    console.log('[DoorDash] Soft retry error:', retryErr.message);
                }
            }

            _cleanupInterceptors();
            return { success: false, error: `0 restaurants found at ${currentUrl}`, restaurants: [] };
        }

        // Stop intercepting responses and requests
        _cleanupInterceptors();
        const capturedCount = Object.keys(_capturedStoreMenus).length;
        if (capturedCount > 0) {
            console.log(`[DoorDash] Intercepted menu data for ${capturedCount} stores during search`);
        }

        // Sort by rating and return top 5
        const sortedRestaurants = sortRestaurantsByRelevance(restaurants, query).slice(0, 5);

        // Save search URL so restaurant selection can navigate back here on CF retry
        updateSessionState({ lastSearchUrl: page.url() });
        console.log('[DoorDash] === SEARCH COMPLETE ===');

        return {
            success: true,
            restaurants: sortedRestaurants,
            totalFound: restaurants.length,
            query: query || 'nearby'
        };

    } catch (error) {
        _cleanupInterceptors();
        console.error('[DoorDash] Browser search error:', error.message);
        console.error('[DoorDash] Stack:', error.stack);
        try { await takeScreenshot('error-' + Date.now()); } catch (e) {}

        // If the browser crashed mid-search, clean up so the next search gets a fresh start
        if (error.message.includes('crashed') || error.message.includes('Target closed') || error.message.includes('closed')) {
            console.log('[DoorDash] Browser crash detected during search — cleaning up for fresh restart');
            try { await closeBrowser(); } catch (e) {}
        }

        return { success: false, error: error.message, restaurants: [] };
    }
}

/**
 * Sort restaurants by relevance to search query, then by rating
 */
function sortRestaurantsByRelevance(restaurants, query = '') {
    const queryLower = query.toLowerCase().trim();

    return restaurants.sort((a, b) => {
        const nameA = (a.name || '').toLowerCase();
        const nameB = (b.name || '').toLowerCase();

        // Priority 1: Exact match
        const exactMatchA = nameA === queryLower;
        const exactMatchB = nameB === queryLower;
        if (exactMatchA && !exactMatchB) return -1;
        if (exactMatchB && !exactMatchA) return 1;

        // Priority 2: Name starts with query
        const startsWithA = nameA.startsWith(queryLower);
        const startsWithB = nameB.startsWith(queryLower);
        if (startsWithA && !startsWithB) return -1;
        if (startsWithB && !startsWithA) return 1;

        // Priority 3: Name contains query
        const containsA = nameA.includes(queryLower);
        const containsB = nameB.includes(queryLower);
        if (containsA && !containsB) return -1;
        if (containsB && !containsA) return 1;

        // Priority 4: Query contains restaurant name (e.g., "chipotle burrito" matches "Chipotle")
        const queryContainsA = queryLower.includes(nameA.split(' ')[0]);
        const queryContainsB = queryLower.includes(nameB.split(' ')[0]);
        if (queryContainsA && !queryContainsB) return -1;
        if (queryContainsB && !queryContainsA) return 1;

        // Priority 5: Sort by rating
        const parseRating = (ratingStr) => {
            if (!ratingStr) return 0;
            const match = String(ratingStr).match(/(\d+\.?\d*)/);
            return match ? parseFloat(match[1]) : 0;
        };

        const ratingA = parseRating(a.rating);
        const ratingB = parseRating(b.rating);

        return ratingB - ratingA; // Descending order
    });
}

/**
 * Sort restaurants by rating (highest first) - kept for backwards compatibility
 */
function sortRestaurantsByRating(restaurants) {
    return sortRestaurantsByRelevance(restaurants, '');
}

/**
 * Extract restaurant list from current page
 */
async function extractRestaurantList(searchPageHtml = '') {
    const restaurants = [];

    try {
        console.log('[DoorDash] Extracting restaurant list...');

        // Priority 1: network-intercepted restaurants from GraphQL responses (zero DOM needed)
        if (_capturedRestaurants.length > 0) {
            // Deduplicate by name (different locations of same chain share a name)
            const seenNames = new Set();
            const deduped = _capturedRestaurants.filter(r => {
                const key = r.name.toLowerCase();
                if (seenNames.has(key)) return false;
                seenNames.add(key);
                return true;
            });
            console.log(`[DoorDash] Using ${deduped.length} network-captured restaurants (deduped from ${_capturedRestaurants.length})`);

            // externalStores returns chain-level IDs that 404 when navigated to.
            // Do a quick DOM scan to find real navigable URLs and match by name.
            try {
                const domNameUrlMap = await Promise.race([
                    page.evaluate(() => {
                        const map = {};
                        for (const a of document.querySelectorAll('a[href*="/store/"]')) {
                            const href = a.getAttribute('href') || '';
                            // Only care about links with a real store ID (5+ digits)
                            if (!/\/store\/[^/]*\d{5,}/.test(href)) continue;
                            // Name element is sibling of link — walk up to container
                            let name = '';
                            let el = a.parentElement;
                            while (el && el !== document.body) {
                                const nameEl = el.querySelector('[data-telemetry-id="store.name"]');
                                if (nameEl) { name = nameEl.textContent.trim(); break; }
                                el = el.parentElement;
                            }
                            if (name && name.length >= 3) map[name.toLowerCase()] = a.href;
                        }
                        return map;
                    }),
                    new Promise(r => setTimeout(() => r({}), 4000))
                ]).catch(() => ({}));

                const domCount = Object.keys(domNameUrlMap).length;
                console.log(`[DoorDash] DOM name→URL map: ${domCount} entries (${Object.keys(domNameUrlMap).slice(0, 3).join(', ')})`);

                if (domCount > 0) {
                    // If DOM has several restaurants but none match network results,
                    // the network data is irrelevant (externalStores mismatch) — use DOM instead.
                    const matchCount = deduped.filter(r => domNameUrlMap[r.name.toLowerCase()]).length;
                    if (domCount >= 5 && matchCount === 0) {
                        console.log(`[DoorDash] 0/${deduped.length} network restaurants found in DOM (${domCount} DOM entries) — falling through to DOM extraction`);
                        _capturedRestaurants = [];
                        // fall through to Priority 2/3
                    } else {
                        for (const r of deduped) {
                            const domUrl = domNameUrlMap[r.name.toLowerCase()];
                            if (domUrl && domUrl !== r.url) {
                                console.log(`[DoorDash] Updated URL for ${r.name}: chain-level → ${domUrl.substring(0, 60)}`);
                                r.url = domUrl;
                            }
                        }
                        return deduped.slice(0, 10).map((r, i) => ({ ...r, index: i }));
                    }
                } else {
                    return deduped.slice(0, 10).map((r, i) => ({ ...r, index: i }));
                }
            } catch (e) {
                console.log('[DoorDash] DOM URL resolution error:', e.message);
                return deduped.slice(0, 10).map((r, i) => ({ ...r, index: i }));
            }
        }

        // Priority 2: parse restaurant data from the raw HTML response (captured before JS runs).
        // DoorDash is fully SSR — React hydrates existing HTML without making XHR calls.
        // All store data is embedded as JSON in <script> tags. This runs in Node.js (not Chrome)
        // so it's safe from OOM. Zero page.evaluate() calls.
        if (searchPageHtml && searchPageHtml.length > 1000) {
            const PROMO_STARTS = ['enjoy', 'get ', 'save ', 'free ', 'order ', 'up to', 'top deal'];

            // Diagnostic: confirm what's in the HTML
            const hasStoreId = searchPageHtml.includes('"storeId"');
            const hasPizza = searchPageHtml.toLowerCase().includes('pizza');
            const scriptCount = (searchPageHtml.match(/<script/gi) || []).length;
            console.log(`[DoorDash] HTML diag: storeId=${hasStoreId}, pizza=${hasPizza}, scripts=${scriptCount}, bytes=${searchPageHtml.length}`);

            // Priority 2a: Extract from embedded JSON — "storeId":"12345678" patterns.
            // DoorDash uses SPA navigation so <a href="/store/..."> hrefs may not exist,
            // but the SSR JSON always contains storeId fields.
            if (hasStoreId) {
                const seenIds = new Set();
                const seenNames = new Set();
                const storeIdRe = /"storeId"\s*:\s*"?(\d{5,})"?/g;
                let m;
                while ((m = storeIdRe.exec(searchPageHtml)) !== null && restaurants.length < 10) {
                    const storeId = m[1];
                    if (seenIds.has(storeId)) continue;
                    // Look for name in a window around this storeId occurrence
                    const winStart = Math.max(0, m.index - 600);
                    const winEnd = Math.min(searchPageHtml.length, m.index + 800);
                    const win = searchPageHtml.substring(winStart, winEnd);
                    // Try businessName first (most specific), then name
                    let name = '';
                    const busNameM = win.match(/"businessName"\s*:\s*"([^"]{3,80})"/);
                    if (busNameM) name = busNameM[1].trim();
                    if (!name) {
                        const nameM = win.match(/"name"\s*:\s*"([^"]{3,80})"/);
                        if (nameM) name = nameM[1].trim();
                    }
                    if (!name || name.length < 3) continue;
                    if (seenNames.has(name.toLowerCase())) continue;
                    if (PROMO_STARTS.some(p => name.toLowerCase().startsWith(p))) continue;
                    seenIds.add(storeId);
                    seenNames.add(name.toLowerCase());
                    const rating = (win.match(/"averageRating"\s*:\s*([\d.]+)/) || [])[1] || '';
                    const dt = (win.match(/"(?:estimatedDeliveryTime|deliveryTime)"\s*:\s*(\d+)/) || [])[1] || '';
                    restaurants.push({
                        id: storeId, name, rating,
                        deliveryTime: dt ? `${dt} min` : '',
                        url: `${DOORDASH_URL}/store/${storeId}/`,
                        index: restaurants.length,
                    });
                    console.log(`[DoorDash] HTML JSON: ${name} (${storeId})`);
                }
                if (restaurants.length > 0) {
                    console.log(`[DoorDash] HTML JSON extraction yielded ${restaurants.length} restaurants`);
                    return restaurants;
                }
                console.log('[DoorDash] HTML JSON: storeId found but no name matches');
            }

            // Priority 2b: href-based extraction (fallback for non-SPA pages)
            const seenIds2 = new Set();
            const hrefMatches = [...searchPageHtml.matchAll(/href="(\/store\/[^"?#]+)"/g)];
            console.log(`[DoorDash] HTML href matches: ${hrefMatches.length}`);
            for (const hm of hrefMatches) {
                if (restaurants.length >= 10) break;
                const href = hm[1];
                const idMatch = href.match(/\/store\/[^/?#]*?\/(\d{5,})/) || href.match(/\/store\/(\d+)/);
                if (!idMatch) continue;
                const storeId = idMatch[1];
                if (seenIds2.has(storeId)) continue;
                seenIds2.add(storeId);
                const pos = searchPageHtml.indexOf(hm[0]);
                const ctx = searchPageHtml.substring(pos, pos + 600);
                let name = '';
                const telMatch = ctx.match(/data-telemetry-id="store\.name"[^>]*>([^<]+)</);
                if (telMatch) name = telMatch[1].trim();
                if (!name) {
                    const ariaMatch = ctx.match(/aria-label="([^"]{3,60})"/);
                    if (ariaMatch) name = ariaMatch[1].trim();
                }
                if (!name || name.length < 3) continue;
                if (PROMO_STARTS.some(p => name.toLowerCase().startsWith(p))) continue;
                // Use the full href (includes slug) — DoorDash 404s on ID-only URLs
                const fullUrl = `${DOORDASH_URL}${href.startsWith('/') ? href : '/' + href}`;
                restaurants.push({
                    id: storeId, name,
                    rating: (ctx.match(/(\d\.\d)/) || [])[1] || '',
                    deliveryTime: (ctx.match(/(\d+[-–]\d+)\s*min/i) || [])[0] || '',
                    url: fullUrl,
                    index: restaurants.length,
                });
                console.log(`[DoorDash] HTML href: found restaurant: ${name} (${storeId}) → ${fullUrl}`);
            }
            if (restaurants.length > 0) {
                console.log(`[DoorDash] HTML href extraction yielded ${restaurants.length} restaurants`);
                return restaurants;
            }
            console.log('[DoorDash] HTML extraction found 0 — falling back to DOM');
        }

        // Fallback: single page.evaluate() that does all DOM work inside Chrome
        const DOORDASH_BASE = DOORDASH_URL;
        const extracted = await Promise.race([
            page.evaluate((baseUrl) => {
                const PROMO_STARTS = ['enjoy', 'get ', 'save ', 'free ', 'order ', 'up to', 'top deal'];
                const links = document.querySelectorAll('a[href*="/store/"]');
                const results = [];
                const seenIds = new Set();
                const seenNames = new Set();

                for (const link of links) {
                    if (results.length >= 10) break;
                    const href = link.getAttribute('href');
                    if (!href) continue;
                    const storeIdMatch = href.match(/\/store\/[^/?#]*?\/(\d{5,})/) || href.match(/\/store\/(\d+)/);
                    if (!storeIdMatch) continue;
                    const storeId = storeIdMatch[1];
                    if (seenIds.has(storeId)) continue;
                    seenIds.add(storeId);

                    // Name element is sibling of link — walk up to container
                    let name = '';
                    try {
                        let el = link.parentElement;
                        while (el && el !== document.body) {
                            const nameEl = el.querySelector('[data-telemetry-id="store.name"]');
                            if (nameEl) { name = nameEl.textContent.trim(); break; }
                            el = el.parentElement;
                        }
                    } catch(e) {}
                    if (!name || name.length < 3) continue;
                    if (PROMO_STARTS.some(p => name.toLowerCase().startsWith(p))) continue;
                    if (seenNames.has(name.toLowerCase())) continue;
                    seenNames.add(name.toLowerCase());

                    const text = link.textContent || '';
                    const ratingMatch = text.match(/(\d\.\d)/);
                    const timeMatch = text.match(/(\d+[-–]\d+)\s*min/i);
                    // Use full href URL (includes slug) — DoorDash 404s on ID-only URLs
                    const fullHref = link.href || `${baseUrl}${href}`;
                    results.push({
                        id: storeId,
                        name,
                        rating: ratingMatch ? ratingMatch[1] : '',
                        deliveryTime: timeMatch ? timeMatch[0] : '',
                        url: fullHref,
                    });
                }
                return results;
            }, DOORDASH_BASE),
            new Promise((resolve) => setTimeout(() => {
                console.log('[DoorDash] extractRestaurantList evaluate timed out (15s)');
                resolve([]);
            }, 15000))
        ]);

        for (let i = 0; i < extracted.length; i++) {
            const r = extracted[i];
            restaurants.push({ ...r, index: i });
            console.log(`[DoorDash] Found restaurant: ${r.name} (ID: ${r.id}, rating: ${r.rating || 'N/A'})`);
        }

        console.log(`[DoorDash] Total restaurants extracted: ${restaurants.length}`);

    } catch (error) {
        console.error('[ERR] [DoorDash] Extract restaurant list error:', error.message);
    }

    return restaurants;
}

/**
 * Get menu for a specific restaurant
 */
async function getRestaurantMenu(credentials, restaurantId, restaurantUrl = null) {
    const { email, password } = credentials;

    try {
        console.log(`[DoorDash] Getting menu for restaurant: ${restaurantId}`);

        // Launch browser if not already running
        if (!page) {
            await launchBrowser();
        }

        // Login if needed
        if (!(await isLoggedIn())) {
            const loginResult = await login(email, password);
            if (!loginResult.success) {
                return { success: false, error: loginResult.error, menu: [] };
            }
        }

        // Navigate to restaurant page
        const url = restaurantUrl || `${DOORDASH_URL}/store/${restaurantId}/`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await waitForCFChallenge(60000);
        await delay(2000);
        await handlePopups();

        // Extract restaurant name
        let restaurantName = 'Restaurant';
        try {
            restaurantName = await page.$eval('h1, [data-anchor-id="StoreName"]', el => el.textContent.trim());
        } catch (e) {}

        // Extract menu items
        const menu = await extractMenuItems();

        console.log(`[DoorDash] Found ${menu.length} menu items`);

        return {
            success: true,
            restaurantId,
            restaurantName,
            menu
        };

    } catch (error) {
        console.error('[DoorDash] Get menu error:', error.message);
        await takeScreenshot('get-menu-error');
        return { success: false, error: error.message, menu: [] };
    }
}

/**
 * Extract menu items from current restaurant page.
 * Strategy 1: LI-based (DoorDash uses UL/LI for menus) with child-LI skip logic
 *   — fixes the "child has price" false-positive from flex-container children.
 * Strategy 2: Generic div/button fallback if LI approach gets < 3 items.
 */
async function extractMenuItems() {
    const menuItems = [];

    try {
        console.log('[DoorDash] Starting menu item extraction...');
        console.log('[DoorDash] Current URL:', page.url());

        // Check if menu was pre-fetched from the search page context (fast path)
        if (_preloadedMenuItems && _preloadedMenuItems.length > 0) {
            console.log(`[DoorDash] Using pre-fetched menu (${_preloadedMenuItems.length} items) — skipping page wait`);
            const items = _preloadedMenuItems;
            _preloadedMenuItems = null; // consume it
            for (let i = 0; i < items.length; i++) {
                menuItems.push({ id: `item-${i}`, index: i, name: items[i].name, price: items[i].price, description: items[i].description || '', x: 0, y: 0 });
            }
            return menuItems;
        }

        await takeScreenshot('extract-menu-start');

        // Wait up to 15s for any price to appear (shorter since we have API fallback below)
        let pricesFound = false;
        try {
            await page.waitForFunction(() => document.body.innerText.includes('$'), { timeout: 15000 });
            pricesFound = true;
            console.log('[DoorDash] Prices detected on page ✓');
        } catch (e) {
            const pageContent = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => 'eval failed');
            console.log('[DoorDash] No prices after 15s — page content:', pageContent);
            await takeScreenshot('extract-menu-no-prices');

            // CF is blocking the page — try in-context API as fallback
            const storeIdMatch = page.url().match(/\/store\/[^/?#]*?\/(\d{5,})/) || page.url().match(/\/store\/(\d+)/);
            if (storeIdMatch) {
                console.log('[DoorDash] Trying in-context API fallback for store', storeIdMatch[1]);
                const apiItems = await fetchMenuFromInContextAPI(storeIdMatch[1]);
                if (apiItems && apiItems.length > 0) {
                    for (let i = 0; i < apiItems.length; i++) {
                        menuItems.push({ id: `item-${i}`, index: i, name: apiItems[i].name, price: apiItems[i].price, description: apiItems[i].description || '', x: 0, y: 0 });
                    }
                    console.log(`[DoorDash] API fallback returned ${menuItems.length} items`);
                    return menuItems;
                }
            }
            return menuItems;
        }

        // DoorDash uses virtual scrolling — items are removed from the DOM when scrolled past.
        // Solution: extract items at each viewport position WHILE scrolling, then deduplicate.
        // Uses a broad selector set since DoorDash's DOM structure varies by restaurant
        // (some use <li>, some use <article>, some use <div role="button">).
        const extractAtViewport = () => page.evaluate(() => {
            const results = [];
            const seen = new Set();

            // Query DoorDash-specific selectors first; fall back to generic li/article
            // only if nothing specific found (avoids iterating thousands of DOM nodes).
            let candidates = document.querySelectorAll(
                '[data-anchor-id="MenuItem"], [data-testid="menu-item"]'
            );
            if (candidates.length === 0) {
                candidates = document.querySelectorAll('li, article');
            }
            // Hard cap to 300 elements — prevents layout-thrash on large pages
            const els = Array.from(candidates).slice(0, 300);

            for (const el of els) {
                // Viewport filter first (cheap) before layout-triggering calls
                const rect = el.getBoundingClientRect();
                if (rect.bottom < -300 || rect.top > window.innerHeight + 300) continue;
                if (rect.width < 80 || rect.height < 50) continue;

                // Get full text for price extraction
                const text = (el.innerText || el.textContent || '').trim();
                if (text.length > 1000) continue;
                const priceMatch = text.match(/\$(\d+(?:\.\d{2})?)/);
                if (!priceMatch) continue;

                const price = parseFloat(priceMatch[1]);
                if (price < 1 || price > 100) continue;

                // innerText gives "Name\nDescription\n$Price" (respects block boundaries).
                // The item name is the first non-calorie line before the price.
                let name = '';
                const beforePrice = text.split('$')[0];
                const lines = beforePrice.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 2);
                for (const line of lines) {
                    if (!line.match(/^\d+\s*(cal|kcal|g|oz)?$/i) && line.length < 100) {
                        name = line.split('•')[0].replace(/\s+/g, ' ').trim();
                        break;
                    }
                }
                if (!name || name.length < 3) continue;

                const key = name.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    results.push({ name, price, x: rect.left + rect.width / 2, y: rect.top + window.scrollY + rect.height / 2 });
                }
            }
            return results;
        });

        // Scroll through the full page, extracting at each stop
        const allItemsMap = new Map(); // name.toLowerCase() -> item
        // Wrap page.evaluate calls with a timeout to avoid hanging on frozen browser
        const evaluateWithTimeout = (fn, arg, ms = 8000) => Promise.race([
            arg !== undefined ? page.evaluate(fn, arg) : page.evaluate(fn),
            new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), ms))
        ]);

        let pageHeight = await evaluateWithTimeout(() => document.body.scrollHeight);
        console.log(`[DoorDash] Page height: ${pageHeight}px — scroll-extracting...`);

        let emptyStreak = 0;
        for (let pos = 0; pos <= pageHeight; pos += 400) {
            try {
                await evaluateWithTimeout((y) => window.scrollTo(0, y), pos);
            } catch (e) {
                console.log(`[DoorDash] Scroll evaluate timeout at pos ${pos} — stopping scroll`);
                break;
            }
            await delay(150);
            let batch;
            try {
                // Timeout the extract to avoid hanging on large DOM pages
                batch = await Promise.race([
                    extractAtViewport(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('extract timeout')), 8000))
                ]);
            } catch (e) {
                console.log(`[DoorDash] Extract evaluate timeout at pos ${pos} — skipping`);
                batch = [];
            }
            const sizeBefore = allItemsMap.size;
            for (const item of batch) {
                const key = item.name.toLowerCase();
                if (!allItemsMap.has(key)) allItemsMap.set(key, item);
            }
            const newItems = allItemsMap.size - sizeBefore;
            if (batch.length > 0) console.log(`[DoorDash] scroll@${pos}: +${batch.length} items (${newItems} new, total ${allItemsMap.size})`);
            // Early exit: stop if no new unique items for 5 consecutive steps (~2000px)
            if (newItems === 0) emptyStreak++;
            else emptyStreak = 0;
            if (emptyStreak >= 5 && allItemsMap.size > 0) {
                console.log(`[DoorDash] No new items for ${emptyStreak} steps — stopping early at pos ${pos}`);
                break;
            }
            // Re-check height in case new content loaded while scrolling
            if (pos > 0 && pos % 2400 === 0) {
                try {
                    pageHeight = await evaluateWithTimeout(() => document.body.scrollHeight);
                } catch (e) {}
            }
        }

        // Final pass at the top (items at top may have been unloaded while at bottom)
        await evaluateWithTimeout(() => window.scrollTo(0, 0)).catch(() => {});
        await delay(800);
        const topBatch = await extractAtViewport().catch(() => []);
        for (const item of topBatch) {
            const key = item.name.toLowerCase();
            if (!allItemsMap.has(key)) allItemsMap.set(key, item);
        }
        await takeScreenshot('extract-menu-scrolled');

        const extracted = Array.from(allItemsMap.values());
        console.log(`[DoorDash] Strategy 1 (scroll+extract): ${extracted.length} items`);

        // --- Strategy 2: Full-page generic scan (no viewport filter) ---
        // Always runs to catch items missed by the scroll loop. After scrolling through
        // the full page, all loaded items are still in the DOM — a full querySelectorAll
        // scan picks up anything the viewport-filtered scroll pass missed.
        let fallback = [];
        {
            console.log('[DoorDash] Trying strategy 2 (generic elements)...');
            fallback = await page.evaluate(() => {
                const results = [];
                const seen = new Set();
                const all = document.querySelectorAll('button, article, div, [role="button"]');
                for (const el of all) {
                    if (el.offsetWidth < 80 || el.offsetHeight < 50) continue;
                    if (['SCRIPT','STYLE','NAV','HEADER','FOOTER'].includes(el.tagName)) continue;

                    const text = (el.innerText || el.textContent || '').trim();
                    const priceMatch = text.match(/\$(\d+(?:\.\d{2})?)/);
                    if (!priceMatch) continue;

                    const price = parseFloat(priceMatch[1]);
                    if (price < 1 || price > 100) continue;
                    if (text.length > 800) continue;

                    // Skip if a child div larger than 200x80 also has a price
                    const children = el.querySelectorAll('div, article, button');
                    let childHasPrice = false;
                    for (const child of children) {
                        if (child.offsetWidth < 200 || child.offsetHeight < 80) continue;
                        if ((child.innerText || child.textContent || '').match(/\$\d+/)) { childHasPrice = true; break; }
                    }
                    if (childHasPrice) continue;

                    const beforePrice = text.split('$')[0];
                    const lines = beforePrice.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 2);
                    let name = '';
                    for (const line of lines) {
                        if (!line.match(/^\d+\s*(cal|kcal|g|oz)?$/i) && line.length < 100) {
                            name = line.split('•')[0].replace(/\s+/g, ' ').trim();
                            break;
                        }
                    }
                    if (!name || name.length < 3) continue;

                    const key = name.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const rect = el.getBoundingClientRect();
                    results.push({ name, price, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                }
                return results.slice(0, 60);
            });
            console.log(`[DoorDash] Strategy 2 (generic): ${fallback.length} items`);
        }

        // Merge both strategies — keep whichever found more, but deduplicate.
        // Previously this discarded fallback if extracted >= 3, which caused "6 items"
        // when the full-page scan found more. Now we take the union of both.
        const combined = [...extracted];
        const extractedNames = new Set(extracted.map(i => i.name.toLowerCase()));
        for (const item of fallback) {
            if (!extractedNames.has(item.name.toLowerCase())) combined.push(item);
        }
        console.log(`[DoorDash] Combined (scroll+generic): ${combined.length} items`);

        const deduped = [];
        const seenNames = new Set();
        for (const item of combined) {
            if (!seenNames.has(item.name.toLowerCase())) {
                seenNames.add(item.name.toLowerCase());
                deduped.push(item);
            }
        }

        for (let i = 0; i < deduped.length; i++) {
            const item = deduped[i];
            menuItems.push({
                id: `item-${i}`,
                index: i,
                name: item.name,
                price: item.price,
                description: '',
                x: item.x || 0,
                y: item.y || 0
            });
            console.log(`[DoorDash] Item ${i + 1}: "${item.name}" - $${item.price}`);
        }

        console.log(`[DoorDash] extractMenuItems returning ${menuItems.length} items`);
        await takeScreenshot('extract-menu-done');
        return menuItems;

    } catch (error) {
        console.error('[DoorDash] Extract menu error:', error.message);
        await takeScreenshot('extract-menu-error');
    }

    // --- OLD SCROLL-BASED EXTRACTION BELOW (kept as fallback reference) ---
    // (unreachable — kept for rollback reference only)
    if (false) {

        // Wait for page to fully load
        await delay(2000);

        // FIRST: Click on menu category HEADERS in the main content to expand/load items
        console.log('[DoorDash] Clicking on menu category headers to load items...');

        // Click on each category header in the MAIN content area (not sidebar)
        const categoriesClicked = await page.evaluate(() => {
            const clicked = [];
            // Find h2/h3 headers that are category names
            const headers = document.querySelectorAll('h2, h3, [class*="CategoryHeader"], [class*="category-header"], [data-anchor-id]');

            for (const header of headers) {
                const text = header.textContent?.trim() || '';
                const rect = header.getBoundingClientRect();

                // Should be in main content area (not sidebar), and visible
                if (rect.left > 200 && rect.width > 100 && rect.top > 0 && rect.top < 3000) {
                    // Check if it's a menu category (not reviews, trending, etc.)
                    const lowerText = text.toLowerCase();
                    const isMenuCategory = ['entrees', 'most ordered', 'popular', 'bowls', 'burritos',
                        'tacos', 'salads', 'appetizers', 'sides', 'beverages', 'drinks', 'desserts',
                        'kids', 'combos', 'specials', 'featured', 'light entrees', 'a la carte'].some(cat => lowerText.includes(cat));

                    if (isMenuCategory && text.length < 50) {
                        // Scroll to this header and click it
                        header.scrollIntoView({ behavior: 'instant', block: 'center' });
                        header.click();
                        clicked.push(text);
                    }
                }
            }
            return clicked;
        });

        console.log(`[DoorDash] Clicked ${categoriesClicked.length} category headers:`, categoriesClicked);
        await delay(2000);

        // Also click sidebar categories
        const categoryNames = ['Entrees', 'Most Ordered', 'Featured', 'Bowls', 'Burritos', 'Tacos', 'Salads', 'Light Entrees', 'Kids'];

        for (const catName of categoryNames) {
            try {
                const clicked = await page.evaluate((name) => {
                    const elements = document.querySelectorAll('a, button, div[role="button"], span, li');
                    for (const el of elements) {
                        const text = el.textContent?.trim() || '';
                        if (text.toLowerCase().includes(name.toLowerCase()) && text.length < 50) {
                            const rect = el.getBoundingClientRect();
                            if (rect.left < 250 && rect.width > 20 && rect.width < 300) {
                                el.click();
                                return text;
                            }
                        }
                    }
                    return null;
                }, catName);

                if (clicked) {
                    console.log(`[DoorDash] Clicked sidebar category: ${clicked}`);
                    await delay(800);
                }
            } catch (e) {}
        }

        await takeScreenshot('after-category-clicks');

        // Extract items WHILE scrolling to capture them at each viewport position
        console.log('[DoorDash] Scrolling and extracting menu items at each position...');

        const allExtractedItems = [];
        const seenItemNames = new Set();

        // Helper function to extract visible items
        const extractVisibleItems = async () => {
            return await page.evaluate(() => {
                const results = [];
                // Look for menu item cards - they typically have an image and price
                const cards = document.querySelectorAll(`
                    [class*="MenuItem"], [class*="menu-item"], [class*="ItemCard"],
                    [class*="StoreItem"], [class*="store-item"], [class*="FoodCard"],
                    [data-testid*="MenuItem"], [data-testid*="StoreItem"],
                    article, [role="article"]
                `.replace(/\s+/g, ' '));

                for (const card of cards) {
                    const rect = card.getBoundingClientRect();
                    // Only process items currently in viewport
                    if (rect.top < -100 || rect.top > window.innerHeight + 100) continue;
                    if (rect.width < 100 || rect.height < 80) continue;

                    const text = card.textContent || '';
                    const priceMatch = text.match(/\$(\d+(?:\.\d{2})?)/);
                    if (!priceMatch) continue;

                    const price = parseFloat(priceMatch[1]);
                    if (price < 1 || price > 100) continue;

                    // Extract name - look for heading-like elements
                    let name = '';
                    const headings = card.querySelectorAll('h1, h2, h3, h4, span, div');
                    for (const h of headings) {
                        const hText = h.textContent?.trim() || '';
                        const hRect = h.getBoundingClientRect();
                        // Name is usually near the top of the card, short, and not a price
                        if (hText.length > 3 && hText.length < 60 &&
                            !hText.includes('$') &&
                            !hText.match(/^\d+\s*cal/i) &&
                            !hText.toLowerCase().includes('add') &&
                            hRect.top >= rect.top && hRect.top < rect.top + 80) {
                            name = hText;
                            break;
                        }
                    }

                    if (!name) {
                        // Fallback - get first line of text
                        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
                        for (const line of lines) {
                            if (!line.includes('$') && line.length < 60) {
                                name = line;
                                break;
                            }
                        }
                    }

                    if (name && name.length > 3) {
                        // Clean up name
                        name = name.split('•')[0].trim();
                        name = name.replace(/\d+%\s*\(\d+[k+]*\)/gi, '').trim(); // Remove ratings
                        results.push({
                            name,
                            price,
                            x: rect.left + rect.width / 2,
                            y: rect.top + rect.height / 2
                        });
                    }
                }

                // Also look for simpler item structures (buttons/links with prices)
                const clickables = document.querySelectorAll('button, a, [role="button"]');
                for (const el of clickables) {
                    const rect = el.getBoundingClientRect();
                    if (rect.top < -100 || rect.top > window.innerHeight + 100) continue;
                    if (rect.left < 200 || rect.width < 100) continue; // Skip sidebar

                    const text = el.textContent || '';
                    const priceMatch = text.match(/\$(\d+(?:\.\d{2})?)/);
                    if (!priceMatch) continue;

                    const price = parseFloat(priceMatch[1]);
                    if (price < 1 || price > 100) continue;

                    // Extract name
                    const parts = text.split(/[\n\r]+/).map(s => s.trim()).filter(s => s.length > 3);
                    let name = '';
                    for (const part of parts) {
                        if (!part.includes('$') && part.length < 60 && part.length > 3) {
                            name = part;
                            break;
                        }
                    }

                    if (name) {
                        name = name.split('•')[0].trim();
                        results.push({ name, price, x: rect.left, y: rect.top });
                    }
                }

                return results;
            });
        };

        // Scroll through the page and extract items at each position
        const scrollSteps = 12;
        for (let i = 0; i < scrollSteps; i++) {
            // Extract items visible at current scroll position
            const items = await extractVisibleItems();
            for (const item of items) {
                const key = item.name.toLowerCase();
                if (!seenItemNames.has(key)) {
                    seenItemNames.add(key);
                    allExtractedItems.push(item);
                    console.log(`[DoorDash] Found item: "${item.name}" - $${item.price}`);
                }
            }

            // Scroll down
            await page.evaluate(() => window.scrollBy(0, 400));
            await delay(500);
        }

        // Scroll to bottom and extract
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(1000);
        const bottomItems = await extractVisibleItems();
        for (const item of bottomItems) {
            const key = item.name.toLowerCase();
            if (!seenItemNames.has(key)) {
                seenItemNames.add(key);
                allExtractedItems.push(item);
            }
        }

        await takeScreenshot('menu-scrolled-bottom');

        // Scroll back to top
        await page.evaluate(() => window.scrollTo(0, 0));
        await delay(1000);
        await takeScreenshot('menu-scrolled-top');

        // Use the items collected during scrolling
        console.log(`[DoorDash] ===== EXTRACTION RESULTS =====`);
        console.log(`[DoorDash] Found ${allExtractedItems.length} menu items during scroll`);

        if (allExtractedItems.length === 0) {
            console.log(`[DoorDash] WARNING: No items found during scroll, trying fallback extraction...`);

            // Fallback: try simple extraction at current position
            const fallbackItems = await page.evaluate(() => {
                const results = [];
                const seen = new Set();

                const elements = document.querySelectorAll('button, a, article, [role="button"]');
                for (const el of elements) {
                    const text = el.textContent || '';
                    const priceMatch = text.match(/\$(\d+(?:\.\d{2})?)/);
                    if (!priceMatch) continue;

                    const price = parseFloat(priceMatch[1]);
                    if (price < 2 || price > 50) continue;

                    const rect = el.getBoundingClientRect();
                    if (rect.left < 200 || rect.width < 100) continue;

                    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3 && !l.includes('$'));
                    const name = lines[0]?.split('•')[0]?.trim();

                    if (name && name.length > 3 && name.length < 50 && !seen.has(name.toLowerCase())) {
                        seen.add(name.toLowerCase());
                        results.push({ name, price, x: rect.left, y: rect.top });
                    }
                }
                return results.slice(0, 20);
            });

            for (const item of fallbackItems) {
                allExtractedItems.push(item);
            }
            console.log(`[DoorDash] Fallback found ${fallbackItems.length} items`);
        }

    } // end if (false) — old extraction code

    return menuItems;
}

/**
 * Detect and wait for a Cloudflare IUAM challenge to auto-resolve.
 * CF challenges show "Just a moment" / "Performing security verification" and
 * auto-solve via JS — we just need to wait for the real page to appear.
 * Returns true if no challenge or challenge resolved; false if timed out.
 */
/**
 * Fetch menu items directly from DoorDash's internal API via an in-context fetch
 * call made from within the already-loaded DoorDash page (search results page).
 * Because the browser already passed CF for doordash.com, same-origin XHR/fetch
 * requests carry the existing CF clearance + session cookies and are NOT blocked
 * by the Turnstile that fires on full page navigations to /store/*.
 *
 * Returns an array of { name, price } items, or null if all endpoints failed.
 */
async function fetchMenuFromInContextAPI(storeId) {
    console.log(`[DoorDash API] Fetching menu for store ${storeId} via in-context fetch...`);

    // Check if we already captured this store's menu from DoorDash's own API calls during search
    if (_capturedStoreMenus[storeId] && _capturedStoreMenus[storeId].length > 0) {
        console.log(`[DoorDash API] Using ${_capturedStoreMenus[storeId].length} items intercepted from DoorDash's own API calls`);
        return _capturedStoreMenus[storeId];
    }

    if (_capturedDoorDashHeaders) {
        const authKeys = Object.keys(_capturedDoorDashHeaders).filter(k => k.startsWith('x-') || k.includes('apollo') || k.includes('csrf'));
        console.log(`[DoorDash API] Using ${authKeys.length} captured auth headers: ${authKeys.join(', ')}`);
    } else {
        console.log('[DoorDash API] No captured DoorDash headers yet — will use minimal headers');
    }

    const result = await page.evaluate(async ({ storeId, ddHeaders }) => {
        const logs = [];

        // Helper: try to extract menu items from various known DoorDash response shapes
        function parseItems(data) {
            const found = [];
            const menus = data?.store?.menus || data?.menus || [];
            for (const menu of menus) {
                const cats = menu.menu_categories || menu.categories || [];
                for (const cat of cats) {
                    const catItems = cat.items || cat.menu_items || [];
                    for (const item of catItems) {
                        const name = item.name || item.title || '';
                        const rawPrice = item.price || item.display_price || item.displayPrice || 0;
                        const price = typeof rawPrice === 'number'
                            ? (rawPrice > 200 ? rawPrice / 100 : rawPrice)
                            : parseFloat(String(rawPrice).replace(/[^0-9.]/g, ''));
                        if (name && price > 0) found.push({ name, price });
                    }
                }
            }
            if (found.length === 0 && data?.data) return parseItems(data.data);
            return found;
        }

        // Build headers for GraphQL: use DoorDash's own captured headers if available.
        // Their headers include auth tokens (x-chk-token, apollographql-client-name, etc.)
        // that make the request look like it came from DoorDash's own React app.
        const gqlHeaders = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        if (ddHeaders) {
            // Copy over DoorDash's auth/session headers (skip hop-by-hop headers)
            const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
            for (const [k, v] of Object.entries(ddHeaders)) {
                if (!skip.has(k.toLowerCase())) gqlHeaders[k] = v;
            }
            logs.push(`Using ${Object.keys(ddHeaders).length} captured DoorDash headers`);
        } else {
            logs.push('No captured DoorDash headers — using minimal headers');
        }

        // Attempt 1: GraphQL with DoorDash's captured headers
        const gqlPayloads = [
            {
                operationName: 'getStore',
                variables: { storeId: String(storeId) },
                query: `query getStore($storeId: ID!) { store(id: $storeId) { name menus { menu_categories { name items { name price description } } } } }`,
            },
            {
                operationName: 'getStore',
                variables: { id: String(storeId) },
                query: `query getStore($id: ID!) { store(id: $id) { name menus { menu_categories { name items { name price description } } } } }`,
            },
        ];

        for (const payload of gqlPayloads) {
            try {
                const resp = await fetch(`/graphql/${payload.operationName}?operation=${payload.operationName}`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: gqlHeaders,
                    body: JSON.stringify(payload),
                });
                const text = await resp.text();
                logs.push(`GQL ${payload.operationName} (vars: ${JSON.stringify(payload.variables)}): ${resp.status} | ${text.substring(0, 300)}`);
                if (resp.status === 200) {
                    const data = JSON.parse(text);
                    const parsed = parseItems(data);
                    if (parsed.length > 0) return { ok: true, items: parsed, logs };
                    logs.push(`GQL parsed 0 items. Raw: ${text.substring(0, 300)}`);
                    return { ok: false, items: [], rawData: text.substring(0, 500), logs };
                }
            } catch (e) {
                logs.push(`GQL error: ${e.message}`);
            }
        }

        // Attempt 2: REST endpoint with DoorDash headers
        try {
            const resp = await fetch(`/api/v2/store/${storeId}/`, {
                credentials: 'include',
                headers: { ...gqlHeaders, 'Accept': 'application/json' },
            });
            const text = await resp.text();
            logs.push(`REST /api/v2/store/${storeId}/: ${resp.status} | ${text.substring(0, 200)}`);
            if (resp.status === 200) {
                const data = JSON.parse(text);
                const parsed = parseItems(data);
                if (parsed.length > 0) return { ok: true, items: parsed, logs };
                logs.push(`REST parsed 0 items. Top-level keys: ${Object.keys(data).join(', ')}`);
                return { ok: false, items: [], rawData: JSON.stringify(data).substring(0, 500), logs };
            }
        } catch (e) {
            logs.push(`REST error: ${e.message}`);
        }

        return { ok: false, items: [], logs };
    }, { storeId, ddHeaders: _capturedDoorDashHeaders });

    for (const line of result.logs) {
        console.log('[DoorDash API]', line);
    }
    if (result.rawData) {
        console.log('[DoorDash API] Raw response data:', result.rawData);
    }

    if (result.ok && result.items.length > 0) {
        console.log(`[DoorDash API] Got ${result.items.length} menu items from in-context API`);
        return result.items;
    }

    return null;
}

async function waitForCFChallenge(timeoutMs = 60000) {
    const isCFChallenge = async () => {
        try {
            // __cf_chl_rt_tk in URL = CF issued an inline JS challenge redirect — treat as challenge
            if (page.url().includes('__cf_chl_rt_tk')) return true;
            // page.content() can hang if there's a pending navigation; use a 5s race to avoid blocking forever
            return await Promise.race([
                page.evaluate(() => {
                    const text = document.body?.innerText || '';
                    // window._cf_chl_opt is always present on DoorDash (global Turnstile init) —
                    // only treat it as a real challenge if the iframe is also present.
                    const hasCFIframe = !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
                    return text.includes('Just a moment') ||
                           text.includes('Performing security verification') ||
                           text.includes('cf-browser-verification') ||
                           text.includes('Enable JavaScript and cookies to continue') ||
                           text.includes('jschl_vc') ||
                           hasCFIframe;
                }),
                new Promise((resolve) => setTimeout(() => resolve(false), 5000))
            ]);
        } catch (e) { return false; }
    };

    if (!(await isCFChallenge())) {
        console.log('[DoorDash] No CF challenge detected, page URL:', page.url());
        return true;
    }

    const snippet = await page.evaluate(() => document.body.innerText.substring(0, 200)).catch(() => '');
    console.log('[DoorDash] CF challenge detected! URL:', page.url(), '| Content snippet:', snippet);
    await takeScreenshot('cf-challenge-detected');

    // Try captcha solver first (2captcha/CapSolver) — much faster than waiting for auto-resolve
    const solverKey = process.env.TWOCAPTCHA_API_KEY || process.env.CAPSOLVER_API_KEY;
    if (solverKey) {
        const solved = await solveCFWithCaptchaService(solverKey);
        if (solved) return true;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await delay(500);
        if (!(await isCFChallenge())) {
            console.log(`[DoorDash] CF challenge resolved after ${Date.now() - start}ms`);
            await delay(500);
            return true;
        }
        if ((Date.now() - start) % 3000 < 600) {
            console.log(`[DoorDash] Still seeing CF challenge (${Math.round((Date.now() - start) / 1000)}s)...`);
        }
    }

    console.log('[DoorDash] CF challenge timed out');
    await takeScreenshot('cf-challenge-timeout');
    return false;
}

/**
 * Solve a Cloudflare Turnstile challenge using 2captcha or CapSolver.
 * Extracts the sitekey from the current page, submits to the solver API,
 * injects the returned token, and waits for CF to clear.
 * Returns true if solved successfully.
 */
async function solveCFWithCaptchaService(apiKey) {
    try {
        const pageUrl = page.url();
        console.log('[CF Solver] Attempting to solve CF challenge...');

        // Extract Turnstile sitekey from the page (CF embeds it in _cf_chl_opt or data-sitekey)
        const tsInfo = await page.evaluate(() => {
            let sitekey = null, action = null, cdata = null;
            // Method 1: window._cf_chl_opt (managed challenge)
            if (window._cf_chl_opt?.cSitekey) sitekey = window._cf_chl_opt.cSitekey;
            // Method 2: data-sitekey attribute on Turnstile div (also grab action/cdata)
            const el = document.querySelector('[data-sitekey]');
            if (el) {
                sitekey = sitekey || el.getAttribute('data-sitekey');
                action = el.getAttribute('data-action');
                cdata = el.getAttribute('data-cdata');
            }
            // Method 3: Turnstile iframe src param
            for (const iframe of document.querySelectorAll('iframe')) {
                try {
                    const u = new URL(iframe.src);
                    const sk = u.searchParams.get('sitekey');
                    if (sk) {
                        sitekey = sitekey || sk;
                        action = action || u.searchParams.get('action');
                        cdata = cdata || u.searchParams.get('cData') || u.searchParams.get('cdata');
                        break;
                    }
                } catch {}
            }
            // Method 4: scan inline scripts for sitekey pattern
            if (!sitekey) {
                for (const s of document.querySelectorAll('script:not([src])')) {
                    const m = s.textContent.match(/['"](0x4[A-Za-z0-9_-]{20,})['"]/);
                    if (m) { sitekey = m[1]; break; }
                }
            }
            return sitekey ? { sitekey, action, cdata } : null;
        }).catch(() => null);

        if (!tsInfo) {
            console.log('[CF Solver] No sitekey found — cannot solve');
            return false;
        }
        const { sitekey, action: tsAction, cdata: tsCdata } = tsInfo;
        console.log(`[CF Solver] Sitekey: ${sitekey}${tsAction ? ', action: ' + tsAction : ''}${tsCdata ? ', cdata: ' + tsCdata : ''}`);

        // Determine API endpoint — CapSolver uses capsolver.com, 2captcha uses 2captcha.com
        const isCapSolver = !!process.env.CAPSOLVER_API_KEY;
        const apiBase = isCapSolver ? 'https://api.capsolver.com' : 'https://api.2captcha.com';
        const taskType = isCapSolver ? 'AntiTurnstileTaskProxyLess' : 'TurnstileTaskProxyless';

        // Submit task
        const submitResp = await fetch(`${apiBase}/createTask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientKey: apiKey,
                task: { type: taskType, websiteURL: pageUrl, websiteKey: sitekey, ...(tsAction && { action: tsAction }), ...(tsCdata && { data: tsCdata }) },
            }),
        });
        const submitData = await submitResp.json();
        if (submitData.errorId || submitData.errorCode) {
            console.log('[CF Solver] Submit error:', submitData.errorCode || submitData.errorDescription);
            return false;
        }
        const taskId = submitData.taskId;
        console.log(`[CF Solver] Task ${taskId} submitted — polling for result...`);

        // Poll for result (up to 120s)
        for (let i = 0; i < 24; i++) {
            await delay(5000);
            const resultResp = await fetch(`${apiBase}/getTaskResult`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientKey: apiKey, taskId }),
            });
            const resultData = await resultResp.json();
            if (resultData.errorId || resultData.errorCode) {
                console.log('[CF Solver] Poll error:', resultData.errorCode);
                return false;
            }
            if (resultData.status === 'ready') {
                const token = resultData.solution?.token || resultData.solution?.cfClearance;
                if (!token) {
                    console.log('[CF Solver] No token in solution:', JSON.stringify(resultData.solution));
                    return false;
                }
                console.log(`[CF Solver] Got token (${token.length} chars) — injecting...`);

                // Inject the Turnstile token into the page and trigger the callback.
                // Two cases:
                //   1. Full-page CF challenge: has forms to submit + navigation follows
                //   2. DoorDash Turnstile overlay: no form, need to call widget callback directly
                const hasOverlay = await page.evaluate(() => !!document.querySelector('[data-testid="turnstile/overlay"]')).catch(() => false);
                await page.evaluate((t) => {
                    // Set all cf-turnstile-response inputs and fire events
                    document.querySelectorAll('[name="cf-turnstile-response"]').forEach(el => {
                        el.value = t;
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    });
                    // Trigger Turnstile widget callback directly if available
                    if (window.turnstile) {
                        // Try to find and call the success callback registered with the widget
                        try {
                            const widgetIds = Object.keys(window.__turnstile_cbs__ || {});
                            widgetIds.forEach(id => { try { window.__turnstile_cbs__[id]?.(t); } catch {} });
                        } catch {}
                        // Fallback: trigger execute/reset which may re-validate
                        try { if (window.turnstile.execute) window.turnstile.execute(); } catch {}
                    }
                    // Submit CF challenge forms (full-page challenge case only)
                    if (!document.querySelector('[data-testid="turnstile/overlay"]')) {
                        document.querySelectorAll('form').forEach(f => { try { f.submit(); } catch {} });
                    }
                }, token);

                // For overlay case: wait for overlay to disappear (no page navigation)
                // For full-page case: wait for navigation
                if (hasOverlay) {
                    await delay(3000);
                    const overlayGone = await page.evaluate(() => {
                        const el = document.querySelector('[data-testid="turnstile/overlay"]');
                        if (!el) return true;
                        const s = window.getComputedStyle(el);
                        return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0';
                    }).catch(() => true);
                    if (overlayGone) {
                        console.log('[CF Solver] Turnstile overlay cleared after token injection!');
                        return true;
                    }
                    console.log('[CF Solver] Overlay still present after injection — token may be invalid');
                    return false;
                }

                // Wait for page to navigate away from full-page CF challenge
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                await delay(2000);

                // Verify CF is gone
                try {
                    const stillCF = await Promise.race([
                        page.evaluate(() => {
                            const text = document.body?.innerText || '';
                            return text.includes('Just a moment') || text.includes('Performing security verification') || !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
                        }),
                        new Promise((resolve) => setTimeout(() => resolve(false), 5000))
                    ]).catch(() => false);
                    if (!stillCF) {
                        console.log('[CF Solver] CF challenge cleared!');
                        return true;
                    }
                } catch {}

                console.log('[CF Solver] Token injected but CF still present');
                return false;
            }
        }
        console.log('[CF Solver] Timed out waiting for solution');
        return false;
    } catch (e) {
        console.log('[CF Solver] Error:', e.message);
        return false;
    }
}

/**
 * Navigate to a restaurant by URL or index and extract menu categories
 */
async function selectRestaurantFromSearch(indexOrUrl) {
    try {
        console.log(`[DoorDash] Selecting restaurant: ${indexOrUrl}`);

        if (typeof indexOrUrl === 'string' && indexOrUrl.includes('/store/')) {
            // Navigate using window.location.href from within the page JS context.
            // This bypasses both problems:
            //   1. Cloudflare Turnstile overlay that blocks pointer events on link clicks
            //   2. CF treating external page.goto() as a cold bot hit
            // An in-page JS navigation uses the existing CF session cookies and is
            // treated as a continuation of the same browsing session.
            const currentUrl = page.url();
            console.log(`[DoorDash] JS navigation from ${currentUrl} → ${indexOrUrl}`);

            _preloadedMenuItems = null; // clear any cached pre-fetch data

            // The indexOrUrl may already be a carousel URL (updated by search flow step 5c).
            // Carousel URLs (/store/ID?cursor=...) work; externalStores ID-only URLs 404.
            let targetUrl = indexOrUrl;

            // Resolve chain-level selection_intel_store IDs → navigable slug URLs.
            // externalStores returns chain-level IDs (e.g. 10017934) that redirect to DoorDash home.
            // In-browser /v2/store/search/ should return real individual stores with url_key slugs.
            const storeIdFromUrl = targetUrl.match(/\/store\/(?:[^/?#]*\/)?(\d+)/)?.[1];
            const capturedEntry = _capturedRestaurants.find(r => r.id === storeIdFromUrl);
            if (storeIdFromUrl && capturedEntry?.name) {
                console.log(`[DoorDash] Resolving navigable URL for ${capturedEntry.name} (id=${storeIdFromUrl})...`);
                try {
                    const resolveResult = await Promise.race([
                        page.evaluate(async ({ name, lat, lng }) => {
                            const paths = [
                                `/v2/store/search/?query=${encodeURIComponent(name)}&lat=${lat}&lng=${lng}&limit=5`,
                                `/api/v1/consumer/consumer_store_search/?query=${encodeURIComponent(name)}&lat=${lat}&lng=${lng}&limit=5`,
                            ];
                            for (const path of paths) {
                                try {
                                    const r = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } });
                                    const text = await r.text();
                                    const data = JSON.parse(text);
                                    const stores = data?.stores || data?.data?.stores || [];
                                    return { ok: r.ok, path, status: r.status, firstStore: stores[0] || null, rawSnippet: text.substring(0, 500) };
                                } catch (e) { return { ok: false, path, error: e.message }; }
                            }
                            return { ok: false };
                        }, { name: capturedEntry.name, lat: 40.5247, lng: -111.8638 }),
                        new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 8000))
                    ]);

                    console.log(`[DoorDash] Store search resolve: ok=${resolveResult.ok} status=${resolveResult.status} path=${resolveResult.path}`);
                    if (resolveResult.ok && resolveResult.firstStore) {
                        const s = resolveResult.firstStore;
                        console.log(`[DoorDash] Store search first result keys: ${Object.keys(s).join(', ')}`);
                        const urlKey = s.url_key || s.urlKey || s.slug || s.url_slug || s.urlSlug || s.page_url || s.pageUrl || '';
                        const realId = String(s.id || s.storeId || '');
                        if (urlKey) {
                            targetUrl = `https://www.doordash.com/store/${urlKey}/${realId}/`;
                            console.log(`[DoorDash] Resolved navigable URL: ${targetUrl}`);
                        } else if (realId && realId !== storeIdFromUrl) {
                            targetUrl = `https://www.doordash.com/store/${realId}/`;
                            console.log(`[DoorDash] No url_key found — using real store id: ${targetUrl}`);
                        } else {
                            console.log(`[DoorDash] No url_key or new id found. rawSnippet: ${resolveResult.rawSnippet}`);
                        }
                    } else if (resolveResult.rawSnippet) {
                        console.log(`[DoorDash] Store search not ok. rawSnippet: ${resolveResult.rawSnippet}`);
                    }
                } catch (e) {
                    console.log('[DoorDash] Store URL resolve error:', e.message);
                }
            }

            // OOM fix: navigate to about:blank before the store page to free search page React
            // memory. Search page React holds ~400-500MB; jumping straight to a store page
            // pushes Chrome past 512MB → "Target crashed".
            if (page.url().includes('/search/')) {
                console.log('[DoorDash] Clearing search page from memory (about:blank) before store load...');
                await page.goto('about:blank', { waitUntil: 'load', timeout: 10000 }).catch(() => {});
                await delay(500);
            }

            try {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
                    console.log('[DoorDash] Store page goto error (continuing):', e.message);
                });
                console.log('[DoorDash] Navigation landed at:', page.url());
            } catch (e) {
                console.log('[DoorDash] Navigation error:', e.message);
            }

            const cfWait = 30000;
            await delay(1000); // brief settle before checking
            const cfResolved = await waitForCFChallenge(cfWait);
            let finalUrl = page.url();
            let bodySnippet = await Promise.race([
                page.evaluate(() => document.body.innerText.substring(0, 150)).catch(() => ''),
                new Promise(r => setTimeout(() => r(''), 5000))
            ]);
            console.log('[DoorDash] After CF check — URL:', finalUrl, '| Body:', bodySnippet);

            // Wait for DoorDash's invisible Turnstile overlay to clear.
            // The overlay is present while CF fingerprints the session; once it passes,
            // the overlay is removed and in-page API calls (item pricing etc.) start working.
            const turnstileStart = Date.now();
            let triedSolver = false;
            for (let t = 0; t < 30; t++) {
                const overlayPresent = await page.evaluate(() => {
                    const el = document.querySelector('[data-testid="turnstile/overlay"]');
                    if (!el) return false;
                    const s = window.getComputedStyle(el);
                    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
                }).catch(() => false);
                if (!overlayPresent) {
                    if (t > 0) console.log(`[DoorDash] Turnstile overlay cleared after ${t}s`);
                    else console.log('[DoorDash] No Turnstile overlay detected');
                    break;
                }
                if (t === 0) {
                    console.log('[DoorDash] Waiting for Turnstile overlay to clear...');
                    // Try 2captcha/CapSolver on first detection
                    const solverKey = process.env.TWOCAPTCHA_API_KEY || process.env.CAPSOLVER_API_KEY;
                    if (solverKey && !triedSolver) {
                        triedSolver = true;
                        console.log('[DoorDash] Turnstile overlay detected — attempting captcha solver...');
                        const solved = await solveCFWithCaptchaService(solverKey);
                        if (solved) { console.log('[DoorDash] Turnstile solved via captcha service'); break; }
                    }
                }
                await delay(300);
                if (t === 29) console.log('[DoorDash] Turnstile overlay still present after 10s — proceeding anyway');
            }

            // If CF challenge did NOT resolve, soft retry keeping the same proxy IP.
            // Restarting the browser rotates to a new IP which may be worse — avoid it.
            const stillCFBlocked = !cfResolved || bodySnippet.includes('security verification') ||
                bodySnippet.includes('Just a moment') || bodySnippet.toLowerCase().startsWith('www.doordash.com\n');
            if (stillCFBlocked) {
                console.log('[DoorDash] CF timed out — soft retrying from search page (keeping same proxy IP)...');
                // Navigate back to search page from homepage context (no browser restart)
                await page.goto(DOORDASH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await delay(5000);
                await waitForCFChallenge(30000); // wait for homepage CF to clear
                await delay(2000);
                // JS navigate to search page from homepage context
                const retrySearchUrl = sessionState.lastSearchUrl || DOORDASH_URL;
                console.log('[DoorDash] Retry: JS navigate to search page:', retrySearchUrl);
                await page.evaluate((url) => { window.location.href = url; }, retrySearchUrl);
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await waitForCFChallenge(20000);
                await delay(2000);
                // Try clicking the restaurant link (organic click from search results)
                const storeId = targetUrl.match(/\/store\/(?:[^/?#]*\/)?(\d+)/)?.[1];
                let retryNavOk = false;
                if (storeId) {
                    const linkHref = await page.evaluate((id) => {
                        const a = document.querySelector(`a[href*="/store/"][href*="${id}"]`);
                        return a ? a.href : null;
                    }, storeId);
                    if (linkHref) {
                        console.log('[DoorDash] Retry: clicking restaurant link:', linkHref);
                        const link = page.locator(`a[href*="/store/"][href*="${storeId}"]`).first();
                        await link.click().catch(() => {});
                        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                        retryNavOk = true;
                    }
                }
                if (!retryNavOk) {
                    // Fallback to JS navigate from search context
                    console.log('[DoorDash] Retry: link not found — JS navigate to store');
                    await page.evaluate((url) => { window.location.href = url; }, targetUrl);
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                }
                await delay(2000);
                await waitForCFChallenge(30000);
                finalUrl = page.url();
                bodySnippet = await page.evaluate(() => document.body.innerText.substring(0, 150)).catch(() => '');
                console.log('[DoorDash] After retry — URL:', finalUrl, '| Body:', bodySnippet);
            }
        } else {
            // It's an index - find and click the store link
            const storeLinks = await page.$$('a[href*="/store/"]');
            const index = parseInt(indexOrUrl);

            if (index < 0 || index >= storeLinks.length) {
                return { success: false, error: 'Invalid restaurant selection' };
            }

            console.log(`[DoorDash] Clicking restaurant at index ${index}...`);
            await storeLinks[index].click();
        }

        await delay(4000);
        await handlePopups();
        await takeScreenshot('restaurant-page');

        // Get restaurant name from page
        let restaurantName = 'Restaurant';
        try {
            // Try various selectors for the restaurant name
            const nameSelectors = ['h1', '[data-anchor-id="StoreName"]', 'h2'];
            for (const sel of nameSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el) {
                        restaurantName = await el.textContent();
                        restaurantName = restaurantName.trim().split('\n')[0]; // Get first line only
                        if (restaurantName.length > 2) break;
                    }
                } catch (e) {}
            }
        } catch (e) {}

        console.log(`[DoorDash] Restaurant name: ${restaurantName}`);

        // Save the clean store URL (strip trailing item/section IDs like /39035756/)
        // so checkoutCurrentCart can navigate back to the main restaurant page if needed.
        const cleanStoreUrl = page.url().replace(/\/(\d{6,})(\/.*)?$/, '/');
        updateSessionState({ currentRestaurantUrl: cleanStoreUrl });

        // Extract menu categories
        const categories = await extractMenuCategories();
        console.log(`[DoorDash] Found ${categories.length} menu categories`);

        return {
            success: true,
            restaurantName,
            categories,
            url: page.url()
        };

    } catch (error) {
        console.error('[DoorDash] Select restaurant error:', error.message);
        await takeScreenshot('select-restaurant-error');
        return { success: false, error: error.message };
    }
}

/**
 * Extract menu categories from restaurant page
 */
async function extractMenuCategories() {
    const categories = [];

    try {
        console.log('[DoorDash] Extracting menu categories...');

        // DoorDash uses various elements for category headers
        // Look for h2/h3 elements that are category titles, or elements with "category" in class
        const categorySelectors = [
            'h2',
            'h3',
            '[class*="category" i]',
            '[class*="Category" i]',
            '[data-anchor-id*="Category"]',
            'button[class*="tab" i]'
        ];

        const seenCategories = new Set();

        for (const selector of categorySelectors) {
            try {
                const elements = await page.$$(selector);

                for (const el of elements) {
                    const text = await el.textContent();
                    const cleanText = text.trim().split('\n')[0].trim();

                    // Skip if too short, too long, or already seen
                    if (cleanText.length < 3 || cleanText.length > 50) continue;
                    if (seenCategories.has(cleanText.toLowerCase())) continue;

                    // Skip things that don't look like categories
                    const skipWords = ['delivery', 'pickup', 'schedule', 'group order', 'sign', 'log', 'cart', 'featured', 'popular',
                        'get to know', 'let us help', 'doing business', 'about', 'careers', 'investor', 'newsroom',
                        'merchant', 'dasher', 'safety', 'blog', 'accessibility', 'privacy', 'terms', 'copyright'];
                    if (skipWords.some(w => cleanText.toLowerCase().includes(w))) continue;

                    // Common menu category patterns
                    const categoryPatterns = [
                        /burrito/i, /taco/i, /bowl/i, /salad/i, /quesadilla/i,
                        /appetizer/i, /starter/i, /side/i, /drink/i, /beverage/i,
                        /dessert/i, /kid/i, /combo/i, /meal/i, /entree/i,
                        /sandwich/i, /wrap/i, /soup/i, /pizza/i, /pasta/i,
                        /breakfast/i, /lunch/i, /dinner/i, /special/i,
                        /chicken/i, /beef/i, /seafood/i, /veggie/i, /vegetarian/i
                    ];

                    // Check if it looks like a category
                    const looksLikeCategory = categoryPatterns.some(p => p.test(cleanText)) ||
                        /^[A-Z]/.test(cleanText); // Starts with capital letter

                    if (looksLikeCategory) {
                        seenCategories.add(cleanText.toLowerCase());
                        categories.push({
                            name: cleanText,
                            index: categories.length
                        });

                        if (categories.length >= 10) break;
                    }
                }

                if (categories.length >= 5) break;

            } catch (e) {
                continue;
            }
        }

        // If we didn't find categories, just return some generic ones based on page content
        if (categories.length === 0) {
            const pageText = await page.content();
            const genericCategories = ['Entrees', 'Sides', 'Drinks', 'Desserts'];
            for (const cat of genericCategories) {
                if (pageText.toLowerCase().includes(cat.toLowerCase())) {
                    categories.push({ name: cat, index: categories.length });
                }
            }
        }

        console.log('[DoorDash] Categories found:', categories.map(c => c.name).join(', '));

    } catch (error) {
        console.error('[DoorDash] Extract categories error:', error.message);
    }

    return categories;
}

/**
 * Get menu items in a specific category
 */
async function getMenuItemsInCategory(categoryName) {
    try {
        console.log(`[DoorDash] Getting items in category: ${categoryName}`);

        // First, try to scroll to the category section
        const categoryHeaders = await page.$$('h2, h3');
        for (const header of categoryHeaders) {
            const text = await header.textContent();
            if (text.toLowerCase().includes(categoryName.toLowerCase())) {
                await header.scrollIntoViewIfNeeded();
                await delay(1000);
                break;
            }
        }

        await takeScreenshot('category-view');

        // Extract menu items
        const items = await extractMenuItems();

        return {
            success: true,
            category: categoryName,
            items: items.slice(0, 10) // Return up to 10 items
        };

    } catch (error) {
        console.error('[DoorDash] Get category items error:', error.message);
        return { success: false, error: error.message, items: [] };
    }
}

/**
 * Add item to cart by clicking on menu item
 * @param {number} index - The index of the item in the menu
 * @param {Object} options - Options like selectFirst for auto-selecting required options
 * @param {Object} cachedItem - Optional cached item with name/price data
 */
async function addItemByIndex(index, options = {}, cachedItem = null) {
    if (!page || !context) {
        return { success: false, browserNotOpen: true };
    }
    try {
        const itemName = cachedItem?.name || `item ${index + 1}`;
        console.log(`[DoorDash] Adding item: ${itemName} (index ${index})...`);
        console.log(`[DoorDash] Options:`, JSON.stringify(options));
        console.log(`[DoorDash] Current URL for item add: ${page.url()}`);

        // If not on a DoorDash store page (e.g. browser is on about:blank after search),
        // navigate there before attempting to find/click the item.
        // Navigate via the DoorDash homepage first to warm up the CF session context —
        // cold-navigating directly from about:blank to a store page triggers CF challenges.
        const storeNavUrl = options.restaurantUrl || sessionState.currentRestaurantUrl;

        // Wait for background pre-warm if it's for this restaurant (started after cache-hit SELECT)
        if (_preWarmPromise && _preWarmUrl) {
            const storeBase = storeNavUrl ? storeNavUrl.split('?')[0] : '';
            const preWarmBase = _preWarmUrl.split('?')[0];
            if (storeBase && (storeBase === preWarmBase || preWarmBase.includes(storeBase.split('/store/')[1] || 'NOMATCH'))) {
                console.log('[DoorDash] Waiting for background pre-warm to complete...');
                await Promise.race([_preWarmPromise, new Promise(r => setTimeout(r, 25000))]);
                _preWarmPromise = null;
                _preWarmUrl = null;
                console.log('[DoorDash] Pre-warm wait done, current URL:', page.url().substring(0, 80));
            }
        }

        if (!page.url().includes('doordash.com/store/') && storeNavUrl) {
            const isOnDoorDash = page.url().includes('doordash.com');
            if (!isOnDoorDash) {
                console.log('[DoorDash] Warming CF session via DoorDash homepage...');
                await page.goto('https://www.doordash.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                await delay(1500);
            }
            console.log(`[DoorDash] Navigating to store page: ${storeNavUrl}`);
            await page.goto(storeNavUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
                console.log('[DoorDash] Navigation to store page error:', e.message);
            });
            await waitForCFChallenge(15000);
            await delay(1000);
            console.log(`[DoorDash] Now at: ${page.url()}`);
        }

        await takeScreenshot(`add-item-start-${index}`);

        // Check if modal is already open (from previous interaction)
        const existingModal = await page.$('[role="dialog"], [aria-modal="true"]');
        if (existingModal && options.selections && options.selections.length > 0) {
            console.log('[DoorDash] Modal already open - applying selections directly');
            // Modal is already open, skip clicking item and go straight to applying selections
            await takeScreenshot('modal-already-open');

            // Start debug screenshots
            startDebugScreenshots(3000);

            // Apply the user's selections
            console.log('[DoorDash] Applying user selections to existing modal...');
            await applyOptionSelections(options.selections);
            await delay(1000);
            await takeScreenshot('after-user-selection-existing');

            // Auto-select any remaining required options
            console.log('[DoorDash] Auto-selecting any remaining required options...');
            await autoSelectAllRequiredOptions();
            await delay(500);

            // Try to click Add to Order button
            console.log('[DoorDash] Attempting to add to cart...');
            for (let attempt = 0; attempt < 3; attempt++) {
                await delay(500);
                const added = await clickAddToOrderButton();

                if (added) {
                    console.log('[DoorDash] Item added to cart successfully!');
                    stopDebugScreenshots();
                    await takeScreenshot('item-added');
                    return { success: true };
                }

                console.log(`[DoorDash] Add attempt ${attempt + 1} failed, trying to select more options...`);
                await autoSelectAllRequiredOptions();
                await delay(500);
            }

            // Check for remaining required options
            const stillRequired = await extractRequiredOptions();
            if (stillRequired.length > 0) {
                console.log('[DoorDash] Still have required options unfulfilled');
                stopDebugScreenshots();
                return {
                    success: false,
                    needsOptions: true,
                    requiredOptions: stillRequired,
                    message: 'Please select required options'
                };
            }

            stopDebugScreenshots();
            return { success: true, message: 'Attempted to add item' };
        }

        let clicked = false;
        const searchName = cachedItem?.name?.split('•')[0]?.trim() || '';

        if (searchName) {
            console.log(`[DoorDash] Searching for item by name: "${searchName}"`);

            // Strategy 0: Playwright locator — most reliable for React apps.
            // Uses actionability checks and proper CDP event sequences.
            // Escaping ® / ™ since regex doesn't need them literally.
            try {
                const safePattern = searchName.replace(/[®™©]/g, '.').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '.');
                const loc = page.locator('[data-anchor-id="MenuItem"], article, [role="button"]')
                    .filter({ hasText: new RegExp(safePattern, 'i') })
                    .first();
                await loc.scrollIntoViewIfNeeded({ timeout: 4000 });
                await delay(200);
                await loc.click({ timeout: 5000 });
                clicked = true;
                console.log(`[DoorDash] Playwright locator click succeeded for "${searchName}"`);
            } catch (locErr) {
                console.log(`[DoorDash] Playwright locator click failed: ${locErr.message.split('\n')[0]}`);
            }

            if (clicked) {
                // Skip treewalker / position-based search below
            } else {

            // First scroll to top
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(300);

            // Scroll directly to the item's cached position — avoids full-page scroll
            // (full-page scan here + extractMenuItems already doing it = Chrome OOM on Railway).
            // cachedItem.y is the absolute document y from extraction; scroll there ± a few
            // steps as fallback in case the DOM shifted slightly since extraction.
            const cachedY = (cachedItem?.y > 0) ? cachedItem.y : 0;
            const searchYPositions = cachedY > 0
                ? [cachedY - 300, cachedY, cachedY + 300, cachedY - 700, cachedY + 700, 0]
                : [0, 400, 800, 1200, 1600, 2000, 2400];
            console.log(`[DoorDash] Targeted scroll to item (cached y=${cachedY}) — ${searchYPositions.length} positions`);

            for (let scrollAttempt = 0; scrollAttempt < searchYPositions.length && !clicked; scrollAttempt++) {
                const scrollY = Math.max(0, searchYPositions[scrollAttempt]);
                await page.evaluate((y) => window.scrollTo(0, y), scrollY);
                await delay(800); // give React virtual scroll time to render items

                // Try to find and click the item at current scroll position.
                // Uses TreeWalker (text-node scan) instead of querySelectorAll('span,div')
                // to avoid iterating thousands of elements — critical on Railway's limited RAM.
                const result = await page.evaluate((name) => {
                    const lowerName = name.toLowerCase().trim();

                    // Helper: walk up from a text node to find a clickable card element.
                    // Prefers actual interactive elements (button/a/[role=button]) over
                    // generic containers — React requires the real interactive element
                    // to fire synthetic events properly.
                    function findCard(startEl) {
                        let el = startEl;
                        let bestCard = null;
                        let bestClickable = null;
                        for (let i = 0; i < 10 && el; i++) {
                            const r = el.getBoundingClientRect();
                            if (r.width > 600 || r.height > 500) break;
                            if (r.width > 100 && r.width < 520 && r.height > 50 && r.height < 400 && r.left > 50) {
                                bestCard = el;
                                const tag = el.tagName?.toLowerCase();
                                const role = el.getAttribute?.('role');
                                const isClickable = tag === 'button' || tag === 'a' ||
                                    role === 'button' || role === 'link' ||
                                    el.getAttribute?.('tabindex') === '0' ||
                                    el.hasAttribute?.('onclick');
                                if (isClickable) bestClickable = el;
                            }
                            el = el.parentElement;
                        }
                        return bestClickable || bestCard;
                    }

                    // STRATEGY 1 (fast): TreeWalker over text nodes — O(n text nodes), early exit
                    // Finds first visible text node whose content matches the item name exactly.
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                    let node;
                    let bestExact = null, bestPrefix = null;
                    while ((node = walker.nextNode())) {
                        const t = node.textContent.trim().replace(/\s+/g, ' ').toLowerCase();
                        if (!t) continue;
                        const isExact = (t === lowerName);
                        const isPrefix = !isExact && t.startsWith(lowerName) && t.length < lowerName.length + 30;
                        if (!isExact && !isPrefix) continue;
                        // Check visibility: parent must be in or near viewport
                        const parentEl = node.parentElement;
                        if (!parentEl) continue;
                        const pr = parentEl.getBoundingClientRect();
                        if (pr.top < -100 || pr.top > window.innerHeight + 100) continue;
                        if (pr.left < 50) continue;
                        if (isExact && !bestExact) bestExact = parentEl;
                        if (isPrefix && !bestPrefix) bestPrefix = parentEl;
                        if (bestExact) break; // exact match found, stop
                    }

                    // Helper: disable Turnstile overlay and return card center coords.
                    // We do NOT click here — clicking via CDP page.mouse.click(x,y) after
                    // evaluate is more reliable than JS dispatchEvent for React 18 event delegation.
                    function prepareCard(card) {
                        document.querySelectorAll('[data-testid="turnstile/overlay"]').forEach(el => {
                            el.style.pointerEvents = 'none';
                            el.style.display = 'none';
                        });
                        card.scrollIntoView({ behavior: 'instant', block: 'center' });
                        const r = card.getBoundingClientRect();
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                    }

                    const matchEl = bestExact || bestPrefix;
                    if (matchEl) {
                        const card = findCard(matchEl);
                        if (card) {
                            const coords = prepareCard(card);
                            return {
                                found: true, clicked: false, strategy: 'treewalker',
                                text: matchEl.textContent.trim().substring(0, 40),
                                x: coords.x, y: coords.y
                            };
                        }
                    }

                    // STRATEGY 2: Specific card selectors (article, role=button, etc.)
                    const cards = document.querySelectorAll(
                        'article, [role="button"], [class*="MenuItem"], [class*="ItemCard"], button, a'
                    );
                    for (const card of cards) {
                        const text = card.textContent || '';
                        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                        const firstLine = lines[0]?.toLowerCase() || '';
                        if (firstLine !== lowerName && !firstLine.startsWith(lowerName)) continue;
                        if (!text.match(/\$\d+/)) continue;
                        const rect = card.getBoundingClientRect();
                        if (rect.width < 100 || rect.width > 480) continue;
                        if (rect.height < 50 || rect.height > 350) continue;
                        if (rect.left < 50) continue;
                        if (rect.top < -50 || rect.top > window.innerHeight + 50) continue;
                        const coords = prepareCard(card);
                        return {
                            found: true, clicked: false, strategy: 'card-match',
                            text: firstLine.substring(0, 40),
                            x: coords.x, y: coords.y
                        };
                    }

                    // Debug: sample a few visible text nodes for logging
                    const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                    const visibleSamples = [];
                    let n2;
                    while ((n2 = walker2.nextNode()) && visibleSamples.length < 8) {
                        const t = n2.textContent.trim();
                        if (!t || t.length < 3) continue;
                        const pr = n2.parentElement?.getBoundingClientRect();
                        if (!pr || pr.top < 0 || pr.top > window.innerHeight) continue;
                        if (t.includes('$')) visibleSamples.push(t.substring(0, 30));
                    }
                    return { found: false, scrollTop: window.scrollY, visiblePriceItems: visibleSamples };
                }, searchName);

                if (!result.found) {
                    console.log(`[DoorDash] y=${scrollY}: not found, scrollTop=${result.scrollTop}, visible: ${JSON.stringify(result.visiblePriceItems)}`);
                }

                if (result.found) {
                    console.log(`[DoorDash] Found "${searchName}" via ${result.strategy}: ${result.text}`);
                    console.log(`[DoorDash] Card center: (${result.x?.toFixed(0)}, ${result.y?.toFixed(0)})`);
                    // Use CDP mouse click — works with React 18 event delegation where
                    // JS dispatchEvent does not. Overlay already hidden via prepareCard().
                    await page.mouse.click(result.x, result.y);
                    console.log('[DoorDash] CDP mouse click dispatched');
                    clicked = true;
                    break;
                }

            }

            if (!clicked) {
                console.log(`[DoorDash] Could not find "${searchName}" at targeted positions`);
                await takeScreenshot('item-not-found');
            }
        }

        // If name-based search didn't work, try scrolling to top and doing position-based
        if (!clicked) {
            console.log('[DoorDash] Name-based search failed, trying position-based at each scroll position...');

            // Scroll past "Order it again" section first
            await page.evaluate(() => {
                const targetSections = ['most ordered', 'featured items', 'entrees', 'popular items'];
                const allElements = document.querySelectorAll('h1, h2, h3, h4, span, div');
                for (const el of allElements) {
                    const text = el.textContent?.toLowerCase()?.trim() || '';
                    for (const section of targetSections) {
                        if (text === section || (text.startsWith(section) && text.length < section.length + 10)) {
                            const rect = el.getBoundingClientRect();
                            if (rect.top > 50) {
                                window.scrollBy(0, rect.top - 50);
                                return;
                            }
                        }
                    }
                }
                // Default scroll past Order it again section
                window.scrollBy(0, 400);
            });
            await delay(500);

            // Scroll and collect all visible items
            let allItems = [];
            const seenTexts = new Set();

            for (let scrollStep = 0; scrollStep < 8; scrollStep++) {
                const items = await page.evaluate(() => {
                    const results = [];
                    const elements = document.querySelectorAll('button, a, article, [role="button"], div[tabindex="0"]');

                    for (const el of elements) {
                        const text = el.textContent || '';
                        if (/\$\d+/.test(text)) {
                            const rect = el.getBoundingClientRect();
                            if (rect.width > 80 && rect.left > 150 &&
                                rect.top > 0 && rect.top < window.innerHeight &&
                                rect.height > 40) {

                                const name = text.split('\n')[0]?.trim()?.substring(0, 50) || text.substring(0, 50);
                                results.push({
                                    name,
                                    fullText: text.toLowerCase(),
                                    x: rect.left + rect.width / 2,
                                    y: rect.top + rect.height / 2,
                                    scrollY: window.scrollY
                                });
                            }
                        }
                    }
                    return results;
                });

                for (const item of items) {
                    if (!seenTexts.has(item.name)) {
                        seenTexts.add(item.name);
                        allItems.push(item);
                    }
                }

                await page.evaluate(() => window.scrollBy(0, 350));
                await delay(300);
            }

            console.log(`[DoorDash] Found ${allItems.length} total items across scroll positions`);

            if (index < allItems.length) {
                const target = allItems[index];
                console.log(`[DoorDash] Clicking item ${index + 1}: "${target.name}"`);

                // Scroll to the position where we found this item
                await page.evaluate((scrollY) => window.scrollTo(0, scrollY), target.scrollY);
                await delay(300);

                // Now click at the position (with timeout guard)
                try {
                    await Promise.race([
                        page.mouse.click(target.x, target.y),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('mouse.click timeout')), 8000))
                    ]);
                } catch (clickErr) {
                    console.log(`[DoorDash] mouse.click timeout — JS click fallback`);
                    await page.evaluate(({x, y}) => { const el = document.elementFromPoint(x, y); if (el) el.click(); }, { x: target.x, y: target.y });
                }
                clicked = true;
            } else {
                return { success: false, error: `Item ${index + 1} not found on page. Only found ${allItems.length} items.` };
            }
        } // end else (Playwright locator failed, fell through to position-based)
        } // end if (searchName)

        if (!clicked) {
            return { success: false, error: 'Could not open item. Please try selecting again.' };
        }

        await delay(800);
        await takeScreenshot('after-item-click');

        // Check if a modal/dialog opened
        let modalOpened = await page.$('[role="dialog"], [data-testid*="modal"], [class*="Modal"], [class*="modal"], [aria-modal="true"]');

        // If no modal yet, wait a bit longer and check again
        if (!modalOpened) {
            console.log('[DoorDash] No modal yet, waiting longer...');
            await delay(600);
            await takeScreenshot('after-item-click-retry');
            modalOpened = await page.$('[role="dialog"], [data-testid*="modal"], [class*="Modal"], [class*="modal"], [aria-modal="true"]');
        }

        if (modalOpened) {
            console.log('[DoorDash] Item modal opened');
            await takeScreenshot('item-modal');
            await delay(1000);

            // Check if modal is a "restaurant closed" notice (not a real item modal)
            const closedMsg = await page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                if (!modal) return null;
                const text = modal.textContent || '';
                if (text.toLowerCase().includes('currently closed') || text.toLowerCase().includes('is closed')) {
                    // Only "Browse menu" or similar — no add button
                    const buttons = Array.from(modal.querySelectorAll('button')).map(b => b.textContent?.trim() || '');
                    return buttons.join(', ');
                }
                return null;
            }).catch(() => null);

            if (closedMsg !== null) {
                console.log(`[DoorDash] Restaurant is closed — modal buttons: ${closedMsg}`);
                await page.keyboard.press('Escape').catch(() => {});
                stopDebugScreenshots();
                return { success: false, error: 'RESTAURANT_CLOSED', message: 'This restaurant is currently closed and not accepting orders.' };
            }

            // Clear any pre-selected options from previous orders
            // DoorDash remembers your last customizations - we want fresh options
            await clearPreSelectedOptions();
            await delay(500);

            // Check for required options that need user input
            const requiredOptions = await extractRequiredOptions();

            if (requiredOptions.length > 0 && !options.skipOptionsCheck) {
                console.log(`[DoorDash] Found ${requiredOptions.length} required option groups`);
                stopDebugScreenshots();
                // Return the options to the server so it can ask the user
                return {
                    success: false,
                    needsOptions: true,
                    requiredOptions: requiredOptions,
                    message: 'This item has required options'
                };
            }

            // If selectFirst is true, auto-select first option in each group
            if (options.selectFirst) {
                console.log('[DoorDash] Auto-selecting first options...');
                await autoSelectFirstOptions();
            }

            // If specific options were provided, select them
            if (options.selections && options.selections.length > 0) {
                console.log('[DoorDash] Applying user selections...');
                await applyOptionSelections(options.selections);
                await delay(1000);
                await takeScreenshot('after-user-selection');

                // After applying user's selection, auto-select any remaining required options
                // This handles cases where there are multiple required groups
                console.log('[DoorDash] Auto-selecting any remaining required options...');
                await autoSelectAllRequiredOptions();
                await delay(500);
            }

            // Try to click "Add to Order" button - try multiple times
            console.log('[DoorDash] Attempting to add to cart...');
            for (let attempt = 0; attempt < 3; attempt++) {
                await delay(500);
                const added = await clickAddToOrderButton();

                if (added) {
                    console.log('[DoorDash] Item added to cart successfully!');
                    stopDebugScreenshots();
                    await takeScreenshot('item-added');
                    return { success: true };
                }

                // If not added, try auto-selecting remaining options
                console.log(`[DoorDash] Add attempt ${attempt + 1} failed, trying to select more options...`);
                await autoSelectAllRequiredOptions();
                await delay(500);
            }

            // Final screenshot to see what went wrong
            await takeScreenshot('add-failed-final-state');

            // Modal still open - check if there are still unfulfilled required options
            const stillRequired = await extractRequiredOptions();
            if (stillRequired.length > 0) {
                console.log('[DoorDash] Still have required options unfulfilled after auto-select');
                stopDebugScreenshots();
                return {
                    success: false,
                    needsOptions: true,
                    requiredOptions: stillRequired,
                    message: 'Please select required options'
                };
            }

            // Modal still open with no detected required options — check if add button says "Make X required selection"
            await takeScreenshot('modal-still-open');
            const addBtnText = await page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                if (!modal) return '';
                const btns = modal.querySelectorAll('button');
                for (const btn of btns) {
                    const t = btn.textContent?.trim() || '';
                    if (t.toLowerCase().includes('required selection') || t.toLowerCase().includes('make')) {
                        return t;
                    }
                }
                return '';
            });

            if (addBtnText) {
                // Button still says "Make X required selection" — extract options once more and surface them
                console.log(`[DoorDash] Add button says "${addBtnText.substring(0, 50)}" — surfacing options to user`);
                const finalOptions = await extractRequiredOptions();
                if (finalOptions.length > 0) {
                    stopDebugScreenshots();
                    return { success: false, needsOptions: true, requiredOptions: finalOptions, message: 'Please select required options' };
                }
            }

            stopDebugScreenshots();
            // Modal is still open and we couldn't add — return failure
            return { success: false, error: 'ITEM_NOT_ADDED', message: 'Could not add item to cart. The item may be unavailable or require options we could not detect.' };
        } else {
            // No modal opened. Verify the cart actually has items (the click may have been
            // absorbed by a CF Turnstile overlay which intercepts all pointer events).
            await delay(800);
            const cartCount = await page.evaluate(() => {
                const btn = document.querySelector('[data-anchor-id="HeaderOrderCart"]');
                const match = (btn?.textContent || btn?.getAttribute('aria-label') || '').match(/(\d+)\s*item/i);
                return match ? parseInt(match[1]) : 0;
            });
            console.log(`[DoorDash] No modal detected. Cart item count: ${cartCount}`);
            if (cartCount === 0) {
                // Check if CF overlay was blocking (must be visible, not just present in DOM)
                const cfOverlay = await page.evaluate(() => {
                    const el = document.querySelector('[data-testid="turnstile/overlay"]');
                    if (!el) return false;
                    const s = window.getComputedStyle(el);
                    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
                }).catch(() => false);
                if (cfOverlay) {
                    console.log('[DoorDash] CF overlay still present — hiding and retrying with CDP click...');
                    const retryCoords = await page.evaluate((name) => {
                        document.querySelectorAll('[data-testid="turnstile/overlay"]').forEach(el => {
                            el.style.pointerEvents = 'none';
                            el.style.display = 'none';
                        });
                        // Find item again and return its center coords
                        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                        let node;
                        while ((node = walker.nextNode())) {
                            if (node.textContent.trim().toLowerCase() === name.toLowerCase()) {
                                let el = node.parentElement;
                                for (let i = 0; i < 6; i++) {
                                    const r = el.getBoundingClientRect();
                                    if (r.width > 100 && r.height > 50) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                                    el = el.parentElement;
                                    if (!el) break;
                                }
                            }
                        }
                        return null;
                    }, searchName);
                    await delay(300);
                    if (retryCoords) {
                        await page.mouse.click(retryCoords.x, retryCoords.y);
                    } else {
                        await page.locator(`text="${searchName}"`).first().click({ timeout: 5000 }).catch(() => {});
                    }
                    await delay(1500);
                    const modalAfterRetry = await page.$('[role="dialog"], [aria-modal="true"]');
                    if (modalAfterRetry) {
                        console.log('[DoorDash] Modal opened after CF cleared — needs options');
                        const requiredOpts = await extractRequiredOptions();
                        stopDebugScreenshots();
                        return { success: false, needsOptions: true, requiredOptions: requiredOpts, message: 'This item has required options' };
                    }
                    const cartCountAfter = await page.evaluate(() => {
                        const btn = document.querySelector('[data-anchor-id="HeaderOrderCart"]');
                        const match = (btn?.textContent || btn?.getAttribute('aria-label') || '').match(/(\d+)\s*item/i);
                        return match ? parseInt(match[1]) : 0;
                    });
                    if (cartCountAfter === 0) {
                        stopDebugScreenshots();
                        return { success: false, error: 'CF overlay blocked item add — try again' };
                    }
                } else {
                    // No CF overlay and cart still empty — click didn't register or item needs a modal
                    // we didn't detect. Try one more wait + check before giving up.
                    await delay(1500);
                    const cartCountRetry = await page.evaluate(() => {
                        const btn = document.querySelector('[data-anchor-id="HeaderOrderCart"]');
                        const match = (btn?.textContent || btn?.getAttribute('aria-label') || '').match(/(\d+)\s*item/i);
                        return match ? parseInt(match[1]) : 0;
                    });
                    if (cartCountRetry === 0) {
                        // Check if a modal appeared late
                        const lateModal = await page.$('[role="dialog"], [aria-modal="true"]');
                        if (lateModal) {
                            console.log('[DoorDash] Late modal detected — needs options');
                            const requiredOpts = await extractRequiredOptions();
                            stopDebugScreenshots();
                            return { success: false, needsOptions: true, requiredOptions: requiredOpts, message: 'This item has required options' };
                        }
                        console.log('[DoorDash] Cart still empty after retry — item was not added');
                        stopDebugScreenshots();
                        return { success: false, error: 'ITEM_NOT_ADDED', message: 'Item was not added to cart. It may require options or the click did not register.' };
                    }
                }
            }
            console.log('[DoorDash] No modal detected - item added directly to cart');
            await takeScreenshot('no-modal-direct-add');
            stopDebugScreenshots();
            return { success: true, message: 'Item added to cart (no customization needed)' };
        }

    } catch (error) {
        console.error('[DoorDash] Add item error:', error.message);
        stopDebugScreenshots();
        // Chrome crashed — reset browser state so next call gets a fresh session
        if (error.message.includes('Target crashed') || error.message.includes('Session closed') || error.message.includes('Target page, context or browser has been closed')) {
            console.log('[DoorDash] Browser crashed — resetting session');
            try { await closeBrowser(); } catch (e) {}
            context = null; page = null;
            resetSessionState();
        }
        return { success: false, error: error.message };
    }
}

/**
 * Extract required options from the item modal
 * Looks for protein/size choices displayed as a list
 */
async function extractRequiredOptions() {
    try {
        await takeScreenshot('extracting-options');
        console.log('[DoorDash] Extracting REQUIRED options only (ignoring optional sections)...');

        // DoorDash modal structure:
        // - Section headers like "Proteins", "Tortillas" with subtitles like "2 Required • Select 1" or "Optional"
        // - We ONLY want sections marked as "Required"
        // - Ignore sections marked "Optional"
        // - Ignore "Recommended" or "Top Recommended" sections (cross-selling)

        const optionGroups = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!modal) return [];

            const groups = [];

            // Find all section containers in the modal
            // DoorDash sections typically have a header with the section name and a subtitle with "Required" or "Optional"
            const allDivs = modal.querySelectorAll('div');

            for (const div of allDivs) {
                const text = div.textContent || '';
                const lowerText = text.toLowerCase();

                // Skip if this is a "Recommended" section (cross-selling)
                if (lowerText.includes('recommended') || lowerText.includes('you may also like')) {
                    continue;
                }

                // Check if this div contains "Required" indicator
                // DoorDash shows "X Required • Select 1" for required sections
                const hasRequired = lowerText.includes('required') &&
                                   (lowerText.includes('select 1') || lowerText.includes('select one'));

                // Skip if it's marked as Optional
                const isOptional = lowerText.includes('optional');

                if (!hasRequired || isOptional) continue;

                // This might be a required section - try to extract its name and options
                // The section name is usually in a child element at the start
                const rect = div.getBoundingClientRect();

                // Skip if too small or too large (not a section container)
                if (rect.height < 50 || rect.height > 500 || rect.width < 200) continue;

                // Try to find the section header name
                let sectionName = '';
                const headings = div.querySelectorAll('h1, h2, h3, h4, span, div');
                for (const h of headings) {
                    const hText = h.textContent?.trim() || '';
                    const hRect = h.getBoundingClientRect();

                    // Section name is usually short and at the top of the section
                    if (hText.length > 2 && hText.length < 30 &&
                        !hText.toLowerCase().includes('required') &&
                        !hText.toLowerCase().includes('select') &&
                        !hText.toLowerCase().includes('optional') &&
                        hRect.top >= rect.top && hRect.top < rect.top + 50) {

                        // Check if this looks like a section name (Proteins, Tortillas, Beans, etc.)
                        const validNames = ['protein', 'tortilla', 'beans', 'rice', 'size', 'style',
                                           'meat', 'filling', 'base', 'dressing', 'sauce', 'type'];
                        const isValidName = validNames.some(n => hText.toLowerCase().includes(n)) ||
                                           hText.match(/^[A-Z][a-z]+(\s+[A-Z]?[a-z]+)?$/); // Capitalized word(s)

                        if (isValidName) {
                            sectionName = hText;
                            break;
                        }
                    }
                }

                if (!sectionName) continue;

                // Check if we already have this section
                if (groups.some(g => g.name.toLowerCase() === sectionName.toLowerCase())) continue;

                // Now find the options within this section
                const options = [];
                const seen = new Set();

                // Look for radio-like elements or option labels
                const optionEls = div.querySelectorAll('[role="radio"], label, [class*="radio"], [class*="option"]');

                for (const opt of optionEls) {
                    let optText = '';

                    // Get direct text or first meaningful text
                    const spans = opt.querySelectorAll('span, div');
                    for (const s of spans) {
                        const sText = s.textContent?.trim() || '';
                        // Skip if it's just "Required" or similar
                        if (sText.length > 3 && sText.length < 80 &&
                            !sText.toLowerCase().includes('required') &&
                            !sText.toLowerCase().includes('select') &&
                            !sText.toLowerCase().includes('optional') &&
                            !sText.match(/^\d+\s*cal/i) &&
                            !sText.match(/^\+?\$\d/)) {
                            optText = sText;
                            break;
                        }
                    }

                    if (!optText) {
                        optText = opt.textContent?.trim() || '';
                    }

                    // Clean up option text
                    optText = optText.split(/\d+\s*cal/i)[0].trim();
                    optText = optText.replace(/\+?\$[\d.]+/g, '').trim();
                    optText = optText.replace(/Includes customization/gi, '').trim();
                    optText = optText.replace(/\bEdit selection\b/gi, '').trim();
                    optText = optText.replace(/\s*•\s*.+$/, '').trim(); // strip " • Medium Dr Pepper®" etc.

                    // Skip if too short, too long, or already seen
                    if (optText.length < 3 || optText.length > 60) continue;
                    if (seen.has(optText.toLowerCase())) continue;
                    if (optText.toLowerCase().includes('required')) continue;

                    seen.add(optText.toLowerCase());

                    // Check if selected
                    const isSelected = opt.getAttribute('aria-checked') === 'true' ||
                                      opt.classList.contains('selected');

                    options.push({ name: optText, selected: isSelected });
                }

                if (options.length > 0) {
                    groups.push({
                        name: sectionName,
                        options: options.map(o => o.name),
                        required: true,
                        hasSelection: options.some(o => o.selected)
                    });
                }
            }

            return groups;
        });

        console.log(`[DoorDash] Found ${optionGroups.length} REQUIRED option groups`);
        optionGroups.forEach(g => {
            console.log(`  - ${g.name}: ${g.options.length} options, hasSelection: ${g.hasSelection}`);
        });

        await takeScreenshot('options-extracted');

        // Check add button to see how many required selections are needed
        const requiredCount = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!modal) return 0;
            for (const btn of modal.querySelectorAll('button')) {
                const t = btn.textContent?.trim() || '';
                const m = t.match(/make\s+(\d+)\s+required/i);
                if (m) return parseInt(m[1], 10);
            }
            return 0;
        }).catch(() => 0);

        if (requiredCount > 0) {
            console.log(`[DoorDash] Add button says ${requiredCount} required selections needed, structured found ${optionGroups.length}`);
        }

        // If structured approach found fewer groups than required (or none), use broad extraction
        if (optionGroups.length === 0 || (requiredCount > 0 && optionGroups.length < requiredCount)) {
            if (optionGroups.length === 0) {
                console.log('[DoorDash] Structured extraction found 0 groups — dumping modal HTML and trying broad extraction...');
            } else {
                console.log(`[DoorDash] Structured found ${optionGroups.length} but need ${requiredCount} — using broad extraction...`);
            }

            // Dump modal HTML to file for inspection
            const modalHtml = await page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                return modal ? modal.innerHTML : 'NO MODAL FOUND';
            });
            const htmlPath = path.join(BROWSER_DATA_DIR, 'modal-debug.html');
            fs.writeFileSync(htmlPath, modalHtml);
            console.log(`[DoorDash] Modal HTML saved to: ${htmlPath}`);

            // Broad extraction: find ALL radiogroups and groups with "Required" anywhere
            const broadGroups = await page.evaluate((reqCount) => {
                const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                if (!modal) return [];

                const groups = [];
                const seen = new Set();

                // Strategy A: Find [role="radiogroup"] elements — the most reliable indicator
                const radioGroups = modal.querySelectorAll('[role="radiogroup"], [role="group"]');
                for (const rg of radioGroups) {
                    // Check header area for "optional" — look at heading's parent to catch sibling "(Optional)" spans
                    const labelId = rg.getAttribute('aria-labelledby');
                    const labelEl = labelId ? document.getElementById(labelId) : null;
                    const headingEl = rg.querySelector('h1,h2,h3,h4,legend');
                    const rgHeaderText = (labelEl?.textContent || headingEl?.parentElement?.textContent || headingEl?.textContent || '').toLowerCase();
                    if (rgHeaderText.includes('optional')) continue;

                    // Find the group's label/name — prefer aria-labelledby or own heading (most reliable)
                    let groupName = (labelEl?.textContent || rg.querySelector('h1,h2,h3,h4,h5,legend')?.textContent || '').trim();
                    if (!groupName || groupName.length > 50) {
                        const prev = rg.previousElementSibling;
                        const prevText = prev?.textContent?.trim() || '';
                        if (prevText && prevText.length <= 50) groupName = prevText;
                    }
                    if (!groupName || groupName.length > 50) {
                        const parent = rg.parentElement;
                        if (parent) {
                            const heading = parent.querySelector('h1,h2,h3,h4,h5,span,p');
                            if (heading) groupName = heading.textContent?.trim()?.split('\n')[0] || '';
                        }
                    }
                    if (!groupName) continue; // skip groups with no detectable name
                    // Trim noise from name
                    groupName = groupName.split(/required|select|choose|pick|\d+\s*cal/i)[0].trim();
                    if (groupName.length > 40) groupName = groupName.substring(0, 40);
                    if (!groupName) continue;
                    // Skip UI elements that aren't option groups (e.g. "4 photos", "See more")
                    if (/^\d+\s+(photo|image|pic|review)/i.test(groupName)) continue;
                    if (/^see\s+more/i.test(groupName)) continue;
                    if (seen.has(groupName.toLowerCase())) continue;

                    // Extract options: radios, checkboxes, list items inside this group
                    const optEls = rg.querySelectorAll('[role="radio"], [role="checkbox"], [role="button"], input[type="radio"], input[type="checkbox"], li, label');
                    const options = [];
                    const optSeen = new Set();
                    for (const opt of optEls) {
                        let txt = opt.getAttribute('aria-label') || opt.textContent?.trim() || '';
                        // Clean price and calorie info for display
                        txt = txt.split(/\d{2,4}\s*cal/i)[0].trim();
                        txt = txt.replace(/\s*\(\+?\$[\d.]+\)\s*/g, match => match); // keep price suffix
                        if (txt.length < 2 || txt.length > 80) continue;
                        if (/^[\d$+\s]+$/.test(txt)) continue; // skip pure numbers/prices
                        if (optSeen.has(txt.toLowerCase())) continue;
                        optSeen.add(txt.toLowerCase());
                        options.push(txt);
                    }
                    // Stepper-type groups (e.g. Sauce) use IncrementQuantity buttons instead of radio/checkbox
                    if (options.length === 0) {
                        const stepperBtns = rg.querySelectorAll('[data-anchor-id="IncrementQuantity"]');
                        for (const btn of stepperBtns) {
                            // Walk up to find the item container, then find the name span
                            let container = btn.parentElement;
                            for (let i = 0; i < 4 && container; i++) {
                                const nameEl = container.querySelector('span');
                                if (nameEl) {
                                    let txt = nameEl.textContent?.trim() || '';
                                    txt = txt.split(/\d{2,4}\s*cal/i)[0].trim();
                                    if (txt.length > 1 && txt.length < 80 && !/^[\d$+\s]+$/.test(txt) && !optSeen.has(txt.toLowerCase())) {
                                        optSeen.add(txt.toLowerCase());
                                        options.push(txt);
                                        break;
                                    }
                                }
                                container = container.parentElement;
                            }
                        }
                    }
                    if (options.length === 0) continue;

                    // Check selection: aria-checked OR input:checked OR label[for]→input.checked
                    // Also check stepper groups: any IncrementQuantity sibling with decrement visible (qty > 0)
                    const isSelected = rg.querySelector('[aria-checked="true"]') !== null ||
                        Array.from(rg.querySelectorAll('label[for]')).some(l => {
                            const inp = document.getElementById(l.htmlFor);
                            return inp && inp.checked;
                        }) ||
                        rg.querySelector('input:checked') !== null ||
                        rg.querySelector('[data-anchor-id="DecrementQuantity"]') !== null;
                    seen.add(groupName.toLowerCase());
                    groups.push({ name: groupName, options: options, required: true, hasSelection: isSelected, isStepperType: options.length > 0 && rg.querySelectorAll('[data-anchor-id="IncrementQuantity"]').length > 0 });
                }

                // Strategy B: Look for divs that contain "Required" text (looser than before)
                // Also runs when Strategy A found fewer groups than the button indicates are required
                if (groups.length === 0 || groups.length < reqCount) {
                    const allDivs = modal.querySelectorAll('div, section, fieldset');
                    for (const div of allDivs) {
                        const ownText = Array.from(div.childNodes)
                            .filter(n => n.nodeType === Node.TEXT_NODE)
                            .map(n => n.textContent.trim()).join(' ').toLowerCase();
                        const divText = div.textContent?.toLowerCase() || '';

                        // Must mention "required" somewhere in it
                        if (!divText.includes('required')) continue;
                        const isOptional = divText.includes('optional');
                        if (isOptional) continue;

                        const rect = div.getBoundingClientRect();
                        if (rect.height < 60 || rect.height > 600 || rect.width < 200) continue;

                        // Get a name from first short text element
                        let groupName = '';
                        const children = div.querySelectorAll('span, p, h1, h2, h3, h4, h5, div');
                        for (const ch of children) {
                            const t = ch.textContent?.trim() || '';
                            if (t.length > 2 && t.length < 40 && !t.toLowerCase().includes('required') &&
                                !t.toLowerCase().includes('select') && !t.toLowerCase().includes('optional')) {
                                groupName = t;
                                break;
                            }
                        }
                        if (!groupName || seen.has(groupName.toLowerCase())) continue;

                        // Extract options from radio/checkbox inputs or li elements
                        const optEls = div.querySelectorAll('[role="radio"], [role="checkbox"], input[type="radio"], li, label');
                        const options = [];
                        const optSeen = new Set();
                        for (const opt of optEls) {
                            let txt = opt.getAttribute('aria-label') || opt.textContent?.trim() || '';
                            txt = txt.split(/\d{2,4}\s*cal/i)[0].trim();
                            if (txt.length < 2 || txt.length > 80) continue;
                            if (/^[\d$+\s]+$/.test(txt)) continue;
                            if (optSeen.has(txt.toLowerCase())) continue;
                            optSeen.add(txt.toLowerCase());
                            options.push(txt);
                        }
                        if (options.length === 0) continue;

                        const isSelected = div.querySelector('[aria-checked="true"]') !== null ||
                            Array.from(div.querySelectorAll('label[for]')).some(l => { const inp = document.getElementById(l.htmlFor); return inp && inp.checked; }) ||
                            div.querySelector('input:checked') !== null;
                        seen.add(groupName.toLowerCase());
                        groups.push({ name: groupName, options: options.slice(0, 10), required: true, hasSelection: isSelected });
                    }
                }

                return groups;
            }, requiredCount);

            if (broadGroups.length > 0) {
                console.log(`[DoorDash] Broad extraction found ${broadGroups.length} groups`);
                broadGroups.forEach(g => console.log(`  - ${g.name}: [${g.options.slice(0,3).join(', ')}...]`));
                const unselected = broadGroups.filter(g => !g.hasSelection);
                return unselected.length > 0 ? unselected : broadGroups;
            }

            console.log('[DoorDash] No required options found — item may not need options');
            return [];
        }

        // Filter to only unselected groups
        const unselectedGroups = optionGroups.filter(g => !g.hasSelection);
        return unselectedGroups.length > 0 ? unselectedGroups : optionGroups;

    } catch (error) {
        console.error('[DoorDash] Extract options error:', error.message);
        await takeScreenshot('extract-options-error');
        return [];
    }
}

/**
 * OLD extractRequiredOptions - keeping for reference
 */
async function extractRequiredOptionsOld() {
    try {
        const options = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!modal) return [];

            const choices = [];
            const seen = new Set();

            const SKIP_WORDS = [
                'order', 'review', 'close', 'back', 'cart', 'add to', 'make', 'select',
                'required', 'optional', 'instruction', 'preference', 'quantity',
                'increase', 'decrease', 'remove', 'edit', 'save', 'cancel'
            ];

            const shouldSkip = (text) => {
                const lower = text.toLowerCase();
                if (lower.length < 4 || lower.length > 50) return true;
                if (SKIP_WORDS.some(w => lower.includes(w))) return true;
                if (/^\d+$/.test(lower)) return true;
                if (lower.includes('review')) return true;
                return false;
            };

            const allElements = modal.querySelectorAll('div, span, button, label');

            for (const el of allElements) {
                let text = '';
                for (const node of el.childNodes) {
                    if (node.nodeType === Node.TEXT_NODE) {
                        text += node.textContent.trim() + ' ';
                    }
                }
                text = text.trim();

                if (!text && el.childNodes.length <= 3) {
                    text = el.textContent.trim();
                }

                if (!text || shouldSkip(text)) continue;

                const foodWords = ['burrito', 'chicken', 'pork', 'steak', 'beef', 'shrimp', 'fish',
                                   'salad', 'bowl', 'taco', 'quesadilla', 'rice', 'beans', 'cheese',
                                   'veggie', 'carnitas', 'barbacoa', 'chipotle', 'honey', 'grilled',
                                   'small', 'regular', 'large', 'medium', 'tortilla', 'flour', 'corn'];

                const lower = text.toLowerCase();
                const looksLikeFood = foodWords.some(w => lower.includes(w));

                if (looksLikeFood && !seen.has(lower)) {
                    seen.add(lower);

                    let name = text
                        .split(/\d+\s*-?\s*\d*\s*cal/i)[0]
                        .split(/\+?\$\d/)[0]
                        .trim();

                    const fullText = el.textContent || '';
                    const priceMatch = fullText.match(/\+?\$(\d+\.?\d*)/);

                    if (name && name.length >= 4 && name.length <= 45) {
                        choices.push({
                            name: name,
                            price: priceMatch ? `$${priceMatch[1]}` : ''
                        });
                    }
                }
            }

            return choices;
        });

        console.log(`[DoorDash] Found ${options.length} food choices:`, options.map(o => o.name));

        if (options.length > 0) {
            return [{
                name: 'Choose Your Protein',
                options: options.map(o => o.price ? `${o.name} (${o.price})` : o.name),
                required: true
            }];
        }

        return [];
    } catch (error) {
        console.error('[DoorDash] Extract options error:', error.message);
        return [];
    }
}

/**
 * Clear pre-selected options from previous orders
 * DoorDash remembers your last customizations - this resets them to show all options fresh
 */
async function clearPreSelectedOptions() {
    try {
        console.log('[DoorDash] Checking for pre-selected options from previous orders...');

        const cleared = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!modal) return { found: false };

            let clearedCount = 0;

            // Strategy 1: Look for "Customize" or "Edit" buttons that reset options
            const buttons = modal.querySelectorAll('button, [role="button"], a');
            for (const btn of buttons) {
                const text = btn.textContent?.toLowerCase()?.trim() || '';
                if (text === 'customize' || text === 'edit' || text === 'change' ||
                    text.includes('customize item') || text.includes('edit item')) {
                    console.log('[ClearOptions] Found customize button:', text);
                    btn.click();
                    return { found: true, action: 'customize-button', text };
                }
            }

            // Strategy 2: Just log pre-selected options (don't click them — causes modal disruption)
            const selectedRadios = modal.querySelectorAll('[role="radio"][aria-checked="true"]');
            if (selectedRadios.length > 0) {
                console.log('[ClearOptions] Found', selectedRadios.length, 'pre-selected options (leaving them — will be overridden by user selection)');
            }

            // Strategy 3: Look for "Includes customization" text which indicates saved options
            const allText = modal.textContent?.toLowerCase() || '';
            if (allText.includes('includes customization') || allText.includes('last ordered')) {
                // Find and click any element that might expand options
                const expandable = modal.querySelectorAll('[aria-expanded="false"], [class*="expand"], [class*="collapse"]');
                for (const el of expandable) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 50 && rect.height > 20) {
                        el.click();
                        clearedCount++;
                    }
                }
                return { found: true, action: 'expanded-sections', count: clearedCount };
            }

            return { found: false };
        });

        if (cleared.found) {
            console.log(`[DoorDash] Cleared pre-selected options: ${JSON.stringify(cleared)}`);
            await delay(800); // Wait for UI to update after clearing
            await takeScreenshot('after-clear-preselected');
        } else {
            console.log('[DoorDash] No pre-selected options found');
        }

    } catch (error) {
        console.error('[DoorDash] Clear pre-selected options error:', error.message);
    }
}

/**
 * Auto-select the first option in each required group
 */
async function autoSelectFirstOptions() {
    try {
        await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!modal) return;

            // Find all unselected radio buttons and click the first one in each group
            const radioGroups = modal.querySelectorAll('[role="radiogroup"], fieldset');

            for (const group of radioGroups) {
                const unchecked = group.querySelector('[role="radio"][aria-checked="false"], input[type="radio"]:not(:checked)');
                if (unchecked) {
                    unchecked.click();
                }
            }

            // Also try clicking any unselected required options
            const unselectedRadios = modal.querySelectorAll('[role="radio"][aria-checked="false"]');
            if (unselectedRadios.length > 0) {
                unselectedRadios[0].click();
            }
        });
        await delay(500);
    } catch (error) {
        console.error('[DoorDash] Auto-select error:', error.message);
    }
}

/**
 * Auto-select ALL required options in the modal
 * This handles DoorDash's multi-section required options
 */
async function autoSelectAllRequiredOptions() {
    try {
        console.log('[DoorDash] Auto-selecting remaining required options...');
        await takeScreenshot('before-auto-select-all');

        // Scroll modal bottom→top to trigger lazy loading of all sections
        await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (modal) { modal.scrollTop = modal.scrollHeight; }
        });
        await delay(300);
        await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (modal) modal.scrollTop = 0;
        });
        await delay(300);

        // Count-feedback approach: iterate ALL groups, click each one, keep it only if
        // the required count decreases. This works regardless of pre-selected state,
        // optional vs required detection, or element type (label/radio/[role="radio"]).
        const getCount = async () => page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!modal) return 0;
            for (const btn of modal.querySelectorAll('button')) {
                const m = (btn.textContent || '').match(/make\s+(\d+)\s+required/i);
                if (m) return parseInt(m[1]);
            }
            return 0;
        }).catch(() => 0);

        const numGroups = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            return modal ? modal.querySelectorAll('[role="radiogroup"], [role="group"]').length : 0;
        });

        let remaining = await getCount();
        console.log(`[DoorDash] AutoSelect: ${remaining} required selections, ${numGroups} groups in modal`);

        // Diagnostic: log structure of each group
        const groupDiag = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!modal) return [];
            return Array.from(modal.querySelectorAll('[role="radiogroup"], [role="group"]')).map((g, i) => {
                const labelId = g.getAttribute('aria-labelledby');
                const labelEl = labelId ? document.getElementById(labelId) : null;
                const heading = g.querySelector('h1,h2,h3,h4,legend');
                const name = (labelEl?.textContent || heading?.textContent || g.getAttribute('aria-label') || '').trim().substring(0, 40);
                return {
                    i,
                    role: g.getAttribute('role'),
                    name,
                    labels: g.querySelectorAll('label').length,
                    roleRadios: g.querySelectorAll('[role="radio"]').length,
                    inputs: g.querySelectorAll('input[type="radio"],input[type="checkbox"]').length
                };
            });
        }).catch(() => []);
        groupDiag.forEach(g => console.log(`[DoorDash] Group[${g.i}] role=${g.role} name="${g.name}" labels=${g.labels} roleRadios=${g.roleRadios} inputs=${g.inputs}`));

        if (remaining === 0) {
            console.log('[DoorDash] No required selections needed');
            await takeScreenshot('after-auto-select-all');
            return 0;
        }

        const modalLoc = page.locator('[role="dialog"], [aria-modal="true"]').first();

        for (let gIdx = 0; gIdx < numGroups && remaining > 0; gIdx++) {
            const group = modalLoc.locator('[role="radiogroup"], [role="group"]').nth(gIdx);

            // Get clickable target: prefer label, then [role="radio"], then stepper button, skip if none
            const targetInfo = await page.evaluate((idx) => {
                const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                if (!modal) return null;
                const groups = modal.querySelectorAll('[role="radiogroup"], [role="group"]');
                const grp = groups[idx];
                if (!grp) return null;
                // Try label, then [role="radio"], then [role="button"], then input, then stepper
                const label = grp.querySelector('label');
                const radio = grp.querySelector('[role="radio"]');
                const roleBtn = grp.querySelector('[role="button"]');
                const input = grp.querySelector('input[type="radio"],input[type="checkbox"]');
                const stepper = grp.querySelector('[data-anchor-id="IncrementQuantity"]');
                // Only use stepper as last resort — it increments quantity rather than selecting
                const target = label || radio || roleBtn || input || stepper;
                if (!target) return null;
                target.scrollIntoView({ block: 'center', inline: 'nearest' });
                const rect = target.getBoundingClientRect();
                return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: (target.textContent || target.getAttribute('aria-label') || '').trim().substring(0, 40), isStepper: !!stepper && !label && !radio && !roleBtn && !input };
            }, gIdx);

            if (!targetInfo) continue;

            console.log(`[DoorDash] AutoSelect[${gIdx}]: trying "${targetInfo.text}"${targetInfo.isStepper ? ' (stepper)' : ''}`);
            await delay(200);

            // Try Playwright locator click: label first, then [role="radio"], then input, then stepper
            let clickOk = false;
            try {
                const labelLoc = group.locator('label').first();
                const radioLoc = group.locator('[role="radio"]').first();
                const inputLoc = group.locator('input[type="radio"],input[type="checkbox"]').first();
                const stepperLoc = group.locator('[data-anchor-id="IncrementQuantity"]').first();
                let target = null;
                const roleBtnLoc = group.locator('[role="button"]').first();
                if (await labelLoc.count() > 0) target = labelLoc;
                else if (await radioLoc.count() > 0) target = radioLoc;
                else if (await roleBtnLoc.count() > 0) target = roleBtnLoc;
                else if (await inputLoc.count() > 0) target = inputLoc;
                else if (await stepperLoc.count() > 0) target = stepperLoc;
                if (target) {
                    await target.scrollIntoViewIfNeeded({ timeout: 2000 });
                    await delay(200);
                    await target.click({ timeout: 4000 });
                    clickOk = true;
                }
            } catch (e) {
                // Fall through to coordinate click
            }

            if (!clickOk && targetInfo.x && targetInfo.y) {
                await page.mouse.click(targetInfo.x, targetInfo.y);
                clickOk = true;
            }

            if (!clickOk) continue;

            await delay(500);
            const newCount = await getCount();
            if (newCount < remaining) {
                console.log(`[DoorDash] AutoSelect[${gIdx}]: registered! (${remaining} → ${newCount})`);
                remaining = newCount;
            } else {
                console.log(`[DoorDash] AutoSelect[${gIdx}]: no change (optional or already handled)`);
            }
        }

        console.log(`[DoorDash] AutoSelect done — remaining required: ${remaining}`);
        await takeScreenshot('after-auto-select-all');
        return remaining;
    } catch (error) {
        console.error('[DoorDash] Auto-select all error:', error.message);
        return 0;
    }
}

/**
 * Apply user's option selections using Playwright's native locator.click()
 * which properly fires real pointer events that React's event system handles.
 * @param {Array} selections - Array of { groupIndex, optionIndex, optionText }
 */
async function applyOptionSelections(selections) {
    try {
        console.log('[DoorDash] Applying option selections:', JSON.stringify(selections));
        await takeScreenshot('before-apply-selections');

        startDebugScreenshots(3000);

        const modal = page.locator('[role="dialog"], [aria-modal="true"]').first();

        // DEBUG: dump actual modal option structure
        const debugHtml = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!modal) return 'no modal';
            const optItems = modal.querySelectorAll('[data-anchor-id="OptionItem"]');
            if (optItems.length > 0) {
                const first = optItems[0];
                const attrs = Array.from(first.attributes).map(a => `${a.name}="${a.value}"`).join(' ');
                return `OptionItems: ${optItems.length}. First: tag=${first.tagName} attrs=[${attrs}] text="${first.textContent?.trim().substring(0,60)}" html=${first.outerHTML.substring(0,300)}`;
            }
            const rg = modal.querySelector('[role="radiogroup"], [role="group"]');
            if (rg) {
                // Also find and dump the first child option element
                const children = rg.querySelectorAll('li, label, [class*="option"], [class*="Option"]');
                const firstChild = children[0];
                const firstChildHtml = firstChild ? `FIRST_OPTION: tag=${firstChild.tagName} attrs=[${Array.from(firstChild.attributes).map(a=>`${a.name}=${a.value}`).join(' ')}] html=${firstChild.outerHTML.substring(0,300)}` : 'no li/label children';
                return 'RADIOGROUP (no OptionItems): ' + rg.outerHTML.substring(0, 800) + ' || ' + firstChildHtml;
            }
            return `no OptionItems or radiogroup. Modal innerHTML (first 500): ${modal.innerHTML.substring(0, 500)}`;
        });
        console.log('[DEBUG] Modal structure:', debugHtml);

        // Helper: parse "Make N required selections" count from add button text
        // Returns 0 when button says "Add to Order" (all required filled)
        const getRequiredCount = async () => {
            return Promise.race([
                page.evaluate(() => {
                    const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                    if (!modal) return 0;
                    for (const btn of modal.querySelectorAll('button')) {
                        const m = (btn.textContent || '').match(/make\s+(\d+)\s+required/i);
                        if (m) return parseInt(m[1]);
                    }
                    return 0;
                }),
                new Promise(resolve => setTimeout(() => resolve(999), 5000))
            ]);
        };

        for (const sel of selections) {
            console.log(`[DoorDash] Processing selection: group=${sel.groupIndex}, option=${sel.optionIndex}, text="${sel.optionText || 'N/A'}"`);

            const groupCount = await page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                if (!modal) return 0;
                return modal.querySelectorAll('[role="radiogroup"], [role="group"]').length;
            });
            console.log(`[DoorDash] Modal has ${groupCount} option groups`);

            if (sel.groupIndex >= groupCount) {
                console.log(`[DoorDash] Group ${sel.groupIndex} not found`);
                continue;
            }

            const beforeCount = await getRequiredCount();
            console.log(`[DoorDash] Required selections before click: ${beforeCount}`);

            const optText = sel.optionText || null;
            const optIdx = sel.optionIndex || 0;
            let clicked = false;

            // Strategy 1: Playwright locator click on label scoped to the correct group
            // This uses Playwright's built-in scroll + real pointer events
            try {
                const modalLoc = page.locator('[role="dialog"], [aria-modal="true"]').first();
                const group = modalLoc.locator('[role="radiogroup"], [role="group"]').nth(sel.groupIndex);
                let label;
                if (optText) {
                    label = group.locator('label').filter({ hasText: new RegExp('^' + optText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
                } else {
                    label = group.locator('label').nth(optIdx);
                }
                const labelCount = await label.count();
                if (labelCount > 0) {
                    console.log(`[DoorDash] Strategy 1: Playwright locator click on label`);
                    await label.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                    await delay(300);
                    await label.click({ timeout: 5000, force: true }).catch(async () => {
                        await label.click({ timeout: 3000 }).catch(() => {});
                    });
                    await delay(600);
                    const afterCount = await getRequiredCount();
                    if (afterCount < beforeCount || (beforeCount === 0 && afterCount === 0)) {
                        console.log(`[DoorDash] Locator click registered! (${beforeCount} → ${afterCount} required)`);
                        clicked = true;
                    } else {
                        console.log(`[DoorDash] Locator click did not register (still ${afterCount} required)`);
                    }
                } else {
                    // Strategy 1b: stepper-type group — click IncrementQuantity button for matching item
                    const stepperBtns = group.locator('[data-anchor-id="IncrementQuantity"]');
                    const stepperCount = await stepperBtns.count();
                    if (stepperCount > 0) {
                        // Find the stepper button whose sibling text matches optText, or use optIdx
                        let targetStepper = null;
                        if (optText) {
                            for (let si = 0; si < stepperCount; si++) {
                                const btn = stepperBtns.nth(si);
                                const container = btn.locator('..').locator('..');
                                const spanText = await container.locator('span').first().textContent({ timeout: 2000 }).catch(() => '');
                                if (spanText.toLowerCase().includes(optText.toLowerCase())) {
                                    targetStepper = btn;
                                    break;
                                }
                            }
                        }
                        if (!targetStepper) targetStepper = stepperBtns.nth(Math.min(optIdx, stepperCount - 1));
                        console.log(`[DoorDash] Strategy 1b: stepper IncrementQuantity click`);
                        await targetStepper.scrollIntoViewIfNeeded({ timeout: 3000 });
                        await delay(300);
                        await targetStepper.click({ timeout: 5000 });
                        await delay(600);
                        const afterCount = await getRequiredCount();
                        if (afterCount < beforeCount || (beforeCount === 0 && afterCount === 0)) {
                            console.log(`[DoorDash] Stepper click registered! (${beforeCount} → ${afterCount} required)`);
                            clicked = true;
                        } else {
                            console.log(`[DoorDash] Stepper click did not register (still ${afterCount} required)`);
                        }
                    }
                }
            } catch (e) {
                console.log(`[DoorDash] Strategy 1 error:`, e.message.substring(0, 200));
            }

            // Strategy 2: coordinate click after scrollIntoView — logs elementFromPoint for overlay diagnosis
            if (!clicked) {
                const coords = await page.evaluate(({ groupIdx, optText, optIdx }) => {
                    const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                    if (!modal) return null;
                    const groups = modal.querySelectorAll('[role="radiogroup"], [role="group"]');
                    const group = groups[groupIdx];
                    if (!group) return null;
                    const labels = Array.from(group.querySelectorAll('label'));
                    const lower = (optText || '').toLowerCase();
                    let targetLabel = optText ? labels.find(l => (l.textContent || '').trim().toLowerCase().startsWith(lower)) : null;
                    if (!targetLabel) targetLabel = labels[Math.min(optIdx, labels.length - 1)];
                    if (!targetLabel) return null;
                    targetLabel.scrollIntoView({ block: 'center', inline: 'nearest' });
                    const rect = targetLabel.getBoundingClientRect();
                    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
                    const el = document.elementFromPoint(cx, cy);
                    return { x: cx, y: cy, tag: el?.tagName, cls: (el?.className || '').substring(0, 80) };
                }, { groupIdx: sel.groupIndex, optText, optIdx });
                if (coords) {
                    console.log(`[DoorDash] Strategy 2: mouse.click at (${Math.round(coords.x)}, ${Math.round(coords.y)}), elementAtPoint=${coords.tag}.${coords.cls}`);
                    await delay(200);
                    await page.mouse.click(coords.x, coords.y);
                    await delay(600);
                    const afterCount = await getRequiredCount();
                    if (afterCount < beforeCount) {
                        console.log(`[DoorDash] Coordinate click registered! (${beforeCount} → ${afterCount} required)`);
                        clicked = true;
                    }
                }
            }

            // Strategy 2b: click [role="radio"] ARIA element (DoorDash uses these instead of <input type="radio">)
            if (!clicked) {
                try {
                    const modalLoc = page.locator('[role="dialog"], [aria-modal="true"]').first();
                    const group = modalLoc.locator('[role="radiogroup"], [role="group"]').nth(sel.groupIndex);
                    const radioEls = group.locator('[role="radio"]');
                    const radioCount = await radioEls.count();
                    if (radioCount > 0) {
                        let target;
                        if (optText) {
                            const byText = group.locator('[role="radio"]').filter({ hasText: new RegExp(optText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
                            target = (await byText.count() > 0) ? byText : radioEls.nth(Math.min(optIdx, radioCount - 1));
                        } else {
                            target = radioEls.nth(Math.min(optIdx, radioCount - 1));
                        }
                        console.log(`[DoorDash] Strategy 2b: click [role="radio"] (${radioCount} found)`);
                        await target.scrollIntoViewIfNeeded({ timeout: 2000 });
                        await delay(200);
                        await target.click({ timeout: 4000 });
                        await delay(600);
                        const afterCount = await getRequiredCount();
                        if (afterCount < beforeCount || (beforeCount === 0 && afterCount === 0)) {
                            console.log(`[DoorDash] Strategy 2b registered! (${beforeCount} → ${afterCount})`);
                            clicked = true;
                        } else {
                            console.log(`[DoorDash] Strategy 2b no change (${afterCount} required)`);
                        }
                    }
                } catch (e) {
                    console.log(`[DoorDash] Strategy 2b error:`, e.message.substring(0, 100));
                }
            }

            // Strategy 3: force-click on radio input scoped to the modal group
            if (!clicked) {
                try {
                    const modalLoc = page.locator('[role="dialog"], [aria-modal="true"]').first();
                    const group = modalLoc.locator('[role="radiogroup"], [role="group"]').nth(sel.groupIndex);
                    const radio = group.locator('input[type="radio"]').nth(optIdx);
                    console.log(`[DoorDash] Strategy 3: force-click radio input`);
                    await radio.click({ force: true, timeout: 3000 });
                    await delay(600);
                    const afterCount = await getRequiredCount();
                    if (afterCount < beforeCount) {
                        console.log(`[DoorDash] Force-click registered! (${beforeCount} → ${afterCount} required)`);
                        clicked = true;
                    } else {
                        console.log(`[DoorDash] Force-click did not register, trying Space key`);
                        await radio.focus({ timeout: 2000 }).catch(() => {});
                        await page.keyboard.press('Space');
                        await delay(600);
                        const afterCount2 = await getRequiredCount();
                        if (afterCount2 < beforeCount) {
                            console.log(`[DoorDash] Space key registered!`);
                            clicked = true;
                        }
                    }
                } catch (e) {
                    console.log(`[DoorDash] Strategy 3 error:`, e.message.substring(0, 200));
                }
            }

            if (!clicked) {
                console.log(`[DoorDash] All strategies failed for "${optText}" in group ${sel.groupIndex}`);
            }

            await delay(400);
            await takeScreenshot('after-option-click');
        }

        await takeScreenshot('after-apply-selections');
    } catch (error) {
        console.error('[DoorDash] Apply selections error:', error.message);
        await takeScreenshot('apply-selections-error');
    }
}

/**
 * Click the "Add to Order" button in the modal
 * Returns true if successful (modal closed)
 */
async function clickAddToOrderButton() {
    console.log('[DoorDash] Looking for Add to Order button...');
    await takeScreenshot('looking-for-add-button');

    // Find the Add button and get its coordinates (don't click inside evaluate)
    const buttonCoords = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
        if (!modal) return { found: false, reason: 'no modal' };

        // Find all buttons in the modal
        const buttons = modal.querySelectorAll('button');
        console.log('[AddButton] Found ' + buttons.length + ' buttons in modal');

        // Look for the "Add to Order" or "Add to Cart" button
        for (const btn of buttons) {
            const text = btn.textContent?.trim() || '';
            const lowerText = text.toLowerCase();

            // Skip buttons that are clearly not the add button
            if (text.length > 100) continue;
            if (text.length < 3) continue;

            const hasAddWord = lowerText.includes('add to') || lowerText.includes('add for') || lowerText.includes('add (') || lowerText.includes('add -');
            const hasMakeOrSelect = lowerText.includes('make') || lowerText.includes('select') || lowerText.includes('required');
            const hasPrice = /\$\d+/.test(text);
            const rect = btn.getBoundingClientRect();
            const isWideButton = rect.width > 150;

            console.log('[AddButton] Checking:', text.substring(0, 50), 'hasAdd:', hasAddWord, 'hasPrice:', hasPrice);

            // "Add to Order - $X" / "Add for $X" / "Add - $X" → ready to add
            if (hasAddWord && !hasMakeOrSelect && hasPrice && isWideButton) {
                console.log('[AddButton] Found Add button:', text.substring(0, 50));
                return {
                    found: true,
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    text: text.substring(0, 50)
                };
            }
        }

        // Fallback: look for any wide button with a price (not "make/select/required")
        for (const btn of buttons) {
            const text = btn.textContent?.trim() || '';
            const lowerText = text.toLowerCase();
            const rect = btn.getBoundingClientRect();
            const hasPrice = /\$\d+/.test(text);
            const isWideButton = rect.width > 150;

            if (lowerText.includes('required')) continue;
            if (lowerText.includes('make')) continue;

            if (hasPrice && isWideButton && lowerText.includes('add')) {
                console.log('[AddButton] Fallback found:', text.substring(0, 50));
                return {
                    found: true,
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    text: text.substring(0, 50)
                };
            }
        }

        // Return all button texts for debugging
        const allBtnTexts = Array.from(buttons).map(b => b.textContent?.trim().substring(0, 60) || '').filter(t => t.length > 0);
        return { found: false, reason: 'no matching button found', allButtons: allBtnTexts };
    });

    console.log('[DoorDash] Add button result:', JSON.stringify(buttonCoords));

    if (buttonCoords.found) {
        // If button is stuck in loading state ($0.00), wait up to 20s for price to populate.
        // DoorDash fetches item details via GraphQL; if CF Turnstile hasn't cleared yet the
        // call gets 403'd and the button stays at $0.00 until CF passes the session.
        if (buttonCoords.text.includes('$0.00') || buttonCoords.text.toLowerCase().startsWith('loading')) {
            console.log('[DoorDash] Button still loading ($0.00) — waiting up to 20s for CF Turnstile to clear...');
            for (let w = 0; w < 20; w++) {
                await delay(1000);
                const refreshed = await page.evaluate(() => {
                    const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                    if (!modal) return null;
                    for (const btn of modal.querySelectorAll('button')) {
                        const t = btn.textContent?.trim() || '';
                        if (t.toLowerCase().includes('add to') || t.toLowerCase().includes('add for')) return t;
                    }
                    return null;
                }).catch(() => null);
                if (refreshed && !refreshed.includes('$0.00') && !refreshed.toLowerCase().startsWith('loading')) {
                    console.log('[DoorDash] Button loaded:', refreshed.substring(0, 50));
                    break;
                }
                console.log(`[DoorDash] Still loading after ${w + 1}s...`);
            }
        }

        console.log(`[DoorDash] Clicking Add button at (${buttonCoords.x}, ${buttonCoords.y}): ${buttonCoords.text}`);
        // Disable any Turnstile overlay that may have appeared on the modal
        await page.evaluate(() => {
            const overlays = document.querySelectorAll('[data-testid="turnstile/overlay"], [class*="Overlay"], [class*="overlay"]');
            overlays.forEach(el => { el.style.pointerEvents = 'none'; });
        }).catch(() => {});

        // Try mouse click first; fall back to JS dispatch (bypasses visual overlays)
        await page.mouse.click(buttonCoords.x, buttonCoords.y).catch(() => {});
        await delay(1500);

        // Check if modal closed
        let modalStillOpen = await page.$('[role="dialog"], [aria-modal="true"]');
        if (!modalStillOpen) {
            console.log('[DoorDash] Modal closed - item added successfully!');
            return true;
        }

        // Fallback: JS click directly on the button element (bypasses pointer-event overlays)
        console.log('[DoorDash] Mouse click did not close modal — trying JS dispatch...');
        const jsClicked = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!modal) return false;
            for (const btn of modal.querySelectorAll('button')) {
                const t = btn.textContent?.trim() || '';
                if (t.toLowerCase().includes('add to') || t.toLowerCase().includes('add for') || t.toLowerCase().includes('add -')) {
                    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    btn.click();
                    return true;
                }
            }
            return false;
        }).catch(() => false);

        await delay(2000);
        await takeScreenshot('after-add-button-click');
        modalStillOpen = await page.$('[role="dialog"], [aria-modal="true"]');
        if (!modalStillOpen) {
            console.log('[DoorDash] Modal closed after JS dispatch - item added successfully!');
            return true;
        } else {
            console.log('[DoorDash] Modal still open after click');
        }
    }

    return false;
}

// Error types for better handling
const DoorDashErrors = {
    LOGIN_FAILED: 'LOGIN_FAILED',
    TWO_FA_REQUIRED: '2FA_REQUIRED',
    TWO_FA_TIMEOUT: '2FA_TIMEOUT',
    RESTAURANT_NOT_FOUND: 'RESTAURANT_NOT_FOUND',
    RESTAURANT_CLOSED: 'RESTAURANT_CLOSED',
    RESTAURANT_UNAVAILABLE: 'RESTAURANT_UNAVAILABLE',
    ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
    ITEM_UNAVAILABLE: 'ITEM_UNAVAILABLE',
    ITEM_SOLD_OUT: 'ITEM_SOLD_OUT',
    PAYMENT_FAILED: 'PAYMENT_FAILED',
    NO_PAYMENT_METHOD: 'NO_PAYMENT_METHOD',
    ADDRESS_NOT_SERVICEABLE: 'ADDRESS_NOT_SERVICEABLE',
    ADDRESS_NOT_FOUND: 'ADDRESS_NOT_FOUND',
    MINIMUM_NOT_MET: 'MINIMUM_NOT_MET',
    CART_CONFLICT: 'CART_CONFLICT',
    RATE_LIMITED: 'RATE_LIMITED',
    CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    BROWSER_ERROR: 'BROWSER_ERROR',
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    UNKNOWN: 'UNKNOWN'
};

/**
 * Detect errors on the current page
 * Returns { hasError: boolean, errorType: string, message: string }
 */
async function detectPageErrors() {
    if (!page) {
        return { hasError: true, errorType: DoorDashErrors.BROWSER_ERROR, message: 'No browser page available' };
    }

    try {
        // Check for captcha / rate limiting
        const captchaIndicators = [
            'iframe[src*="captcha"]',
            'iframe[src*="recaptcha"]',
            '[data-testid="captcha"]',
            'text="verify you are human"',
            'text="too many requests"'
        ];
        for (const selector of captchaIndicators) {
            const el = await page.$(selector);
            if (el && await el.isVisible()) {
                return { hasError: true, errorType: DoorDashErrors.CAPTCHA_REQUIRED, message: 'Captcha verification required' };
            }
        }

        // Check for restaurant closed/unavailable
        const closedIndicators = [
            'text="Currently unavailable"',
            'text="This store is closed"',
            'text="Closed"',
            'text="Opens at"',
            '[data-testid="store-closed"]',
            'text="not accepting orders"'
        ];
        for (const selector of closedIndicators) {
            try {
                const el = await page.$(selector);
                if (el && await el.isVisible()) {
                    const text = await el.textContent();
                    return { hasError: true, errorType: DoorDashErrors.RESTAURANT_CLOSED, message: text || 'Restaurant is closed' };
                }
            } catch (e) {
                continue;
            }
        }

        // Check for item unavailable / sold out
        const soldOutIndicators = [
            'text="Sold out"',
            'text="Unavailable"',
            '[data-testid="sold-out"]',
            '.sold-out',
            '[class*="soldOut"]'
        ];
        for (const selector of soldOutIndicators) {
            try {
                const el = await page.$(selector);
                if (el && await el.isVisible()) {
                    return { hasError: true, errorType: DoorDashErrors.ITEM_SOLD_OUT, message: 'Item is sold out' };
                }
            } catch (e) {
                continue;
            }
        }

        // Check for minimum order not met
        const minimumIndicators = [
            'text="Minimum order"',
            'text="minimum"',
            'text="Add more items"',
            '[data-testid="minimum-order"]'
        ];
        for (const selector of minimumIndicators) {
            try {
                const el = await page.$(selector);
                if (el && await el.isVisible()) {
                    const text = await el.textContent();
                    if (text && text.toLowerCase().includes('minimum')) {
                        return { hasError: true, errorType: DoorDashErrors.MINIMUM_NOT_MET, message: text };
                    }
                }
            } catch (e) {
                continue;
            }
        }

        // Check for cart conflicts / item no longer available modals
        const conflictIndicators = [
            'text="Item no longer available"',
            'text="no longer available"',
            'text="has changed"',
            'text="price has changed"',
            '[data-testid="cart-conflict"]'
        ];
        for (const selector of conflictIndicators) {
            try {
                const el = await page.$(selector);
                if (el && await el.isVisible()) {
                    return { hasError: true, errorType: DoorDashErrors.CART_CONFLICT, message: 'Cart item no longer available' };
                }
            } catch (e) {
                continue;
            }
        }

        // Check for address errors
        const addressErrors = [
            'text="doesn\'t deliver here"',
            'text="does not deliver"',
            'text="outside delivery area"',
            'text="address not found"',
            'text="invalid address"'
        ];
        for (const selector of addressErrors) {
            try {
                const el = await page.$(selector);
                if (el && await el.isVisible()) {
                    const text = await el.textContent();
                    return { hasError: true, errorType: DoorDashErrors.ADDRESS_NOT_SERVICEABLE, message: text || 'Address not serviceable' };
                }
            } catch (e) {
                continue;
            }
        }

        // Check for payment errors
        const paymentErrors = [
            'text="Payment declined"',
            'text="payment failed"',
            'text="card declined"',
            'text="insufficient funds"',
            '[data-testid="payment-error"]'
        ];
        for (const selector of paymentErrors) {
            try {
                const el = await page.$(selector);
                if (el && await el.isVisible()) {
                    const text = await el.textContent();
                    return { hasError: true, errorType: DoorDashErrors.PAYMENT_FAILED, message: text || 'Payment failed' };
                }
            } catch (e) {
                continue;
            }
        }

        // No errors detected
        return { hasError: false, errorType: null, message: null };

    } catch (error) {
        console.error('[DoorDash] Error detection failed:', error.message);
        return { hasError: false, errorType: null, message: null };
    }
}

/**
 * Generic retry wrapper with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxAttempts - Maximum number of attempts (default: 3)
 * @param {number} baseDelay - Base delay in ms (default: 1000)
 */
async function withRetry(fn, maxAttempts = 3, baseDelay = 1000) {
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            console.log(`[DoorDash] Attempt ${attempt}/${maxAttempts} failed: ${error.message}`);

            // Check if it's a retryable error
            const isRetryable = error.message.includes('timeout') ||
                error.message.includes('net::') ||
                error.message.includes('Navigation') ||
                error.message.includes('Target closed') ||
                error.message.includes('Session closed');

            if (!isRetryable || attempt === maxAttempts) {
                throw error;
            }

            // Exponential backoff: 1s, 2s, 4s, ...
            const delayMs = baseDelay * Math.pow(2, attempt - 1);
            console.log(`[DoorDash] Retrying in ${delayMs}ms...`);
            await delay(delayMs);

            // On browser/connection errors, try to restart browser
            if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
                console.log('[DoorDash] Attempting browser restart...');
                try {
                    await closeBrowser();
                    await launchBrowser();
                } catch (e) {
                    console.error('[DoorDash] Browser restart failed:', e.message);
                }
            }
        }
    }

    throw lastError;
}

/**
 * Parse error and return user-friendly message
 */
function getUserFriendlyError(error) {
    const errorMessages = {
        [DoorDashErrors.LOGIN_FAILED]: 'Could not login to DoorDash. Please check your credentials.',
        [DoorDashErrors.TWO_FA_REQUIRED]: 'DoorDash requires 2-factor authentication. Please complete login manually.',
        [DoorDashErrors.TWO_FA_TIMEOUT]: 'Verification code timeout. Please try again.',
        [DoorDashErrors.RESTAURANT_NOT_FOUND]: 'Could not find that restaurant on DoorDash.',
        [DoorDashErrors.RESTAURANT_CLOSED]: 'This restaurant is currently closed.',
        [DoorDashErrors.RESTAURANT_UNAVAILABLE]: 'This restaurant is not available right now.',
        [DoorDashErrors.ITEM_NOT_FOUND]: 'Could not find that item on the menu.',
        [DoorDashErrors.ITEM_UNAVAILABLE]: 'That item is currently unavailable.',
        [DoorDashErrors.ITEM_SOLD_OUT]: 'That item is sold out.',
        [DoorDashErrors.PAYMENT_FAILED]: 'Payment failed. Please check your payment method on DoorDash.',
        [DoorDashErrors.NO_PAYMENT_METHOD]: 'No payment method on file. Please add a card in DoorDash app.',
        [DoorDashErrors.ADDRESS_NOT_SERVICEABLE]: 'DoorDash does not deliver to this address from this restaurant.',
        [DoorDashErrors.ADDRESS_NOT_FOUND]: 'Could not find that address. Please check and try again.',
        [DoorDashErrors.MINIMUM_NOT_MET]: 'Order minimum not met. Please add more items.',
        [DoorDashErrors.CART_CONFLICT]: 'Some items in your cart are no longer available.',
        [DoorDashErrors.RATE_LIMITED]: 'Too many requests. Please wait a few minutes and try again.',
        [DoorDashErrors.CAPTCHA_REQUIRED]: 'Verification required. Please try again later.',
        [DoorDashErrors.NETWORK_ERROR]: 'Network error. Please check your connection.',
        [DoorDashErrors.BROWSER_ERROR]: 'Browser error. Please try again.',
        [DoorDashErrors.SESSION_EXPIRED]: 'Session expired. Please try again.',
        [DoorDashErrors.UNKNOWN]: 'Something went wrong with the order. Please try again.'
    };

    return errorMessages[error] || errorMessages[DoorDashErrors.UNKNOWN];
}

/**
 * Get real order status from DoorDash orders page
 * @param {Object} credentials - { email, password }
 * @param {string} trackingUrl - optional direct tracking URL from order confirmation
 * @returns {Object} { status, statusText, eta, raw }
 */
async function getOrderStatus(credentials, trackingUrl = null) {
    try {
        await ensureLoggedIn(credentials);

        const targetUrl = trackingUrl || `${DOORDASH_URL}/orders`;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await handlePopups();
        await delay(2000);

        const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
        const lower = pageText.toLowerCase();

        // Map DoorDash's status language to our internal statuses
        let status = 'unknown';
        let statusText = '';

        if (lower.includes('has been delivered') || lower.includes('order delivered') || lower.includes('enjoy your meal') || lower.includes('enjoy your food') || lower.includes('enjoy your order')) {
            status = 'delivered';
            statusText = 'Your order has been delivered!';
        } else if (lower.includes('on the way') || lower.includes('heading to you') || lower.includes('almost there')) {
            status = 'on_the_way';
            statusText = 'Your Dasher is on the way!';
        } else if (lower.includes('picked up') || lower.includes('dasher picked') || (!lower.includes('heading to the restaurant') && lower.includes('picked'))) {
            status = 'picked_up';
            statusText = 'Dasher picked up your order!';
        } else if (lower.includes('dasher') && (lower.includes('assigned') || lower.includes('picking up'))) {
            status = 'dasher_assigned';
            statusText = 'A Dasher has been assigned and is picking up your order.';
        } else if (lower.includes('preparing') || lower.includes('restaurant is') || lower.includes('being prepared')) {
            status = 'preparing';
            statusText = 'The restaurant is preparing your order.';
        } else if (lower.includes('order placed') || lower.includes('order received') || lower.includes('confirmed')) {
            status = 'placed';
            statusText = 'Order placed! Restaurant will start preparing soon.';
        } else if (lower.includes('cancelled') || lower.includes('canceled')) {
            status = 'cancelled';
            statusText = 'Your order was cancelled.';
        }

        // Try to extract ETA
        let eta = null;
        const etaMatch = pageText.match(/(\d{1,2}:\d{2}\s*[AP]M|\d+\s*(?:min|minutes?))/i);
        if (etaMatch) eta = etaMatch[1];

        return { status, statusText, eta, raw: pageText.slice(0, 500) };
    } catch (error) {
        console.error('[DoorDash] getOrderStatus error:', error.message);
        return { status: 'unknown', statusText: '', eta: null, error: error.message };
    }
}

/**
 * Open browser for manual login - user logs in themselves, session is saved
 */
async function openForManualLogin() {
    try {
        if (!page || !context) {
            await launchBrowser(false); // always non-headless for manual login
        }

        await page.goto(`${DOORDASH_URL}/consumer/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('[DoorDash] Browser opened for manual login. Waiting up to 3 minutes...');

        // Poll every 3 seconds for up to 3 minutes
        const timeout = 3 * 60 * 1000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
            await delay(3000);
            const content = await page.content().catch(() => '');
            const url = page.url();
            if ((content.includes('href="/account"') || content.includes('/orders')) && !url.includes('/login')) {
                console.log('[DoorDash] Manual login successful! Session saved.');
                updateSessionState({ loggedIn: true });
                return { success: true };
            }
        }

        return { success: false, error: 'Timed out waiting for login' };
    } catch (error) {
        console.error('[DoorDash] Manual login error:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Clear the DoorDash browser cart by clicking all remove/decrement buttons
 * Called when user does CLEAR_CART to keep DB and browser in sync
 */
async function clearBrowserCart() {
    if (!page || !context) {
        console.log('[DoorDash] clearBrowserCart: no browser open, nothing to clear');
        return;
    }
    try {
        console.log('[DoorDash] Clearing browser cart...');
        const url = page.url();
        if (!url.includes('doordash.com')) {
            console.log('[DoorDash] Not on DoorDash, skipping browser cart clear');
            return;
        }
        // Click all minus (-) buttons in the cart until no items remain
        let attempts = 0;
        while (attempts < 30) {
            const removed = await page.evaluate(() => {
                // Find quantity decrement buttons (data-anchor-id contains "Decrement" or aria-label contains "remove" or "-")
                const selectors = [
                    '[data-anchor-id*="CartItemDecrement"]',
                    '[data-anchor-id*="Decrement"]',
                    'button[aria-label*="Remove"]',
                    'button[aria-label*="remove"]',
                    'button[aria-label*="-"]',
                ];
                for (const sel of selectors) {
                    const btns = document.querySelectorAll(sel);
                    if (btns.length > 0) {
                        btns[0].click();
                        return true;
                    }
                }
                return false;
            });
            if (!removed) break;
            await new Promise(r => setTimeout(r, 300));
            attempts++;
        }
        console.log(`[DoorDash] Browser cart clear done (${attempts} items removed)`);
    } catch (e) {
        console.log('[DoorDash] clearBrowserCart error (non-fatal):', e.message);
    }
}

/**
 * Read current cart items directly from the DoorDash browser.
 * Returns array of {name, quantity, price} or null if unavailable.
 */
async function readBrowserCart() {
    if (!page || !context) return null;
    try {
        const url = page.url();
        if (!url.includes('doordash.com')) return null;

        // Try to read from the cart sidebar on the current page
        const items = await page.evaluate(() => {
            const results = [];
            // Cart items are in elements with data-anchor-id containing "CartItem"
            const cartItemEls = document.querySelectorAll('[data-anchor-id*="CartItem"]');
            for (const el of cartItemEls) {
                // Skip buttons/controls inside cart items
                if (el.tagName === 'BUTTON') continue;
                const nameEl = el.querySelector('[data-anchor-id*="CartItemName"], [data-testid*="item-name"]')
                    || el.querySelector('span[class*="name"], p[class*="name"]');
                const qtyEl = el.querySelector('[data-anchor-id*="CartItemQuantity"], [data-anchor-id*="quantity"]');
                const priceEl = el.querySelector('[data-anchor-id*="CartItemPrice"], [data-testid*="price"]');
                const name = nameEl ? nameEl.textContent.trim() : el.textContent.trim().split('\n')[0].trim();
                const qty = qtyEl ? parseInt(qtyEl.textContent.trim()) || 1 : 1;
                const priceText = priceEl ? priceEl.textContent.trim() : '';
                const price = parseFloat((priceText.match(/\$?([\d.]+)/) || [])[1] || '0');
                if (name && name.length > 1) results.push({ name, quantity: qty, price });
            }
            return results;
        });

        if (items && items.length > 0) {
            console.log(`[DoorDash] readBrowserCart: found ${items.length} items in sidebar`);
            return items;
        }

        // Fallback: navigate to /cart/
        console.log('[DoorDash] readBrowserCart: no sidebar items, navigating to /cart/');
        const prevUrl = page.url();
        await page.goto('https://www.doordash.com/cart/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 2000));

        const cartPageItems = await page.evaluate(() => {
            const results = [];
            // On the cart page, look for product names and prices
            const rows = document.querySelectorAll('[data-anchor-id*="CartItem"]:not(button), [data-testid*="cart-item"]');
            for (const row of rows) {
                const texts = Array.from(row.querySelectorAll('span, p, div'))
                    .map(e => e.childNodes.length === 1 && e.childNodes[0].nodeType === 3 ? e.textContent.trim() : '')
                    .filter(t => t.length > 1);
                const priceMatch = texts.find(t => /^\$[\d.]+$/.test(t));
                const name = texts.find(t => !/^\$/.test(t) && t.length > 2 && !/^\d+$/.test(t));
                if (name) results.push({ name, quantity: 1, price: parseFloat((priceMatch || '$0').replace('$', '')) });
            }
            return results;
        });

        // Navigate back to where we were
        if (prevUrl && prevUrl !== page.url()) {
            await page.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        }

        console.log(`[DoorDash] readBrowserCart: found ${cartPageItems.length} items on /cart/ page`);
        return cartPageItems.length > 0 ? cartPageItems : null;
    } catch (e) {
        console.log('[DoorDash] readBrowserCart error:', e.message);
        return null;
    }
}

/**
 * Navigate to a restaurant page (for recovery after server restart)
 */
async function navigateToRestaurantPage(url) {
    if (!page || !context) {
        await launchBrowser();
        // Re-import auth cookies after crash (skip CF cookies — fingerprint-specific)
        if (process.env.DOORDASH_COOKIES) {
            try {
                const allCookies = JSON.parse(process.env.DOORDASH_COOKIES);
                const CF_COOKIES = new Set(['cf_clearance', '__cf_bm', '_cfuvid', '__cfwaitingroom']);
                const authCookies = allCookies.filter(c => !CF_COOKIES.has(c.name));
                await context.addCookies(authCookies);
                console.log(`[DoorDash] Re-imported ${authCookies.length} auth cookies after relaunch`);
            } catch (e) {
                console.error('[DoorDash] Failed to re-import cookies:', e.message);
            }
        }
    }
    console.log(`[DoorDash] Navigating to restaurant page for recovery: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForCFChallenge(60000);
    await delay(2000);
    await handlePopups();
    console.log('[DoorDash] Restaurant page loaded');
}

async function exportCookies() {
    if (!context) return { success: false, error: 'Browser not open' };
    const cookies = await context.cookies();
    return { success: true, cookies };
}

async function importCookies(cookies) {
    if (!context) {
        await launchBrowser();
        if (!context) throw new Error('Browser failed to launch for importCookies');
    }
    await context.addCookies(cookies);
    console.log(`[DoorDash] Imported ${cookies.length} cookies`);
    return { success: true };
}

// Wrap browser-touching exports with the serial op lock to prevent concurrent requests
// that confuse the shared browser page and trigger CF rate-limiting.
function locked(fn) {
    return function(...args) { return withOpLock(() => fn(...args)); };
}

async function prewarmRestaurantPage(restaurantUrl) {
    _preWarmUrl = restaurantUrl;
    _preWarmPromise = (async () => {
        try {
            if (!page || !context) await launchBrowser();
            // Quick health check
            const alive = await Promise.race([
                page.evaluate(() => true).then(() => true).catch(() => false),
                new Promise(r => setTimeout(() => r(false), 2000))
            ]);
            if (!alive) {
                await closeBrowser().catch(() => {});
                await launchBrowser();
            }
            const currentUrl = page.url();
            const storeBase = restaurantUrl.split('?')[0];
            if (currentUrl.startsWith(storeBase)) {
                console.log('[DoorDash] Pre-warm: already on store page');
                return;
            }
            console.log('[DoorDash] Pre-warming store page in background:', storeBase.substring(0, 80));
            if (!currentUrl.startsWith('https://www.doordash.com') || currentUrl.includes('/login')) {
                await page.goto(`${DOORDASH_URL}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await waitForCFChallenge(20000);
                await delay(500);
            }
            await page.goto(restaurantUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForCFChallenge(30000);
            await handlePopups();
            console.log('[DoorDash] Pre-warm complete:', page.url().substring(0, 80));
        } catch (e) {
            console.log('[DoorDash] Pre-warm error:', e.message);
        }
    })();
    return _preWarmPromise;
}

async function prewarmBrowser() {
    _preWarmPromise = (async () => {
        try {
            if (!page || !context) await launchBrowser();
            const currentUrl = page.url();
            if (currentUrl.startsWith('https://www.doordash.com') && !currentUrl.includes('/login')) {
                console.log('[DoorDash] Browser already warm');
                return;
            }
            console.log('[DoorDash] Pre-warming browser (homepage)...');
            await page.goto(`${DOORDASH_URL}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await waitForCFChallenge(20000);
            console.log('[DoorDash] Browser pre-warm complete');
        } catch (e) {
            console.log('[DoorDash] Browser pre-warm error:', e.message);
        }
    })();
    return _preWarmPromise;
}

module.exports = {
    launchBrowser,
    closeBrowser,
    openForManualLogin,
    login,
    setAddress,
    searchRestaurant,
    addItemToCart,
    checkout,
    placeOrder: locked(placeOrder),
    getOrderConfirmation,
    placeFullOrder,
    checkoutCurrentCart: locked(checkoutCurrentCart),
    placeAdditionalOrder,
    handlePopups,
    takeScreenshot,
    isLoggedIn,
    DoorDashErrors,
    getUserFriendlyError,
    // Session management
    getSessionState,
    validateSession,
    ensureLoggedIn,
    // Error detection and retry
    detectPageErrors,
    withRetry,
    // Real restaurant search functions
    searchRestaurantsNearAddress: locked(searchRestaurantsNearAddress),
    extractRestaurantList,
    sortRestaurantsByRating,
    sortRestaurantsByRelevance,
    getRestaurantMenu: locked(getRestaurantMenu),
    extractMenuItems,
    extractMenuCategories,
    getMenuItemsInCategory,
    selectRestaurantFromSearch: locked(selectRestaurantFromSearch),
    addItemByIndex: locked(addItemByIndex),
    navigateToRestaurantPage: locked(navigateToRestaurantPage),
    clearBrowserCart: locked(clearBrowserCart),
    readBrowserCart: locked(readBrowserCart),
    getOrderStatus: locked(getOrderStatus),
    exportCookies,
    importCookies,
    prewarmRestaurantPage,
    prewarmBrowser,
};
