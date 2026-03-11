require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const path = require('path');
const fs = require('fs');
const db = require('./db');
const restaurants = require('./restaurants');
const doordash = require('./doordash');

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

// Send SMS via Twilio
async function sendSMS(to, message) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE) {
        console.log(`[SMS Disabled] Would send to ${to}: ${message.substring(0, 50)}...`);
        return false;
    }

    try {
        const credentials = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
        const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${credentials}`
            },
            body: new URLSearchParams({ From: TWILIO_PHONE, To: to, Body: message })
        });

        const result = await response.json();

        if (response.ok) {
            console.log(`[Twilio] Sent to ${to}, sid: ${result.sid}`);
            return true;
        } else {
            console.error('[Twilio] Send failed:', result.message || JSON.stringify(result));
            return false;
        }
    } catch (error) {
        console.error('[Twilio] Error sending SMS:', error.message);
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
    if (cart.items?.length > 0 && currentRestaurant) {
        context += `\n\nCurrent cart from ${currentRestaurant.name}:`;
        cart.items.forEach(item => {
            context += `\n- ${item.quantity}x ${item.name} ($${item.price})`;
        });
    }

    // DoorDash menu - include actual menu items from the restaurant
    if (doordashMenu && doordashMenu.length > 0 && currentRestaurant) {
        context += `\n\n=== CURRENT RESTAURANT: ${currentRestaurant.name} ===`;
        // Filter by budget if set — only show affordable items to Claude
        const budgetFilter = preferences.budget || null;
        const allMenuItems = doordashMenu.slice(0, 20);
        const menuToShow = budgetFilter
            ? allMenuItems.filter(item => (item.price || 0) <= budgetFilter)
            : allMenuItems;
        if (budgetFilter) {
            context += `\n\n*** MENU UNDER $${budgetFilter.toFixed(2)} (budget filter active — DO NOT suggest items over this price) ***`;
        } else {
            context += `\n\n*** ACTUAL MENU FROM DOORDASH (USE ONLY THESE ITEMS - DO NOT MAKE UP OTHER ITEMS) ***`;
        }
        // Use original index so ADD_ITEM_NUM maps correctly
        menuToShow.forEach((item) => {
            const originalIndex = doordashMenu.indexOf(item) + 1;
            context += `\n${originalIndex}. ${item.name} - $${item.price?.toFixed(2) || '?.??'}`;
        });
        context += `\n*** END OF MENU ***`;
        context += `\n\nCRITICAL RULES FOR MENU:`;
        context += `\n- ONLY show the ${menuToShow.length} items listed above. These are the ACTUAL items from DoorDash.`;
        context += `\n- DO NOT invent, fabricate, or add any menu items that are not in the list above.`;
        context += `\n- DO NOT create categories like "Burritos", "Bowls", "Tacos" with made-up items.`;
        context += `\n- Copy the menu items EXACTLY as shown above with their exact names and prices.`;
        context += `\n- When user says a NUMBER, use [ADD_ITEM_NUM: that exact number].`;
        context += `\n- When user says an ITEM NAME (like "tres leches"), find the EXACT matching item in the menu above and use its number.`;
        context += `\n- DOUBLE CHECK: Before using [ADD_ITEM_NUM: X], verify that item X in the menu above matches what the user asked for.`;
        context += `\n- Example: If user says "tres leches" and menu shows "13. Tres Leches - $4.99", use [ADD_ITEM_NUM: 13]`;
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

    // Pending item awaiting options
    if (preferences.pendingItem) {
        const optionName = Object.keys(preferences.pendingItem.requiredOptions)[0];
        context += `\n\nAWAITING SELECTION: User needs to pick ${optionName} for ${preferences.pendingItem.name}`;
        context += `\nWhen they reply with a number, use [SELECT_OPTION: number]`;
    }

    return `You are MessageAI, an SMS-based food ordering assistant. You help users find restaurants, browse menus, and place orders.

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

17. QUICK ORDER - When user specifies restaurant + item + options:
    [QUICK_ORDER: restaurant | item | protein]
    Examples:
    - "chicken burrito from chipotle" → [QUICK_ORDER: chipotle | burrito | chicken]
    - "big mac from mcdonalds" → [QUICK_ORDER: mcdonalds | big mac]

    FOR MULTIPLE ITEMS: Use multiple commands!
    - "chicken burrito from chipotle and crunchwrap from taco bell" →
      [QUICK_ORDER: chipotle | burrito | chicken] [QUICK_ORDER: taco bell | crunchwrap]

    IMPORTANT: Process ALL items in one response. Don't say "I'll do one then the other".
    Just use multiple [QUICK_ORDER] commands and they'll all be added to the cart.

CRITICAL RULES:
- When user says a NUMBER after seeing restaurants, use [SELECT: number]
- When user says a NUMBER after seeing a menu, use [ADD_ITEM_NUM: number]
- When user says an item NAME, use [ADD_ITEM_NUM: number] with the matching number
- NEVER use [SHOW_MENU] - the system shows it automatically after selecting
- ALWAYS include [SELECT: number] in the SAME message when the user picks a restaurant. The menu will be appended automatically - do NOT say "let me get the menu" or "loading the menu". Just briefly acknowledge their choice (1 short sentence) and include the command. The menu will appear below your message automatically.
- ALWAYS use [SAVE_BUDGET: X] when user mentions a price limit, budget, or "cheap/affordable". NEVER just talk about it in text without the command.

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
        return `Your ${name} order should have arrived by now.\nIf you haven't received it, check the DoorDash app.`;
    }
}

// Process commands from AI response
async function processCommands(response, user, phoneNumber) {
    let cleanResponse = response;
    let actions = [];
    let additionalContext = '';

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

    // Search restaurants - uses real DoorDash if credentials available
    const searchMatch = response.match(/\[SEARCH:\s*(.+?)\]/i);
    if (searchMatch) {
        const query = searchMatch[1].trim().toLowerCase();
        cleanResponse = cleanResponse.replace(searchMatch[0], '').trim();

        const prefs = db.getUserPreferences(user.id);
        const address = db.getUserAddress(user.id);

        // Check if user has DoorDash credentials for real search
        if (db.hasDoorDashCredentials(user.id) && address) {
            const credentials = db.getDoorDashCredentials(user.id);

            try {
                additionalContext = `\n\nSearching DoorDash for "${query}"...`;

                // Search DoorDash for real restaurants
                const searchResult = await doordash.searchRestaurantsNearAddress(credentials, address, query);

                if (searchResult.success && searchResult.restaurants.length > 0) {
                    // Cache the search results
                    db.cacheSearchResults(user.id, query, searchResult.restaurants);

                    // Store restaurant IDs in prefs for selection
                    prefs.lastSearchResults = searchResult.restaurants.map(r => r.id);
                    prefs.lastSearchSource = 'doordash';
                    prefs.lastSearchQuery = query;
                    db.setUserPreferences(user.id, prefs);

                    // Format results for display - Top 5 highest rated
                    additionalContext = `\n\nTop ${searchResult.restaurants.length} highest rated ${query || 'restaurants'} on DoorDash:\n\n`;
                    additionalContext += searchResult.restaurants.map((r, i) => {
                        let line = `${i + 1}. ${r.name.toUpperCase()}`;
                        let details = [];
                        if (r.rating) details.push(`★ ${r.rating}`);
                        if (r.deliveryTime) details.push(r.deliveryTime);
                        if (r.deliveryFee) details.push(r.deliveryFee);
                        if (details.length > 0) {
                            line += `\n   ${details.join(' · ')}`;
                        }
                        return line;
                    }).join('\n\n');
                    additionalContext += `\n\nWhich one would you like? (Reply with the number)`;

                    actions.push({ type: 'search_doordash', query, count: searchResult.restaurants.length, totalFound: searchResult.totalFound });
                } else {
                    additionalContext = `\n\nI couldn't find any "${query}" restaurants on DoorDash near you. Try a different search?`;
                    actions.push({ type: 'search_doordash', query, count: 0 });
                }

            } catch (error) {
                const fs = require('fs');
                fs.appendFileSync('C:/Users/hatch/Projects/MessageAI/doordash_error.log', `\n[${new Date().toISOString()}] DoorDash search error:\n${error?.stack || error}\n`);
                console.error('[Search] DoorDash search error:', error);
                // Fall back to mock data
                additionalContext = `\n\nDoorDash search failed. Here are some options:\n\n`;
                const results = restaurants.searchRestaurants(query);
                if (results.length > 0) {
                    additionalContext += restaurants.formatRestaurantList(results);
                    additionalContext += `\n\nWhich one would you like? (Reply with the number)`;
                    prefs.lastSearchResults = results.map(r => r.id);
                    prefs.lastSearchSource = 'mock';
                    db.setUserPreferences(user.id, prefs);
                }
                actions.push({ type: 'search_fallback', query, count: results.length });
            }
        } else {
            // No DoorDash credentials - use mock data
            // Check for exact restaurant name match FIRST
            const allRestaurants = restaurants.restaurants;
            const exactMatch = allRestaurants.find(r => {
                const name = r.name.toLowerCase();
                const firstWord = name.split(' ')[0];
                return query.includes(firstWord) || name.includes(query);
            });

            if (exactMatch) {
                // Direct match to a restaurant - go straight to menu
                prefs.currentRestaurant = exactMatch.id;
                prefs.lastSearchResults = null;
                prefs.lastSearchSource = 'mock';
                db.setUserPreferences(user.id, prefs);
                additionalContext = `\n\n${restaurants.formatMenu(exactMatch, prefs.budget || null)}\n\nWhat would you like? (Reply with item number)`;
                actions.push({ type: 'select_restaurant', restaurant: exactMatch.name });
            } else {
                // No exact match, do cuisine search
                const results = restaurants.searchRestaurants(query);
                if (results.length > 0) {
                    additionalContext = `\n\nHere's what I found:\n\n${restaurants.formatRestaurantList(results)}\n\nWhich one would you like? (Reply with the number)`;
                    prefs.lastSearchResults = results.map(r => r.id);
                    prefs.lastSearchSource = 'mock';
                    db.setUserPreferences(user.id, prefs);
                    actions.push({ type: 'search', query, count: results.length });
                } else {
                    additionalContext = `\n\nI couldn't find any ${query} restaurants nearby. Try another cuisine?`;
                    actions.push({ type: 'search', query, count: 0 });
                }
            }

            // Suggest setting up DoorDash if not set up
            if (!db.hasDoorDashCredentials(user.id)) {
                additionalContext += `\n\n(Tip: Link your DoorDash account to see real restaurants near you!)`;
            }
        }
    }

    // Select restaurant
    const selectMatch = response.match(/\[SELECT_RESTAURANT:\s*(.+?)\]/i);
    if (selectMatch) {
        const restaurantId = selectMatch[1].trim();
        const restaurant = restaurants.getRestaurant(restaurantId);
        cleanResponse = cleanResponse.replace(selectMatch[0], '').trim();

        if (restaurant) {
            const prefs = db.getUserPreferences(user.id);
            prefs.currentRestaurant = restaurantId;
            db.setUserPreferences(user.id, prefs);
            additionalContext = `\n\n${restaurants.formatMenu(restaurant, prefs.budget || null)}\n\nWhat would you like to order? (Reply with item number)`;
            actions.push({ type: 'select_restaurant', restaurant: restaurant.name });
        }
    }

    // Handle numeric selection (restaurant)
    const numberMatch = response.match(/\[SELECT:\s*(\d+)\]/i);
    if (numberMatch) {
        const num = parseInt(numberMatch[1]) - 1;
        const prefs = db.getUserPreferences(user.id);
        cleanResponse = cleanResponse.replace(numberMatch[0], '').trim();

        if (prefs.lastSearchResults && prefs.lastSearchResults[num]) {
            const restaurantId = prefs.lastSearchResults[num];

            // Check if this was a DoorDash search or mock search
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
                            db.setUserPreferences(user.id, prefs);

                            const restaurantName = menuResult.restaurantName || selectedRestaurant.name;

                            // Always extract menu items so we can add them later
                            const menuItems = await doordash.extractMenuItems();
                            console.log(`[DoorDash] Extracted ${menuItems.length} menu items`);

                            // Cache the restaurant data WITH menu
                            db.cacheCurrentRestaurant(user.id, {
                                id: restaurantId,
                                name: restaurantName,
                                categories: menuResult.categories || [],
                                url: menuResult.url,
                                source: 'doordash',
                                menu: menuItems  // Include menu items!
                            });

                            // Also cache menu separately for redundancy
                            if (menuItems && menuItems.length > 0) {
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
                                    // Use original index so ADD_ITEM_NUM still maps correctly
                                    menuText += displayItems.map(item =>
                                        `${menuItems.indexOf(item) + 1}. ${item.name.toUpperCase()}\n   $${parseFloat(item.price || 0).toFixed(2)}${item.description ? ' · ' + item.description : ''}`
                                    ).join('\n\n');
                                }
                                menuText += `\n\nWhat would you like? (Reply with item number)`;
                                cleanResponse = menuText;
                                additionalContext = '';
                            } else {
                                additionalContext = '';
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
                // Mock restaurant
                const restaurant = restaurants.getRestaurant(restaurantId);
                if (restaurant) {
                    prefs.currentRestaurant = restaurantId;
                    prefs.currentRestaurantSource = 'mock';
                    db.setUserPreferences(user.id, prefs);
                    cleanResponse = `${restaurants.formatMenu(restaurant, prefs.budget || null)}\n\nWhat would you like? (Reply with item number)`;
                    additionalContext = '';
                    actions.push({ type: 'select_restaurant', restaurant: restaurant.name });
                    console.log(`[DB] Selected restaurant: ${restaurant.name}`);
                } else {
                    additionalContext = `\n\nSorry, that's not a valid option. Please pick a number from the list.`;
                }
            }
        } else {
            additionalContext = `\n\nSorry, that's not a valid option. Please pick a number from the list.`;
        }
    }

    // Show menu
    if (response.includes('[SHOW_MENU]')) {
        const prefs = db.getUserPreferences(user.id);
        cleanResponse = cleanResponse.replace('[SHOW_MENU]', '').trim();

        if (prefs.currentRestaurant) {
            const restaurant = restaurants.getRestaurant(prefs.currentRestaurant);
            additionalContext = `\n\n${restaurants.formatMenu(restaurant, prefs.budget || null)}`;
            actions.push({ type: 'show_menu' });
        } else {
            additionalContext = `\n\nNo restaurant selected. What cuisine are you in the mood for?`;
        }
    }

    // Add item to cart
    const addMatch = response.match(/\[ADD_ITEM:\s*(.+?)\]/i);
    if (addMatch) {
        const itemId = addMatch[1].trim();
        const prefs = db.getUserPreferences(user.id);
        cleanResponse = cleanResponse.replace(addMatch[0], '').trim();

        if (prefs.currentRestaurant) {
            const restaurant = restaurants.getRestaurant(prefs.currentRestaurant);
            const item = restaurants.getMenuItem(prefs.currentRestaurant, itemId);

            if (item) {
                db.addToCart(user.id, prefs.currentRestaurant, item);
                const cart = db.getCart(user.id);
                additionalContext = `\n\nAdded ${item.name}!\n\n${restaurants.formatCart(cart)}\n\nAnything else, or say "checkout" to order?`;
                actions.push({ type: 'add_item', item: item.name });
            }
        }
    }

    // Add by number - handle multiple items (supports both mock and DoorDash)
    const addNumMatches = [...response.matchAll(/\[ADD_ITEM_NUM:\s*(\d+)\]/gi)];
    const itemsAdded = [];
    let pendingItem = null;

    for (const match of addNumMatches) {
        const requestedNum = parseInt(match[1]);
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
            // Check if using DoorDash or mock data
            if (prefs.currentRestaurantSource === 'doordash') {
                // Real DoorDash item - get from cache and add via automation
                const currentRestaurant = db.getCachedCurrentRestaurant(user.id);

                if (currentRestaurant && currentRestaurant.menu && currentRestaurant.menu[num]) {
                    const item = currentRestaurant.menu[num];

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
                            { selectFirst: false, selections: pendingSelections, skipOptionsCheck: true } :
                            { selectFirst: false }; // Don't auto-select, let user choose

                        // Add item via browser automation
                        const addResult = await doordash.addItemByIndex(num, addOptions, item);

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
                            actions.push({ type: 'needs_options', item: item.name, options: addResult.requiredOptions });
                        } else {
                            additionalContext = `\n\nCouldn't add ${item.name}. ${addResult.error || 'Please try again.'}`;
                        }
                    } catch (error) {
                        console.error('[AddItem] DoorDash error:', error);
                        additionalContext = `\n\nError adding item. Please try again.`;
                    }
                } else {
                    additionalContext = `\n\nSorry, couldn't find that item. The menu may have changed.`;
                }
            } else {
                // Mock restaurant
                const restaurant = restaurants.getRestaurant(prefs.currentRestaurant);
                const item = restaurant?.menu[num];

                if (item) {
                    // Check if item has required options
                    if (item.requiredOptions && Object.keys(item.requiredOptions).length > 0) {
                        // Store pending item and ask for options
                        prefs.pendingItem = { ...item, menuIndex: num };
                        db.setUserPreferences(user.id, prefs);
                        pendingItem = item;
                    } else {
                        // No required options, add directly
                        db.addToCart(user.id, prefs.currentRestaurant, item);
                        itemsAdded.push(item.name);
                        actions.push({ type: 'add_item', item: item.name });
                    }
                }
            }
        }
    }

    // Handle pending item with required options
    if (pendingItem) {
        const optionName = Object.keys(pendingItem.requiredOptions)[0];
        const options = pendingItem.requiredOptions[optionName];

        // Strip any AI-generated options list from the response
        cleanResponse = cleanResponse
            .replace(/choose your \w+:?[\s\S]*?reply with/gi, '')
            .replace(/\d\.\s*(chicken|steak|carnitas|barbacoa|sofritas|veggie|tofu)[\s\S]*?(?=\n\n|$)/gi, '')
            .replace(/🌯/g, '')
            .trim();

        // Keep just a simple acknowledgment
        if (cleanResponse.length > 100) {
            cleanResponse = `Adding ${pendingItem.name}!`;
        }

        additionalContext = `\n\nChoose your ${optionName}:\n\n`;
        additionalContext += options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
        additionalContext += `\n\nReply with the number.`;
        actions.push({ type: 'awaiting_option', item: pendingItem.name, option: optionName });
    }
    // Show cart after adding items (only if no pending item)
    else if (itemsAdded.length > 0) {
        const cart = db.getCart(user.id);
        const itemList = itemsAdded.join(' and ');
        additionalContext = `\n\nAdded ${itemList}!\n\n${restaurants.formatCart(cart)}\n\nAnything else, or say "checkout" to order?`;
    }

    // Handle TEXT-based multi-option selection for DoorDash (e.g., "flour, black, tomatillo ranch")
    // This runs BEFORE [SELECT_OPTION] to catch text-based selections
    const textSelectMatch = response.match(/\[SELECT_OPTIONS_TEXT:\s*(.+?)\]/i);
    if (textSelectMatch && textSelectMatch[1]) {
        const prefs = db.getUserPreferences(user.id);

        if (prefs.pendingDoordashItem && prefs.pendingDoordashOptions) {
            const userChoices = textSelectMatch[1].toLowerCase().split(/[,\s]+/).filter(s => s.length > 2);
            console.log('[DoorDash] Text-based option selection:', userChoices);

            const selections = [];

            // For each pending option group, find a matching user choice
            for (let gIdx = 0; gIdx < prefs.pendingDoordashOptions.length; gIdx++) {
                const group = prefs.pendingDoordashOptions[gIdx];
                let matchedOption = null;
                let matchedIndex = 0;

                // Try to find a user choice that matches an option in this group
                for (const choice of userChoices) {
                    for (let oIdx = 0; oIdx < group.options.length; oIdx++) {
                        const opt = group.options[oIdx].toLowerCase();
                        if (opt.includes(choice) || choice.includes(opt.split(' ')[0])) {
                            matchedOption = group.options[oIdx];
                            matchedIndex = oIdx;
                            break;
                        }
                    }
                    if (matchedOption) break;
                }

                // If no match found, use first option as default
                if (!matchedOption && group.options.length > 0) {
                    matchedOption = group.options[0];
                    matchedIndex = 0;
                }

                if (matchedOption) {
                    const cleanOption = matchedOption.replace(/\s*\(\+?\$[\d.]+\)\s*$/, '').trim();
                    selections.push({
                        groupIndex: gIdx,
                        optionIndex: matchedIndex,
                        optionText: cleanOption
                    });
                    console.log(`[DoorDash] Group ${gIdx} (${group.name}): Matched "${cleanOption}"`);
                }
            }

            // Store the new selections and trigger add item
            prefs.pendingDoordashSelections = selections;
            db.setUserPreferences(user.id, prefs);

            const item = prefs.pendingDoordashItem;
            const num = item.menuIndex;

            cleanResponse = cleanResponse.replace(textSelectMatch[0], '').trim();

            try {
                const addResult = await doordash.addItemByIndex(num, {
                    selectFirst: false,
                    selections: selections,
                    skipOptionsCheck: true
                }, item);

                if (addResult.success) {
                    prefs.pendingDoordashItem = null;
                    prefs.pendingDoordashOptions = null;
                    prefs.pendingDoordashSelections = null;
                    db.setUserPreferences(user.id, prefs);

                    const cartItem = {
                        id: item.id || `doordash-${num}`,
                        name: item.name,
                        price: item.price || 0,
                        source: 'doordash'
                    };
                    db.addToCart(user.id, prefs.currentRestaurant, cartItem);

                    const cart = db.getCart(user.id);
                    additionalContext = `\n\nAdded ${item.name}!\n\n${restaurants.formatCart(cart)}\n\nAnything else, or say "checkout" to order?`;
                    actions.push({ type: 'add_item_doordash', item: item.name });
                } else if (addResult.needsOptions) {
                    additionalContext = `\n\nPlease select more options:\n`;
                    addResult.requiredOptions.forEach((group) => {
                        additionalContext += `**${group.name}**:\n`;
                        group.options.forEach((opt, oIdx) => {
                            additionalContext += `   ${oIdx + 1}. ${opt}\n`;
                        });
                    });
                    prefs.pendingDoordashOptions = addResult.requiredOptions;
                    db.setUserPreferences(user.id, prefs);
                } else {
                    additionalContext = `\n\nCouldn't add ${item.name}. ${addResult.error || 'Please try again.'}`;
                }
            } catch (error) {
                console.error('[AddItem] DoorDash text selection error:', error);
                additionalContext = `\n\nError adding item. Please try again.`;
            }
        }
    }

    // Handle option selection for pending item (both mock and DoorDash)
    const optionMatch = response.match(/\[SELECT_OPTION:\s*(\d+)\]/i);
    if (optionMatch) {
        const optNum = parseInt(optionMatch[1]) - 1;
        const prefs = db.getUserPreferences(user.id);
        cleanResponse = cleanResponse.replace(optionMatch[0], '').trim();

        // Check if we have a pending DoorDash item with options
        if (prefs.pendingDoordashItem && prefs.pendingDoordashOptions) {
            console.log('[DoorDash] Applying user option selection:', optNum);
            console.log('[DoorDash] Pending options groups:', prefs.pendingDoordashOptions.length);

            // Build selections for ALL groups
            // User's choice for the first group, auto-select first option for remaining groups
            const selections = [];

            for (let gIdx = 0; gIdx < prefs.pendingDoordashOptions.length; gIdx++) {
                const group = prefs.pendingDoordashOptions[gIdx];

                if (gIdx === 0) {
                    // User's selection for first group
                    let optionText = '';
                    if (group.options[optNum]) {
                        optionText = group.options[optNum];
                        optionText = optionText.replace(/\s*\(\+?\$[\d.]+\)\s*$/, '').trim();
                    }
                    selections.push({
                        groupIndex: gIdx,
                        optionIndex: optNum,
                        optionText: optionText
                    });
                    console.log(`[DoorDash] Group ${gIdx} (${group.name}): User selected "${optionText}"`);
                } else if (!group.hasSelection) {
                    // Auto-select first option for remaining unselected groups
                    const firstOption = group.options[0] || '';
                    const cleanOption = firstOption.replace(/\s*\(\+?\$[\d.]+\)\s*$/, '').trim();
                    selections.push({
                        groupIndex: gIdx,
                        optionIndex: 0,
                        optionText: cleanOption
                    });
                    console.log(`[DoorDash] Group ${gIdx} (${group.name}): Auto-selecting "${cleanOption}"`);
                }
            }

            prefs.pendingDoordashSelections = selections;
            db.setUserPreferences(user.id, prefs);

            // Re-trigger add item with the selection
            const item = prefs.pendingDoordashItem;
            const num = item.menuIndex;

            try {
                const addResult = await doordash.addItemByIndex(num, {
                    selectFirst: false,
                    selections: prefs.pendingDoordashSelections,
                    skipOptionsCheck: true
                }, item);

                if (addResult.success) {
                    // Clear pending state
                    prefs.pendingDoordashItem = null;
                    prefs.pendingDoordashOptions = null;
                    prefs.pendingDoordashSelections = null;
                    db.setUserPreferences(user.id, prefs);

                    // Add to cart
                    const cartItem = {
                        id: item.id || `doordash-${num}`,
                        name: item.name,
                        price: item.price || 0,
                        source: 'doordash'
                    };
                    db.addToCart(user.id, prefs.currentRestaurant, cartItem);

                    const cart = db.getCart(user.id);
                    additionalContext = `\n\nAdded ${item.name}!\n\n${restaurants.formatCart(cart)}\n\nAnything else, or say "checkout" to order?`;
                    actions.push({ type: 'add_item_doordash', item: item.name });
                } else if (addResult.needsOptions) {
                    // Still more options needed
                    additionalContext = `\n\nPlease select more options:\n`;
                    addResult.requiredOptions.forEach((group, gIdx) => {
                        additionalContext += `**${group.name}**:\n`;
                        group.options.forEach((opt, oIdx) => {
                            additionalContext += `${oIdx + 1}. ${opt}\n`;
                        });
                    });
                    prefs.pendingDoordashOptions = addResult.requiredOptions;
                    db.setUserPreferences(user.id, prefs);
                } else {
                    additionalContext = `\n\nCouldn't add ${item.name}. ${addResult.error || 'Please try again.'}`;
                }
            } catch (error) {
                console.error('[DoorDash] Option selection error:', error);
                additionalContext = `\n\nError adding item. Please try again.`;
            }
        } else if (prefs.pendingItem && prefs.currentRestaurant) {
            // Mock restaurant pending item
            const item = prefs.pendingItem;
            const optionName = Object.keys(item.requiredOptions)[0];
            const options = item.requiredOptions[optionName];
            const selectedOption = options[optNum];

            if (selectedOption) {
                // Add item with selected option
                const itemWithOption = {
                    ...item,
                    name: `${item.name} (${selectedOption.replace(' (+$2)', '')})`,
                    price: selectedOption.includes('+$2') ? item.price + 2 : item.price,
                    selectedOptions: { [optionName]: selectedOption }
                };
                delete itemWithOption.requiredOptions;
                delete itemWithOption.menuIndex;

                db.addToCart(user.id, prefs.currentRestaurant, itemWithOption);

                // Clear pending item
                prefs.pendingItem = null;
                db.setUserPreferences(user.id, prefs);

                const cart = db.getCart(user.id);
                additionalContext = `\n\nAdded ${itemWithOption.name}!\n\n${restaurants.formatCart(cart)}\n\nAnything else, or say "checkout" to order?`;
                actions.push({ type: 'add_item', item: itemWithOption.name });
            }
        }
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

    // Clear cart
    if (response.includes('[CLEAR_CART]')) {
        db.clearCart(user.id);
        const prefs = db.getUserPreferences(user.id);
        prefs.currentRestaurant = null;
        db.setUserPreferences(user.id, prefs);
        cleanResponse = cleanResponse.replace('[CLEAR_CART]', '').trim();
        additionalContext = `\n\nCart cleared! What else can I help with?`;
        actions.push({ type: 'clear_cart' });
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

                    if (result.success) {
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
                            total.toFixed(2)
                        );
                        db.clearCart(user.id);
                        prefs.currentRestaurant = null;
                        prefs.currentRestaurantSource = null;
                        db.setUserPreferences(user.id, prefs);

                        additionalContext = `\n\n🎉 Order placed successfully!\n\nTrack your order in the DoorDash app.`;
                        actions.push({ type: 'order_placed_doordash', restaurant: restaurantName });
                    } else {
                        additionalContext = `\n\n${result.error || 'Could not complete checkout.'}\n\nYour cart is saved. Try ordering directly through the DoorDash app.`;
                    }
                } catch (error) {
                    console.error('[Checkout] DoorDash error:', error);
                    additionalContext = `\n\nSomething went wrong. Try ordering directly through the DoorDash app.`;
                }
            } else {
                // Mock restaurant order - use original flow
                const credentials = db.getDoorDashCredentials(user.id);
                const totals = restaurants.calculateMultiOrderTotal(cart);

                // Prepare items for DoorDash automation
                const orderItems = [];
                const restaurantNames = [];

                restaurantIds.forEach(restaurantId => {
                    const restaurant = restaurants.getRestaurant(restaurantId);
                    const items = cart.items[restaurantId];
                    if (!restaurant || !items) return;

                    restaurantNames.push(restaurant.name);

                    items.forEach(item => {
                        orderItems.push({
                            restaurant: restaurant.name,
                            name: item.name,
                            options: item.selectedOptions || {},
                            quantity: item.quantity || 1
                        });
                    });
                });

            // Send initial response while order is being placed
            additionalContext = `\n\nPlacing your order on DoorDash...\n\n`;
            additionalContext += restaurantNames.map(n => `📍 ${n}`).join('\n') + '\n';
            additionalContext += `Total: ~$${totals.total}\n\n`;
            additionalContext += `Please wait while I complete the order...`;

            // Place order via browser automation with session reuse
            try {
                // Group items by restaurant for multi-restaurant orders
                const ordersByRestaurant = {};
                orderItems.forEach(item => {
                    if (!ordersByRestaurant[item.restaurant]) {
                        ordersByRestaurant[item.restaurant] = [];
                    }
                    ordersByRestaurant[item.restaurant].push(item);
                });

                const restaurantList = Object.entries(ordersByRestaurant);
                const isMultiOrder = restaurantList.length > 1;

                // Place orders for each restaurant with session reuse
                const orderResults = [];
                const successfulOrders = [];
                const failedOrders = [];

                for (let i = 0; i < restaurantList.length; i++) {
                    const [restaurantName, items] = restaurantList[i];
                    const isLastOrder = i === restaurantList.length - 1;

                    console.log(`[DoorDash] Placing order ${i + 1}/${restaurantList.length} at ${restaurantName}...`);

                    // Use keepBrowserOpen for all orders except the last one
                    const result = await doordash.placeFullOrder(credentials, {
                        restaurantName,
                        items,
                        address,
                        tipPercent: 15
                    }, {
                        keepBrowserOpen: !isLastOrder && isMultiOrder,
                        isAdditionalOrder: i > 0
                    });

                    orderResults.push({
                        restaurant: restaurantName,
                        ...result
                    });

                    if (result.success) {
                        successfulOrders.push({ restaurant: restaurantName, result });
                    } else {
                        failedOrders.push({ restaurant: restaurantName, result });
                        // Don't break - try remaining orders if using session reuse
                        if (!isMultiOrder) break;
                    }
                }

                // Handle results
                const allSuccess = failedOrders.length === 0;
                const partialSuccess = successfulOrders.length > 0 && failedOrders.length > 0;

                if (allSuccess) {
                    // All orders successful - clear cart
                    const orderIds = [];
                    restaurantIds.forEach(restaurantId => {
                        const restaurant = restaurants.getRestaurant(restaurantId);
                        const items = cart.items[restaurantId];
                        if (!restaurant || !items) return;

                        const restaurantTotals = restaurants.calculateOrderTotal(items, restaurant);
                        const orderId = db.createOrder(
                            user.id,
                            restaurant.id,
                            restaurant.name,
                            items,
                            address,
                            parseFloat(restaurantTotals.subtotal),
                            parseFloat(restaurantTotals.total)
                        );
                        orderIds.push(orderId);

                        // Learn from this order
                        if (!prefs.favoriteCuisines) prefs.favoriteCuisines = [];
                        if (!prefs.favoriteCuisines.includes(restaurant.cuisine)) {
                            prefs.favoriteCuisines.push(restaurant.cuisine);
                        }
                        if (!prefs.favoriteRestaurants) prefs.favoriteRestaurants = [];
                        if (!prefs.favoriteRestaurants.includes(restaurant.id)) {
                            prefs.favoriteRestaurants.unshift(restaurant.id);
                            prefs.favoriteRestaurants = prefs.favoriteRestaurants.slice(0, 5);
                        }
                    });

                    // Clear cart and prefs only on full success
                    db.clearCart(user.id);
                    prefs.currentRestaurant = null;
                    prefs.lastSearchResults = null;
                    db.setUserPreferences(user.id, prefs);

                    // Format success message
                    const firstResult = orderResults[0];
                    const eta = firstResult.eta || '30-45 min';

                    if (restaurantIds.length > 1) {
                        additionalContext = `\n\nOrders placed on DoorDash!\n\n`;
                        additionalContext += restaurantNames.map(n => `📍 ${n}`).join('\n') + '\n\n';
                        additionalContext += `Total: $${totals.total}\n`;
                        additionalContext += `Delivering to: ${address}\n\n`;
                        if (firstResult.orderNumber) {
                            additionalContext += `DoorDash Order: ${firstResult.orderNumber}\n`;
                        }
                        additionalContext += `Estimated arrival: ${eta}\n\n`;
                        additionalContext += `Track your order in the DoorDash app!`;
                    } else {
                        const restaurant = restaurants.getRestaurant(restaurantIds[0]);
                        additionalContext = `\n\nOrder placed on DoorDash!\n\n`;
                        additionalContext += `${restaurant.name}\n`;
                        additionalContext += `Total: $${totals.total}\n`;
                        additionalContext += `Delivering to: ${address}\n\n`;
                        if (firstResult.orderNumber) {
                            additionalContext += `DoorDash Order: ${firstResult.orderNumber}\n`;
                        }
                        additionalContext += `Estimated arrival: ${eta}\n\n`;
                        additionalContext += `Track your order in the DoorDash app!`;
                    }

                    actions.push({
                        type: 'order_placed_doordash',
                        orderIds,
                        total: totals.total,
                        doordashResults: orderResults
                    });

                } else if (partialSuccess) {
                    // Some orders succeeded, some failed - DON'T clear cart
                    additionalContext = `\n\nPartial order success:\n\n`;
                    successfulOrders.forEach(({ restaurant }) => {
                        additionalContext += `✓ ${restaurant} - Order placed!\n`;
                    });
                    failedOrders.forEach(({ restaurant, result }) => {
                        const errorMsg = doordash.getUserFriendlyError(result.errorType || result.error);
                        additionalContext += `✗ ${restaurant} - ${errorMsg}\n`;
                    });
                    additionalContext += `\nYour cart still has the failed items. Say "checkout" to retry.`;

                    actions.push({
                        type: 'order_partial_success',
                        successfulOrders: successfulOrders.map(o => o.restaurant),
                        failedOrders: failedOrders.map(o => o.restaurant),
                        doordashResults: orderResults
                    });

                } else {
                    // All orders failed - DON'T clear cart so user can retry
                    const firstFailure = failedOrders[0];
                    const errorType = firstFailure.result.errorType || firstFailure.result.error;
                    const errorMsg = doordash.getUserFriendlyError(errorType);

                    additionalContext = `\n\nOrder failed: ${errorMsg}\n\n`;

                    // Provide specific recovery suggestions based on error type
                    switch (errorType) {
                        case doordash.DoorDashErrors.TWO_FA_REQUIRED:
                        case doordash.DoorDashErrors.TWO_FA_TIMEOUT:
                            additionalContext += `Please login to DoorDash manually to complete verification, then try again.`;
                            break;
                        case doordash.DoorDashErrors.NO_PAYMENT_METHOD:
                            additionalContext += `Add a payment method in the DoorDash app, then try again.`;
                            break;
                        case doordash.DoorDashErrors.RESTAURANT_CLOSED:
                        case doordash.DoorDashErrors.RESTAURANT_UNAVAILABLE:
                            additionalContext += `Try a different restaurant or check back later.`;
                            break;
                        case doordash.DoorDashErrors.ADDRESS_NOT_SERVICEABLE:
                            additionalContext += `This restaurant may not deliver to your address. Try a different restaurant.`;
                            break;
                        case doordash.DoorDashErrors.MINIMUM_NOT_MET:
                            additionalContext += `Add more items to meet the minimum order amount.`;
                            break;
                        case doordash.DoorDashErrors.ITEM_SOLD_OUT:
                        case doordash.DoorDashErrors.ITEM_UNAVAILABLE:
                            additionalContext += `Some items aren't available. Try removing them and ordering again.`;
                            break;
                        default:
                            additionalContext += `Your cart is saved. Say "checkout" to try again, or "clear cart" to start over.`;
                    }

                    // Include failed step info if available
                    if (firstFailure.result.failedStep) {
                        console.log(`[DoorDash] Order failed at step: ${firstFailure.result.failedStep}`);
                    }

                    actions.push({
                        type: 'order_failed',
                        error: errorType,
                        errorMessage: errorMsg,
                        restaurant: firstFailure.restaurant,
                        failedStep: firstFailure.result.failedStep,
                        doordashResults: orderResults
                    });
                }

            } catch (error) {
                console.error('[DoorDash] Order error:', error);
                // DON'T clear cart on error - let user retry
                additionalContext = `\n\nSomething went wrong placing your order.\n\n`;
                additionalContext += `Your cart is saved. Say "checkout" to try again.\n\n`;
                additionalContext += `If the problem continues, try ordering directly through the DoorDash app.`;
                actions.push({ type: 'order_error', error: error.message });

                // Try to close browser on error
                try {
                    await doordash.closeBrowser();
                } catch (e) {
                    // Ignore
                }
            }
            } // Close else block for mock restaurant flow
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

    // Quick order - supports multiple items from different restaurants
    const quickOrderMatches = [...response.matchAll(/\[QUICK_ORDER:\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?\]/gi)];
    const quickOrdersAdded = [];
    let pendingQuickOrder = null;

    for (const match of quickOrderMatches) {
        const restaurantQuery = match[1].trim().toLowerCase();
        const itemQuery = match[2].trim().toLowerCase();
        const optionQuery = match[3]?.trim().toLowerCase();
        cleanResponse = cleanResponse.replace(match[0], '').trim();

        // Find restaurant
        const allRestaurants = restaurants.restaurants;
        const restaurant = allRestaurants.find(r => {
            const name = r.name.toLowerCase();
            const firstWord = name.split(' ')[0];
            return restaurantQuery.includes(firstWord) || name.includes(restaurantQuery);
        });

        if (restaurant) {
            // Find menu item
            const menuItem = restaurant.menu.find(item => {
                const itemName = item.name.toLowerCase();
                return itemName.includes(itemQuery) || itemQuery.includes(itemName.split(' ')[0]);
            });

            if (menuItem) {
                // Check if item needs options and we have them
                if (menuItem.requiredOptions && optionQuery) {
                    const optionName = Object.keys(menuItem.requiredOptions)[0];
                    const options = menuItem.requiredOptions[optionName];
                    const selectedOption = options.find(opt =>
                        opt.toLowerCase().includes(optionQuery) || optionQuery.includes(opt.toLowerCase().split(' ')[0])
                    );

                    if (selectedOption) {
                        const itemWithOption = {
                            ...menuItem,
                            name: `${menuItem.name} (${selectedOption.replace(' (+$2)', '')})`,
                            price: selectedOption.includes('+$2') ? menuItem.price + 2 : menuItem.price,
                            selectedOptions: { [optionName]: selectedOption }
                        };
                        delete itemWithOption.requiredOptions;

                        db.addToCart(user.id, restaurant.id, itemWithOption);
                        quickOrdersAdded.push(`${itemWithOption.name} from ${restaurant.name}`);
                        actions.push({ type: 'quick_order', restaurant: restaurant.name, item: itemWithOption.name });
                    } else {
                        pendingQuickOrder = { restaurant, menuItem, optionName };
                    }
                } else if (menuItem.requiredOptions) {
                    pendingQuickOrder = { restaurant, menuItem };
                } else {
                    db.addToCart(user.id, restaurant.id, menuItem);
                    quickOrdersAdded.push(`${menuItem.name} from ${restaurant.name}`);
                    actions.push({ type: 'quick_order', restaurant: restaurant.name, item: menuItem.name });
                }
            }
        }
    }

    // Show results after processing all quick orders
    if (quickOrdersAdded.length > 0) {
        const cart = db.getCart(user.id);
        const itemList = quickOrdersAdded.join(' and ');
        additionalContext = `\n\nAdded ${itemList}!\n\n${restaurants.formatCart(cart)}\n\nAnything else, or say "checkout" to order?`;
    }

    // Handle any pending item that needs options
    if (pendingQuickOrder && quickOrdersAdded.length === 0) {
        const { restaurant, menuItem } = pendingQuickOrder;
        const prefs = db.getUserPreferences(user.id);
        prefs.currentRestaurant = restaurant.id;
        prefs.pendingItem = { ...menuItem };
        db.setUserPreferences(user.id, prefs);

        const optionName = Object.keys(menuItem.requiredOptions)[0];
        const options = menuItem.requiredOptions[optionName];
        additionalContext = `\n\nChoose your ${optionName} for ${menuItem.name}:\n\n`;
        additionalContext += options.map((opt, i) => `${i + 1}. ${opt}`).join('\n');
        additionalContext += `\n\nReply with the number.`;
    }

    // Reorder last order
    if (response.includes('[REORDER]')) {
        const orders = db.getUserOrders(user.id, 1);
        cleanResponse = cleanResponse.replace('[REORDER]', '').trim();

        if (orders.length > 0) {
            const lastOrder = orders[0];
            const restaurant = restaurants.getRestaurant(lastOrder.restaurant_id);

            if (restaurant) {
                // Add all items from last order to cart
                db.clearCart(user.id);
                lastOrder.items.forEach(item => {
                    db.addToCart(user.id, lastOrder.restaurant_id, item);
                });

                // Set current restaurant
                const prefs = db.getUserPreferences(user.id);
                prefs.currentRestaurant = lastOrder.restaurant_id;
                db.setUserPreferences(user.id, prefs);

                const cart = db.getCart(user.id);
                additionalContext = `\n\nI've loaded your last order!\n\n${restaurants.formatCart(cart)}\n\nSay "checkout" to place this order, or make changes.`;
                actions.push({ type: 'reorder', orderId: lastOrder.id });
            } else {
                additionalContext = `\n\nSorry, ${lastOrder.restaurant_name} isn't available right now. Want to try somewhere else?`;
            }
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
            additionalContext = `\n\n${getOrderStatusText(latestOrder)}`;
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
        if (restaurantIds.length === 0) {
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
        if (preferences.currentRestaurantSource === 'doordash') {
            // Get cached DoorDash restaurant with menu
            const cachedRestaurant = db.getCachedCurrentRestaurant(user.id);
            if (cachedRestaurant) {
                currentRestaurant = { name: cachedRestaurant.name, source: 'doordash' };
                doordashMenu = cachedRestaurant.menu || [];
            }
        } else {
            // Mock restaurant
            currentRestaurant = restaurants.getRestaurant(preferences.currentRestaurant);
        }
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

    try {
        const { response, actions } = await handleMessage(from, message);
        console.log(`[Twilio] Reply to ${from}: ${response.substring(0, 100)}...`);
        await sendSMS(from, response);
        res.sendStatus(200);
    } catch (error) {
        console.error('[Twilio Webhook] Error:', error);
        await sendSMS(from, 'Sorry, something went wrong. Please try again.');
        res.sendStatus(200);
    }
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
            db.setUserPreferences(user.id, prefs);
            // Also clear cached restaurant data
            db.clearDoorDashCache(user.id);
            console.log(`[Clear] Cleared all data for user ${user.id}`);
        }
    }
    res.json({ success: true });
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

// Cleanup expired sessions periodically
setInterval(() => {
    db.deleteExpiredSessions();
}, 60 * 60 * 1000);

// Proactive order status SMS updates (every 2 minutes)
async function pollOrderStatuses() {
    try {
        const activeOrders = db.getActiveOrders();
        for (const order of activeOrders) {
            const minutesAgo = Math.floor((Date.now() - new Date(order.placed_at).getTime()) / 60000);

            let newStatus;
            if (minutesAgo < 5) newStatus = 'placed';
            else if (minutesAgo < 20) newStatus = 'preparing';
            else if (minutesAgo < 35) newStatus = 'picked_up';
            else if (minutesAgo < 50) newStatus = 'on_the_way';
            else newStatus = 'delivered';

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
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

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
                if (time !== currentTime) continue;

                console.log(`[Scheduler] Placing scheduled order for user ${userRow.id} at ${time}`);

                // Clear scheduled order first to prevent double-execution
                prefs.scheduledOrder = null;
                db.db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(prefs), userRow.id);

                const phone = userPhone || userRow.phone_number;
                await sendSMS(phone, `Placing your scheduled order now!`);

                // Create order record from snapshot
                const restaurantIds = Object.keys(cart || {});
                if (restaurantIds.length === 0) continue;

                const creds = db.getDoorDashCredentials(userRow.id);

                if (creds && restaurantSource !== 'mock') {
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
                        await sendSMS(phone, `Scheduled order placed! ETA: ${result.eta || '30-45 min'}`);
                    } else {
                        await sendSMS(phone, `Couldn't place your scheduled order automatically. Please order manually.`);
                    }
                } else {
                    // Mock order — just create DB record
                    let subtotal = 0;
                    restaurantIds.forEach(rid => {
                        const restaurant = restaurants.getRestaurant(rid);
                        (cart[rid] || []).forEach(item => { subtotal += (item.price || 0) * (item.quantity || 1); });
                        if (restaurant) {
                            const totals = restaurants.calculateOrderTotal(cart[rid], restaurant);
                            db.createOrder(userRow.id, rid, restaurant.name, cart[rid], address, parseFloat(totals.subtotal), parseFloat(totals.total));
                        }
                    });

                    await sendSMS(phone, `Your scheduled order has been placed!`);
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
app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  MessageAI Server Running!`);
    console.log(`========================================`);
    console.log(`  Open in browser: http://localhost:${PORT}`);
    console.log(`  Database: messageai.db`);
    console.log(`========================================\n`);

    if (!process.env.ANTHROPIC_API_KEY) {
        console.log('Warning: ANTHROPIC_API_KEY not set in .env file\n');
    }
});
