/**
 * DoorDash Internal API Module
 * Extracts session cookies from the saved Chrome profile (no CAPTCHA needed
 * since the user already logged in manually) and uses them for direct API calls.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SESSION_FILE = path.join(__dirname, 'doordash-session.json');
const CHROME_INSTALLED_CHECK = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const BOT_PROFILE_DIR = CHROME_INSTALLED_CHECK
    ? 'C:\\Users\\hatch\\AppData\\Local\\MessageAI\\ChromeProfile'
    : require('path').join(process.env.BROWSER_DATA_DIR || '/data/browser-data', 'ChromeProfile');
const HEADLESS_API = process.env.DOORDASH_HEADLESS !== 'false';
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Headers that mimic a real browser request
function buildHeaders(cookies, extraHeaders = {}) {
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'Origin': 'https://www.doordash.com',
        'Referer': 'https://www.doordash.com/',
        'Cookie': cookieString,
        ...extraHeaders,
    };
}

// --- Session management ---

function loadSession() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            if (data.cookies && data.expires_at && Date.now() < data.expires_at) {
                console.log('[DoorDash API] Loaded saved session');
                return data;
            }
            console.log('[DoorDash API] Saved session expired');
        }
    } catch (e) {
        console.log('[DoorDash API] Could not load session:', e.message);
    }
    return null;
}

function saveSession(data) {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
    console.log('[DoorDash API] Session saved');
}

// --- Extract cookies from Chrome profile ---

async function extractCookiesFromBrowser() {
    console.log('[DoorDash API] Launching Chrome to extract session cookies...');
    console.log('[DoorDash API] (Using saved profile - no login needed)');

    const CHROME_INSTALLED = fs.existsSync(CHROME_EXE);
    let context = null;

    try {
        context = await chromium.launchPersistentContext(BOT_PROFILE_DIR, {
            headless: HEADLESS_API,
            channel: CHROME_INSTALLED ? 'chrome' : undefined,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-infobars',
            ],
            ignoreDefaultArgs: ['--enable-automation'],
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        const page = context.pages()[0] || await context.newPage();
        page.setDefaultTimeout(30000);

        // Navigate to DoorDash to activate session cookies
        console.log('[DoorDash API] Navigating to DoorDash...');
        await page.goto('https://www.doordash.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));

        // Check if we're logged in
        const pageContent = await page.content();
        const isLoggedIn = pageContent.includes('/account') || pageContent.includes('/orders') ||
                           !pageContent.includes('Sign in or Sign up');
        console.log('[DoorDash API] Logged in:', isLoggedIn);

        if (!isLoggedIn) {
            console.log('[DoorDash API] Not logged in - please run manual-login.js first!');
            return null;
        }

        // Get all cookies for DoorDash domains
        const allCookies = await context.cookies([
            'https://www.doordash.com',
            'https://identity.doordash.com',
            'https://api.doordash.com',
        ]);

        console.log(`[DoorDash API] Extracted ${allCookies.length} cookies`);

        // Log cookie names for debugging (not values)
        const cookieNames = allCookies.map(c => c.name).join(', ');
        console.log('[DoorDash API] Cookie names:', cookieNames);

        // Look for JWT/auth token in cookies
        let accessToken = null;
        const tokenCookies = ['access_token', 'jwt', 'auth_token', 'consumer_token', 'dd_access_token', 'sessionToken'];
        for (const name of tokenCookies) {
            const cookie = allCookies.find(c => c.name === name);
            if (cookie) {
                accessToken = cookie.value;
                console.log(`[DoorDash API] Found auth token in cookie: ${name}`);
                break;
            }
        }

        return { cookies: allCookies, accessToken };

    } finally {
        if (context) {
            try { await context.close(); } catch (e) {}
        }
    }
}

async function getSession() {
    // Try saved session first
    const saved = loadSession();
    if (saved) return saved;

    // Extract from browser
    const extracted = await extractCookiesFromBrowser();
    if (!extracted) {
        throw new Error('Not logged in to DoorDash. Please run: node manual-login.js');
    }

    const session = {
        cookies: extracted.cookies,
        accessToken: extracted.accessToken,
        created_at: Date.now(),
        expires_at: Date.now() + (12 * 60 * 60 * 1000), // 12 hours
    };

    saveSession(session);
    return session;
}

// --- Geocoding ---

async function geocodeAddress(address) {
    console.log('[DoorDash API] Geocoding:', address);

    // Try multiple query formats for Nominatim
    const queries = [
        address,
        address.replace(/\b(S|N|E|W)\b/g, m => ({ S: 'South', N: 'North', E: 'East', W: 'West' }[m])),
        address.split(' ').slice(0, -1).join(' '), // without zip
    ];

    for (const q of queries) {
        try {
            const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=us`;
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'MessageAI/1.0 (personal-food-assistant)',
                    'Accept': 'application/json',
                },
            });

            if (!response.ok) continue;

            const results = await response.json();
            if (results.length) {
                const { lat, lon, display_name } = results[0];
                console.log('[DoorDash API] Geocoded to:', display_name);
                return { lat: parseFloat(lat), lng: parseFloat(lon) };
            }
        } catch (e) {
            console.log('[DoorDash API] Nominatim attempt failed:', e.message);
        }
        // Small delay between Nominatim requests
        await new Promise(r => setTimeout(r, 500));
    }

    // Fallback: hard-code Draper UT coordinates if address matches
    if (/draper/i.test(address) && /utah|ut\b/i.test(address)) {
        console.log('[DoorDash API] Using Draper UT fallback coordinates');
        return { lat: 40.5247, lng: -111.8638 };
    }

    throw new Error(`Could not geocode address: ${address}`);
}

// --- Restaurant Search via DoorDash GraphQL ---

async function searchViaGraphQL(session, lat, lng, query) {
    console.log('[DoorDash API] Searching via GraphQL...');

    const headers = buildHeaders(session.cookies, {
        'Content-Type': 'application/json',
    });
    if (session.accessToken) {
        headers['Authorization'] = `Bearer ${session.accessToken}`;
    }

    const body = JSON.stringify({
        operationName: 'getStoreListPage',
        variables: { lat, lng, query: query || '', offset: 0, limit: 20 },
        query: `query getStoreListPage($lat: Float, $lng: Float, $query: String, $offset: Int, $limit: Int) {
            searchStores(lat: $lat, lng: $lng, query: $query, offset: $offset, limit: $limit) {
                stores {
                    id name description averageRating numRatings
                    deliveryFee { displayString }
                    deliveryMinutes headerImgUrl priceRange isOpen
                    url
                }
            }
        }`,
    });

    const response = await fetch('https://www.doordash.com/graphql/getStoreListPage', {
        method: 'POST',
        headers,
        body,
    });

    console.log('[DoorDash API] GraphQL status:', response.status);
    const text = await response.text();

    if (!response.ok) {
        console.log('[DoorDash API] GraphQL error:', text.slice(0, 200));
        return null;
    }

    try {
        const data = JSON.parse(text);
        return data?.data?.searchStores?.stores || null;
    } catch (e) {
        console.log('[DoorDash API] GraphQL parse error:', text.slice(0, 200));
        return null;
    }
}

async function searchViaRestAPI(session, lat, lng, query) {
    console.log('[DoorDash API] Searching via REST API...');

    const params = new URLSearchParams({
        lat: lat.toString(),
        lng: lng.toString(),
        query: query || '',
        limit: '20',
    });

    const headers = buildHeaders(session.cookies, { 'Accept': 'application/json' });
    if (session.accessToken) {
        headers['Authorization'] = `JWT ${session.accessToken}`;
    }

    const url = `https://api.doordash.com/v1/consumer/consumer_store_search/?${params}`;
    const response = await fetch(url, { headers });

    console.log('[DoorDash API] REST status:', response.status);
    const text = await response.text();

    if (!response.ok) {
        console.log('[DoorDash API] REST error:', text.slice(0, 200));
        return null;
    }

    try {
        const data = JSON.parse(text);
        return data.results || data.stores || data.data || null;
    } catch (e) {
        return null;
    }
}

function normalizeStore(store) {
    return {
        name: store.name || store.store_name || 'Unknown',
        id: store.id || store.store_id,
        url: store.url || (store.id ? `https://www.doordash.com/store/${store.id}/` : null),
        rating: store.averageRating || store.average_rating || store.rating || null,
        numRatings: store.numRatings || store.num_ratings || 0,
        deliveryFee: store.deliveryFee?.displayString || store.delivery_fee || 'Unknown',
        deliveryMinutes: store.deliveryMinutes || store.delivery_minutes || null,
        isOpen: store.isOpen !== false && store.is_open !== false,
        description: store.description || '',
    };
}

// --- Main exported function ---

async function searchRestaurantsNearAddress(credentials, address, query = '') {
    console.log('[DoorDash API] === STARTING API SEARCH ===');
    console.log('[DoorDash API] Query:', query || 'all');
    console.log('[DoorDash API] Address:', address);

    // Step 1: Get session (uses saved cookies or extracts from browser)
    const session = await getSession();

    // Step 2: Geocode address
    const { lat, lng } = await geocodeAddress(address);

    // Step 3: Search (try multiple endpoints)
    let rawStores = await searchViaGraphQL(session, lat, lng, query);
    if (!rawStores || rawStores.length === 0) {
        console.log('[DoorDash API] GraphQL returned nothing, trying REST...');
        rawStores = await searchViaRestAPI(session, lat, lng, query);
    }

    if (!rawStores || rawStores.length === 0) {
        // Session might be stale - clear it and try once more with fresh session
        console.log('[DoorDash API] No results - refreshing session and retrying...');
        try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
        const freshSession = await getSession();
        rawStores = await searchViaGraphQL(freshSession, lat, lng, query);
        if (!rawStores || rawStores.length === 0) {
            rawStores = await searchViaRestAPI(freshSession, lat, lng, query);
        }
    }

    if (!rawStores || rawStores.length === 0) {
        return { success: false, error: 'No restaurants found', restaurants: [] };
    }

    // Step 4: Normalize and return top 5
    const restaurants = rawStores
        .map(normalizeStore)
        .filter(r => r.name && r.name !== 'Unknown');

    restaurants.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const top5 = restaurants.slice(0, 5);

    console.log(`[DoorDash API] Returning ${top5.length} restaurants`);
    return { success: true, restaurants: top5, totalFound: restaurants.length, query };
}

module.exports = {
    searchRestaurantsNearAddress,
    getSession,
    extractCookiesFromBrowser,
    geocodeAddress,
};
