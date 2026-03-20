/**
 * DoorDash Browser Automation Module
 * Uses Playwright to automate real orders on DoorDash
 * Restaurant search uses the internal HTTP API (no browser needed).
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// API module for search (bypasses Cloudflare CAPTCHA)
const doordashApi = require('./doordash-api');

// Configuration
const DOORDASH_URL = 'https://www.doordash.com';
const BROWSER_DATA_DIR = process.env.BROWSER_DATA_DIR || path.join(__dirname, 'browser-data');
const HEADLESS = process.env.DOORDASH_HEADLESS !== 'false';

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
        placeOrder: 'button[data-anchor-id="PlaceOrderButton"], button:has-text("Place Order")',
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

// Session state tracking
const sessionState = {
    launched: false,
    loggedIn: false,
    currentRestaurantPage: null,
    lastActivity: null,
    loginEmail: null
};

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
async function launchBrowser(headless = HEADLESS) {
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
    const CHROME_INSTALLED = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    const BOT_PROFILE_DIR = CHROME_INSTALLED
        ? 'C:\\Users\\hatch\\AppData\\Local\\MessageAI\\ChromeProfile'
        : path.join(BROWSER_DATA_DIR, 'ChromeProfile');

    if (!fs.existsSync(BOT_PROFILE_DIR)) {
        fs.mkdirSync(BOT_PROFILE_DIR, { recursive: true });
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
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    };

    if (!CHROME_INSTALLED) {
        launchOptions.viewport = { width: 1280, height: 720 };
        launchOptions.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    }

    console.log(`[DoorDash] Launching ${CHROME_INSTALLED ? 'real Chrome' : 'bundled Chromium'} with dedicated MessageAI profile`);
    context = await chromium.launchPersistentContext(BOT_PROFILE_DIR, launchOptions);

    // Remove webdriver property so sites can't detect automation
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    page = context.pages()[0] || await context.newPage();

    // Set default timeout
    page.setDefaultTimeout(30000);

    updateSessionState({ launched: true });
    console.log('[DoorDash] Browser launched');
    return page;
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
            // Already logged in - verify it's the same account if we know
            if (sessionState.loginEmail && sessionState.loginEmail !== email) {
                console.log('[DoorDash] Different account requested, need to re-login');
                // Could add logout logic here if needed
            } else {
                console.log('[DoorDash] Already logged in, reusing session');
                updateSessionState({ loggedIn: true, loginEmail: email });
                return { success: true, message: 'Session reused' };
            }
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
        // Extended list of popup/overlay dismiss buttons
        const dismissButtons = [
            // Cookie consent
            'button:has-text("Accept")',
            'button:has-text("Accept All")',
            'button:has-text("Accept Cookies")',
            'button:has-text("Got it")',
            'button:has-text("I Accept")',
            'button#onetrust-accept-btn-handler',
            '[data-testid="accept-cookies"]',
            // Promotional popups
            'button:has-text("Not now")',
            'button:has-text("No thanks")',
            'button:has-text("Skip")',
            'button:has-text("Maybe later")',
            'button:has-text("Close")',
            'button:has-text("Dismiss")',
            // Close buttons
            '[aria-label="Close"]',
            '[aria-label="close"]',
            '[data-anchor-id="CloseButton"]',
            'button[class*="close"]',
            'button[class*="Close"]',
            // Modal overlays - click outside or X
            '[data-testid="modal-close"]',
            '[data-testid="close-button"]',
            'div[role="dialog"] button[aria-label="Close"]'
        ];

        for (const selector of dismissButtons) {
            try {
                const buttons = await page.$$(selector);
                for (const button of buttons) {
                    if (await button.isVisible()) {
                        await button.click({ force: true });
                        await delay(300);
                    }
                }
            } catch (e) {
                // Continue trying other selectors
            }
        }

        // Also try pressing Escape to close any modals
        await page.keyboard.press('Escape');
        await delay(300);

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
        await delay(2000);
        await handlePopups();

        // Check for account menu or user icon that indicates logged in state
        const accountIndicators = [
            '[data-anchor-id="AccountMenu"]',
            '[data-testid="account-button"]',
            'button[aria-label="Account"]',
            '[data-anchor-id="UserAvatar"]',
            // Additional indicators for logged-in state
            '[data-testid="user-menu"]',
            'button[aria-label="Open account menu"]',
            '[aria-label="Account menu"]',
            'img[alt*="avatar"]',
            'img[alt*="profile"]'
        ];

        for (const selector of accountIndicators) {
            const element = await page.$(selector);
            if (element && await element.isVisible()) {
                console.log('[DoorDash] Already logged in');
                return true;
            }
        }

        return false;
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
async function checkoutCurrentCart() {
    console.log('[DoorDash] === CHECKING OUT CURRENT CART ===');

    try {
        if (!page) {
            return { success: false, error: 'Browser not open' };
        }

        await takeScreenshot('checkout-start');

        // First, close any open modals that might be blocking
        const closeModalBtn = await page.$('[role="dialog"] button[aria-label*="close"], [role="dialog"] button:has-text("×"), [aria-modal="true"] button[aria-label*="close"]');
        if (closeModalBtn) {
            console.log('[DoorDash] Closing open modal first...');
            await closeModalBtn.click();
            await delay(1000);
        }

        // Press Escape to close any modals
        await page.keyboard.press('Escape');
        await delay(500);

        await takeScreenshot('after-close-modals');

        // Look for a checkout/continue button anywhere on the page (DoorDash embeds cart in sidebar)
        const findCheckoutBtn = async () => {
            return await page.evaluate(() => {
                const buttons = document.querySelectorAll('button, a');
                // Priority order: exact data-anchor-id → text match
                for (const btn of buttons) {
                    const anchorId = (btn.getAttribute('data-anchor-id') || '').toLowerCase();
                    if (anchorId.includes('checkout') || anchorId.includes('cartcheckout')) {
                        const rect = btn.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: btn.textContent.trim().substring(0, 40) };
                        }
                    }
                }
                for (const btn of buttons) {
                    const text = (btn.textContent || '').trim().toLowerCase();
                    const rect = btn.getBoundingClientRect();
                    if (rect.width < 60 || rect.height < 28) continue;
                    if (rect.top < 0 || rect.top > window.innerHeight) continue;
                    const isCheckout = text.includes('go to checkout') || text.includes('checkout') ||
                                       text === 'continue' || text.includes('continue to checkout') ||
                                       text.includes('view cart') || text.includes('place order');
                    if (isCheckout) {
                        console.log('[Cart] Found checkout button:', text.substring(0, 40), 'at', Math.round(rect.left), Math.round(rect.top));
                        return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: text.substring(0, 40) };
                    }
                }
                return { found: false };
            });
        };

        // First try: look for checkout button directly (DoorDash sidebar often has it)
        let checkoutBtnCoords = await findCheckoutBtn();

        if (!checkoutBtnCoords.found) {
            // Try clicking the cart icon in the header to open cart drawer
            const cartCoords = await page.evaluate(() => {
                const buttons = document.querySelectorAll('button, a');
                for (const btn of buttons) {
                    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                    const anchorId = (btn.getAttribute('data-anchor-id') || '').toLowerCase();
                    if (ariaLabel.includes('cart') || anchorId.includes('cart')) {
                        const rect = btn.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                        }
                    }
                }
                return { found: false };
            });
            if (cartCoords.found) {
                await page.mouse.click(cartCoords.x, cartCoords.y);
                await delay(1500);
            }
            checkoutBtnCoords = await findCheckoutBtn();
        }

        await takeScreenshot('after-cart-click');

        if (checkoutBtnCoords.found) {
            console.log(`[DoorDash] Clicking checkout button: ${checkoutBtnCoords.text}`);
            await page.mouse.click(checkoutBtnCoords.x, checkoutBtnCoords.y);
            await delay(3000);
        } else {
            // Fallback: try DoorDash cart URL (more reliable than /checkout/)
            console.log('[DoorDash] No checkout button found, trying direct navigation...');
            const storeUrl = page.url();
            const storeIdMatch = storeUrl.match(/\/store\/[^/]+-(\d+)\//);
            const cartUrl = storeIdMatch
                ? `https://www.doordash.com/store/${storeIdMatch[0].split('/').filter(Boolean)[1]}/`
                : 'https://www.doordash.com/cart/';
            await page.goto(cartUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(2000);
            checkoutBtnCoords = await findCheckoutBtn();
            if (checkoutBtnCoords.found) {
                await page.mouse.click(checkoutBtnCoords.x, checkoutBtnCoords.y);
                await delay(3000);
            }
        }

        await takeScreenshot('checkout-page');

        // Check if we're on checkout page
        const pageUrl = page.url();
        console.log(`[DoorDash] Current URL: ${pageUrl}`);

        if (!pageUrl.includes('checkout')) {
            // One more try - direct navigation
            console.log('[DoorDash] Still not on checkout, trying direct nav...');
            await page.goto('https://www.doordash.com/checkout/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(3000);
            await takeScreenshot('checkout-direct-nav');

            const newUrl = page.url();
            if (!newUrl.includes('checkout')) {
                return { success: false, error: 'Could not open checkout page' };
            }
        }

        // Look for Place Order button
        const placeOrderSelectors = [
            'button:has-text("Place Order")',
            'button:has-text("Submit Order")',
            '[data-testid="PlaceOrderButton"]',
            'button[type="submit"]',
            '[data-anchor-id="CheckoutButton"]'
        ];

        for (const selector of placeOrderSelectors) {
            try {
                const btn = await page.$(selector);
                if (btn && await btn.isVisible()) {
                    const btnText = await btn.textContent();
                    console.log(`[DoorDash] Found order button: ${btnText}`);

                    // Check if button is disabled (might need to select options)
                    const isDisabled = await btn.getAttribute('disabled');
                    if (isDisabled) {
                        console.log('[DoorDash] Order button is disabled - may need payment/address');
                        await takeScreenshot('checkout-button-disabled');
                        return { success: false, error: 'Checkout button disabled. Check payment method and address in DoorDash app.' };
                    }

                    // Dry-run mode: stop before clicking
                    const DRY_RUN = process.env.DOORDASH_DRY_RUN === 'true';
                    if (DRY_RUN) {
                        console.log('[DoorDash] DRY RUN — skipping Place Order click');
                        await takeScreenshot('dry-run-place-order');
                        return { success: true, dryRun: true, message: 'Dry run complete — checkout page loaded, Place Order button found.' };
                    }

                    // Click place order
                    console.log('[DoorDash] Clicking Place Order...');
                    await btn.click();
                    await delay(5000);
                    await takeScreenshot('after-place-order');

                    // Check for confirmation
                    const pageContent = await page.content();
                    const isConfirmed = pageContent.includes('Order confirmed') ||
                                       pageContent.includes('Order placed') ||
                                       pageContent.includes('Your order is on') ||
                                       pageContent.includes('Thanks for your order') ||
                                       page.url().includes('confirmation');

                    if (isConfirmed) {
                        const orderUrl = page.url();
                        console.log('[DoorDash] Order placed! URL:', orderUrl);
                        await takeScreenshot('order-confirmed');
                        return { success: true, message: 'Order placed!', orderUrl };
                    } else {
                        // Check for error messages
                        const errorIndicators = ['error', 'failed', 'problem', 'unable', 'sorry'];
                        const hasError = errorIndicators.some(e => pageContent.toLowerCase().includes(e));

                        if (hasError) {
                            await takeScreenshot('checkout-error');
                            return { success: false, error: 'Order failed. Check DoorDash app for details.' };
                        }

                        return { success: true, message: 'Order submitted - check DoorDash app for confirmation' };
                    }
                }
            } catch (e) {
                console.log(`[DoorDash] Selector failed: ${selector}`, e.message);
            }
        }

        return { success: false, error: 'Could not find Place Order button' };

    } catch (error) {
        console.error('[DoorDash] Checkout error:', error.message);
        await takeScreenshot('checkout-exception');
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

    // Try HTTP API first - no browser, no CAPTCHA
    try {
        console.log('[DoorDash] Attempting search via internal API (no browser)...');
        const apiResult = await doordashApi.searchRestaurantsNearAddress(credentials, address, query);
        if (apiResult.success && apiResult.restaurants.length > 0) {
            console.log('[DoorDash] API search succeeded!');
            return apiResult;
        }
        console.log('[DoorDash] API search returned no results, falling back to browser...');
        console.log('[DoorDash] API error:', apiResult.error);
    } catch (apiError) {
        console.log('[DoorDash] API search threw error, falling back to browser:', apiError.message);
    }

    // Fall back to browser automation
    try {
        console.log(`[DoorDash] === BROWSER SEARCH FALLBACK ===`);

        // Step 1: Make sure browser is open
        if (!page || !context) {
            console.log('[DoorDash] Launching browser...');
            await launchBrowser();
        }

        // Step 2: Go to DoorDash
        console.log('[DoorDash] Navigating to DoorDash...');
        await page.goto(DOORDASH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(3000);
        await takeScreenshot('1-loaded-homepage');
        console.log('[DoorDash] Homepage loaded, URL:', page.url());

        // Step 3: Check if logged in — skip if cookies were pre-loaded via env var
        const hasCookieEnv = !!process.env.DOORDASH_COOKIES;
        const loggedIn = hasCookieEnv ? true : await isLoggedIn();
        console.log('[DoorDash] Logged in:', loggedIn, '(cookie env:', hasCookieEnv, ')');

        if (!loggedIn) {
            console.log('[DoorDash] Not logged in, attempting login...');
            const loginResult = await login(email, password);
            if (!loginResult.success) {
                const recheckOk = await isLoggedIn();
                if (!recheckOk) {
                    return { success: false, error: `Login failed: ${loginResult.error || 'unknown'}`, restaurants: [] };
                }
            }
            await takeScreenshot('2-after-login');
        }

        // Step 4: Enter delivery address if the address input is showing instead of search
        const allInputs = await page.$$('input');
        let addressInputFound = false;
        for (const input of allInputs) {
            try {
                const placeholder = await input.getAttribute('placeholder');
                const isVisible = await input.isVisible();
                if (isVisible && placeholder && placeholder.toLowerCase().includes('address')) {
                    console.log('[DoorDash] Address input found - entering delivery address...');
                    await input.click();
                    await delay(500);
                    await input.fill(address);
                    await delay(2000);
                    // Pick first autocomplete suggestion
                    const suggestion = await page.$('[role="option"], [data-anchor-id="AddressSuggestion"]');
                    if (suggestion) {
                        await suggestion.click();
                        console.log('[DoorDash] Selected address suggestion');
                    } else {
                        await page.keyboard.press('Enter');
                    }
                    await delay(3000);
                    await takeScreenshot('3b-address-set');
                    addressInputFound = true;
                    break;
                }
            } catch (e) { continue; }
        }

        // Step 5: Find and click the search bar
        console.log('[DoorDash] Looking for search bar...');
        await takeScreenshot('3-before-search');

        let searchFound = false;
        const freshInputs = await page.$$('input');
        console.log(`[DoorDash] Found ${freshInputs.length} input elements`);

        for (const input of freshInputs) {
            try {
                const placeholder = await input.getAttribute('placeholder');
                const isVisible = await input.isVisible();
                console.log(`[DoorDash] Input placeholder: "${placeholder}", visible: ${isVisible}`);
                if (isVisible && placeholder && placeholder.toLowerCase().includes('search')) {
                    console.log('[DoorDash] Found search input!');
                    await input.click();
                    await delay(500);
                    await input.fill(query);
                    await takeScreenshot('4-typed-query');
                    await delay(500);
                    await page.keyboard.press('Enter');
                    searchFound = true;
                    break;
                }
            } catch (e) { continue; }
        }

        if (!searchFound) {
            console.log('[DoorDash] Using direct search URL...');
            const searchUrl = `${DOORDASH_URL}/search/store/${encodeURIComponent(query)}/`;
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        // Step 5: Wait for results to load
        console.log('[DoorDash] Waiting for search results...');
        await delay(4000);
        await handlePopups();
        await takeScreenshot('5-search-results');
        console.log('[DoorDash] Current URL:', page.url());

        // Step 6: Extract restaurants
        console.log('[DoorDash] Extracting restaurants...');
        const restaurants = await extractRestaurantList();
        console.log(`[DoorDash] Extracted ${restaurants.length} restaurants`);
        await takeScreenshot('6-extraction-done');

        // If nothing found, gather diagnostics
        if (restaurants.length === 0) {
            const currentUrl = page.url();
            const storeLinks = await page.$$('a[href*="/store/"]');
            const sampleHrefs = [];
            for (let i = 0; i < Math.min(3, storeLinks.length); i++) {
                sampleHrefs.push(await storeLinks[i].getAttribute('href'));
            }
            const diagMsg = `0 restaurants extracted. URL: ${currentUrl}. Store links: ${storeLinks.length}. Sample hrefs: ${JSON.stringify(sampleHrefs)}`;
            console.log('[DoorDash] DIAG:', diagMsg);
            return { success: false, error: diagMsg, restaurants: [] };
        }

        // Sort by rating and return top 5
        const sortedRestaurants = sortRestaurantsByRelevance(restaurants, query).slice(0, 5);

        console.log('[DoorDash] === SEARCH COMPLETE ===');
        return {
            success: true,
            restaurants: sortedRestaurants,
            totalFound: restaurants.length,
            query: query || 'nearby'
        };

    } catch (error) {
        console.error('[DoorDash] Browser search error:', error.message);
        console.error('[DoorDash] Stack:', error.stack);
        try { await takeScreenshot('error-' + Date.now()); } catch (e) {}

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
async function extractRestaurantList() {
    const restaurants = [];

    try {
        console.log('[DoorDash] Extracting restaurant list...');

        // Get all links that go to /store/ pages
        const storeLinks = await page.$$('a[href*="/store/"]');
        console.log(`[DoorDash] Found ${storeLinks.length} store links`);

        const seenNames = new Set();

        for (let i = 0; i < storeLinks.length && restaurants.length < 10; i++) {
            try {
                const link = storeLinks[i];

                // Get the href and extract store ID
                const href = await link.getAttribute('href');
                if (!href || !href.includes('/store/')) continue;
                if (i < 5) console.log(`[DoorDash] Sample href[${i}]: ${href}`);

                // Support both old format /store/12345/ and new format /store/slug/12345/
                const storeIdMatch = href.match(/\/store\/[^/?#]*?\/(\d{5,})/) || href.match(/\/store\/(\d+)/);
                if (!storeIdMatch) {
                    console.log(`[DoorDash] No store ID in href: ${href}`);
                    continue;
                }

                // Get the text content of the link (restaurant name is usually in here)
                const textContent = await link.textContent();
                if (!textContent || textContent.trim().length < 3) continue;

                // Parse out the restaurant name (usually the first meaningful text)
                const lines = textContent.split('\n').map(l => l.trim()).filter(l => l.length > 2);
                let name = lines[0] || '';

                // Clean up the name - remove ratings, prices, delivery info appended after restaurant name
                name = name.replace(/^\d+\.\d+\s*/, ''); // Remove leading rating like "4.5 "
                name = name.replace(/\d+\.\d+\(.*$/, ''); // Remove "4.5(2k+)•..." appended after name
                name = name.replace(/\s*[•(].*$/, ''); // Remove anything after • or ( (reviews, distance, time)
                name = name.replace(/\$+.*$/, ''); // Remove price indicators
                name = name.replace(/\d+[-–]\d+\s*min.*$/i, ''); // Remove delivery time range
                name = name.replace(/\d+\s*min.*$/i, ''); // Remove single delivery time
                name = name.trim();

                if (!name || name.length < 3 || seenNames.has(name.toLowerCase())) continue;
                seenNames.add(name.toLowerCase());

                // Extract rating if present
                const ratingMatch = textContent.match(/(\d\.\d)/);
                const rating = ratingMatch ? ratingMatch[1] : '';

                // Extract delivery time
                const timeMatch = textContent.match(/(\d+-\d+)\s*min/i);
                const deliveryTime = timeMatch ? timeMatch[0] : '';

                restaurants.push({
                    id: storeIdMatch[1],
                    name: name,
                    rating: rating,
                    deliveryTime: deliveryTime,
                    url: href.startsWith('http') ? href : `${DOORDASH_URL}${href}`,
                    index: i
                });

                console.log(`[DoorDash] Found restaurant: ${name} (ID: ${storeIdMatch[1]}, rating: ${rating || 'N/A'})`);

            } catch (e) {
                continue;
            }
        }

        console.log(`[DoorDash] Total restaurants extracted: ${restaurants.length}`);

    } catch (error) {
        console.error('[DoorDash] Extract restaurant list error:', error.message);
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
        await delay(3000);
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
 * Extract menu items from current restaurant page
 * Filters out UI/navigation elements and focuses on actual food items with prices
 */
async function extractMenuItems() {
    const menuItems = [];

    try {
        console.log('[DoorDash] Starting menu item extraction...');
        await takeScreenshot('extract-menu-start');

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

        // Add all items to menuItems with proper structure
        for (let i = 0; i < Math.min(allExtractedItems.length, 25); i++) {
            const item = allExtractedItems[i];
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
        console.log(`[DoorDash] ===== END EXTRACTION (${menuItems.length} items) =====`);

        await takeScreenshot('extract-menu-done');

    } catch (error) {
        console.error('[DoorDash] Extract menu error:', error.message);
        await takeScreenshot('extract-menu-error');
    }

    return menuItems;
}

/**
 * Navigate to a restaurant by URL or index and extract menu categories
 */
async function selectRestaurantFromSearch(indexOrUrl) {
    try {
        console.log(`[DoorDash] Selecting restaurant: ${indexOrUrl}`);

        // If it's a URL, navigate directly
        if (typeof indexOrUrl === 'string' && indexOrUrl.includes('/store/')) {
            console.log('[DoorDash] Navigating to restaurant URL...');
            await page.goto(indexOrUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
                    const skipWords = ['delivery', 'pickup', 'schedule', 'group order', 'sign', 'log', 'cart', 'featured', 'popular'];
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

            // First scroll to top
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(300);

            // Click on sidebar menu categories to load items (DoorDash lazy-loads sections)
            console.log('[DoorDash] Clicking sidebar categories to load menu items...');

            // Use page.evaluate to find and click sidebar links - more reliable
            const clickedCategories = await page.evaluate(() => {
                const clicked = [];
                const categoriesToFind = ['light entrees', 'most ordered', 'entrees', 'salads'];

                // Find all links/buttons in the page
                const allLinks = document.querySelectorAll('a, button, [role="button"], [role="tab"]');

                for (const link of allLinks) {
                    const text = link.textContent?.toLowerCase()?.trim() || '';
                    const rect = link.getBoundingClientRect();

                    // Check if this is a sidebar link (left side of page, reasonable size)
                    if (rect.left < 200 && rect.width > 30 && rect.width < 250 && rect.height > 15 && rect.height < 60) {
                        for (const cat of categoriesToFind) {
                            if (text === cat || text.includes(cat)) {
                                link.click();
                                clicked.push(text);
                                break;
                            }
                        }
                    }
                }
                return clicked;
            });

            console.log(`[DoorDash] Clicked sidebar categories: ${JSON.stringify(clickedCategories)}`);
            await delay(1000);

            // Scroll through the ENTIRE page to trigger lazy loading of all sections
            console.log('[DoorDash] Scrolling through page to load all items...');
            const totalHeight = await page.evaluate(() => document.body.scrollHeight);
            for (let scrollPos = 0; scrollPos < totalHeight; scrollPos += 500) {
                await page.evaluate((pos) => window.scrollTo(0, pos), scrollPos);
                await delay(200);
            }

            // Take a screenshot after loading
            await takeScreenshot('after-scroll-load');

            // Now scroll back to top to start searching
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(500);
            console.log('[DoorDash] All items loaded, starting search...');

            // Scroll through the ENTIRE page looking for the item
            // Get page height first
            const pageHeight = await page.evaluate(() => document.body.scrollHeight);
            const viewportHeight = await page.evaluate(() => window.innerHeight);
            const scrollSteps = Math.ceil(pageHeight / 300) + 5; // More scroll steps

            console.log(`[DoorDash] Page height: ${pageHeight}, will scroll ${scrollSteps} times`);

            for (let scrollAttempt = 0; scrollAttempt < scrollSteps && !clicked; scrollAttempt++) {
                // Periodically screenshot during scroll to show search progress
                if (scrollAttempt % 4 === 0) {
                    await takeScreenshot(`searching-scroll-${scrollAttempt}`);
                }

                // Try to find and click the item at current scroll position
                const result = await page.evaluate((name) => {
                    const lowerName = name.toLowerCase().trim();

                    // STRATEGY 1: Find headings/titles that exactly match our item name
                    // Menu item names are usually in h1-h4, span, or div elements
                    const titleElements = document.querySelectorAll('h1, h2, h3, h4, h5, span, div');

                    for (const titleEl of titleElements) {
                        // Get DIRECT text content only (not nested elements)
                        let directText = '';
                        for (const node of titleEl.childNodes) {
                            if (node.nodeType === Node.TEXT_NODE) {
                                directText += node.textContent;
                            }
                        }
                        directText = directText.trim().toLowerCase();

                        // Also try the full text if direct text is empty
                        const fullText = titleEl.textContent?.trim()?.toLowerCase() || '';

                        // Check if this element's text IS the item name (not just contains it)
                        const isExactMatch = directText === lowerName ||
                                            directText.startsWith(lowerName) ||
                                            fullText === lowerName ||
                                            (fullText.startsWith(lowerName) && fullText.length < lowerName.length + 30);

                        if (!isExactMatch) continue;

                        const rect = titleEl.getBoundingClientRect();
                        if (rect.top < -50 || rect.top > window.innerHeight + 50) continue;
                        if (rect.left < 150) continue;

                        // Found the title! Now find the parent card to click
                        let cardEl = titleEl;
                        for (let i = 0; i < 5; i++) {
                            const parent = cardEl.parentElement;
                            if (!parent) break;
                            const parentRect = parent.getBoundingClientRect();
                            // Parent should be a reasonable card size
                            if (parentRect.width > 100 && parentRect.width < 500 &&
                                parentRect.height > 60 && parentRect.height < 400) {
                                cardEl = parent;
                            }
                            // Stop if parent is too big
                            if (parentRect.width > 600 || parentRect.height > 500) break;
                        }

                        console.log('[FindItem] Found title match:', directText || fullText.substring(0, 40));
                        cardEl.scrollIntoView({ behavior: 'instant', block: 'center' });

                        // Get coordinates AFTER scroll so they're accurate
                        const cardRect = cardEl.getBoundingClientRect();
                        return {
                            found: true,
                            strategy: 'title-match',
                            text: directText || fullText.substring(0, 40),
                            x: cardRect.left + cardRect.width / 2,
                            y: cardRect.top + cardRect.height / 2
                        };
                    }

                    // STRATEGY 2: Look for menu item cards where first line matches
                    const cards = document.querySelectorAll(`
                        article, [role="button"],
                        [class*="MenuItem"], [class*="ItemCard"], [class*="StoreItem"],
                        button, a
                    `.replace(/\s+/g, ' '));

                    for (const card of cards) {
                        const text = card.textContent || '';
                        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                        const firstLine = lines[0]?.toLowerCase() || '';

                        // First line should BE the item name or start with it
                        if (firstLine !== lowerName && !firstLine.startsWith(lowerName)) continue;

                        // Must have a price somewhere
                        if (!text.match(/\$\d+/)) continue;

                        const rect = card.getBoundingClientRect();
                        if (rect.width < 100 || rect.width > 450) continue;
                        if (rect.height < 50 || rect.height > 350) continue;
                        if (rect.left < 150) continue;
                        if (rect.top < -50 || rect.top > window.innerHeight + 50) continue;

                        console.log('[FindItem] Found card match:', firstLine.substring(0, 40));
                        card.scrollIntoView({ behavior: 'instant', block: 'center' });

                        // Get coordinates AFTER scroll so they're accurate
                        const cardRect = card.getBoundingClientRect();
                        return {
                            found: true,
                            strategy: 'card-match',
                            text: firstLine.substring(0, 40),
                            x: cardRect.left + cardRect.width / 2,
                            y: cardRect.top + cardRect.height / 2
                        };
                    }

                    return { found: false };
                }, searchName);

                if (result.found) {
                    console.log(`[DoorDash] Found "${searchName}" via ${result.strategy}: ${result.text}`);
                    console.log(`[DoorDash] Card center: (${result.x?.toFixed(0)}, ${result.y?.toFixed(0)})`);
                    await delay(400);
                    await takeScreenshot(`found-item-scroll-${scrollAttempt}`);

                    // Click directly at the card's center coordinates from scrollIntoView
                    // (avoids re-searching with locator which lands on text span instead of card)
                    if (result.x && result.y) {
                        console.log(`[DoorDash] Clicking card at (${result.x.toFixed(0)}, ${result.y.toFixed(0)})...`);
                        await page.mouse.click(result.x, result.y);
                        clicked = true;
                        break;
                    }
                }

                // Scroll down to continue searching
                await page.evaluate(() => window.scrollBy(0, 300));
                await delay(350);
            }

            if (!clicked) {
                console.log(`[DoorDash] Could not find "${searchName}" after full page scroll`);
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

                // Now click at the position
                await page.mouse.click(target.x, target.y);
                clicked = true;
            } else {
                return { success: false, error: `Item ${index + 1} not found on page. Only found ${allItems.length} items.` };
            }
        }

        if (!clicked) {
            return { success: false, error: 'Could not open item. Please try selecting again.' };
        }

        await delay(2500);
        await takeScreenshot('after-item-click');

        // Check if a modal/dialog opened
        let modalOpened = await page.$('[role="dialog"], [data-testid*="modal"], [class*="Modal"], [class*="modal"], [aria-modal="true"]');

        // If no modal yet, wait a bit longer and check again
        if (!modalOpened) {
            console.log('[DoorDash] No modal yet, waiting longer...');
            await delay(2000);
            await takeScreenshot('after-item-click-retry');
            modalOpened = await page.$('[role="dialog"], [data-testid*="modal"], [class*="Modal"], [class*="modal"], [aria-modal="true"]');
        }

        if (modalOpened) {
            console.log('[DoorDash] Item modal opened');
            await takeScreenshot('item-modal');
            await delay(1000);

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
            return { success: true, message: 'Attempted to add item' };
        } else {
            // No modal - DoorDash adds simple items (drinks, sides, etc.) directly without a modal
            // If we found the item and clicked it, assume it was added successfully
            console.log('[DoorDash] No modal detected - item likely added directly to cart');
            await takeScreenshot('no-modal-direct-add');
            stopDebugScreenshots();
            return { success: true, message: 'Item added to cart (no customization needed)' };
        }

    } catch (error) {
        console.error('[DoorDash] Add item error:', error.message);
        stopDebugScreenshots();
        await takeScreenshot('add-item-error');
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

        // If structured approach found nothing, dump modal HTML for debugging and try broader extraction
        if (optionGroups.length === 0) {
            console.log('[DoorDash] Structured extraction found 0 groups — dumping modal HTML and trying broad extraction...');

            // Dump modal HTML to file for inspection
            const modalHtml = await page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                return modal ? modal.innerHTML.substring(0, 30000) : 'NO MODAL FOUND';
            });
            const htmlPath = path.join(BROWSER_DATA_DIR, 'modal-debug.html');
            fs.writeFileSync(htmlPath, modalHtml);
            console.log(`[DoorDash] Modal HTML saved to: ${htmlPath}`);

            // Broad extraction: find ALL radiogroups and groups with "Required" anywhere
            const broadGroups = await page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                if (!modal) return [];

                const groups = [];
                const seen = new Set();

                // Strategy A: Find [role="radiogroup"] elements — the most reliable indicator
                const radioGroups = modal.querySelectorAll('[role="radiogroup"], [role="group"]');
                for (const rg of radioGroups) {
                    const fullText = rg.textContent?.toLowerCase() || '';
                    // Skip if it looks optional
                    if (fullText.includes('optional')) continue;

                    // Find the group's label/name (sibling or nearby heading)
                    let groupName = '';
                    const prev = rg.previousElementSibling;
                    if (prev) groupName = prev.textContent?.trim() || '';
                    if (!groupName || groupName.length > 50) {
                        // Try parent's first heading
                        const parent = rg.parentElement;
                        if (parent) {
                            const heading = parent.querySelector('h1,h2,h3,h4,h5,span,p');
                            if (heading) groupName = heading.textContent?.trim()?.split('\n')[0] || '';
                        }
                    }
                    if (!groupName) groupName = 'Choose an option';
                    // Trim noise from name
                    groupName = groupName.split(/required|select|choose|pick|\d+\s*cal/i)[0].trim();
                    if (groupName.length > 40) groupName = groupName.substring(0, 40);
                    if (!groupName) continue;
                    if (seen.has(groupName.toLowerCase())) continue;

                    // Extract options: radios, checkboxes, list items inside this group
                    const optEls = rg.querySelectorAll('[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"], li, label');
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
                    if (options.length === 0) continue;

                    // Check selection: aria-checked OR input:checked OR label[for]→input.checked
                    const isSelected = rg.querySelector('[aria-checked="true"]') !== null ||
                        Array.from(rg.querySelectorAll('label[for]')).some(l => {
                            const inp = document.getElementById(l.htmlFor);
                            return inp && inp.checked;
                        }) ||
                        rg.querySelector('input:checked') !== null;
                    seen.add(groupName.toLowerCase());
                    groups.push({ name: groupName, options: options.slice(0, 10), required: true, hasSelection: isSelected });
                }

                // Strategy B: Look for divs that contain "Required" text (looser than before)
                if (groups.length === 0) {
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
            });

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
                options: options.slice(0, 10).map(o => o.price ? `${o.name} (${o.price})` : o.name),
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

        // First, scroll through the modal to make sure all sections are loaded
        await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (modal) {
                // Scroll to bottom and back to trigger lazy loading
                modal.scrollTop = modal.scrollHeight;
            }
        });
        await delay(300);
        await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (modal) modal.scrollTop = 0;
        });
        await delay(300);

        // Find unselected radio buttons and get their coordinates
        const unselectedOptions = await page.evaluate(() => {
            const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
            if (!modal) return [];

            const options = [];

            // Find all radio buttons in the modal
            const radios = Array.from(modal.querySelectorAll('[role="radio"]'));
            console.log('[AutoSelect] Found', radios.length, 'radio buttons in modal');

            if (radios.length === 0) return [];

            // Group radios by finding their radiogroup parent or by proximity
            // DoorDash uses [role="radiogroup"] for option groups
            const radioGroups = modal.querySelectorAll('[role="radiogroup"]');
            console.log('[AutoSelect] Found', radioGroups.length, 'radiogroups');

            if (radioGroups.length > 0) {
                // Use radiogroups for grouping
                for (const group of radioGroups) {
                    const groupRadios = group.querySelectorAll('[role="radio"]');
                    let hasSelection = false;
                    let firstUnselected = null;

                    for (const radio of groupRadios) {
                        const isChecked = radio.getAttribute('aria-checked') === 'true';
                        if (isChecked) {
                            hasSelection = true;
                            break;
                        }
                        if (!firstUnselected) {
                            firstUnselected = radio;
                        }
                    }

                    if (!hasSelection && firstUnselected) {
                        const rect = firstUnselected.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            const text = firstUnselected.textContent?.trim()?.substring(0, 50) || 'unknown';
                            console.log('[AutoSelect] Will click (radiogroup):', text);
                            options.push({
                                x: rect.left + rect.width / 2,
                                y: rect.top + rect.height / 2,
                                text: text,
                                needsScroll: rect.top < 0 || rect.top > window.innerHeight
                            });
                        }
                    }
                }
            } else {
                // Fallback: group by vertical position (radios close together are in same group)
                // Sort radios by vertical position
                radios.sort((a, b) => {
                    const rectA = a.getBoundingClientRect();
                    const rectB = b.getBoundingClientRect();
                    return rectA.top - rectB.top;
                });

                // Group radios that are within 150px vertically of each other
                const groups = [];
                let currentGroup = [];
                let lastTop = -1000;

                for (const radio of radios) {
                    const rect = radio.getBoundingClientRect();
                    if (rect.top - lastTop > 150 && currentGroup.length > 0) {
                        groups.push(currentGroup);
                        currentGroup = [];
                    }
                    currentGroup.push(radio);
                    lastTop = rect.top;
                }
                if (currentGroup.length > 0) groups.push(currentGroup);

                console.log('[AutoSelect] Grouped into', groups.length, 'groups by position');

                // For each group, check if it has a selection
                for (const group of groups) {
                    let hasSelection = false;
                    let firstUnselected = null;

                    for (const radio of group) {
                        const isChecked = radio.getAttribute('aria-checked') === 'true';
                        if (isChecked) {
                            hasSelection = true;
                            break;
                        }
                        if (!firstUnselected) {
                            firstUnselected = radio;
                        }
                    }

                    if (!hasSelection && firstUnselected) {
                        const rect = firstUnselected.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            const text = firstUnselected.textContent?.trim()?.substring(0, 50) || 'unknown';
                            console.log('[AutoSelect] Will click (position group):', text);
                            options.push({
                                x: rect.left + rect.width / 2,
                                y: rect.top + rect.height / 2,
                                text: text,
                                needsScroll: rect.top < 0 || rect.top > window.innerHeight
                            });
                        }
                    }
                }
            }

            return options;
        });

        console.log(`[DoorDash] Found ${unselectedOptions.length} unselected options to auto-select`);

        // Click each unselected option using native Playwright clicks
        for (const opt of unselectedOptions) {
            // If element needs scrolling, scroll it into view first
            if (opt.needsScroll) {
                console.log(`[DoorDash] Scrolling to option: "${opt.text}"`);
                await page.evaluate((optText) => {
                    const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                    if (!modal) return;

                    const radios = modal.querySelectorAll('[role="radio"]');
                    for (const radio of radios) {
                        if (radio.textContent?.includes(optText.substring(0, 20))) {
                            radio.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            break;
                        }
                    }
                }, opt.text);
                await delay(500);

                // Re-get coordinates after scroll
                const newCoords = await page.evaluate((optText) => {
                    const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                    if (!modal) return null;

                    const radios = modal.querySelectorAll('[role="radio"]');
                    for (const radio of radios) {
                        if (radio.textContent?.includes(optText.substring(0, 20))) {
                            const rect = radio.getBoundingClientRect();
                            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                        }
                    }
                    return null;
                }, opt.text);

                if (newCoords) {
                    opt.x = newCoords.x;
                    opt.y = newCoords.y;
                }
            }

            console.log(`[DoorDash] Auto-clicking: "${opt.text}" at (${opt.x}, ${opt.y})`);
            await page.mouse.click(opt.x, opt.y);
            await delay(400);
        }

        await takeScreenshot('after-auto-select-all');
        return unselectedOptions.length;
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

        for (const sel of selections) {
            console.log(`[DoorDash] Processing selection: group=${sel.groupIndex}, option=${sel.optionIndex}, text="${sel.optionText || 'N/A'}"`);

            // Phase 1: find coordinates of the target label (don't click yet)
            const coords = await page.evaluate(({ groupIdx, optIdx, optText }) => {
                const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
                if (!modal) return { found: false, reason: 'no modal' };

                const groups = modal.querySelectorAll('[role="radiogroup"], [role="group"]');
                if (groupIdx >= groups.length) {
                    return { found: false, reason: `group ${groupIdx} not found (only ${groups.length} groups)` };
                }
                const group = groups[groupIdx];
                group.scrollIntoView({ block: 'nearest' });

                const labels = group.querySelectorAll('label');
                if (labels.length === 0) return { found: false, reason: 'no labels in group' };

                // Find best matching label by text score
                let bestLabel = null;
                let bestScore = -1;
                let bestLabelText = '';

                if (optText) {
                    const lower = optText.toLowerCase();
                    for (const label of labels) {
                        const text = (label.textContent || '').trim().toLowerCase();
                        let score = -1;
                        if (text === lower) score = 3;
                        else if (text.startsWith(lower + ' ') || text.startsWith(lower + '\n')) score = 2;
                        else if (text.startsWith(lower)) score = 1;
                        if (score > bestScore) { bestScore = score; bestLabel = label; bestLabelText = text; }
                        if (bestScore === 3) break;
                    }
                }
                // Fall back to index if no text match
                if (!bestLabel || bestScore < 0) {
                    const idx = Math.min(optIdx, labels.length - 1);
                    bestLabel = labels[idx];
                    bestLabelText = (bestLabel.textContent || '').trim().substring(0, 40);
                    bestScore = -99;
                }

                bestLabel.scrollIntoView({ block: 'nearest' });
                const rect = bestLabel.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return { found: false, reason: 'label not visible' };

                // If label wraps an input, use input coords for more reliable click target
                const inputEl = bestLabel.htmlFor ? document.getElementById(bestLabel.htmlFor)
                              : bestLabel.querySelector('input');
                let x, y;
                if (inputEl) {
                    const ir = inputEl.getBoundingClientRect();
                    x = ir.left + ir.width / 2;
                    y = ir.top + ir.height / 2;
                } else {
                    x = rect.left + rect.width / 2;
                    y = rect.top + rect.height / 2;
                }

                return { found: true, x, y, score: bestScore, text: bestLabelText.substring(0, 40) };
            }, { groupIdx: sel.groupIndex, optIdx: sel.optionIndex, optText: sel.optionText || '' });

            console.log(`[DoorDash] Group ${sel.groupIndex} coords:`, JSON.stringify(coords));

            if (coords.found) {
                // Phase 2: use real Playwright mouse click (triggers all pointer/focus events React needs)
                await page.mouse.click(coords.x, coords.y);
                console.log(`[DoorDash] Mouse-clicked "${coords.text}" at (${coords.x.toFixed(0)}, ${coords.y.toFixed(0)})`);
            } else {
                console.log(`[DoorDash] Could not find option: ${coords.reason}`);
            }

            await delay(500);
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
        console.log(`[DoorDash] Clicking Add button at (${buttonCoords.x}, ${buttonCoords.y}): ${buttonCoords.text}`);
        await page.mouse.click(buttonCoords.x, buttonCoords.y);
        await delay(2000);
        await takeScreenshot('after-add-button-click');

        // Check if modal closed
        const modalStillOpen = await page.$('[role="dialog"], [aria-modal="true"]');
        if (!modalStillOpen) {
            console.log('[DoorDash] Modal closed - item added successfully!');
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

        if (lower.includes('delivered') || lower.includes('enjoy your')) {
            status = 'delivered';
            statusText = 'Your order has been delivered!';
        } else if (lower.includes('on the way') || lower.includes('heading to you') || lower.includes('almost there')) {
            status = 'on_the_way';
            statusText = 'Your Dasher is on the way!';
        } else if (lower.includes('picked up') || lower.includes('dasher picked') || lower.includes('heading to the restaurant') === false && lower.includes('picked')) {
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
 * Navigate to a restaurant page (for recovery after server restart)
 */
async function navigateToRestaurantPage(url) {
    if (!page || !context) {
        await launchBrowser();
    }
    console.log(`[DoorDash] Navigating to restaurant page for recovery: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
    }
    await context.addCookies(cookies);
    console.log(`[DoorDash] Imported ${cookies.length} cookies`);
    return { success: true };
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
    placeOrder,
    getOrderConfirmation,
    placeFullOrder,
    checkoutCurrentCart,
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
    searchRestaurantsNearAddress,
    extractRestaurantList,
    sortRestaurantsByRating,
    sortRestaurantsByRelevance,
    getRestaurantMenu,
    extractMenuItems,
    extractMenuCategories,
    getMenuItemsInCategory,
    selectRestaurantFromSearch,
    addItemByIndex,
    navigateToRestaurantPage,
    clearBrowserCart,
    getOrderStatus,
    exportCookies,
    importCookies
};
