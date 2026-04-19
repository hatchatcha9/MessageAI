require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const twilio = require('twilio');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const restaurants = require('./restaurants');
const doordash = require('./doordash');

// In-memory log buffer for remote debugging
const logBuffer = [];
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...args) => { const line = args.join(' '); logBuffer.push(line); if (logBuffer.length > 2000) logBuffer.shift(); _origLog(...args); };
console.error = (...args) => { const line = '[ERR] ' + args.join(' '); logBuffer.push(line); if (logBuffer.length > 2000) logBuffer.shift(); _origErr(...args); };

const CRASH_LOG = 'C:/Users/hatch/Projects/MessageAI/crash.log';
process.on('uncaughtException', (err) => {
    fs.appendFileSync(CRASH_LOG, `\n[${new Date().toISOString()}] UncaughtException:\n${err?.stack || err}\n`);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    fs.appendFileSync(CRASH_LOG, `\n[${new Date().toISOString()}] UnhandledRejection:\n${reason?.stack || reason}\n`);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Anthropic client
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For Twilio webhook
app.use(express.static('public'));

// Twilio Configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

if (TWILIO_ACCOUNT_SID && TWILIO_PHONE) {
    console.log(`[Twilio] Enabled — sending from ${TWILIO_PHONE}`);
} else {
    console.log('[Twilio] Disabled - missing TWILIO_ACCOUNT_SID or TWILIO_PHONE in .env');
}

const SMS_MAX_CHARS = 1550; // Twilio API limit is 1600; stay under to be safe

function truncateSMS(text) {
    if (text.length <= SMS_MAX_CHARS) return text;
    return text.substring(0, SMS_MAX_CHARS - 30).trimEnd() + '\n\n...(reply "more" for rest)';
}

// Send SMS via Twilio
async function sendSMS(to, message) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE) {
        console.log(`[SMS Disabled] Would send to ${to}: ${message.substring(0, 50)}...`);
        return false;
    }

    const body = truncateSMS(message);
    if (body.length !== message.length) {
        console.warn(`[Twilio] Message truncated: ${message.length} → ${body.length} chars`);
    }

    try {
        const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        const result = await client.messages.create({ from: TWILIO_PHONE, to, body });
        console.log(`[Twilio] Sent to ${to} (${body.length} chars), sid: ${result.sid}`);
        return true;
    } catch (error) {
        console.error('[Twilio] Send failed:', error.message);
        return false;
    }
}

// Build system prompt with user context
function buildSystemPrompt(user, userAddress, preferences, cart, currentRestaurant, doordashMenu = null) {
    let context = '';

    if (userAddress) {
        context += `\nDelivery address: ${userAddress}`;
    } else {
        context += `\nNo delivery address saved yet`;
    }

    if (preferences.favoriteCuisines?.length) {
        context += `\nFavorite cuisines: ${preferences.favoriteCuisines.join(', ')}`;
    }

    if (preferences.dietaryRestrictions?.length) {
        context += `\nDietary restrictions: ${preferences.dietaryRestrictions.join(', ')}`;
    }

    // Order history for context
    const orderHistory = db.getUserOrders(user.id, 3);
    if (orderHistory.length > 0) {
        context += `\n\nRecent orders:`;
        orderHistory.forEach(order => {
            const items = order.items.map(i => i.name).join(', ');
            context += `\n- ${order.restaurant_name}: ${items}`;
        });
        context += `\n(User can say "order my usual" or "reorder" to get their last order)`;
    }

    // Cart info
    const cartEntries = Object.entries(cart.items || {});
    if (cartEntries.length > 0 && currentRestaurant) {
        context += `\n\nCurrent cart from ${currentRestaurant.name}:`;
        cartEntries.forEach(([, items]) => {
            items.forEach(item => {
                context += `\n- ${item.quantity}x ${item.name} ($${item.price})`;
            });
        });
    }

    // Warn Claude when no restaurant is selected — must search before adding items
    if (!currentRestaurant) {
        context += `\n\n⚠️ NO RESTAURANT SELECTED. Do NOT use [ADD_ITEM_NUM:] — there is no active menu. If user wants food, ALWAYS use [SEARCH: food_type] first, then let them pick a restaurant.`;
    }

    // DoorDash menu - include actual menu items from the restaurant
    if (doordashMenu && doordashMenu.length > 0 && currentRestaurant) {
        context += `\n\n=== CURRENT RESTAURANT: ${currentRestaurant.name} ===`;
        // Filter by budget if set — only show affordable items to Claude
        const budgetFilter = preferences.budget || null;
        const menuToShow = budgetFilter
            ? doordashMenu.filter(item => (item.price || 0) <= budgetFilter)
            : doordashMenu;
        if (budgetFilter) {
            context += `\n\n*** MENU UNDER $${budgetFilter.toFixed(2)} (budget filter active — DO NOT suggest items over this price) ***`;
        } else {
            context += `\n\n*** ACTUAL MENU FROM DOORDASH (USE ONLY THESE ITEMS - DO NOT MAKE UP OTHER ITEMS) ***`;
        }
        // Use original index so ADD_ITEM_NUM maps correctly
        menuToShow.forEach((item) => {
            const originalIndex = doordashMenu.indexOf(item) + 1;
            const desc = item.description ? ` — ${item.description}` : '';
            context += `\n${originalIndex}. ${item.name} - $${item.price?.toFixed(2) || '?.??'}${desc}`;
        });
        context += `\n*** END OF MENU ***`;
        context += `\n\nCRITICAL RULES FOR MENU:`;
        context += `\n- ONLY suggest items listed above (all ${menuToShow.length} items). These are the ACTUAL items from DoorDash.`;
        context += `\n- DO NOT invent, fabricate, or add any menu items that are not in the list above.`;
        context += `\n- When user asks for a TYPE of food (entree, side, drink, dessert, appetizer, etc.), scan ALL ${menuToShow.length} items above — not just the first few — and recommend the best matches by name and number. The user's SMS display only shows 15 at a time, but YOU can see everything.`;
        context += `\n- When user says a NUMBER, use [ADD_ITEM_NUM: that exact number].`;
        context += `\n- When user says an ITEM NAME (like "tres leches"), find the EXACT matching item in the menu above and use its number.`;
        context += `\n- DOUBLE CHECK: Before using [ADD_ITEM_NUM: X], verify that item X in the menu above matches what the user asked for.`;
        context += `\n- Example: If user says "tres leches" and menu shows "13. Tres Leches - $4.99", use [ADD_ITEM_NUM: 13]`;
    }

    // Pending option selection — user must pick an option, NOT add a new item
    if (preferences.pendingDoordashItem && preferences.pendingDoordashOptions) {
        const itemName = preferences.pendingDoordashItem.name;
        context += `\n\n⚠️ AWAITING OPTION SELECTION for "${itemName}". The user is responding to an options prompt.`;
        context += `\n- A NUMBER response means [SELECT_OPTION: number] — NOT [ADD_ITEM_NUM:]`;
        context += `\n- A TEXT response means [SELECT_OPTIONS_TEXT: text]`;
        context += `\n- Do NOT use [ADD_ITEM_NUM:] until the pending options are resolved.`;
    }

    // Budget mode
    if (preferences.budget) {
        context += `\n\nBudget: $${preferences.budget.toFixed(2)} per order - focus on items under this price`;
    }

    // Scheduled order
    if (preferences.scheduledOrder) {
        const { time, restaurantId } = preferences.scheduledOrder;
        const [h, m] = time.split(':').map(Number);
        const timeDisplay = `${h > 12 ? h - 12 : (h || 12)}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
        context += `\n\nScheduled order: set for ${timeDisplay} today`;
    }

    const isNewUser = !userAddress && (!preferences.favoriteCuisines?.length) && (db.getUserOrders(user.id, 1).length === 0);
    const onboarding = isNewUser ? `

NEW USER ONBOARDING: This person just texted for the first time. Welcome them warmly and in ONE message explain:
1. What MessageAI is ("I can find restaurants on DoorDash and order food for you via text!")
2. Ask for their delivery address first: "What's your delivery address?"
3. Mention DoorDash setup: "You'll also need to link your DoorDash account — say 'setup doordash email password' when ready."
Keep it friendly and brief. Do NOT search for food yet.` : '';

    return `You are MessageAI, an SMS-based food ordering assistant. You help users find restaurants, browse menus, and place orders.${onboarding}

USER INFO:${context || '\nNew user - no saved info yet'}

IMPORTANT - USE THESE COMMANDS IN YOUR RESPONSES:

1. SEARCH RESTAURANTS - When user wants food:
   [SEARCH: cuisine_type]

2. SELECT RESTAURANT - When user picks a restaurant by NUMBER (1, 2, 3, etc.):
   [SELECT: 1] or [SELECT: 2] etc.
   IMPORTANT: Use the NUMBER they said, not a restaurant name/ID!

3. ADD TO CART - When user picks menu items by NUMBER:
   [ADD_ITEM_NUM: 1] or [ADD_ITEM_NUM: 2] etc.
   For MULTIPLE items, use multiple commands: [ADD_ITEM_NUM: 1] [ADD_ITEM_NUM: 6]
   IMPORTANT: Use the NUMBER from the menu!
   NOTE: If an item needs options (like protein), the system will ask automatically.
   Just say "Adding [item]!" and use the command - DON'T list options yourself.

4. SELECT OPTION - When user picks a required option (like protein):
   - For a NUMBER response: [SELECT_OPTION: 1] or [SELECT_OPTION: 2] etc.
   - For TEXT responses (e.g. "flour, black beans, ranch"): [SELECT_OPTIONS_TEXT: flour, black, ranch]
   Use this when user responds to a "choose your options" prompt.
   For multi-option text, include key words from each selection separated by commas.

4. SHOW CART - Show current cart:
   [SHOW_CART]

5. CLEAR CART - Empty the cart:
   [CLEAR_CART]

6. PLACE ORDER - When user confirms order:
   [PLACE_ORDER]

7. SAVE ADDRESS - When user provides their address:
   [SAVE_ADDRESS: full address here]

8. MY ORDERS - Show order history:
   [MY_ORDERS]

9. REORDER - When user wants their usual/last order:
   [REORDER]
   Triggers: "order my usual", "same as last time", "reorder", "the usual"

10. SETUP DOORDASH - When user wants to connect their DoorDash account:
    [SETUP_DOORDASH: email | password]
    Triggers: "setup doordash", "connect doordash", "link doordash"
    Example: "setup doordash john@email.com mypassword123"

11. CHECK DOORDASH - Check if user has DoorDash credentials set up:
    [CHECK_DOORDASH]
    Triggers: "is doordash set up?", "check doordash", "doordash status"

12. ORDER STATUS - Check on current order:
    [ORDER_STATUS]
    Triggers: "where's my food", "where's my order", "order status", "how long until", "is my food here yet"

13. SCHEDULE ORDER - Schedule an order for later:
    [SCHEDULE_ORDER: HH:MM]
    Triggers: "order at 6pm", "schedule for 7:30", "set order for 8pm tonight"
    IMPORTANT: Convert to 24-hour format (6pm → 18:00, 7:30pm → 19:30, 12pm → 12:00, midnight → 00:00)
    Only use after user has items in cart.

14. CANCEL SCHEDULE - Cancel a scheduled order:
    [CANCEL_SCHEDULE]
    Triggers: "cancel schedule", "don't schedule", "cancel scheduled order"

15. BUDGET MODE - Set a spending limit per item:
    [SAVE_BUDGET: amount]
    Triggers: "something under $15", "keep it under $20", "budget $10", "cheap options", "what's cheap", "budget mode", "on a budget", "what's affordable"
    IMPORTANT: You MUST use this command. Do NOT just describe cheap options in text.
    If user says "budget mode" without a number, ask "What's your budget?" then use [SAVE_BUDGET: X] when they reply.
    If user says "under $X", extract X and use [SAVE_BUDGET: X] [SEARCH: ...]
    Example: "something under $15" → [SAVE_BUDGET: 15] [SEARCH: food]

16. CLEAR BUDGET - Remove budget limit:
    [CLEAR_BUDGET]
    Triggers: "no budget", "remove budget", "clear budget", "money is no object", "price doesn't matter"

17. REMOVE ITEM - Remove a specific item from cart:
    [REMOVE_ITEM: item name]
    Triggers: "remove the X", "take off the X", "don't want X", "delete X from cart", "get rid of X"
    Example: "remove the burrito" → [REMOVE_ITEM: burrito]
    IMPORTANT: Use this to remove ONE item. Use [CLEAR_CART] only when user wants to start completely over.

CRITICAL RULES:
- NEVER describe what a command does in your text. The system handles ALL confirmations automatically. Do NOT say "Address saved!", "Setting up your DoorDash account", "Budget set", "Cart cleared", etc. — just use the command. One brief sentence max (e.g. "On it!" or "Got it!").
- NEVER describe cart contents, list items, or calculate totals yourself. The system appends the real cart automatically.
- NEVER list restaurant search results or menu items in your text. The system appends results after [SEARCH:] and [SELECT:] automatically. Just say one short sentence like "Looking for pizza!" and use the command.
- When user says a NUMBER after seeing restaurants, use [SELECT: number]
- When user says a NUMBER after seeing a menu, use [ADD_ITEM_NUM: number]
- When user says an item NAME, use [ADD_ITEM_NUM: number] with the matching number
- The full menu is in your system prompt above — scan ALL items to find what the user wants, even if their SMS only showed 15 items. NEVER tell the user an item isn't available without checking the full menu above.
- NEVER use [SHOW_MENU] - the system shows it automatically after selecting
- ALWAYS use [SAVE_BUDGET: X] when user mentions a price limit, budget, or "cheap/affordable". NEVER just talk about it in text without the command.
- After [CLEAR_CART], if the user's next request involves food/ordering, ALWAYS follow up with [SEARCH: food_type] in the same response.
- If NO RESTAURANT IS SELECTED (no menu shown above), NEVER use [ADD_ITEM_NUM:]. You MUST use [SEARCH: food_type] first.
- If the user asks for a DIFFERENT type of food than what was just searched, ALWAYS use [SEARCH: new_type] — never pick from the old restaurant list.

NATURAL LANGUAGE - Understand these phrases:
- "I'm hungry" / "feed me" / "get me food" → Ask what cuisine or suggest based on history
- "something quick" / "fast food" → Search for fastest delivery options
- "something cheap" / "under $X" / "budget mode" → Use [SAVE_BUDGET: X] then [SEARCH: ...]
- "where's my food" / "order status" → Use [ORDER_STATUS]
- "order at Xpm" / "schedule for X" → Use [SCHEDULE_ORDER: HH:MM]
- "surprise me" → Pick something from their order history or a popular option
- "my usual" / "same as last time" / "reorder" → Use [REORDER]
- "what's good?" / "any recommendations?" → Suggest based on their history
- "cancel" / "start over" / "never mind" → Use [CLEAR_CART]
- After clearing cart, if user immediately requests food → Use [CLEAR_CART] then [SEARCH: food_type] in the same response
- "remove the X" / "take off X" / "delete X" → Use [REMOVE_ITEM: X] — NOT [CLEAR_CART]

PERSONALITY:
- Be casual and friendly, like texting a friend who knows good food
- Keep responses SHORT - this is SMS!
- Use their order history to make smart suggestions
- If they seem indecisive, make a recommendation
- Acknowledge their choice briefly, then use the command`;
}

// Get human-readable order status based on time elapsed
function getOrderStatusText(order) {
    const minutesAgo = Math.floor((Date.now() - new Date(order.placed_at).getTime()) / 60000);
    const name = order.restaurant_name;

    if (order.status === 'delivered') return `Your ${name} order has been delivered!`;
    if (order.status === 'cancelled') return `Your ${name} order was cancelled.`;

    if (minutesAgo < 5) {
        return `Order received at ${name}!\nThe restaurant just got your order.`;
    } else if (minutesAgo < 20) {
        return `${name} is preparing your food.\nOrdered ${minutesAgo} min ago.`;
    } else if (minutesAgo < 35) {
        return `Your driver picked up your order from ${name}!\nOn the way to you now.`;
    } else if (minutesAgo < 50) {
        return `Almost there! Your ${name} order is close.\nPlaced ${minutesAgo} min ago.`;
    } else {
        db.updateOrderStatus(order.id, 'delivered');
        return `Your ${name} order should have arrived by now. If something went wrong, reply "help" and we'll sort it out.`;
    }
}

function formatCheckoutError(error) {
    if (!error) return 'Could not complete checkout.';
    if (error.includes('Place Order button')) return "Couldn't reach the checkout button. Your cart is saved — try saying 'checkout' again.";
    if (error.includes('disabled'))           return "The checkout button was disabled. This usually means a payment or address issue — try again in a few minutes or reply 'help'.";
    if (error.includes('Browser not open'))   return "The browser session timed out. Search for a restaurant again to start fresh.";
    if (error.includes('EMPTY_CART'))          return "The DoorDash cart was reset (server restarted). Please search for the restaurant again and re-add your items.";
    if (error.includes('checkout page'))      return "Couldn't load the checkout page. Your cart is saved — try saying 'checkout' again.";
    return "Checkout ran into an issue. Your cart is saved — try saying 'checkout' again or reply 'help'.";
}

// Process commands from AI response
async function processCommands(response, user, phoneNumber) {
    let cleanResponse = response;
    let actions = [];
    let additionalContext = '';
    let textResolvedMenuIndex = -1; // tracks which menu index SELECT_OPTIONS_TEXT already added this turn

    // Budget — must run BEFORE search so the saved budget is visible to the search handler
    const budgetMatch = response.match(/\[SAVE_BUDGET:\s*(\d+(?:\.\d+)?)\]/i);
    if (budgetMatch) {
        const budget = parseFloat(budgetMatch[1]);
        const prefs = db.getUserPreferences(user.id);
        prefs.budget = budget;
        db.setUserPreferences(user.id, prefs);
        cleanResponse = cleanResponse.replace(budgetMatch[0], '').trim();
        // Only show confirmation when no search is also happening (search results make it obvious)
        if (!response.match(/\[SEARCH:/i)) {
            additionalContext = `\n\nBudget set to $${budget.toFixed(2)}! Items over your budget will be flagged on menus.`;
        }
        actions.push({ type: 'budget_set', amount: budget });
    }

    if (response.includes('[CLEAR_BUDGET]')) {
        const prefs = db.getUserPreferences(user.id);
        prefs.budget = null;
        db.setUserPreferences(user.id, prefs);
        cleanResponse = cleanResponse.replace('[CLEAR_BUDGET]', '').trim();
        additionalContext = `\n\nBudget cleared! All menu items will show again.`;
        actions.push({ type: 'budget_cleared' });
    }

    // Clear cart — must run BEFORE search so prefs are cleared and don't overwrite search results
    if (response.includes('[CLEAR_CART]')) {
        db.clearCart(user.id);
        doordash.clearBrowserCart().catch(() => {}); // sync DoorDash browser cart (non-blocking)
        const prefsForClear = db.getUserPreferences(user.id);
        prefsForClear.currentRestaurant = null;
        prefsForClear.currentRestaurantSource = null;
        prefsForClear.currentRestaurantUrl = null;
        prefsForClear.pendingItem = null;
        prefsForClear.pendingDoordashItem = null;
        prefsForClear.pendingDoordashOptions = null;
        prefsForClear.pendingDoordashSelections = null;
        db.setUserPreferences(user.id, prefsForClear);
        cleanResponse = cleanResponse.replace('[CLEAR_CART]', '').trim();
        // Only show "cart cleared" message if no search is following (search results make it obvious)
        if (!response.match(/\[SEARCH:/i)) {
            additionalContext = `\n\nCart cleared! What else can I help with?`;
        }
        actions.push({ type: 'clear_cart' });
    }

    // Search restaurants - always uses DoorDash
    const searchMatch = response.match(/\[SEARCH:\s*(.+?)\]/i);
    if (searchMatch) {
        const query = searchMatch[1].trim().toLowerCase();
        cleanResponse = cleanResponse.replace(searchMatch[0], '').trim();

        const prefs = db.getUserPreferences(user.id);
        const address = db.getUserAddress(user.id);

        const credentials = db.getDoorDashCredentials(user.id) || {
            email: process.env.DOORDASH_EMAIL,
            password: process.env.DOORDASH_PASSWORD
        };

        if (!address) {
            additionalContext = `\n\nI need your delivery address first. What's your address?`;
        } else {
            try {
                const searchResult = await doordash.searchRestaurantsNearAddress(credentials, address, query);
                if (searchResult.success && searchResult.restaurants.length > 0) {
                    db.cacheSearchResults(user.id, query, searchResult.restaurants);
                    prefs.lastSearchResults = searchResult.restaurants.map(r => r.id);
                    prefs.lastSearchSource = 'doordash';
                    prefs.lastSearchQuery = query;
                    db.setUserPreferences(user.id, prefs);
                    additionalContext = `\n\nTop ${searchResult.restaurants.length} results on DoorDash near you:\n\n`;
                    additionalContext += searchResult.restaurants.map((r, i) => {
                        let line = `${i + 1}. ${r.name.toUpperCase()}`;
                        let details = [];
                        if (r.rating) details.push(`★ ${r.rating}`);
                        if (r.deliveryTime) details.push(r.deliveryTime);
                        if (r.deliveryFee) details.push(r.deliveryFee);
                        if (details.length > 0) line += `\n   ${details.join(' · ')}`;
                        return line;
                    }).join('\n\n');
                    additionalContext += `\n\nWhich one? (Reply with the number)`;
                    actions.push({ type: 'search_doordash', query, count: searchResult.restaurants.length });
                } else {
                    const reason = searchResult.error || 'no results returned';
                    // Save the failed query so "try again" retries the right search
                    prefs.lastSearchQuery = query;
                    prefs.lastSearchResults = null;
                    db.setUserPreferences(user.id, prefs);
                    additionalContext = `\n\nSearch for "${query}" failed (${reason}). Use [SEARCH: ${query}] to try again.`;
                }
            } catch (error) {
                prefs.lastSearchQuery = query;
                prefs.lastSearchResults = null;
                db.setUserPreferences(user.id, prefs);
                additionalContext = `\n\nSearch for "${query}" crashed: ${error.message}. Use [SEARCH: ${query}] to try again.`;
            }
        }
    }

    // [SELECT_RESTAURANT:] is no longer used — restaurant selection goes through [SELECT: N] + DoorDash cache

    // Handle numeric selection (restaurant)
    const numberMatch = response.match(/\[SELECT:\s*(\d+)\]/i);
    if (numberMatch) {
        const num = parseInt(numberMatch[1]) - 1;
        const prefs = db.getUserPreferences(user.id);
        cleanResponse = cleanResponse.replace(numberMatch[0], '').trim();

        if (prefs.lastSearchResults && prefs.lastSearchResults[num]) {
            const restaurantId = prefs.lastSearchResults[num];

            // Check if this was a DoorDash search result
            if (prefs.lastSearchSource === 'doordash') {
                // Real DoorDash restaurant - navigate to it and get categories
                const credentials = db.getDoorDashCredentials(user.id);
                const cachedResults = db.getCachedSearchResults(user.id, prefs.lastSearchQuery);

                if (credentials && cachedResults && cachedResults[num]) {
                    const selectedRestaurant = cachedResults[num];
                    additionalContext = `\n\nLoading ${selectedRestaurant.name}...`;

                    try {
                        // Navigate to the restaurant page using the stored URL
                        const menuResult = await doordash.selectRestaurantFromSearch(selectedRestaurant.url || num);

                        if (menuResult.success) {
                            prefs.currentRestaurant = restaurantId;
                            prefs.currentRestaurantSource = 'doordash';
                            prefs.currentRestaurantUrl = menuResult.url;
                            // Clear pending option state when switching restaurants
                            delete prefs.pendingDoordashItem;
                            delete prefs.pendingDoordashOptions;
                            delete prefs.pendingDoordashSelections;
                            db.setUserPreferences(user.id, prefs);

                            // Clear cart and menu page when switching restaurants
                            db.clearCart(user.id);
                            doordash.clearBrowserCart().catch(() => {});
                            prefs.menuPage = 0;

                            const restaurantName = menuResult.restaurantName || selectedRestaurant.name;

                            // Use cached menu if fresh (30-min TTL), otherwise scrape
                            const cachedMenu = db.getCachedRestaurantMenu(user.id, restaurantId);
                            const menuItems = cachedMenu || await doordash.extractMenuItems();
                            console.log(`[DoorDash] ${cachedMenu ? 'Using cached' : 'Extracted'} ${menuItems.length} menu items`);

                            // Cache the restaurant data WITH menu
                            db.cacheCurrentRestaurant(user.id, {
                                id: restaurantId,
                                name: restaurantName,
                                categories: menuResult.categories || [],
                                url: menuResult.url,
                                source: 'doordash',
                                menu: menuItems
                            });

                            // Cache menu separately if freshly scraped
                            if (!cachedMenu && menuItems && menuItems.length > 0) {
                                db.cacheRestaurantMenu(user.id, restaurantId, menuItems);
                            }

                            // Replace AI filler text with just the menu
                            if (menuItems && menuItems.length > 0) {
                                const userPrefs = db.getUserPreferences(user.id);
                                const budget = userPrefs.budget || null;
                                const displayItems = budget
                                    ? menuItems.filter(item => (parseFloat(item.price) || 0) <= budget)
                                    : menuItems;

                                let menuText = `══════════════════\n`;
                                menuText += `  ${restaurantName.toUpperCase()}\n`;
                                if (budget) menuText += `  Under $${budget.toFixed(2)}\n`;
                                menuText += `══════════════════\n\n`;

                                if (displayItems.length === 0) {
                                    menuText += `No items available under $${budget.toFixed(2)} at this restaurant.`;
                                } else {
                                    // Cap at 15 items to stay under SMS length limits
                                    const PAGE_SIZE = 15;
                                    const pageItems = displayItems.slice(0, PAGE_SIZE);
                                    // Use original index so ADD_ITEM_NUM still maps correctly
                                    menuText += pageItems.map(item =>
                                        `${menuItems.indexOf(item) + 1}. ${item.name.toUpperCase()}\n   $${parseFloat(item.price || 0).toFixed(2)}${item.description ? ' · ' + item.description : ''}`
                                    ).join('\n\n');
                                    if (displayItems.length > PAGE_SIZE) {
                                        menuText += `\n\n(+${displayItems.length - PAGE_SIZE} more items — say "more menu" to see them)`;
                                    }
                                }
                                menuText += `\n\nWhat would you like? (Reply with item number)`;
                                cleanResponse = menuText;
                                additionalContext = '';
                            } else {
                                additionalContext = `\n\nReached ${restaurantName} but couldn't load menu items. Try selecting again?`;
                            }
                            actions.push({ type: 'select_restaurant_doordash', restaurant: restaurantName, menuItemCount: menuItems.length });

                            console.log(`[DoorDash] Selected restaurant: ${restaurantName}`);
                        } else {
                            additionalContext = `\n\nCouldn't load the menu. Try searching again?`;
                        }

                    } catch (error) {
                        console.error('[Select] DoorDash menu error:', error);
                        additionalContext = `\n\nError loading menu. Please try again.`;
                    }
                } else {
                    additionalContext = `\n\nSorry, that restaurant is no longer available. Try searching again?`;
                }
            } else {
                additionalContext = `\n\nSorry, that restaurant is no longer available. Try searching again?`;
            }
        } else {
            additionalContext = `\n\nSorry, that's not a valid option. Please pick a number from the list.`;
        }
    }

    // Show menu
    if (response.includes('[SHOW_MENU]')) {
        const prefs = db.getUserPreferences(user.id);
        cleanResponse = cleanResponse.replace('[SHOW_MENU]', '').trim();

        if (prefs.currentRestaurant && prefs.currentRestaurantSource === 'doordash') {
            const cachedRestaurant = db.getCachedCurrentRestaurant(user.id);
            if (cachedRestaurant && cachedRestaurant.menu && cachedRestaurant.menu.length > 0) {
                const budget = prefs.budget || null;
                const menuItems = cachedRestaurant.menu;
                const displayItems = budget
                    ? menuItems.filter(item => (parseFloat(item.price) || 0) <= budget)
                    : menuItems;
                let menuText = `══════════════════\n`;
                menuText += `  ${cachedRestaurant.name.toUpperCase()}\n`;
                if (budget) menuText += `  Under $${budget.toFixed(2)}\n`;
                menuText += `══════════════════\n\n`;
                if (displayItems.length === 0) {
                    menuText += `No items available under $${budget.toFixed(2)} at this restaurant.`;
                } else {
                    const PAGE_SIZE = 15;
                    const pageStart = prefs.menuPage ? prefs.menuPage * PAGE_SIZE : 0;
                    const pageItems = displayItems.slice(pageStart, pageStart + PAGE_SIZE);
                    menuText += pageItems.map(item =>
                        `${menuItems.indexOf(item) + 1}. ${item.name.toUpperCase()}\n   $${parseFloat(item.price || 0).toFixed(2)}${item.description ? ' · ' + item.description : ''}`
                    ).join('\n\n');
                    if (displayItems.length > pageStart + PAGE_SIZE) {
                        menuText += `\n\n(+${displayItems.length - pageStart - PAGE_SIZE} more — say "more menu")`;
                    }
                }
                additionalContext = `\n\n${menuText}`;
            } else {
                additionalContext = `\n\nMenu not available. Try selecting the restaurant again.`;
            }
            actions.push({ type: 'show_menu' });
        } else {
            additionalContext = `\n\nNo menu available. Try searching for a restaurant first.`;
        }
    }

    // "more menu" — show next page of menu items
    if (/\bmore menu\b/i.test(response) && !response.includes('[')) {
        const prefsMore = db.getUserPreferences(user.id);
        const cachedMore = db.getCachedCurrentRestaurant(user.id);
        if (cachedMore && cachedMore.menu) {
            const PAGE_SIZE = 15;
            prefsMore.menuPage = (prefsMore.menuPage || 0) + 1;
            db.setUserPreferences(user.id, prefsMore);
            const menuItems = cachedMore.menu;
            const displayItems = prefsMore.budget
                ? menuItems.filter(item => (parseFloat(item.price) || 0) <= prefsMore.budget)
                : menuItems;
            const pageStart = prefsMore.menuPage * PAGE_SIZE;
            const pageItems = displayItems.slice(pageStart, pageStart + PAGE_SIZE);
            if (pageItems.length === 0) {
                additionalContext = `\n\nThat's the whole menu!`;
                prefsMore.menuPage = 0;
                db.setUserPreferences(user.id, prefsMore);
            } else {
                let menuText = pageItems.map(item =>
                    `${menuItems.indexOf(item) + 1}. ${item.name.toUpperCase()}\n   $${parseFloat(item.price || 0).toFixed(2)}${item.description ? ' · ' + item.description : ''}`
                ).join('\n\n');
                if (displayItems.length > pageStart + PAGE_SIZE) {
                    menuText += `\n\n(+${displayItems.length - pageStart - PAGE_SIZE} more — say "more menu")`;
                }
                cleanResponse = menuText;
                additionalContext = '';
            }
        }
    }

    // Handle TEXT-based multi-option selection — runs BEFORE ADD_ITEM_NUM so pending options resolve first
    const textSelectMatch = response.match(/\[SELECT_OPTIONS_TEXT:\s*(.+?)\]/i);
    if (textSelectMatch) {
        cleanResponse = cleanResponse.replace(textSelectMatch[0], '').trim(); // always strip the command
        if (textSelectMatch[1]) {
            const prefsText = db.getUserPreferences(user.id);
            if (prefsText.pendingDoordashItem && prefsText.pendingDoordashOptions) {
                // Split by comma only to preserve multi-word phrases, then match positionally
                // e.g. "Teri Chicken, Kalua Pig, White Rice, Teri Sauce" → phrase[0] → group[0], phrase[1] → group[1], etc.
                const userPhrases = textSelectMatch[1].split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 0);
                console.log('[DoorDash] Text-based option selection (phrases):', userPhrases);
                const numGroups = prefsText.pendingDoordashOptions.length;
                const selectionsText = [];

                // Helper: find best matching option index in a group for a phrase
                // Priority: exact match > opt starts with phrase > phrase is first word of opt > substring
                function matchPhraseInGroup(group, phrase) {
                    if (!phrase) return null;
                    let bestIdx = -1, bestScore = 0;
                    for (let oIdx = 0; oIdx < group.options.length; oIdx++) {
                        const opt = group.options[oIdx].toLowerCase();
                        let score = 0;
                        if (opt === phrase) {
                            score = 4; // exact match
                        } else if (new RegExp('^' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)').test(opt)) {
                            score = 3; // opt starts with phrase then space or end
                        } else if (opt.split(' ')[0] === phrase) {
                            score = 2; // phrase is first word of opt
                        } else if (opt.includes(phrase)) {
                            score = 1; // substring fallback
                        }
                        if (score > bestScore) {
                            bestScore = score;
                            bestIdx = oIdx;
                        }
                    }
                    if (bestIdx >= 0) {
                        return { index: bestIdx, option: group.options[bestIdx] };
                    }
                    return null;
                }

                // Phase 1: positional matching — phrase[N] → group[N]
                for (let gIdx = 0; gIdx < numGroups; gIdx++) {
                    const group = prefsText.pendingDoordashOptions[gIdx];
                    const phrase = userPhrases[gIdx];
                    const match = matchPhraseInGroup(group, phrase);
                    let matchedOption, matchedIndex;
                    if (match) {
                        matchedOption = match.option;
                        matchedIndex = match.index;
                    } else if (group.options.length > 0) {
                        matchedOption = group.options[0];
                        matchedIndex = 0;
                    }
                    if (matchedOption) {
                        const cleanOption = matchedOption.replace(/\s*\(\+?\$[\d.]+\)\s*$/, '').trim();
                        selectionsText.push({ groupIndex: gIdx, optionIndex: matchedIndex, optionText: cleanOption });
                        console.log(`[DoorDash] Group ${gIdx} (${group.name}): Matched "${cleanOption}"`);
                    }
                }

                // Phase 2: overflow phrases — when user gave more phrases than groups,
                // map extras to last group (handles multi-select/checkbox groups like Five Guys toppings)
                if (userPhrases.length > numGroups && numGroups > 0) {
                    const lastGroupIdx = numGroups - 1;
                    const lastGroup = prefsText.pendingDoordashOptions[lastGroupIdx];
                    for (let pIdx = numGroups; pIdx < userPhrases.length; pIdx++) {
                        const match = matchPhraseInGroup(lastGroup, userPhrases[pIdx]);
                        if (match) {
                            const cleanOption = match.option.replace(/\s*\(\+?\$[\d.]+\)\s*$/, '').trim();
                            selectionsText.push({ groupIndex: lastGroupIdx, optionIndex: match.index, optionText: cleanOption });
                            console.log(`[DoorDash] Group ${lastGroupIdx} extra (checkbox): Matched "${cleanOption}"`);
                        }
                    }
                }
                prefsText.pendingDoordashSelections = selectionsText;
                db.setUserPreferences(user.id, prefsText);
                const itemText = prefsText.pendingDoordashItem;
                const numText = itemText.menuIndex;
                try {
                    let addResultText = await doordash.addItemByIndex(numText, { selectFirst: false, selections: selectionsText, skipOptionsCheck: true, restaurantUrl: prefsText.currentRestaurantUrl }, itemText);
                    // If browser was closed (server restart), re-navigate and retry
                    if (!addResultText.success && addResultText.browserNotOpen && prefsText.currentRestaurantUrl) {
                        console.log('[Recovery] Browser not open - navigating back to restaurant page...');
                        await doordash.navigateToRestaurantPage(prefsText.currentRestaurantUrl);
                        addResultText = await doordash.addItemByIndex(numText, { selectFirst: false, selections: selectionsText, skipOptionsCheck: true, restaurantUrl: prefsText.currentRestaurantUrl }, itemText);
                    }
                    if (addResultText.success) {
                        prefsText.pendingDoordashItem = null;
                        prefsText.pendingDoordashOptions = null;
                        prefsText.pendingDoordashSelections = null;
                        db.setUserPreferences(user.id, prefsText);
                        db.addToCart(user.id, prefsText.currentRestaurant, { id: itemText.id || `doordash-${numText}`, name: itemText.name, price: itemText.price || 0, source: 'doordash' });
                        actions.push({ type: 'add_item_doordash', item: itemText.name });
                        textResolvedMenuIndex = numText; // mark so ADD_ITEM_NUM won't re-add this item
                        // Show cart now — ADD_ITEM_NUM may not fire in the same response
                        const cartNow = db.getCart(user.id);
                        additionalContext = `\n\nAdded ${itemText.name}!\n\n${restaurants.formatCart(cartNow)}\n\nAnything else, or say "checkout" to order?`;
                    } else if (addResultText.needsOptions) {
                        additionalContext = `\n\nPlease select more options:\n`;
                        addResultText.requiredOptions.forEach(group => {
                            additionalContext += `**${group.name}**:\n`;
                            group.options.forEach((opt, oIdx) => { additionalContext += `   ${oIdx + 1}. ${opt}\n`; });
                        });
                        prefsText.pendingDoordashOptions = addResultText.requiredOptions;
                        db.setUserPreferences(user.id, prefsText);
                    } else if (addResultText.browserNotOpen) {
                        additionalContext = `\n\nBrowser session expired. Please search for a restaurant again.`;
                    } else {
                        additionalContext = `\n\nCouldn't add ${itemText.name}. Please try again.`;
                    }
                } catch (error) {
                    console.error('[AddItem] DoorDash text selection error:', error);
                    additionalContext = `\n\nError adding item. Please try again.`;
                }
            }
        }
    }

    // Handle numeric option selection — runs BEFORE ADD_ITEM_NUM so pending options resolve first
    const optionMatch = response.match(/\[SELECT_OPTION:\s*(\d+)\]/i);
    if (optionMatch) {
        const optNum = parseInt(optionMatch[1]) - 1;
        const prefsOpt = db.getUserPreferences(user.id);
        cleanResponse = cleanResponse.replace(optionMatch[0], '').trim();
        if (prefsOpt.pendingDoordashItem && prefsOpt.pendingDoordashOptions) {
            console.log('[DoorDash] Applying user option selection:', optNum);
            const selectionsOpt = [];
            for (let gIdx = 0; gIdx < prefsOpt.pendingDoordashOptions.length; gIdx++) {
                const group = prefsOpt.pendingDoordashOptions[gIdx];
                if (gIdx === 0) {
                    let optionText = (group.options[optNum] || '').replace(/\s*\(\+?\$[\d.]+\)\s*$/, '').trim();
                    selectionsOpt.push({ groupIndex: gIdx, optionIndex: optNum, optionText });
                    console.log(`[DoorDash] Group ${gIdx} (${group.name}): User selected "${optionText}"`);
                } else if (!group.hasSelection) {
                    const cleanOption = (group.options[0] || '').replace(/\s*\(\+?\$[\d.]+\)\s*$/, '').trim();
                    selectionsOpt.push({ groupIndex: gIdx, optionIndex: 0, optionText: cleanOption });
                    console.log(`[DoorDash] Group ${gIdx} (${group.name}): Auto-selecting "${cleanOption}"`);
                }
            }
            prefsOpt.pendingDoordashSelections = selectionsOpt;
            db.setUserPreferences(user.id, prefsOpt);
            const itemOpt = prefsOpt.pendingDoordashItem;
            const numOpt = itemOpt.menuIndex;
            try {
                let addResultOpt = await doordash.addItemByIndex(numOpt, { selectFirst: false, selections: selectionsOpt, skipOptionsCheck: true, restaurantUrl: prefsOpt.currentRestaurantUrl }, itemOpt);
                // If browser was closed (server restart), re-navigate and retry
                if (!addResultOpt.success && addResultOpt.browserNotOpen && prefsOpt.currentRestaurantUrl) {
                    console.log('[Recovery] Browser not open - navigating back to restaurant page...');
                    await doordash.navigateToRestaurantPage(prefsOpt.currentRestaurantUrl);
                    addResultOpt = await doordash.addItemByIndex(numOpt, { selectFirst: false, selections: selectionsOpt, skipOptionsCheck: true, restaurantUrl: prefsOpt.currentRestaurantUrl }, itemOpt);
                }
                if (addResultOpt.success) {
                    prefsOpt.pendingDoordashItem = null;
                    prefsOpt.pendingDoordashOptions = null;
                    prefsOpt.pendingDoordashSelections = null;
                    db.setUserPreferences(user.id, prefsOpt);
                    db.addToCart(user.id, prefsOpt.currentRestaurant, { id: itemOpt.id || `doordash-${numOpt}`, name: itemOpt.name, price: itemOpt.price || 0, source: 'doordash' });
                    actions.push({ type: 'add_item_doordash', item: itemOpt.name });
                    // Show cart now — ADD_ITEM_NUM may not fire in the same response
                    const cartOpt = db.getCart(user.id);
                    additionalContext = `\n\nAdded ${itemOpt.name}!\n\n${restaurants.formatCart(cartOpt)}\n\nAnything else, or say "checkout" to order?`;
                } else if (addResultOpt.needsOptions) {
                    additionalContext = `\n\nPlease select more options:\n`;
                    addResultOpt.requiredOptions.forEach((group, gIdx) => {
                        additionalContext += `**${group.name}**:\n`;
                        group.options.forEach((opt, oIdx) => { additionalContext += `${oIdx + 1}. ${opt}\n`; });
                    });
                    prefsOpt.pendingDoordashOptions = addResultOpt.requiredOptions;
                    db.setUserPreferences(user.id, prefsOpt);
                } else if (addResultOpt.browserNotOpen) {
                    additionalContext = `\n\nBrowser session expired. Please search for a restaurant again.`;
                } else {
                    additionalContext = `\n\nCouldn't add ${itemOpt.name}. Please try again.`;
                }
            } catch (error) {
                console.error('[DoorDash] Option selection error:', error);
                additionalContext = `\n\nError adding item. Please try again.`;
            }
        }
    }

    // [ADD_ITEM:] is deprecated — items are added via [ADD_ITEM_NUM:] using DoorDash menu indices

    // Add by number - handle multiple items (DoorDash)
    const addNumMatches = [...response.matchAll(/\[ADD_ITEM_NUM:\s*(\d+)\]/gi)];
    const itemsAdded = [];
    let needsOptionsBreak = false;

    for (let matchIdx = 0; matchIdx < addNumMatches.length; matchIdx++) {
        const match = addNumMatches[matchIdx];
        if (needsOptionsBreak) {
            cleanResponse = cleanResponse.replace(match[0], '').trim();
            continue;
        }
        const requestedNum = parseInt(match[1]);
        if (isNaN(requestedNum) || requestedNum < 1) continue;
        const num = requestedNum - 1; // Convert to 0-based index
        const prefs = db.getUserPreferences(user.id);
        cleanResponse = cleanResponse.replace(match[0], '').trim();

        // Log what Claude requested
        const currentRestaurant = db.getCachedCurrentRestaurant(user.id);
        const menuItem = currentRestaurant?.menu?.[num];
        console.log(`[ADD_ITEM_NUM] Claude requested item #${requestedNum}, index ${num}, which is: "${menuItem?.name || 'NOT FOUND'}"`);
        if (currentRestaurant?.menu) {
            console.log(`[ADD_ITEM_NUM] Menu has ${currentRestaurant.menu.length} items`);
        }

        if (prefs.currentRestaurant) {
            // Check if using DoorDash
            if (prefs.currentRestaurantSource === 'doordash') {
                // Real DoorDash item - get from cache and add via automation
                const currentRestaurant = db.getCachedCurrentRestaurant(user.id);

                const menuLen = currentRestaurant?.menu?.length ?? 'no menu';
                console.log(`[ADD_ITEM_NUM] Cache check: restaurant=${!!currentRestaurant}, menuLen=${menuLen}, num=${num}`);
                if (currentRestaurant && currentRestaurant.menu && currentRestaurant.menu[num]) {
                    const item = currentRestaurant.menu[num];

                    // If SELECT_OPTIONS_TEXT already added this item this turn, just show cart — don't re-add
                    if (num === textResolvedMenuIndex) {
                        console.log(`[ADD_ITEM_NUM] Skipping re-add of index ${num} — already resolved by SELECT_OPTIONS_TEXT`);
                        itemsAdded.push(item.name);
                        continue;
                    }

                    try {
                        // Check if we have pending selections for THIS SPECIFIC item
                        // Only use pending selections if they're for the same menu item
                        const isPendingItem = prefs.pendingDoordashItem &&
                                             prefs.pendingDoordashItem.menuIndex === num;
                        const pendingSelections = isPendingItem ? prefs.pendingDoordashSelections : null;

                        // If adding a DIFFERENT item, clear the old pending state
                        if (!isPendingItem && prefs.pendingDoordashItem) {
                            console.log('[DoorDash] Clearing old pending state - adding different item');
                            prefs.pendingDoordashItem = null;
                            prefs.pendingDoordashOptions = null;
                            prefs.pendingDoordashSelections = null;
                            db.setUserPreferences(user.id, prefs);
                        }

                        const addOptions = pendingSelections ?
                            { selectFirst: false, selections: pendingSelections, skipOptionsCheck: true, restaurantUrl: prefs.currentRestaurantUrl } :
                            { selectFirst: false, restaurantUrl: prefs.currentRestaurantUrl }; // Don't auto-select, let user choose

                        // Add item via browser automation
                        let addResult = await doordash.addItemByIndex(num, addOptions, item);
                        // If browser was closed (server restart), re-navigate and retry
                        if (!addResult.success && addResult.browserNotOpen && prefs.currentRestaurantUrl) {
                            console.log('[Recovery] Browser not open - navigating back to restaurant page...');
                            try {
                                await doordash.navigateToRestaurantPage(prefs.currentRestaurantUrl);
                                addResult = await doordash.addItemByIndex(num, addOptions, item);
                            } catch (e) {
                                addResult = { success: false, error: 'Browser session expired. Please search for a restaurant again.' };
                            }
                        }

                        if (addResult.success) {
                            // Clear any pending selections
                            prefs.pendingDoordashSelections = null;
                            prefs.pendingDoordashItem = null;
                            db.setUserPreferences(user.id, prefs);

                            // Add to local cart for display
                            const cartItem = {
                                id: item.id || `doordash-${num}`,
                                name: item.name,
                                price: item.price || 0,
                                description: item.description || '',
                                source: 'doordash'
                            };
                            db.addToCart(user.id, prefs.currentRestaurant, cartItem);
                            itemsAdded.push(item.name);
                            actions.push({ type: 'add_item_doordash', item: item.name });
                        } else if (addResult.needsOptions) {
                            // Item has required options - ask user to choose
                            // Stop processing further ADD_ITEM_NUM commands until options are resolved
                            needsOptionsBreak = true;
                            prefs.pendingDoordashItem = { ...item, menuIndex: num };
                            prefs.pendingDoordashOptions = addResult.requiredOptions;
                            prefs.pendingDoordashGroupIndex = 0; // Track which group we're asking about
                            db.setUserPreferences(user.id, prefs);

                            // Show ALL option groups so user understands what they need to select
                            additionalContext = `\n\n${item.name} has ${addResult.requiredOptions.length} required option(s):\n\n`;

                            addResult.requiredOptions.forEach((group, gIdx) => {
                                const isCurrent = gIdx === 0;
                                additionalContext += `**${gIdx + 1}. ${group.name}**${group.required ? ' (Required)' : ''}${group.hasSelection ? ' ✓' : ''}:\n`;
                                if (isCurrent || !group.hasSelection) {
                                    // Show options for current group or unselected groups
                                    group.options.slice(0, 8).forEach((opt, oIdx) => {
                                        additionalContext += `   ${oIdx + 1}. ${opt}\n`;
                                    });
                                    if (group.options.length > 8) {
                                        additionalContext += `   ... and ${group.options.length - 8} more\n`;
                                    }
                                }
                                additionalContext += '\n';
                            });

                            // Ask for the first group's choice
                            const firstGroup = addResult.requiredOptions[0];
                            additionalContext += `**Please choose for "${firstGroup.name}"** - Reply with a number (1-${Math.min(8, firstGroup.options.length)})`;
                            additionalContext += `\n(Other options will use defaults, or you can specify: "2, Flour, Black Beans")`;

                            // If there were more items queued, mention them
                            const remaining = addNumMatches.slice(matchIdx + 1);
                            if (remaining.length > 0) {
                                const currentMenu = db.getCachedCurrentRestaurant(user.id);
                                const remainingNames = remaining.map(m => {
                                    const idx = parseInt(m[1]) - 1;
                                    return currentMenu?.menu?.[idx]?.name || `item #${m[1]}`;
                                });
                                additionalContext += `\n\n(I'll add ${remainingNames.join(' and ')} after you pick.)`;
                            }

                            actions.push({ type: 'needs_options', item: item.name, options: addResult.requiredOptions });
                        } else if (addResult.browserNotOpen) {
                            additionalContext = `\n\nBrowser session expired. Please search for a restaurant again.`;
                        } else {
                            additionalContext = `\n\nCouldn't add ${item.name}. Please try again.`;
                        }
                    } catch (error) {
                        console.error('[AddItem] DoorDash error:', error);
                        additionalContext = `\n\nError adding item. Please try again.`;
                    }
                } else {
                    additionalContext = `\n\nCouldn't find item #${requestedNum} (index ${num}, menu has ${menuLen} items). Try selecting the restaurant again.`;
                }
            } else {
                additionalContext = `\n\nPlease search for a DoorDash restaurant first.`;
            }
        }
    }

    // Show cart after adding items
    if (itemsAdded.length > 0) {
        const cart = db.getCart(user.id);
        const itemList = itemsAdded.join(' and ');
        additionalContext = `\n\nAdded ${itemList}!\n\n${restaurants.formatCart(cart)}\n\nAnything else, or say "checkout" to order?`;
    }

    // Show cart
    if (response.includes('[SHOW_CART]')) {
        const cart = db.getCart(user.id);
        cleanResponse = cleanResponse.replace('[SHOW_CART]', '').trim();

        const restaurantIds = Object.keys(cart.items || {});
        if (restaurantIds.length > 0) {
            additionalContext = `\n\n${restaurants.formatCart(cart)}`;
        } else {
            additionalContext = `\n\nYour cart is empty. What would you like to order?`;
        }
        actions.push({ type: 'show_cart' });
    }

    // Remove item from cart
    const removeItemMatch = response.match(/\[REMOVE_ITEM:\s*(.+?)\]/i);
    if (removeItemMatch) {
        const itemName = removeItemMatch[1].trim().toLowerCase();
        cleanResponse = cleanResponse.replace(removeItemMatch[0], '').trim();
        const cart = db.getCart(user.id);
        let removed = false;
        for (const restaurantId of Object.keys(cart.items || {})) {
            const items = cart.items[restaurantId];
            const match = items.find(i =>
                i.name.toLowerCase().includes(itemName) ||
                itemName.includes(i.name.toLowerCase().split(' ')[0])
            );
            if (match) {
                db.removeFromCart(user.id, restaurantId, match.id);
                const updatedCart = db.getCart(user.id);
                const hasItems = Object.values(updatedCart.items || {}).some(arr => arr.length > 0);
                additionalContext = `\n\nRemoved ${match.name}!\n\n${hasItems ? restaurants.formatCart(updatedCart) : 'Cart is now empty.'}`;
                removed = true;
                actions.push({ type: 'remove_item', item: match.name });
                break;
            }
        }
        if (!removed) {
            additionalContext = `\n\nCouldn't find "${removeItemMatch[1].trim()}" in your cart.`;
        }
    }

    // Setup DoorDash credentials
    const setupDoordashMatch = response.match(/\[SETUP_DOORDASH:\s*(.+?)\s*\|\s*(.+?)\]/i);
    if (setupDoordashMatch) {
        const email = setupDoordashMatch[1].trim();
        const password = setupDoordashMatch[2].trim();
        cleanResponse = cleanResponse.replace(setupDoordashMatch[0], '').trim();

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            additionalContext = `\n\nThat doesn't look like a valid email. Please try again with format: setup doordash email@example.com password`;
        } else {
            db.setDoorDashCredentials(user.id, email, password);
            additionalContext = `\n\nDoorDash credentials saved! Your account is now linked. When you place an order, I'll submit it directly to DoorDash.`;
            actions.push({ type: 'doordash_setup', email });
        }
    }

    // Check DoorDash setup status
    if (response.includes('[CHECK_DOORDASH]')) {
        cleanResponse = cleanResponse.replace('[CHECK_DOORDASH]', '').trim();

        if (db.hasDoorDashCredentials(user.id)) {
            const creds = db.getDoorDashCredentials(user.id);
            additionalContext = `\n\nYour DoorDash account is linked (${creds.email}). Orders will be placed automatically!`;
        } else {
            additionalContext = `\n\nDoorDash not set up yet. Say "setup doordash email@example.com yourpassword" to link your account.`;
        }
        actions.push({ type: 'doordash_check' });
    }

    // Place order - supports multiple restaurants with real DoorDash integration
    if (response.includes('[PLACE_ORDER]')) {
        const cart = db.getCart(user.id);
        const prefs = db.getUserPreferences(user.id);
        const address = db.getUserAddress(user.id);
        cleanResponse = cleanResponse.replace('[PLACE_ORDER]', '').trim();

        const restaurantIds = Object.keys(cart.items || {});

        if (!address) {
            additionalContext = `\n\nI need your delivery address first. What's your address?`;
        } else if (restaurantIds.length === 0) {
            additionalContext = `\n\nYour cart is empty! Add some items first.`;
        } else if (!db.hasDoorDashCredentials(user.id)) {
            // No DoorDash credentials - prompt to set up
            additionalContext = `\n\nTo place real orders, I need your DoorDash account.\n\nSay: "setup doordash your@email.com yourpassword"\n\nYour credentials are encrypted and only used to place orders.`;
            actions.push({ type: 'doordash_required' });
        } else {
            // Has DoorDash credentials - attempt real order
            const prefs = db.getUserPreferences(user.id);

            // Check if this is a DoorDash order (items already in browser cart)
            if (prefs.currentRestaurantSource === 'doordash') {
                // Use simple checkout - items are already in the DoorDash cart
                console.log('[Checkout] DoorDash order - using checkoutCurrentCart');

                try {
                    const result = await doordash.checkoutCurrentCart();

                    if (result.dryRun) {
                        additionalContext = `\n\n✅ Dry run complete! Checkout page loaded and Place Order button found. Everything looks ready.\n\n(Remove DOORDASH_DRY_RUN from .env to place real orders.)`;
                    } else if (result.success) {
                        // Create order record
                        const currentRestaurant = db.getCachedCurrentRestaurant(user.id);
                        const restaurantName = currentRestaurant?.name || 'DoorDash Order';

                        // Calculate totals from local cart
                        let subtotal = 0;
                        restaurantIds.forEach(rid => {
                            const items = cart.items[rid];
                            if (items) {
                                items.forEach(item => {
                                    subtotal += (parseFloat(item.price) || 0) * (item.quantity || 1);
                                });
                            }
                        });

                        // Estimate fees (DoorDash typical: delivery $2.99, service ~15%, tax ~8%)
                        const deliveryFee = 2.99;
                        const serviceFee = subtotal * 0.15;
                        const tax = subtotal * 0.08;
                        const total = subtotal + deliveryFee + serviceFee + tax;

                        // Get user address
                        const userAddress = db.getUserAddress(user.id) || 'Address on file';

                        db.createOrder(
                            user.id,
                            prefs.currentRestaurant,
                            restaurantName,
                            cart.items[prefs.currentRestaurant] || [],
                            userAddress,
                            subtotal.toFixed(2),
                            total.toFixed(2),
                            prefs.currentRestaurantUrl || null,
                            result.orderUrl || null
                        );
                        db.clearCart(user.id);
                        prefs.currentRestaurant = null;
                        prefs.currentRestaurantSource = null;
                        prefs.currentRestaurantUrl = null;
                        prefs.scheduledOrder = null;
                        db.setUserPreferences(user.id, prefs);

                        additionalContext = `\n\n🎉 Order placed! Reply "order status" anytime to check on your delivery.`;
                        actions.push({ type: 'order_placed_doordash', restaurant: restaurantName });
                    } else {
                        additionalContext = `\n\n${formatCheckoutError(result.error)}\n\nYour cart is saved.`;
                    }
                } catch (error) {
                    console.error('[Checkout] DoorDash error:', error);
                    additionalContext = `\n\n${formatCheckoutError(error.message)}\n\nYour cart is saved.`;
                }
            }
        }
    }

    // Save address
    const addressMatch = response.match(/\[SAVE_ADDRESS:\s*(.+?)\]/i);
    if (addressMatch) {
        const address = addressMatch[1].trim();
        db.setUserAddress(user.id, address);
        cleanResponse = cleanResponse.replace(addressMatch[0], '').trim();
        additionalContext = `\n\nAddress saved! I'll deliver to: ${address}`;
        actions.push({ type: 'address_saved', address });
    }

    // Show orders
    if (response.includes('[MY_ORDERS]')) {
        const orders = db.getUserOrders(user.id, 5);
        cleanResponse = cleanResponse.replace('[MY_ORDERS]', '').trim();

        if (orders.length > 0) {
            additionalContext = `\n\nYour recent orders:\n\n`;
            additionalContext += orders.map(o =>
                `#${o.id} - ${o.restaurant_name} - $${o.total.toFixed(2)} (${o.status})`
            ).join('\n');
        } else {
            additionalContext = `\n\nNo orders yet. Ready to place your first?`;
        }
        actions.push({ type: 'show_orders' });
    }

    // Reorder last order
    if (response.includes('[REORDER]')) {
        const orders = db.getUserOrders(user.id, 1);
        cleanResponse = cleanResponse.replace('[REORDER]', '').trim();

        if (orders.length > 0) {
            const lastOrder = orders[0];
            db.clearCart(user.id);
            doordash.clearBrowserCart().catch(() => {});

            const restaurantUrl = lastOrder.restaurant_url;
            if (restaurantUrl) {
                additionalContext = `\n\nLoading ${lastOrder.restaurant_name}...`;
                try {
                    const navResult = await doordash.selectRestaurantFromSearch(restaurantUrl);
                    if (navResult.success) {
                        const prefs = db.getUserPreferences(user.id);
                        prefs.currentRestaurant = lastOrder.restaurant_id;
                        prefs.currentRestaurantSource = 'doordash';
                        prefs.currentRestaurantUrl = restaurantUrl;
                        db.setUserPreferences(user.id, prefs);

                        const cachedMenu = db.getCachedRestaurantMenu(user.id, lastOrder.restaurant_id);
                        const menuItems = cachedMenu || await doordash.extractMenuItems();
                        if (!cachedMenu && menuItems.length > 0)
                            db.cacheRestaurantMenu(user.id, lastOrder.restaurant_id, menuItems);

                        for (const item of lastOrder.items) {
                            const menuIdx = menuItems.findIndex(m =>
                                m.name.toLowerCase().includes(item.name.toLowerCase()) ||
                                item.name.toLowerCase().includes(m.name.toLowerCase())
                            );
                            if (menuIdx >= 0) {
                                const addResult = await doordash.addItemByIndex(menuIdx, { selectFirst: true, restaurantUrl: lastOrder.restaurant_url }, menuItems[menuIdx]);
                                if (addResult.success) {
                                    db.addToCart(user.id, lastOrder.restaurant_id, {
                                        id: `doordash-${menuIdx}`, name: item.name,
                                        price: item.price, source: 'doordash'
                                    });
                                }
                            }
                        }
                        const cart = db.getCart(user.id);
                        additionalContext = `\n\nLoaded your last order from ${lastOrder.restaurant_name}!\n\n${restaurants.formatCart(cart)}\n\nNote: any customizations (e.g. protein choice) may be reset to defaults. Reply "show cart" to verify before checking out.`;
                    } else {
                        additionalContext = `\n\nCouldn't reconnect to ${lastOrder.restaurant_name}. Try searching for it again.`;
                    }
                } catch (err) {
                    console.error('[Reorder] Browser nav failed:', err.message);
                    additionalContext = `\n\nSomething went wrong loading ${lastOrder.restaurant_name}. Try searching for it again.`;
                }
            } else {
                // Old order without stored URL — load DB cart only
                lastOrder.items.forEach(item => db.addToCart(user.id, lastOrder.restaurant_id, item));
                const prefs = db.getUserPreferences(user.id);
                prefs.currentRestaurant = lastOrder.restaurant_id;
                db.setUserPreferences(user.id, prefs);
                const cart = db.getCart(user.id);
                additionalContext = `\n\nLoaded your last order from ${lastOrder.restaurant_name}!\n\n${restaurants.formatCart(cart)}\n\nNote: any customizations (e.g. protein choice) may be reset to defaults. Reply "show cart" to verify before checking out.`;
            }
            actions.push({ type: 'reorder', orderId: lastOrder.id });
        } else {
            additionalContext = `\n\nYou don't have any previous orders yet. What would you like to eat?`;
        }
    }

    // Order status
    if (response.includes('[ORDER_STATUS]')) {
        cleanResponse = cleanResponse.replace('[ORDER_STATUS]', '').trim();
        const latestOrder = db.getLatestActiveOrderForUser(user.id);

        if (!latestOrder) {
            // Check if they have any recent delivered order
            const recentOrders = db.getUserOrders(user.id, 1);
            if (recentOrders.length > 0 && recentOrders[0].status === 'delivered') {
                additionalContext = `\n\nYour last order from ${recentOrders[0].restaurant_name} was delivered. Want to order again?`;
            } else {
                additionalContext = `\n\nNo active orders right now. Want to order something?`;
            }
        } else {
            let statusText = null;
            if (latestOrder.tracking_url && db.hasDoorDashCredentials(user.id)) {
                try {
                    const creds = db.getDoorDashCredentials(user.id);
                    const statusResult = await doordash.getOrderStatus(creds, latestOrder.tracking_url);
                    if (statusResult && statusResult.statusText) {
                        statusText = statusResult.statusText;
                        if (statusResult.eta) statusText += ` ETA: ${statusResult.eta}`;
                    }
                } catch (e) {
                    console.error('[OrderStatus] Real poll failed:', e.message);
                }
            }
            additionalContext = `\n\n${statusText || getOrderStatusText(latestOrder)}`;
        }
        actions.push({ type: 'order_status' });
    }

    // Schedule order
    const scheduleMatch = response.match(/\[SCHEDULE_ORDER:\s*(\d{1,2}):(\d{2})\]/i);
    if (scheduleMatch) {
        const hours = parseInt(scheduleMatch[1]);
        const minutes = parseInt(scheduleMatch[2]);
        const cart = db.getCart(user.id);
        const prefs = db.getUserPreferences(user.id);
        const address = db.getUserAddress(user.id);
        cleanResponse = cleanResponse.replace(scheduleMatch[0], '').trim();

        const restaurantIds = Object.keys(cart.items || {});
        if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
            additionalContext = `\n\nInvalid time. Please use a valid 12 or 24-hour time (e.g., "7pm" or "19:00").`;
        } else if (restaurantIds.length === 0) {
            additionalContext = `\n\nYour cart is empty! Add items first, then I can schedule the order.`;
        } else if (!address) {
            additionalContext = `\n\nI need your delivery address before scheduling. What's your address?`;
        } else {
            const scheduledOrder = {
                time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
                cart: cart.items,
                restaurantId: prefs.currentRestaurant,
                restaurantSource: prefs.currentRestaurantSource,
                address,
                phoneNumber
            };
            prefs.scheduledOrder = scheduledOrder;
            db.setUserPreferences(user.id, prefs);

            const h = hours;
            const timeDisplay = `${h > 12 ? h - 12 : (h || 12)}:${String(minutes).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
            additionalContext = `\n\nOrder scheduled for ${timeDisplay}! I'll place it automatically.\n\nSay "cancel schedule" if you change your mind.`;
            actions.push({ type: 'order_scheduled', time: scheduledOrder.time });
        }
    }

    // Cancel schedule
    if (response.includes('[CANCEL_SCHEDULE]')) {
        const prefs = db.getUserPreferences(user.id);
        cleanResponse = cleanResponse.replace('[CANCEL_SCHEDULE]', '').trim();

        if (prefs.scheduledOrder) {
            const { time } = prefs.scheduledOrder;
            const [h, m] = time.split(':').map(Number);
            const timeDisplay = `${h > 12 ? h - 12 : (h || 12)}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
            prefs.scheduledOrder = null;
            db.setUserPreferences(user.id, prefs);
            additionalContext = `\n\nScheduled order for ${timeDisplay} cancelled.`;
        } else {
            additionalContext = `\n\nNo scheduled order to cancel.`;
        }
        actions.push({ type: 'cancel_schedule' });
    }

    // (budget handled at top of processCommands, before search)

    // Clear history
    if (response.includes('[CLEAR_HISTORY]')) {
        db.clearConversationHistory(user.id);
        cleanResponse = cleanResponse.replace('[CLEAR_HISTORY]', '').trim();
        actions.push({ type: 'history_cleared' });
    }

    // Strip cart/order display blocks Claude may have generated in its text
    // Cart blocks contain "YOUR CART" or "YOUR ORDER" surrounded by ══ borders
    cleanResponse = cleanResponse.replace(/══+[^═]*(?:YOUR CART|YOUR ORDER|🛒)[\s\S]*?══+[^\n]*/gi, '').trim();
    // Also strip ── sub-blocks (line items + totals) that Claude generated
    cleanResponse = cleanResponse.replace(/══+[\s\S]*?Anything else[^\n]*/gi, '').trim();
    cleanResponse = cleanResponse.replace(/──+[\s\S]*?TOTAL:[^\n]*\n?/gi, '').trim();
    // Strip bullet-point item lines like "• Coke Bottle - $4.20" (price formatting)
    cleanResponse = cleanResponse.replace(/^[•\-]\s+.+\s+-\s+\$[\d.]+\s*$/gm, '').trim();
    // Strip Claude-generated fee rows (restaurant name then delivery/service/tax lines)
    cleanResponse = cleanResponse.replace(/^.*\n(?:Delivery|Service Fee|Tax):\s+\$[\d.]+.*$/gm, '').trim();
    cleanResponse = cleanResponse.replace(/\n{3,}/g, '\n\n').trim();

    // Clean up response
    cleanResponse = cleanResponse.replace(/\n{3,}/g, '\n\n').trim();
    cleanResponse = (cleanResponse + additionalContext).trim();

    return { response: cleanResponse, actions };
}

// Handle incoming message
async function handleMessage(phoneNumber, message) {
    const user = db.getOrCreateUser(phoneNumber);
    const userAddress = db.getUserAddress(user.id);
    const preferences = db.getUserPreferences(user.id);
    const cart = db.getCart(user.id);

    let currentRestaurant = null;
    let doordashMenu = null;

    if (preferences.currentRestaurant) {
        // Get cached DoorDash restaurant with menu
        const cachedRestaurant = db.getCachedCurrentRestaurant(user.id);
        if (cachedRestaurant) {
            currentRestaurant = { name: cachedRestaurant.name, source: 'doordash' };
            doordashMenu = cachedRestaurant.menu || [];
        }
    }

    // Intercept "more menu" directly — show next page of cached menu without going to Claude
    if (/^more menu$/i.test(message.trim()) && doordashMenu && doordashMenu.length > 0) {
        const PAGE_SIZE = 15;
        preferences.menuPage = (preferences.menuPage || 0) + 1;
        db.setUserPreferences(user.id, preferences);
        const displayItems = preferences.budget
            ? doordashMenu.filter(item => (parseFloat(item.price) || 0) <= preferences.budget)
            : doordashMenu;
        const pageStart = preferences.menuPage * PAGE_SIZE;
        const pageItems = displayItems.slice(pageStart, pageStart + PAGE_SIZE);
        db.saveMessage(user.id, 'user', message);
        if (pageItems.length === 0) {
            preferences.menuPage = 0;
            db.setUserPreferences(user.id, preferences);
            return { response: "That's the whole menu!", actions: [] };
        }
        let menuText = pageItems.map(item => {
            const originalIndex = doordashMenu.indexOf(item) + 1;
            return `${originalIndex}. ${item.name.toUpperCase()}\n   $${parseFloat(item.price || 0).toFixed(2)}${item.description ? ' · ' + item.description : ''}`;
        }).join('\n\n');
        if (displayItems.length > pageStart + PAGE_SIZE) {
            menuText += `\n\n(+${displayItems.length - pageStart - PAGE_SIZE} more — say "more menu")`;
        }
        db.saveMessage(user.id, 'assistant', menuText);
        return { response: menuText, actions: [] };
    }

    const history = db.getConversationHistory(user.id, 20);
    const messages = [...history, { role: 'user', content: message }];

    db.saveMessage(user.id, 'user', message);

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            system: buildSystemPrompt(user, userAddress, preferences, cart, currentRestaurant, doordashMenu),
            messages: messages
        });

        let assistantMessage = response.content[0].text;
        const { response: cleanedResponse, actions } = await processCommands(assistantMessage, user, phoneNumber);
        assistantMessage = cleanedResponse;

        db.saveMessage(user.id, 'assistant', assistantMessage);

        return { response: assistantMessage, actions };
    } catch (error) {
        console.error('Error calling Claude:', error);
        return { response: 'Sorry, I had trouble processing that. Try again?', actions: [] };
    }
}

// API endpoint for SMS simulation
app.post('/api/message', async (req, res) => {
    const { phoneNumber, message } = req.body;

    if (!phoneNumber || !message) {
        return res.status(400).json({ error: 'Phone number and message required' });
    }

    console.log(`[${phoneNumber}] Received: ${message}`);

    const { response, actions } = await handleMessage(phoneNumber, message);

    console.log(`[${phoneNumber}] Replied: ${response}`);
    if (actions.length) {
        console.log(`[${phoneNumber}] Actions:`, actions);
    }

    res.json({ response, actions });
});

// Twilio Webhook - receives inbound SMS
// Twilio sends form-encoded: From, To, Body
app.post('/api/twilio/webhook', async (req, res) => {
    const message = req.body?.Body;
    const from = req.body?.From;

    if (!message || !from) {
        console.log('[Twilio Webhook] Missing Body or From');
        return res.sendStatus(200);
    }

    console.log(`[Twilio] Incoming SMS from ${from}: ${message}`);

    // Respond to Twilio immediately — DoorDash can take >15s and Twilio would time out
    res.set('Content-Type', 'text/xml').send('<Response></Response>');

    // Process and reply asynchronously
    (async () => {
        try {
            const { response } = await handleMessage(from, message);
            console.log(`[Twilio] Reply to ${from}: ${response.substring(0, 100)}...`);
            await sendSMS(from, response);
        } catch (error) {
            console.error('[Twilio Webhook] Error:', error);
            await sendSMS(from, 'Sorry, something went wrong. Please try again.');
        }
    })();
});

// Get user profile endpoint
app.get('/api/user/:phoneNumber', (req, res) => {
    // Restrict to localhost only — this endpoint is for local debugging
    const ip = req.ip || req.connection.remoteAddress || '';
    if (!ip.includes('127.0.0.1') && !ip.includes('::1') && !ip.includes('localhost')) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const user = db.getUserByPhone(req.params.phoneNumber);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    const address = db.getUserAddress(user.id);
    const preferences = db.getUserPreferences(user.id);
    const cart = db.getCart(user.id);

    res.json({
        id: user.id,
        phoneNumber: user.phone_number,
        hasPin: !!user.pin_hash,
        hasAddress: !!address,
        preferences,
        cart,
        createdAt: user.created_at,
        lastActive: user.last_active
    });
});

// Clear conversation endpoint
app.post('/api/clear', (req, res) => {
    const { phoneNumber } = req.body;
    if (phoneNumber) {
        const user = db.getUserByPhone(phoneNumber);
        if (user) {
            db.clearConversationHistory(user.id);
            db.clearCart(user.id);
            // Clear all cached restaurant/search data
            const prefs = db.getUserPreferences(user.id);
            prefs.currentRestaurant = null;
            prefs.currentRestaurantSource = null;
            prefs.currentRestaurantUrl = null;
            prefs.lastSearchResults = null;
            prefs.lastSearchSource = null;
            prefs.lastSearchQuery = null;
            prefs.pendingItem = null;
            prefs.pendingDoordashItem = null;
            prefs.pendingDoordashOptions = null;
            prefs.pendingDoordashSelections = null;
            prefs.pendingDoordashGroupIndex = null;
            db.setUserPreferences(user.id, prefs);
            // Also clear cached restaurant data
            db.clearDoorDashCache(user.id);
            // Clear the DoorDash browser cart to stay in sync
            doordash.clearBrowserCart().catch(() => {});
            console.log(`[Clear] Cleared all data for user ${user.id}`);
        }
    }
    res.json({ success: true });
});

// Health check — shows env var status without exposing values
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        anthropicKey: process.env.ANTHROPIC_API_KEY ? `set (${process.env.ANTHROPIC_API_KEY.length} chars)` : 'MISSING',
        twilio: process.env.TWILIO_ACCOUNT_SID ? 'set' : 'MISSING',
        doordashEmail: process.env.DOORDASH_EMAIL ? 'set' : 'MISSING',
        dbPath: process.env.DB_PATH || 'default',
        browserDataDir: process.env.BROWSER_DATA_DIR || 'default'
    });
});

// Serve the simulator UI
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Manual DoorDash login - opens browser for user to log in themselves
app.post('/api/doordash/manual-login', async (req, res) => {
    console.log('[Manual Login] Opening browser for manual DoorDash login...');
    res.json({ message: 'Browser opening - log into DoorDash in the window that appears. You have 3 minutes.' });
    const result = await doordash.openForManualLogin();
    if (result.success) {
        console.log('[Manual Login] Success - session saved.');
    } else {
        console.log('[Manual Login] Failed:', result.error);
    }
});

// Remote log viewer
app.get('/logs', (req, res) => {
    const n = parseInt(req.query.n) || 500;
    res.type('text/plain').send(logBuffer.slice(-n).join('\n'));
});

// Export DoorDash cookies (run locally, paste into Railway env)
app.get('/api/export-cookies', async (req, res) => {
    const result = await doordash.exportCookies();
    if (result.success) {
        res.json({ cookies: result.cookies, count: result.cookies.length });
    } else {
        res.status(500).json({ error: result.error });
    }
});

// Cleanup expired sessions periodically
setInterval(() => {
    db.deleteExpiredSessions();
}, 60 * 60 * 1000);

// Proactive order status SMS updates (every 2 minutes)
async function pollOrderStatuses() {
    try {
        const activeOrders = db.getActiveOrders() || [];
        for (const order of activeOrders) {
            const minutesAgo = Math.floor((Date.now() - new Date(order.placed_at).getTime()) / 60000);

            let newStatus;

            // Try real DoorDash status first if user has credentials
            const creds = db.getDoorDashCredentials(order.user_id);
            if (creds) {
                try {
                    const realStatus = await doordash.getOrderStatus(creds, order.tracking_url || null);
                    if (realStatus.status && realStatus.status !== 'unknown') {
                        newStatus = realStatus.status;
                    }
                } catch (e) {
                    console.error('[StatusPoll] Real status check failed, falling back to time estimate:', e.message);
                }
            }

            // Fall back to time-based estimate if real status unavailable
            if (!newStatus) {
                if (minutesAgo < 5) newStatus = 'placed';
                else if (minutesAgo < 20) newStatus = 'preparing';
                else if (minutesAgo < 35) newStatus = 'picked_up';
                else if (minutesAgo < 50) newStatus = 'on_the_way';
                else newStatus = 'delivered';
            }

            if (newStatus === order.last_known_status) continue;

            db.updateOrderLastStatus(order.id, newStatus);
            if (newStatus === 'delivered') {
                db.updateOrderStatus(order.id, 'delivered');
            }

            const phone = order.user_phone;
            if (!phone) continue;

            let message;
            switch (newStatus) {
                case 'preparing':
                    message = `${order.restaurant_name} is preparing your order!`;
                    break;
                case 'picked_up':
                    message = `Your driver picked up your order from ${order.restaurant_name}! On the way!`;
                    break;
                case 'on_the_way':
                    message = `Almost there! Your ${order.restaurant_name} order is almost at your door.`;
                    break;
                case 'delivered':
                    message = `Your ${order.restaurant_name} order has been delivered! Enjoy your food!`;
                    break;
            }

            if (message) {
                console.log(`[StatusPoll] Sending update to ${phone}: ${newStatus}`);
                await sendSMS(phone, message);
            }
        }
    } catch (err) {
        console.error('[StatusPoll] Error:', err.message);
    }
}

setInterval(pollOrderStatuses, 2 * 60 * 1000);

// Scheduled order execution (every minute)
async function checkScheduledOrders() {
    try {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const usersWithScheduled = db.db.prepare(`
            SELECT * FROM users
            WHERE preferences LIKE '%scheduledOrder%'
            AND last_active > datetime('now', '-24 hours')
        `).all();

        for (const userRow of usersWithScheduled) {
            try {
                const prefs = JSON.parse(userRow.preferences || '{}');
                if (!prefs.scheduledOrder) continue;

                const { time, cart, restaurantId, restaurantSource, address, phoneNumber: userPhone } = prefs.scheduledOrder;
                if (!time || !time.includes(':')) continue;

                const [schedH, schedM] = time.split(':').map(Number);
                const schedMinutes = schedH * 60 + schedM;
                // Fire if within a 1-minute window (handles server timing drift)
                if (Math.abs(schedMinutes - currentMinutes) > 1) continue;

                console.log(`[Scheduler] Placing scheduled order for user ${userRow.id} at ${time}`);

                // Clear scheduled order first to prevent double-execution
                prefs.scheduledOrder = null;
                db.db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(prefs), userRow.id);

                const phone = userPhone || userRow.phone_number;
                await sendSMS(phone, `Placing your scheduled order now!`);

                // Create order record from snapshot
                const restaurantIds = Object.keys(cart || {});
                if (restaurantIds.length === 0) continue;

                const creds = db.getDoorDashCredentials(userRow.id) || {
                    email: process.env.DOORDASH_EMAIL,
                    password: process.env.DOORDASH_PASSWORD
                };

                // DoorDash order — attempt automation
                const orderItems = [];
                restaurantIds.forEach(rid => {
                    (cart[rid] || []).forEach(item => {
                        orderItems.push({ restaurant: rid, name: item.name, options: item.selectedOptions || {}, quantity: item.quantity || 1 });
                    });
                });

                const result = await doordash.placeFullOrder(creds, {
                    restaurantName: restaurantIds[0],
                    items: orderItems,
                    address,
                    tipPercent: 15
                });

                if (result.success) {
                    db.setCart(userRow.id, {});
                    await sendSMS(phone, `Scheduled order placed! ETA: ${result.eta || '30-45 min'}`);
                } else {
                    await sendSMS(phone, `Couldn't place your scheduled order automatically. Please order manually.`);
                }
            } catch (err) {
                console.error(`[Scheduler] Error for user ${userRow.id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[Scheduler] Error:', err.message);
    }
}

setInterval(checkScheduledOrders, 60 * 1000);

// Start server
app.listen(PORT, async () => {
    console.log(`\n========================================`);
    console.log(`  MessageAI Server Running!`);
    console.log(`========================================`);
    console.log(`  Open in browser: http://localhost:${PORT}`);
    console.log(`  Database: messageai.db`);
    console.log(`========================================\n`);

    if (!process.env.ANTHROPIC_API_KEY) {
        console.log('Warning: ANTHROPIC_API_KEY not set in .env file\n');
    }

    // Auto-import DoorDash cookies from env var (set on Railway to skip login)
    if (process.env.DOORDASH_COOKIES) {
        try {
            const cookies = JSON.parse(process.env.DOORDASH_COOKIES);
            await doordash.importCookies(cookies);
            console.log(`[Startup] Imported ${cookies.length} DoorDash cookies from env`);
        } catch (e) {
            console.error('[Startup] Failed to import DOORDASH_COOKIES:', e.message);
        }
    }
});
