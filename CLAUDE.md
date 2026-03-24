# MessageAI — Claude Session Brief

## What This App Is
SMS-based AI food ordering assistant. Users text a phone number, talk to Claude, and it finds nearby restaurants on DoorDash, shows menus, and places real orders via browser automation (Playwright).

## How to Run
```bash
cd /c/Users/hatch/Projects/MessageAI
"/c/Program Files/nodejs/node.exe" server.js
```
Then start Cloudflare tunnel in a second terminal:
```bash
"/c/Program Files (x86)/cloudflared/cloudflared" tunnel --url http://localhost:3000
```
Update Twilio webhook with the new tunnel URL:
```bash
curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/$TWILIO_PHONE_SID.json" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  -d "SmsUrl=https%3A%2F%2F[NEW_URL]%2Fapi%2Ftwilio%2Fwebhook"
```
Test via browser at http://localhost:3000 (SMS simulator UI).

## Key Config
- **Node**: `C:\Program Files\nodejs\node.exe` (v24) — always use full path in bash
- **Twilio number**: (801) 346-2263 / +18013462263
- **DB**: better-sqlite3 (messageai.db), AES-256 encrypted
- **DoorDash account**: testclaudemail762@gmail.com / S@ltcode8!
- **User address**: 12447 S Deer Cove Draper Utah 84020
- **User phone**: +18018006072

## Architecture
| File | Purpose |
|------|---------|
| `server.js` | Main server — Express, Claude AI, all command processing |
| `doordash.js` | Browser automation (Playwright) — menu scraping, adding items, checkout |
| `doordash-api.js` | Cookie-based HTTP search (no CAPTCHA) — used first, falls back to browser |
| `restaurants.js` | Cart formatting and order total helpers only (no mock data) |
| `db.js` | SQLite with AES-256 encryption |
| `public/index.html` | SMS simulator UI |
| `public/privacy.html` | Privacy policy (also hosted at hatchatcha9.github.io/messageai-legal/) |
| `public/terms.html` | Terms & conditions (also hosted at hatchatcha9.github.io/messageai-legal/) |

## Commands Claude Understands (in server.js system prompt)
`[SEARCH: query]` `[SELECT: N]` `[ADD_ITEM_NUM: N]` `[SELECT_OPTION: N]` `[SELECT_OPTIONS_TEXT: text]`
`[SHOW_CART]` `[CLEAR_CART]` `[REMOVE_ITEM: name]` `[PLACE_ORDER]` `[SAVE_ADDRESS: address]`
`[MY_ORDERS]` `[REORDER]` `[SETUP_DOORDASH: email | password]` `[CHECK_DOORDASH]`
`[ORDER_STATUS]` `[SCHEDULE_ORDER: HH:MM]` `[CANCEL_SCHEDULE]`
`[SAVE_BUDGET: amount]` `[CLEAR_BUDGET]`

## What Was Fixed (2026-03-12 session)
1. **Mock restaurant data removed** — server.js no longer references getRestaurant/formatMenu, only DoorDash
2. **REMOVE_ITEM command added** — `[REMOVE_ITEM: name]` does name-based lookup and removes one item
3. **Cart display in buildSystemPrompt** — fixed `cart.items?.length` (was object not array)
4. **Legacy pendingItem handler removed** — old mock-era dead code in SELECT_OPTION
5. **Multi-item + options bug** — when item 1 needs options, loop now breaks and queues item 2
6. **SELECT_OPTIONS_TEXT / SELECT_OPTION reordered** — now run BEFORE ADD_ITEM_NUM so pending options resolve first
7. **SELECT_OPTIONS_TEXT always strips command** — no longer leaks raw `[SELECT_OPTIONS_TEXT: ...]` into response
8. **No-modal item add** — simple items (drinks etc.) get added directly without a modal; treated as success
9. **Claude hallucinating cart** — added CRITICAL RULE: never describe cart contents yourself
10. **Missing closing brace in PLACE_ORDER** — pre-existing syntax error fixed
11. **Post-cart-clear search** — Claude now uses [SEARCH:] after clearing cart instead of plain text

## A2P 10DLC Status
- Campaign resubmitted 2026-03-12 after fixing:
  - Privacy/Terms URLs now real: https://hatchatcha9.github.io/messageai-legal/
  - Removed incorrect "lending" and "age-gated" checkboxes
  - Updated opt-in language and sample messages
- Awaiting approval

## Known Working
- Real DoorDash ordering works end-to-end (orders go to 12447 S Deer Cove)
- Budget filtering (`under $15`) filters menu display
- Scheduled orders fire automatically
- Order status polling (real DoorDash status + time-based fallback)

## What Was Fixed (2026-03-13 session)
1. **SELECT_OPTIONS_TEXT phrase matching** — old code split on all whitespace+commas into individual words, causing "teri" to match BOTH protein groups before "kalua" got a chance. Fixed to split on commas only, then match positionally: phrase[0]→group[0], phrase[1]→group[1], etc. (`server.js` ~line 522)
2. **applyOptionSelections text matching** — changed from `text.includes(option)` to score-based matching: exact(3) > startsWith+space(2) > startsWith(1), no includes fallback. Prevents "SUB - White Rice" matching "White Rice". (`doordash.js`)
3. **applyOptionSelections atomic click** — rewrote to do find+scroll+click all inside a single `page.evaluate` call. Eliminates the async gap between evaluate and `page.mouse.click` where DoorDash's modal could shift and cause misses. Uses `dispatchEvent(mousedown/mouseup/click)` + `.click()` for React compatibility. Also added group-index fallback: `radiogroup[groupIndex] → radio[optionIndex]`. (`doordash.js` ~line 4036)

## What Was Fixed (2026-03-15 session)
1. **Restaurant name cleanup** — `extractRestaurantList` in doordash.js now strips `4.8(50+)•0.6 mi•21 min` appended after restaurant names
2. **CLEAR_CART ordering** — moved before SEARCH in processCommands so SEARCH's additionalContext (live results) isn't overwritten by CLEAR_CART's "Cart cleared!" message
3. **Cart duplication** — Claude was reproducing old dirty search results from conversation history. Fixed by: (a) clearing conversation history, (b) adding CRITICAL RULE to not write search lists or cart content, (c) stripping ══/──/bullet-price patterns from cleanResponse before appending additionalContext
4. **Browser cart sync** — added `clearBrowserCart()` to doordash.js (clicks decrement buttons until empty), called on both `[CLEAR_CART]` command and `/api/clear` endpoint
5. **doordash-api.js HTTP search** — BLOCKED by DoorDash WAF (GraphQL 403, REST 404) — browser fallback always used now

## Confirmed Working (2026-03-15)
- Options flow end-to-end: Mo' Bettahs → Mini 2 Choice → "Teri Chicken, Kalua Pig, Macaroni Salad, White Rice, Teri Sauce" → adds correctly ✅
- REMOVE_ITEM: works correctly ✅
- Multi-item + options: Mini-2 Choice + drink both added, both tracked in actions array ✅
- Clean cart display: shows once, no duplication ✅

## What Was Fixed (2026-03-15 session, part 2)
1. **Checkbox topping selection** — Five Guys uses checkboxes (multi-select) not radio buttons. Fixed `applyOptionSelections` to use `page.mouse.click(x, y)` instead of JS `element.click()`. Screenshots confirm checkboxes are now being checked.
2. **Multi-select overflow phrases** — `SELECT_OPTIONS_TEXT` now maps overflow phrases (more phrases than groups) to the last group. "Lettuce, Tomato, Pickle, Ketchup" creates 4 selections for group 0 instead of just 1.
3. **Cart stripping regex** — New regex strips `══ YOUR CART/ORDER ══` blocks Claude generates; now uses broader pattern matching `YOUR CART|YOUR ORDER|🛒` inside the block.
4. **Checkout button detection** — Rewrote `checkoutCurrentCart()` to search for checkout buttons by `data-anchor-id` and text anywhere on the page (including right sidebar). Fallback uses `/cart/` URL instead of broken `/checkout/`.

## Confirmed Working (2026-03-15 part 2)
- **Full end-to-end order placed** ✅ — Five Guys, Little Cheeseburger + Coke, checkout through DoorDash successfully
- Checkbox topping selection (Lettuce, Tomato, Pickle, Ketchup all checked) ✅
- Cart shows once, no duplication ✅
- Checkout placed real order to 12447 S Deer Cove ✅

## What Was Fixed (2026-03-20 session — Railway deployment)
1. **Search 0 restaurants** — DoorDash URL format changed from `/store/12345/` to `/store/slug/12345?cursor=...`; fixed regex in `extractRestaurantList` + strip query params
2. **Headed browser on Railway** — `headless: false` hardcoded in both `doordash.js` and `doordash-api.js`; both now use env-based headless flag
3. **Windows-only profile path** — Both files now use `BROWSER_DATA_DIR` env var for browser profile on non-Windows
4. **Login OTP loop** — DoorDash sends OTP on Railway; improved "Use password instead" link detection
5. **Fragile isLoggedIn check** — Replaced inline `!pageContent.includes('sign-in')` with proper `isLoggedIn()` function
6. **networkidle timeouts** — All 6 occurrences replaced with `domcontentloaded`
7. **CF cookie fingerprint** — `cf_clearance`/`__cf_bm`/`_cfuvid` are browser-fingerprint-specific; now filtered out when importing DOORDASH_COOKIES env var
8. **Crash recovery** — Auth cookies re-imported in every `launchBrowser()` call so session survives browser crash/restart
9. **Menu extraction rewrite** — Old viewport-based filtering failed in headless; rewritten to scroll full page then extract all price-containing elements
10. **Remote logging** — Added in-memory log buffer + `/logs` HTTP endpoint for Railway debugging
11. **DOORDASH_COOKIES env** — 110 session cookies exported locally, set in Railway env vars, auto-imported on startup and browser launch

## What Was Fixed (2026-03-22 session — CF bypass attempts)
1. **Xvfb / headed Chrome disabled** — `start.sh` reverted to headless mode; headed Chrome under Xvfb crashes with SIGSEGV in compositor (`--disable-gpu` causes null pointer deref in rendering pipeline)
2. **Log buffer increased** — 300 → 2000 lines in server.js
3. **extractMenuItems LI bug** — old child-price check walked ALL descendants; large flex-container divs caused parent LIs to be incorrectly skipped; fixed to check only child LI elements
4. **railway.toml startCommand removed** — `startCommand = "node server.js"` was overriding the Dockerfile CMD, bypassing xvfb-run; removed
5. **Chrome SingletonLock** — delete `SingletonLock`/`SingletonCookie`/`SingletonSocket` before `launchPersistentContext` to handle Railway redeploys on new hosts
6. **Pre-fetch menu before navigation** — `selectRestaurantFromSearch` now calls `fetchMenuFromInContextAPI(storeId)` BEFORE navigating; result cached in `_preloadedMenuItems`; `extractMenuItems` returns immediately if preloaded
7. **CF wait reduced** — `waitForCFChallenge` in `selectRestaurantFromSearch` reduced to 5s if preloaded, 30s otherwise (was 60s)
8. **Page price wait reduced** — `waitForFunction` in `extractMenuItems` reduced from 60s → 15s (faster fallback to API)
9. **Network response interceptor** — `page.on('response', ...)` set up during search to capture DoorDash's own API responses; result: DoorDash makes NO XHR calls (SSR only), interceptor captures nothing
10. **`__NEXT_DATA__` check** — DoorDash does NOT use Next.js `__NEXT_DATA__`; confirmed by log
11. **Apollo Client found** — `window.__APOLLO_CLIENT__` exists! DoorDash uses Apollo GraphQL client
12. **Apollo cache extraction** — `_extractAndCacheMenuData()` added; called on Apollo `cache.extract()` after search results load; walks the cache tree looking for store ID + menus/featured_items

## Current State (as of 2026-03-22)
- **Last commit**: `602a2ad` — Apollo cache extraction (not yet tested, session ended before test)
- **Search**: Works ✓ — 10 pizza restaurants returned
- **Menu**: Still broken — all DoorDash API endpoints (`/api/v2/store/ID/`, `/graphql`) return **403** with CF challenge HTML from Railway IP, even from within browser context (XHR)
- **Apollo approach**: Most promising — `window.__APOLLO_CLIENT__` confirmed present. `cache.extract()` should contain store data DoorDash's JS has fetched. **This is the next thing to test.**

## Architecture of CF Problem
- CF allows: `/search/store/pizza/` page navigation ✓
- CF blocks: `/store/ID/` page navigation ✗ (Turnstile challenge)
- CF blocks: `/api/v2/store/ID/` XHR ✗ (403 even from browser context)
- CF blocks: `/graphql` POST ✗ (403 even from browser context)
- DoorDash uses Apollo Client (`window.__APOLLO_CLIENT__`) — cache stores all fetched data
- **Key**: Extract Apollo cache after search — no new requests needed

## Next Session TODO
1. **Deploy is live** — last push (`602a2ad`) should be deployed; test immediately
2. **Test Apollo approach**:
   ```bash
   curl -X POST "https://messageai-production.up.railway.app/api/twilio/webhook" -d "From=%2B18018006072&Body=pizza+near+me"
   # wait ~45s
   curl "https://messageai-production.up.railway.app/logs" | grep "Apollo\|Intercepted\|keyTypes\|menus for stores"
   ```
3. If Apollo cache has menu data → check log for `Apollo cache: X keys, types: {...}` and `menus for stores: 12345, ...`
4. If `_extractAndCacheMenuData` doesn't find items → log will show key types (e.g., `Store:12345`, `MenuItem:abc`) — use those types to write targeted extraction
5. Then select a restaurant and verify menu appears: `curl -X POST ... -d "From=...&Body=1"` → check for menu items in response

## Railway Testing (no Twilio needed)
```bash
# Send test message directly (no Twilio signature check)
curl -X POST "https://messageai-production.up.railway.app/api/twilio/webhook" \
  -d "From=%2B18018006072&Body=MESSAGE_HERE"
# Check logs
curl "https://messageai-production.up.railway.app/logs"
```
