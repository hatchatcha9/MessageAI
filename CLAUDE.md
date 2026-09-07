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

## A2P 10DLC Status — APPROVED & LIVE (verified via Twilio API 2026-08-29)
- **Brand** `BNe2c4d1b8da2b4c98b8dda6264349556d` — status APPROVED, identity VERIFIED, type SOLE_PROPRIETOR, TCR id `B7643AT`, approved 2026-03-10. No errors.
- **Campaign** `QE2c6890da8086d771620e9b13fadeba0b` (TCR campaign id `CR87P0R`) — campaign_status VERIFIED (terminal/active), use case SOLE_PROPRIETOR, registered 2026-03-10. No errors.
- **Messaging Service** `MG963204ab7a2e83b904872338925c41d5` ("Sole Proprietor A2P Messaging Service") — `us_app_to_person_registered: true`; inbound webhook → `https://messageai-production.up.railway.app/api/twilio/webhook` (Railway).
- **Number** `+18013462263` attached to that Messaging Service (SMS/MMS/Voice).
- **Sole Proprietor throughput caps:** AT&T 0.25 msg/sec (msg_class W); T-Mobile brand tier STARTER (~1,000 msgs/day). Fine for personal use, not scale.
- The old "Awaiting approval" note was stale — it approved 2026-03-10. What made it *look* broken on 2026-08-29 was the Twilio account running out of funds → suspended → API 401s; re-funding (balance $19.76, account now "Full"/active) restored everything. Nothing to fix on the A2P side.

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

## What Was Fixed (2026-03-26 session — CF bypass SOLVED)
1. **Residential proxy** — IPRoyal `geo.iproyal.com:12321` set as `PROXY_URL` Railway env var; Playwright proxy URL parsing fixed to extract username/password as separate fields
2. **Xvfb + headed Chrome** — Re-enabled Xvfb in `start.sh`; headed mode is the key bypass (CF Turnstile fingerprints headless browsers); startup confirms `headless=false, DISPLAY=:99`
3. **GPU flags fixed** — Previous crash (SIGSEGV) was `--disable-gpu` + headed + Xvfb; removed that flag; `--no-zygote`/`--use-gl=swiftshader` now headless-only (spread in args conditional on `headless`)
4. **User agent fixed** — Was `Chrome/131` but actual Chromium is v145; updated to `Chrome/145.0.0.0`
5. **Menu now loads** — `No CF challenge detected`, 10 menu categories, prices detected, items returned

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

## Current State (as of 2026-03-26)
- **Search**: Works ✓ — 10 restaurants returned
- **Menu**: **FIXED** ✓ — Xvfb + headed Chrome + IPRoyal residential proxy bypasses CF Turnstile
- **Orders**: Should work end-to-end (menu loads, items visible)

## Architecture of CF Problem
- CF allows: `/search/store/pizza/` page navigation ✓
- CF blocks: `/store/ID/` page navigation ✗ (Turnstile challenge)
- CF blocks: `/api/v2/store/ID/` XHR ✗ (403 even from browser context)
- CF blocks: `/graphql` POST ✗ (403 even from browser context)
- DoorDash uses Apollo Client (`window.__APOLLO_CLIENT__`) — cache stores all fetched data
- **Key**: Extract Apollo cache after search — no new requests needed

## What Was Fixed (2026-04-02 session — proxy replaced with fresh cookies)
1. **IPRoyal expired** — funds ran out; renewed but DoorDash hard-blocks ALL residential proxy pools (IPRoyal, BrightData) with HTTP 403
2. **2captcha integrated** — `solveCFWithCaptchaService()` added to `doordash.js`; supports `TWOCAPTCHA_API_KEY` or `CAPSOLVER_API_KEY`; integrated into `waitForCFChallenge`
3. **Expired DoorDash cookies** — `dd_session_id`/`authState` had expired; exported 107 fresh cookies from local browser → uploaded to Railway `DOORDASH_COOKIES`
4. **PROXY_URL removed** — not needed; fresh cookies + no proxy = DoorDash loads fine with no CF challenge
5. **Apollo cache __ref resolution** — fixed `resolveRef()` to recursively resolve `__ref` pointers in the normalized Apollo cache
6. **Request interceptor** — `page.on('request', ...)` in `searchRestaurantsNearAddress` captures DoorDash's own GraphQL auth headers into `_capturedDoorDashHeaders`
7. **page.evaluate multi-arg bug** — `fetchMenuFromInContextAPI` now passes `{ storeId, ddHeaders }` as single object arg

## What Was Fixed (2026-04-03 session — OOM crash fix)
1. **"Target crashed" on menu load** — removed `fetchMenuFromInContextAPI` pre-fetch call from `selectRestaurantFromSearch`. The pre-fetch ran `page.evaluate` with async fetch BEFORE navigation — this caused Chrome OOM crash on Railway. Now just navigates directly to store page and relies on DOM scraping in `extractMenuItems`.
2. **Memory reduction** — added `page.route()` in `launchBrowser()` to block `image`/`media`/`font` resource types. DoorDash restaurant pages have many food images; blocking them significantly reduces RAM.
3. **Simplified cfWait** — removed the `_preloadedMenuItems ? 5000 : 30000` conditional; now always 30s.

## Current State (as of 2026-04-03)
- **Search**: Works ✓ — 10 restaurants, no CF, no proxy
- **Menu**: Fixed ✓ — removed OOM-causing pre-fetch; DOM scraping used instead
- **Full ordering flow**: Should work end-to-end

## Session 2026-08-24 (Day 1 of weekly plan) — autoSelectAllRequiredOptions() retry-loop bug FIXED, verified live

**Root cause, finally isolated:** the click loop clicked the first label/radio/checkbox in EVERY visited group unconditionally, with no check for whether that group already had a selection. Two consequences, both real bugs:
1. **Silent-overwrite risk (newly found this session, not in the 2026-08-23 notes):** for an already-satisfied radiogroup (e.g. "Choose Your Wings" after the user's real choice, "10 Classic Wings," was already applied), clicking the first-rendered option ("10 Boneless Wings") would silently swap the selection — a radiogroup always has exactly one selection either way, so `getCount()`'s required-tally never reflects the swap. Never observed a live wrong-flavor add during testing, but the code path was live and would have triggered it.
2. **Misattributed credit (the 2026-08-23 finding, root-caused further):** a single fixed 500ms delay before reading `getCount()` after a click meant a still-in-flight React re-render from an EARLIER group's click could get credited to whichever group was checked NEXT — this is how the un-named "Add a Side → Seasoned Fries" toggle got wrongly credited with resolving the real requirement, when clicking it actually just swapped the modal into a new "Fry Seasoning" sub-view with its own new unsatisfied requirement.

**Fix (`doordash.js`, `autoSelectAllRequiredOptions()`, ~line 6884-7070):**
1. Added an `alreadySatisfied` flag per group (checked in the same DOM snapshot as the existing `isOptional` classification) — any group with `input:checked`/`[aria-checked="true"]`/`[aria-selected="true"]` is now skipped entirely by the click loop, never touched. Logged as `AutoSelect: never touching already-satisfied groups [...]`.
2. Replaced the fixed 500ms-then-read with a short poll (up to 3 reads, 500ms apart) that keeps checking until the count actually changes, so credit goes to the group that actually caused it instead of whichever happens to be checked next.

Deliberately did NOT add the "+$ price suffix = skip" heuristic considered in the 2026-08-23 notes — "Choose Your Wings"'s own (genuinely required) options also carry a "+$" price suffix, so that heuristic risked false-skipping real required groups. The already-satisfied + correct-attribution fixes address the actual mechanism instead of guessing from label text.

**Verified live, twice, against the exact repro from the 2026-08-23 notes** (search "wingstop" → select id 1285837 → add itemIndex 2 "10 Wings" with `{"groupIndex":0,"optionIndex":1,"optionText":"10 Classic Wings","groupName":"Choose Your Wings"}`):
- First attempt hit an unrelated modal-open timing hiccup (page assets still loading) and correctly reported `needsOptions` rather than adding wrong — not a regression, a pre-existing separate flake.
- Second attempt (fresh restaurant re-select) succeeded end-to-end. Logs confirmed `never touching already-satisfied groups [0, 2, 3, 4, 5, 6, 7]` — group 0 ("Choose Your Wings") was correctly left alone, and the previously-problematic Seasoned Fries group was never even visited this time.
- Confirmed via real `readBrowserCart()` ("show my cart" through `/api/voice`): `1x 10 Wings - $16.39` — correct base item, no phantom side-item upcharge, no price drift from a wrong flavor swap.
- Cart cleared afterward and reconfirmed genuinely empty via the same real-cart read.

**Not committed yet** — holding for explicit user go-ahead per this repo's git safety rules. Diff is against `6f35e64` (last commit before this fix); the 2026-08-23 session's two intermediate attempts were never committed, so this diff is the full net change, not an incremental one.

**Not yet done / next (Day 2 per the weekly plan is explicitly "verify Day 1 live"):**
1. Re-test with an item that has a genuine multi-pick stepper group ("Choose Flavors," min 2 units × 2 distinct flavors = 10 total, per the 2026-08-22 notes) — today's fix was verified on a single-flavor item ("10 Wings"); the loop still only clicks each group ONCE per pass, which may be insufficient on its own for multi-unit stepper groups. This is the outstanding item #3 from the 2026-08-23 notes, still unverified.
2. Re-verify the search-speed timeout cuts from 2026-08-22 with a genuinely fresh uncached search (still never actually measured before/after, per that session's notes).
3. Everything else from the standing backlog: GPS wiring, review-text-as-menu-item scraping (Wingstop/Costa Vida), physical-tap 18px-threshold confirmation, Wildside Bowls modal issue if it resurfaces, food.html multi-select stepper UI.

## Session 2026-08-24 continued — voice DoorDash command surface tested (SEARCH/SELECT work), new ADD_ITEM_NUM name-truncation bug found (NOT fixed)

Tested the real voice command path (`/api/voice`, not food.html) for SEARCH → SELECT → ADD_ITEM_NUM — this had never been verified beyond SHOW_CART since the 2026-07-22 `doordash`/`doordashUI` null-alias fix. SEARCH and SELECT both work correctly live (confirmed against "tacos" search → Taco Time menu).

**New bug found, NOT fixed:** ADD_ITEM_NUM failed for Taco Time's "Tacos" item. Root cause: `extractMenuItems()` (doordash.js ~line 3980-3988) picks only the FIRST non-calorie line of an item card's innerText as the name, then `break`s — so a card whose real name spans two DOM lines (e.g. "Tacos -" then a separate line with the actual descriptor) gets truncated. Confirmed live: cached menu entry is literally `{"name":"Tacos -","price":3.79}`. The later click-by-name search (`addItemByIndex`'s Playwright locator + anchored regex, ~line 5606-5641) then also fails to find a match on the real page and the add fails. Also surfaces a confusing voice UX bug: the response text says "Added Tacos to your cart" (Claude's own paraphrase, generated before it knows the real result) immediately followed by "Couldn't add Tacos -. Please try again." (the real error) — self-contradictory to a user. No real cart mutation occurred (verified via `/api/food/cart` — empty).

**Not fixed this session** — needs a fresh DOM dump of Taco Time's actual item-card HTML to see what's really between "Tacos -" and the price/description (same kind of forensics past Wingstop click-strategy bugs needed), not a guess-and-check fix. Next session: dump the card HTML (search "tacos" → select Taco Time id 29280516 → look at item index 7's live DOM), see what's actually on the line after "Tacos -", then fix `extractMenuItems()`'s single-line name-picking to either join adjacent short lines or handle a trailing " -" as a continuation marker rather than a terminator.

## Session 2026-08-23 (IN PROGRESS, paused mid-investigation — resume here)

**Goal:** Fix `autoSelectAllRequiredOptions()`'s retry-loop bug (confirmed 2026-08-22 as the real cause of "can't pick options" add failures — it wanders into an optional side/upsell section instead of reaching genuinely-required groups).

**First attempt (deployed, then found flawed):** prioritized groups using `_origIdx` from a separate `extractRequiredOptions()` call. **This was wrong** — confirmed live via logs that `_origIdx` values from that separate `page.evaluate()` call do NOT reliably line up with the indices `autoSelectAllRequiredOptions()`'s own click loop uses (same cross-call index-drift bug class as the 2026-08-21 Wingstop wrong-order fix). Live evidence: priority list pointed at "Recommended Beverages/Sides/Dessert" groups instead of the real "Choose Flavors"/"Choose a Dip" groups.

**Second attempt (current state, deployed to Pi, NOT committed):** replaced the cross-call approach with an inline classification computed in the SAME `page.evaluate()` snapshot already used for the diagnostic `groupDiag` dump (`doordash.js`, `autoSelectAllRequiredOptions()`, ~line 6856-6900) — each group gets an `isOptional` flag (checks own label/heading/prevSibling + 2 ancestor levels' text for "optional"/"recommended"), and the click loop visits non-optional groups first, optional/recommended ones last. This correctly excludes the "Recommended Sides And Apps"/"Recommended Dessert"/"Recommended Beverages" upsell groups (confirmed live via log: `Group[10] ... (optional/recommended)` etc.).

**Still broken — new finding, not yet fixed:** a DIFFERENT, earlier, un-labeled group (no `aria-labelledby`, no heading — same "undetectable name" problem noted for Wingstop's flavor group back in 2026-08-21) also contains a "Seasoned Fries" checkbox toggle. This group is NOT caught by the `isOptional` heuristic (no "optional"/"recommended" text within 2 ancestor levels) even though checking that box is genuinely optional and — worse — checking it introduces a BRAND NEW required sub-question ("Fry Seasoning") that DoorDash then reports as unsatisfied, so the add still fails, just for a different-looking reason. Live logs show the auto-select loop's count-feedback (`getCount()`) crediting this click with resolving the requirement (1→0) — most likely a misattribution: the real satisfying click was probably the EARLIER "Choose Flavors" stepper click, and React's async re-render hadn't caught up until the NEXT check. Was mid-investigation into the modal's raw HTML (`(Optional)` marker byte offsets: 14341, 21624, 23589, 28097 in the dumped `modal-debug.html`) to find a better structural signal than ancestor-text-scanning when the session was paused.

**Confirmed safe:** across all of today's test attempts, `journalctl` shows zero `addCartItemV2` GraphQL mutations fired — nothing ever actually hit the real DoorDash cart. No cleanup needed.

**Next session, in order:**
1. Finish diagnosing why the un-named "Seasoned Fries" group isn't classified as optional/skippable — check what's at those 4 `(Optional)` byte offsets in a fresh `modal-debug.html` dump (re-run the same repro: search "wingstop" → select id 1285837 → `/api/food/cart/add` itemIndex 2 ("10 Wings") → submit `{"groupIndex":0,"optionIndex":1,"optionText":"10 Classic Wings","groupName":"Choose Your Wings"}` as `selections`) to see the real structural relationship between that group and its "(Optional)" marker.
2. Consider a more robust heuristic than ancestor-text-scanning — e.g. treat any checkbox/toggle option whose own label includes a "+$" price suffix as an up-sell add-on that should never be auto-clicked to satisfy a requirement (add-ons increase price and can spawn new sub-questions; genuinely required choices for THIS item's base config are a safer default target).
3. Also double check the "Choose Flavors" stepper group (`Increase quantity by 1`) really is or isn't getting satisfied by a single click — needs multiple increments (min 2 units per flavor, 2 distinct flavors, 10 total) per the 2026-08-22 notes; today's loop only clicks each group ONCE per pass, which may be insufficient on its own for multi-unit stepper groups regardless of the optional-skipping fix.
4. Uncommitted changes currently sitting in local `doordash.js` (deployed to Pi) — do not lose them; diff against `6f35e64` before committing once the fix is actually verified working end-to-end.
5. Weekly plan Day 1 formally starts 2026-08-24 per user's memory note — this session's work counts as a head start, not the official Day 1.

## Session 2026-08-25 continued (Day 2) — root-caused and fixed the multi-minute stepper-item hang from earlier today. Committed `1adcddd`, pushed.

**Root cause of the hang (found, not just guessed):** `server.js`'s `/api/food/cart/add` route has a single-option auto-fill retry (~line 3251-3257) that, when every remaining required group in `addResult.requiredOptions` has exactly one option, makes a SECOND full `doordashUI.addItemByIndex()` call (reopens the item modal from scratch) with no timeout around it at all. This is the "something outside the clean `ITEM_NOT_ADDED` return path" that reopened the modal a second time and then hung, per this file's earlier note today. Inside `doordash.js`, the treewalker item-search loop's `page.evaluate()` call (the fallback used when the Playwright-locator click strategy fails to find the item by name) also had no timeout — `page.evaluate()` has no built-in timeout in Playwright, so if the page's JS context is stuck (e.g. from the CF/heavy-SPA fragility already documented extensively in this file), that evaluate can hang forever and silently defeat the loop's own bounded iteration count. Same failure class as the already-fixed `clearBrowserCart()` hang from 2026-08-21 — just a different call site that hadn't been wrapped yet.

**Fix:**
1. `doordash.js`: extended `evalWithTimeout()` (the existing helper from the 2026-08-21 `clearBrowserCart()` fix) to accept an optional `arg` parameter so it can wrap evaluates that take arguments, not just zero-arg ones. Wrapped the treewalker item-search evaluate with an 8s timeout per scroll position.
2. `server.js`: wrapped the second-attempt `addItemByIndex()` retry call in a `Promise.race` against a 75s timeout (matches the ~79s documented worst-case for other browser ops) — a stuck retry now returns a clean `ITEM_NOT_ADDED` error instead of hanging the request (and the service) indefinitely.

**Verified live, twice, against the exact repro from earlier today** (search "wingstop" → select id 1285837 → `/api/food/cart/add` itemIndex 2 "10 Wings" with only `{"groupIndex":0,"optionIndex":0,"optionText":"10 Classic Wings","groupName":"Choose Your Wings"}` selected, letting auto-fill handle everything else): both runs completed cleanly with no hang and no manual restart needed (unlike this morning's session, which required a hard `kill -9` + service restart). Both times the auto-select loop wandered through the same "Seasoned Fries" / drink-flavor sub-flows documented earlier today, but both times it still landed on a correct final add — confirmed via a genuine `actions`-marked "show my cart" voice read: exactly `1x 10 Wings - $16.39`, no phantom upcharge items, matching the base item price. Cart cleared and reconfirmed genuinely empty via the same real-cart-read method after each run (not trusting `/api/food/cart/clear`'s immediate response, per this file's standing lesson).

**Not fully resolved — worth flagging, not chased further this session:** the "modal already open" code path in `addItemByIndex()` (`doordash.js` ~line 5589-5603, used when `applyOptionSelections()` is called against an already-open modal) returns `{success: true, message: 'Attempted to add item'}` whenever `extractRequiredOptions()` reports zero remaining groups — but does NOT verify the modal actually closed or that a real cart mutation happened first. In both of today's verified runs this turned out to be correct (the real cart did get the item), but the code path itself has no such guarantee built in, unlike the other add path (5940-6094) which double-checks the "Make N required selection" button text before giving up. This is architecturally the same class of "trust a local signal instead of the real cart" bug this file has hit multiple times before (2026-08-19 stale-cart-summary bug, 2026-08-21 Wingstop silent-wrong-order bug) — worth a dedicated look if a false "success" is ever caught live.

**Also not addressed:** the underlying multi-unit stepper design task (parse a stepper group's required quantity and click it that many times, from the 2026-08-22/23 notes) is still not implemented — but today's specific repro item didn't actually require it to succeed (the "Increase quantity by 1" stepper group's own requirement resolved itself as not-actually-blocking once the rest of the flow completed), so it's unclear from today's testing alone whether this is still a live problem for OTHER items/configurations that do hard-require multiple stepper clicks. Needs a repro against an item where the stepper truly is the last blocking requirement to know for sure.

**Housekeeping:** removed a leftover `browser-data/modal-debug.html` debug dump from this morning's investigation. Both services confirmed active throughout, no restarts needed after deploying the fix. Real DoorDash cart confirmed empty at session end via genuine `actions`-marked read.

**Committed `1adcddd`, pushed to `origin/master`** (user asked directly).

**Extended re-test — 4 more repro runs same session, 6 total today:** ran the identical repro (Wingstop id 1285837, itemIndex 2 "10 Wings", only `Choose Your Wings`→`10 Classic Wings` selected, auto-fill handles the rest) 4 more times after the commit. **Zero hangs across all 6 runs today** (2 pre-commit + 4 post-commit). Results: 5 of 6 succeeded (each time landing exactly `1x 10 Wings - $16.39` in the real cart, verified via a genuine `actions`-marked cart read after every single run — no phantom upcharges, no wrong flavor, ever); 1 of 6 failed cleanly with a proper `502 ITEM_NOT_ADDED` after exhausting the normal 3-attempt loop (111s) — that run's first `addItemByIndex()` call returned a definitive failure directly (not `needsOptions`), so server.js's second-call retry path wasn't even exercised that time. Run times ranged ~98-147s when items were added, well within the new 75s+8s timeout budgets (those only engage when something actually gets stuck, which didn't happen in any of the 6 runs). Real DoorDash cart cleared and reconfirmed genuinely empty after every single run.

**Test methodology correction, worth remembering:** the voice phrase `"show my cart"` is NOT one of `_handleMessage()`'s exact-match cart-viewing phrases (the real list is `show cart`, `view cart`, `what's in my cart`, `my cart`, `cart`, `what do i have`, `show order`) — using it sometimes still worked (Claude's own judgment correctly called `[SHOW_CART]`) but at least once during this testing it silently fell through to a hallucinated `"Your cart is empty"` response with `"actions":[]"` while the real cart still had an item, exactly the failure mode the direct intercept was built to prevent. **Always use an exact-listed phrase (`"my cart"` worked reliably every time) to verify real cart state** — don't trust variations, even ones that usually work.

**Conclusion for now:** the specific multi-minute unrecoverable hang from earlier today has not recurred in 6 consecutive attempts post-fix, including under the same DoorDash-side flakiness (repeated wandering through "Seasoned Fries"/drink-flavor sub-flows) that was present when the original hang occurred. Reasonable confidence it's fixed, though this codebase's documented history of Xvfb/Chromium fragility means it can't be called impossible to recur.

**Not yet done / next session:**
1. Consider verifying the "modal already open" success-without-verification gap (flagged above) doesn't produce a false positive on some other item/restaurant.
2. Everything else from the standing backlog unchanged: GPS wiring, review-text-as-menu-item scraping (Wingstop/Costa Vida), physical-tap 18px-threshold confirmation, food.html multi-select stepper UI, the `extractRestaurantList` 15s timeout noticed 2026-08-25 morning, multi-unit stepper design task.

## Session 2026-08-25 continued further (Day 2) — deep bug check of the `1adcddd` fix found a real gap; properly fixed. Not yet committed.

**A user-requested deep review of `1adcddd` found a real correctness bug in its server.js half**, not caught by live testing because the retry code path it touches was never actually exercised in the 6 repro runs (every run resolved inside the FIRST `addItemByIndex()` call, never reaching the second-call retry branch).

**The bug:** `addItemByIndex` is exported wrapped in `locked()` (`doordash.js` ~line 8583), which serializes every DoorDash browser call through a shared `_opLockPromise` (`withOpLock`, ~line 401-414) so concurrent requests don't confuse the one shared browser page. `1adcddd`'s server.js fix wrapped the retry call in `Promise.race([addItemByIndex(...), timeout])` — but `Promise.race` never cancels the loser. If the timeout won, the real `addItemByIndex()` call kept running in the background and **kept holding the serial lock** until it finished on its own — meaning every other DoorDash request (search, select, checkout, even "show my cart") would silently queue up behind a call nobody was waiting on anymore. Worse: if that abandoned call later succeeded for real, nothing was left to consume its result — `db.addToCart()` never runs for it — so the real DoorDash cart would get the item while the local cart (what `food.html` displays) silently stayed empty. Also, the chosen 75s threshold was miscalibrated against the session's own data: genuinely-successful single-call adds that day took 98-147s, and a full retry (fresh navigate+search+modal+select cycle) would plausibly take at least that long — meaning the timeout was more likely to fire on still-working requests than on truly-hung ones.

**Proper fix, in two parts:**
1. **Root cause, actually fixed:** every remaining naked `page.evaluate()` inside `addItemByIndex`'s own body (not just the one treewalker call from `1adcddd`) is now wrapped with `evalWithTimeout()` — about 15 call sites (hydration-check body-text read, all the scroll-to-position/scroll-by calls in both the name-based and position-based item-search paths, the CDP-click JS fallback, the restaurant-closed-modal check, the add-button-text read, and all three cart-item-count reads used in the CF-overlay recovery branch). `page.evaluate()` has no built-in Playwright timeout, so any of these could have hung forever under the same "stuck JS context" failure mode as the one bug already found — now `addItemByIndex` itself is bounded end-to-end (as far as its own body goes) and will always return on its own, genuinely releasing the op lock rather than needing to be abandoned from outside. This is the same pattern `clearBrowserCart()` already established for exactly this reason.
2. **Remaining defense-in-depth, done correctly this time:** the server.js `Promise.race` around the retry call is kept, but as a backstop for whatever might still be lurking unbounded in `addItemByIndex`'s helper functions (`applyOptionSelections()`, `autoSelectAllRequiredOptions()`, `extractRequiredOptions()`, `clickAddToOrderButton()`, `clearPreSelectedOptions()` — none of these have been individually audited yet, that's real follow-up work). On timeout it now calls `doordashUI.closeBrowser()` (exported unlocked specifically so it can run while another op is mid-flight) before falling back to an error response — this forces the abandoned call's next `page.*` call to throw, so it actually unwinds through its own catch and releases the lock for real, at the cost of a fresh browser launch on the next request, instead of leaving a zombie holding the lock forever. Timeout raised 75s → 180s, comfortably above the observed 98-147s range for genuine single-call success.

**Verified live after deploying:** re-ran the Wingstop repro — succeeded cleanly in 148s, correct item/price in the real cart, no regression. Real cart cleared and reconfirmed empty. Both services healthy.

**Not committed** — holding for user go-ahead (diff is against `1adcddd`, currently on the Pi and live-verified but not in git).

**Still open:** never managed to actually trigger the second-call retry branch live (the `closeBrowser()` backstop has never fired for real); the helper-function audit item below (now done as a findings-only pass, not yet fixed) supersedes item 2 from the original list above.

## Session 2026-08-25 continued further still (Day 2) — full-codebase bug audit, user asked to "go through the whole software." Findings only, nothing fixed yet. Paused here per user request — see next session for fixes.

User asked for one more deep bug check, this time across the entire codebase, not just today's diff. Dispatched 4 parallel static-review agents (no live testing — real DoorDash account involved) covering: (1) `server.js` in full, (2) `doordash.js` in full including the 5 helper functions flagged as unaudited above (`applyOptionSelections`, `autoSelectAllRequiredOptions`, `extractRequiredOptions`, `clickAddToOrderButton`, `clearPreSelectedOptions`), (3) `db.js`/`doordash-api.js`/`restaurants.js`/`modules/*.js`, (4) `voice/voice_loop.py`/`public/*.html`. Findings below, ranked by severity, NONE fixed yet — user said to pause and save this for the weekly report instead of continuing into fixes this session.

### HIGH severity
1. **The exact "second addItemByIndex() call with no timeout" hang class fixed today in `/api/food/cart/add` is UNFIXED in the voice/SMS command path** (the primary, older interface) — `server.js`: `SELECT_OPTIONS_TEXT` handler (~1070/1075), `SELECT_OPTION` handler (~1199/1204), main `ADD_ITEM_NUM` handler (~1433/1439, and the identical single-option-auto-fill-retry pattern at ~1491), and `REORDER`'s per-item loop (~1905). A hang in any of these wedges doordash.js's shared op lock for BOTH voice and touchscreen.
2. **`doordash.js`'s 5 previously-unaudited helper functions all have multiple naked (un-timeout-guarded) `page.evaluate()` calls**, with exact line numbers found: `extractRequiredOptions()` (6232, 6412, 6421, plus 6388 catch-but-no-timeout), `clearPreSelectedOptions()` (6708, its only evaluate, fully unguarded), `autoSelectAllRequiredOptions()` (6836, 6841, 6960 with no catch at all, plus 6850/6869/7030 catch-but-no-timeout, plus `readRequiredGroupSelections()` at 6786), `applyOptionSelections()` (7118, 7159, 7296, 7331, 7428 with no try/catch, 7510, 7544, 7576, 7597, plus 7189/7240/7321 catch-but-no-timeout), `clickAddToOrderButton()`+`_isPostAddConfirmation()` (7683 with no catch, plus 7764/7801/7841/7848 catch-but-no-timeout). Also **`readBrowserCart()`** itself — the app's own "verify against real state" ground-truth check this whole file's history relies on — has 3 unguarded evaluates (8366, 8401, 8413), which defeats its purpose if it hangs.
3. **`voice/voice_loop.py:255-258`** — the Piper TTS `subprocess.run()` call has no `timeout=`. Since the voice loop is single-threaded, a hung `piper` process freezes wake word, tap-to-speak, AND dictation entirely — same failure class, different language.
4. **`doordash.js`: `placeFullOrder()`/`placeAdditionalOrder()` (the scheduled-order path, fired every 60s by `checkScheduledOrders()`) entirely bypass the serial op lock** — exported unlocked, and internally call unlocked local functions directly instead of the `locked()`-wrapped exports every other command path goes through. **A scheduled order and an interactive voice/touchscreen session can drive the same shared browser page concurrently** — real double-charge/wrong-order risk, architecturally real and reachable, not hypothetical.
5. **`doordash.js`: both `checkoutCurrentCart()` (~2913) and `placeOrder()` (~2247) have an "assume success" fallback** when they can't recognize the confirmation page/text — silently reports a real order as placed when it may not have been.
6. **`server.js`: `PLACE_ORDER` (~1739-1772) and `/api/food/checkout` (~3358-3364) build the saved order record from the local SQLite cart, not the real DoorDash cart that was just checked out** — if local/real state had drifted (e.g. a failed `REMOVE_ITEM` that only logged a warning), the recorded order/total won't match what was actually charged.
7. **`public/food.html` (~1163-1176): the two-tap checkout confirm can be bypassed by a single bounced tap.** The confirm button is only `disabled` on the SECOND tap — this exact touchscreen is documented elsewhere in this codebase as double-firing a single physical tap ("contact bounce"). A bounced first tap can run both branches back-to-back, placing a real charge with the confirmation screen never actually shown to the user.
8. **`public/food.html` (~1177-1211): the Cancel button stays live during the in-flight checkout POST.** Tapping Cancel resets the UI while the real request keeps running server-side; tapping Confirm again can fire a second real checkout call before the first resolves.

### MEDIUM severity
- `server.js`: touchscreen (`/api/food/*`) and voice/SMS share one user record but only voice/SMS is lock-serialized (`withUserLock`) — concurrent voice+touch actions can race on restaurant-selection state; `/api/food/checkout` has no route-level double-submit guard of its own; `REORDER` silently drops items it can't re-add with no error shown to the user; a "localhost only" debug-endpoint IP check (`/api/user/:phoneNumber`) can be bypassed via a spoofed `X-Forwarded-For` since `trust proxy` is enabled; a dead `answeredNames` variable in `SELECT_OPTION`'s handler means the stated infinite-loop-prevention comment doesn't describe what's actually gating the logic.
- `doordash.js`: `applyOptionSelections()` Strategies 1/1b/2b can mark a click "registered" without verifying the CORRECT option was selected when the group was already at 0-required (the same gap already fixed for sibling strategies 2c/2d, just not here — real silent-wrong-order risk); Strategy 2 has no try/catch, silently truncating the whole selections loop on a transient error; legacy `addItemToCart()` (what the scheduled-order path actually runs through) reports success without checking the modal closed; `extractMenuItems()`'s fallback strategy, `selectRestaurantFromSearch()`'s CF-overlay poll loop (30x), and `removeCartItem()`'s loop (20x) are all unguarded the same way as the HIGH findings above.
- `restaurants.js`/`doordash-api.js`: `calculateOrderTotal()` assumes `deliveryFee` is a number, but the only real producer of restaurant objects (`normalizeStore()`) sets it to a string (`'Unknown'`, `'$2.99'`) — corrupts a real order total via `NaN` or string concatenation; DoorDash session cookies (as sensitive as the password) are saved to disk in plaintext, inconsistent with `db.js`'s AES-256 encryption of the password; no locking around concurrent Chromium profile launches, unlike doordash.js.
- `db.js`: `ENCRYPTION_KEY` is never validated as a well-formed 32-byte hex key at startup — a malformed key crashes on the first `encrypt()` call instead of failing fast at boot; PINs are hashed with unsalted single-round SHA-256.
- `modules/reminders.js`: a relative time like "in 1000 hours" overflows `setTimeout`'s 32-bit delay limit and fires almost immediately instead of ~41 days later; a `Map` key-type mismatch (string vs. number user id) can make restored reminders invisible to lookups after a restart while still silently firing in the background.
- `modules/weather.js`: `normalizeLocation()` truncates any multi-word city ("Salt Lake City, Utah") to just its first word — a NEW, currently-live gap, different from the already-fixed malformed-query bug.
- `modules/gps.js`: an unawaited async NMEA handler can let a stale, slow-to-geocode fix overwrite a newer position (self-corrects on the next fix).
- `public/spotify.html` (~395): a Spotify device id is interpolated into an HTML attribute with no escaping (low practical risk since device ids are opaque backend tokens, but same bug class already fixed elsewhere in this app).

### LOW severity
- `server.js`: most bracket-command handlers strip their own tag with a single-occurrence `.replace()` — a doubled tag from Claude would leak literal `[TAG]` text to the user.
- `doordash.js`: `evalWithTimeout()`'s loser `setTimeout` is never cleared (harmless, minor timer pile-up under sustained load, not a correctness bug).
- `db.js`: `getOrder`/`getUserOrders` have an unguarded `JSON.parse()`, inconsistent with the graceful-degradation pattern used everywhere else in that file; `encrypt('')` conflates "never set" with "explicitly cleared" (both become `null`).
- `restaurants.js`: `formatCart()` assumes `item.name` is always defined, would throw on a malformed scraped item.
- `modules/camera.js`: a JPEG frame-boundary edge case can drop a live-preview frame (cosmetic, self-heals on the next full frame).

### Not fixed — session paused here per user request
User asked to pause and save all of this for the upcoming weekly report rather than starting a fix pass. Nothing above has been touched. When resuming, suggested priority order: (1) the scheduled-order lock bypass (#4) since it's the most architecturally serious and easiest to reason about (route `placeFullOrder`/`placeAdditionalOrder`'s internal calls through the already-`locked()` exports instead of the unlocked local functions), (2) the food.html checkout double-tap/cancel-race (#7/#8) since it's a direct, easily-reproducible real-money bug on the actual device, (3) extend today's `evalWithTimeout()` treatment to the voice/SMS retry call sites (#1) and add a `timeout=` to the Piper subprocess call (#3), (4) the 5 helper-function naked-evaluate audit (#2) — largest single chunk of work, do last since it's the most mechanical/repetitive.

## Session 2026-08-26 (Day 3 of weekly plan) — fixed audit finding #1: scheduled-order lock bypass

Started Day 3 by first committing+pushing the Day 2 fix that had been verified live but never committed (`2b2cf18`, bounding all naked `page.evaluate()` calls in `addItemByIndex` + the `closeBrowser()` backstop — see the "Session 2026-08-25 continued further" entry above). Repo/Pi/origin now in sync.

**Then fixed audit finding #1 (the top-priority item from the 2026-08-25 full-codebase audit):** `placeFullOrder`/`placeAdditionalOrder` were exported unlocked in `doordash.js`'s `module.exports`, unlike every other browser-touching export (`placeOrder`, `checkoutCurrentCart`, `searchRestaurantsNearAddress`, `clearBrowserCart` are all already wrapped with `locked()`). Since `server.js`'s `checkScheduledOrders()` (fires every 60s via `setInterval`) calls `doordash.placeFullOrder(...)` directly, a scheduled order could run concurrently with an interactive voice/touchscreen session on the same shared browser page — real double-charge/wrong-order risk, not hypothetical.

**Fix:** wrapped both exports with the existing `locked()` helper — `placeFullOrder: locked(placeFullOrder)`, `placeAdditionalOrder: locked(placeAdditionalOrder)`. Left `placeFullOrder`'s own internal calls to `searchRestaurant`/`addItemToCart`/`checkout`/`placeOrder` as raw local (unlocked) function calls, unchanged — calling one of the `locked()` exports from inside an already-locked call would deadlock against `withOpLock`'s single-promise-chain design (the outer call would never resolve until the inner one does, but the inner one queues behind the still-unresolved outer call).

**Verified:** `node -c doordash.js` syntax-clean; deployed to the Pi, `frog-server` restarted cleanly (browser launched, Wingstop pre-warm succeeded); confirmed via `node -e` on the Pi that `dd.placeFullOrder` is now the `locked()` wrapper function, not the raw export; real DoorDash cart confirmed genuinely empty afterward via a real `"my cart"` voice request (exact `actions` marker present, not a hallucinated empty response). Did not attempt a live concurrent-scheduled-order race test — orchestrating a real scheduled order to fire while driving a simultaneous interactive session wasn't worth the real-money risk for what is a mechanical, low-risk change consistent with an already-proven pattern used successfully elsewhere in this exact file for months.

Committed `1b59c53`, pushed.

**Then did the original Day 3 plan task: filtered fake review-text menu items on Wingstop/Costa Vida.** Root-caused via live DOM forensics (temporary `_debugFindByText`/`_debugFindByTestId`/`_debugListTestIdsContaining`/`_debugScrollTo` exports in doordash.js + matching `/api/_debug/*` routes in server.js — all narrow, fixed diagnostics, no arbitrary code execution allowed; all fully removed before commit). Confirmed on both restaurants: the customer-reviews carousel renders as `data-testid="carousel-slider"` (a shared DoorDash platform component — same testid on both Wingstop and Costa Vida), lazily mounted only once scrolled into view. Review cards render as "Reviewer Name — $XX.XX" (the dollar figure is an unrelated "amount spent" stat, not a price) and passed every existing filter in `extractMenuItems()`, producing fake menu items like "Butch H" and full review sentences ("I'll give you credit for trying but that's it.. Definitely not worth the").

**Fix:** added `[data-testid="carousel-slider"]` to the existing cross-sell/recommended-carousel exclusion `closest()` selector, in both of `extractMenuItems()`'s extraction strategies (Strategy 1's `extractAtViewport`, Strategy 2's full-page fallback scan) — same pattern already used there for the recommended-items/cross-sell carousel exclusion.

**Verified live:** cleared the 24h menu cache for both restaurants (`doordash_cache` table, `cache_type='menu'`, keys `1285837`/`157397`) via a node one-liner over SSH, then did a fresh `/api/food/select` for each. Wingstop: 39 items, all real menu items, zero garbage (previously included "Butch H" and the review-sentence item). Costa Vida: 23 items, all real, zero garbage. Real DoorDash cart confirmed empty throughout via a genuine `actions`-marked "my cart" voice request.

**Also spotted, not fixed (out of scope for this task):** both restaurants' fresh menus included one promo-banner item that slips past the existing promo-text filter — Wingstop's "Buy 1, get 1 free" ($15) and Costa Vida's "Try DashPass with a free trial" ($15) — different wording than the `/\d+%\s*off/`, `/^free\s/`, `/^save\s/` etc. patterns already filtered. Same bug class, not the review-text issue asked for today.

Committed `801d343`, pushed.

**Then fixed audit finding #2: food.html's checkout double-tap/cancel race (`public/food.html`).** Two real bugs in the two-tap checkout confirm flow, both matching this exact touchscreen's documented resistive-digitizer "contact bounce" behavior (a single physical tap can dispatch two `click` events):
1. **A bounced first tap could skip the confirmation screen entirely.** The click handler had no time gate — the first (of two bounced) click synchronously set `checkoutConfirming = true` and returned; the immediately-following bounced click saw that flag already true and ran straight through to the real `/api/food/checkout` POST, so the user never actually saw or consciously tapped "Confirm — $X.XX" before being charged.
2. **The Cancel button stayed clickable during the in-flight checkout request.** Tapping Cancel mid-request called `resetCheckoutUI()`, which re-enabled the "Place Order" button and cleared `checkoutConfirming` — a second real tap sequence could then fire a second `/api/food/checkout` POST before the first one had resolved.

**Fix:** added a 600ms debounce window (`checkoutConfirmShownAt`, matching the debounce value screen.html already uses for the same hardware quirk) — any click landing within that window of showing the confirm screen is ignored, so a bounce can no longer complete both steps in one gesture. Also disable the Cancel button (native `disabled`, blocks the click event outright) for the duration of the real checkout request, re-enabled by `resetCheckoutUI()` on every exit path (error/dry-run/success, the last via `renderCart()`'s existing call to it).

**Verified live with zero real-money risk:** loaded the real `food.html` in a Playwright browser pointed at the Pi, injected a fake cart item directly into JS state (no real DoorDash cart mutation), and stubbed `window.fetch` for `/api/food/checkout` only (a 1.5s-delayed fake success response) so no real network call could reach DoorDash. Confirmed: two synchronous `.click()` calls (simulating a bounce) produced **0** checkout calls, confirm text stayed showing; a genuine tap after waiting out the debounce produced exactly **1** call; Cancel was `disabled` immediately and a click on it while disabled was a no-op (state stayed `checkoutConfirming: true` mid-flight); after the stubbed request resolved, UI reset correctly (cart cleared, Cancel re-enabled, checkout button hidden). Real DoorDash cart confirmed empty before and after via a genuine `actions`-marked "my cart" voice check.

Committed `551d618`, pushed.

**Then fixed audit finding #3: extended timeout guards to the voice/SMS retry paths, and added a timeout to the Piper TTS subprocess call.**

**Part A (`server.js`):** the "second `addItemByIndex()` call with no timeout" hang class fixed in `/api/food/cart/add` (touchscreen route, commit `2b2cf18`) was still unguarded in the voice/SMS command path — the primary, older interface. Extracted a shared `addItemByIndexGuarded(...)` helper (right after `formatCheckoutError`, ~line 551) using the same `Promise.race(180s timeout) + closeBrowser()` backstop pattern, and converted all 10 `doordash.addItemByIndex(...)` call sites across `SELECT_OPTIONS_TEXT` (~1096/1101, plus its queued-item retry ~1121), `SELECT_OPTION` (~1225/1230, plus ~1249), the main `ADD_ITEM_NUM` handler (~1459/1465, plus the single-option auto-fill retry ~1517), and `REORDER`'s per-item loop (~1931) to use it — both the first and retry calls in each handler, since the residual risk (the 5 still-unaudited `doordash.js` helper functions `addItemByIndex` calls into) applies equally to either. A hang in any of these previously wedged doordash.js's shared op lock for both voice and touchscreen.

**Part B (`voice/voice_loop.py`):** the Piper TTS `subprocess.run()` call (~line 255) had no `timeout=`. Since the voice loop is single-threaded, a hung `piper` process would freeze wake word, tap-to-speak, and dictation entirely, forever — nothing else in the loop runs until `speak()` returns. Added `timeout=30` (matches this file's own convention for network round trips) with a caught `subprocess.TimeoutExpired` that logs and returns `False` (the function's existing "interrupted" contract), inside the already-existing `try/finally` so temp-WAV cleanup still runs on a timeout.

**Verified live:** both services restarted cleanly. Piper TTS confirmed working post-fix (`journalctl` showed the real "frog is ready" startup greeting play and finish normally). Ran a real voice order through the newly-guarded path end-to-end (search Costa Vida → select → `ADD_ITEM_NUM` "Chips & Queso" → size-selection reply → real add succeeded, correct item/price in the real cart) — confirms the guarded wrapper doesn't break the happy path (a `Promise.race` against a real call that resolves normally just returns that result, same as a plain `await`). Real cart cleared and reconfirmed genuinely empty via the actual `readBrowserCart()` drawer-open log line ("found 0 items after opening drawer"), not a hallucinated response.

Committed `29dc96a`, pushed.

**Then fixed the last item from the audit's suggested priority order — finding #4: the 5 previously-unaudited `doordash.js` helper functions' naked `page.evaluate()` calls, plus the app's own ground-truth `readBrowserCart()`.** This was flagged as "largest single chunk of work, most mechanical/repetitive" — bounded ~22 evaluate call sites across `extractRequiredOptions()` (4 sites), `clearPreSelectedOptions()` (1) + its sibling `readRequiredGroupSelections()` (1), `autoSelectAllRequiredOptions()` (5), `applyOptionSelections()` (12 — the largest, covering every click Strategy 0/0b/1/2/2b/2c/2d/3), `clickAddToOrderButton()` (4) + `_isPostAddConfirmation()` (1), and `readBrowserCart()` (3) — all with the same `evalWithTimeout()` wrapper already established for `addItemByIndex()`'s own body (commit `2b2cf18`). Left `applyOptionSelections()`'s `getRequiredCount()` helper alone — it already has its own bespoke `Promise.race(5s)` bound (resolves a sentinel `999` rather than throwing), functionally equivalent to `evalWithTimeout` already, and converting it would require adding try/catch at every one of its many call sites for no real safety gain.

**Verified live, two ways, on real DoorDash pages:**
1. **Complex failure case** — the standard Wingstop "10 Wings" stepper-multi-pick repro (partial manual selection, letting `autoSelectAllRequiredOptions()` auto-fill the "Choose Flavors" stepper group it's never fully solved). Exhausted all strategies and correctly returned a clean `ITEM_NOT_ADDED` error after 153s — no hang, no stray cart item (confirmed via a genuine "my cart" read). Confirms the bounded functions don't mask or worsen the already-known "can't fully auto-fill a multi-unit stepper" limitation — it still fails the same way, just can't hang doing it.
2. **Happy path** — Wingstop "Cajun Fried Corn" (a real, single required "Choose Size" group) through the full voice path: `extractRequiredOptions()` correctly found the group, `applyOptionSelections()`'s click succeeded, `clickAddToOrderButton()` closed the modal, and the real cart showed the correct item/price via a genuine read. Cart cleared and reconfirmed empty.

**Also observed, not investigated (unrelated to this fix — doordash.js only, no server.js changes today):** two voice responses this session came back with what looked like doubled/concatenated text (a "Top N results" list appearing twice in one response, and an "Added X!" + order summary appearing twice). Both had internally-consistent, correct `actions` arrays (single real action each time) — cosmetic response-text duplication only, no double-add or double-search actually occurred. Didn't reproduce reliably enough to chase down this session; worth a dedicated look if it recurs.

**Housekeeping mid-session:** hit the exact "Xvfb/Chromium fragility under sustained load" pattern this file has documented before (duplicated GraphQL request logging after the heavy 153s stepper test) — resolved with the file's own established recovery sequence (`pkill -9` node/xvfb-run/Xvfb/chrome, `systemctl reset-failed`, `systemctl restart`), not a new issue.

All 4 items from the 2026-08-25 audit's suggested priority order are now done: #1 scheduled-order lock bypass, #2 food.html checkout race, #3 voice/SMS timeout guards + Piper TTS timeout, #4 this session's helper-function audit. Real DoorDash cart confirmed empty at session end. Both services healthy.

**Not yet committed** — holding for user go-ahead.

## Session 2026-09-01 (Tue) — "week of Sep 1" plan Day 2: Little Caesars required-options FIXED + revived the dead HTTP options fast-path. Verified live. NOT committed.

**Cadence correction:** the weekly report + a new "Plan — week of Sep 1" WERE sent by email Sun 2026-08-30 (an earlier memory note wrongly said they were skipped). That plan: Day 1 = stale-restaurant boot-prewarm hijack (already done 2026-08-31 as `65739dd`, UNPUSHED); Day 2 = this; Day 3 = `extractMenuItems()` two-DOM-line name truncation + calorie-digit concat; Day 4 = MEDIUM audit backlog pick 2–3 (partly done in `e89f971`/`cff2d6f`); Day 5 = full smoke test. **Next report Sun 2026-09-07 covers this plan — Day 1 ✅, Day 2 ✅, Days 3 & 5 open, Day 4 partial.**

**Day 2 task:** Little Caesars "Custom Stuffed Crust" (build-your-own pizza) surfaced only 1 generic option group instead of its real required Sauce + Cheese groups (Day-5 smoke-test finding #2).

**Root-caused 3 real bugs (via a temporary `_diagItemOptions` fn + `/api/_diag/item-options` route — BOTH REMOVED before session end; `git status` shows only `doordash.js` + pre-existing `CLAUDE.md`/`modules/gps.js`):**
1. `fetchItemPageViaAPI`'s `itemPage` GraphQL query still sends the `isNested` arg, which DoorDash removed → every call 400s `GRAPHQL_VALIDATION_FAILED` → the HTTP options fast-path has been **dead for every optioned item at every restaurant**, always falling back to Playwright DOM scraping.
2. `extractStoreIdFromUrl` returns the **menu id**, not the store id, for canonical `/store/<slug>-<storeId>/<menuId>/` URLs (grabbed the 2nd path segment). Broke `_capturedItemIds` key matching AND made `itemPage` 404 "Item not found".
3. Little Caesars renders NO usable itemId in DOM or React fiber — the IDs are only in the `self.__next_f` SSR payload (`{"__typename":"MenuPageItem","id":"...","name":"..."}`), which nothing parsed.

**Fixes (all `doordash.js`, deployed to Pi + live-verified, NOT committed):**
- Drop `isNested` from the `itemPage` query + vars.
- `extractStoreIdFromUrl`: take trailing `\d{5,}` from the slug segment; fall back to bare `/store/<digits>`; then old regex.
- New SSR `__next_f` fallback in `extractMenuItems` (when DOM+fiber capture 0 IDs): regex-parse `MenuPageItem`/`StorePageCarouselItem` `{id,name}` → populate `_capturedItemIds` AND stamp `menuItems[i].id = "item-<realId>"` so it persists into the DB menu cache (survives restart / cached SELECT).
- `addItemByIndex` fast-path: fall back to parsing `cachedItem.id` (`/^item-(\d{5,})$/`) for the itemId.
- `itemPage` fast-path timeout 5s → 12s (Pi cold calls run 5–11s).
- `convertOptionListsToRequired` also surfaces `isOptional:false / min:0` groups; `addItemByIndex` uses `convertOptionListsToRequired(...).length` for the needsOptions decision (was a stricter separate filter).
- After an API `addCartItemV2` failure, `navigateToRestaurantPage(backUrl)` before the Playwright fallback.

**Verified live (real DoorDash cart, incl. once after `systemctl restart` with empty `_capturedItemIds`):** CSC discovery → `["Sauce Selection","Cheese Selection"]` (4 opts each); CSC add Sauce=Regular + Cheese=Regular → `[API] ✅ Item added via HTTP API`, real cart `1x Custom Stuffed Crust - $17.49` (verified via `my cart` voice read w/ `actions:[{show_cart}]`); cart cleared + reconfirmed empty.

**KNOWN ROUGH EDGE (reported to user, left for later — not a clean regression):** Costa Vida "Single Taco" **add** fails — DoorDash's `itemPage` response OMITS the "Tortilla" required group entirely, so `addCartItemV2` → `item_validation_error: "Please select at least 1 options for Tortilla"`, then the Playwright fallback hits the pre-existing Costa-Vida "Only found 0 items" menu-render flake (2026-08-29 finding #1 signature). Real fix: on `item_validation_error`, detect the named group + re-surface ALL optionLists as `needsOptions`, OR make the post-API Playwright fallback reliably re-render the CV menu.

**Resume points / testing notes:** `sqlite3` CLI NOT on Pi — use `node -e 'require("dotenv").config(); const db=require("./db"); ...'` (db.js hard-refuses without `ENCRYPTION_KEY`). `db.clearDoorDashCache(userId)` forces fresh `extractMenuItems`. LC store `1161247`/menu `31838397`; CV store `157397`/menu `1657559`; CSC itemId `11736262125`. Pi browser needed the documented manual recovery mid-session (`pkill -9 -f chrome-linux/chrome` — the `pkill Xvfb` form returns ssh exit 255 and killed `frog-voice` once). Both services `active`, cart empty, `DOORDASH_DRY_RUN=true` at session end.

**Next per user:** continue on the MessageAI / SMS side.

## Session 2026-09-07 (Sun) — week-of-Sep-1 report written; Day 2 committed; Day 3 done + committed. 2 commits, still UNPUSHED.

User was away on a trip mid-week-of-Sep-1, so that plan stalled after Days 1/2/4. This session: wrote the weekly report + the week-of-Sep-8 plan (`reports/2026-09-07-weekly.md`, `reports/2026-09-08-plan.md`, plus a plain-ASCII `reports/2026-09-07-email.txt` for pasting into email), then cleared two of the three slipped items.

**`604a267`** — committed the 2026-09-01 Day-2 Little Caesars required-options fix (was verified-live-but-uncommitted; `doordash.js` + `CLAUDE.md`). No code change from what was already on the Pi.

**`4be5269` (Day 3)** — `extractMenuItems()` / option-label name-truncation (`"Tacos -"`, `"10 Classic Wings860 -"`, `"Small Chips & Salsa+"`). Added `cleanScrapedName()` (`doordash.js` ~line 364) — strips trailing price/calorie/`+`/dangling-dash junk in a fixpoint loop, plus a dangling-dash-gated glued-calorie-digit strip (`"Wings860"` -> `"Wings"`) that's conservative enough to leave `"Route 44"` / `"Coke 20 oz"` alone. Applied at the **Node boundary** of the DOM-scrape fallbacks only (API paths are already clean):
- `extractMenuItems()` — clean each name before the dedup pass (so raw + cleaned don't both survive).
- `extractRequiredOptions()` — new local `cleanGroups()` run on both the structured `optionGroups` return and the broad-extraction `broadGroups` return.
24 unit cases pass. **Forensics finding:** the menu-item `" -"` shape no longer reproduces on its own — DoorDash rewrote the menu card DOM (no more `data-anchor-id="MenuItem"`; cards are `div.image-action-card-container`, virtualized ~6 at a time; innerText lines are clean `["Crisp Meat Burrito","$4.08","•","96% (76)"]`) and the Day-2 SSR `__next_f` parser supplies clean names + real ids. So Day 3 is mostly *hardening the fallback* for when the API path fails. The `+` artifact (`"Small Chips & Salsa+"`) IS still live on the Costa Vida DOM-scrape option path and is now stripped.
Temp diag (`_diagMenuCards` in doordash.js + `/api/_diag/menu-cards` route in server.js) added for the DOM forensics, **both fully removed before commit** — `grep` confirms clean, `server.js` working-tree diff is empty.

**Verified live on the Pi:** fresh (cache-cleared) Taco Time (40 items) + Costa Vida (22 items) + Wingstop (38 items) scrapes — zero mangled names, zero suspicious. Costa Vida "Chips & Salsa" (idx 12) -> "Size" -> "Small Chips & Salsa" DOM-scrape option path added end-to-end into the **real cart** at $4.49 (`selectedOptions: ["Small Chips & Salsa","Pico De Gallo"]` — Pico auto-defaulted, expected). Wingstop "10 Wings" still clean-fails (known stepper-item hard case, not a regression) and Cajun Fried Corn add didn't complete first-try — both amid heavy Pi browser degradation this session.

**Pi state at stop:** browser went into the documented degraded state (page `document.body.innerText` returning raw `self.__next_f.push(...)` script text instead of a rendered menu; `readBrowserCart` / `clearBrowserCart` evaluate timeouts). The `pkill -9 -f Xvfb` recovery form returned ssh exit 255 and took `frog-voice` + `frog-server` down — both restarted cleanly (`systemctl reset-failed` then `start`) and are `active`. **A test "Chips & Salsa" item may still be in the real DoorDash cart** — `clearBrowserCart()` ran twice but `my cart` still showed it at **$0.00 / Subtotal $0.00** (almost certainly a stale render of an already-emptied cart; `DOORDASH_DRY_RUN=true` so zero charge risk). Worth a real `readBrowserCart()`-backed check next session, ideally after a full Pi reboot.

**`readBrowserCart()` name-mash seen live** (rolled into week-of-Sep-8 Day 5): `"Chips & SalsaSmall Chips & Salsa, Pico De Gallo$4.491 ×1 ×1 × - $0.00"` — the `cff2d6f` selectors + cut-at-`$` fallback still don't match DoorDash's current cart-row markup. `cleanScrapedName()` can be reused for the trailing junk once a fresh cart-row DOM dump is in hand.

**Repo:** `65739dd..4be5269` = **8 commits UNPUSHED** (`604a267` + `4be5269` new this session). `modules/gps.js` still uncommitted (pre-existing). `reports/` committed this session. User has NOT given the push go-ahead — the report notes it as a pre-req for the week-of-Sep-8 plan.

**Week-of-Sep-8 plan (`reports/2026-09-08-plan.md`), SMS/MessageAI-weighted:** Day 1 = saved-order record from the real cart (audit #6 carryover — totals are real since `cff2d6f`, line items aren't); Day 2 = the multi-restaurant smoke test that the trip pre-empted; Day 3 = SMS `[SELECT]` not updating `currentRestaurant` on a 2nd select + re-run the blocked first-time-SMS-user flow; Day 4 = verify the `91a596a` SMS pre-charge confirmation scrape (address/card/total) end-to-end on **Railway** (never tested against a real checkout page); Day 5 = `readBrowserCart()` proper fix.

## Railway Testing (no Twilio needed)
```bash
# Send test message directly (no Twilio signature check)
curl -X POST "https://messageai-production.up.railway.app/api/twilio/webhook" \
  -d "From=%2B18018006072&Body=MESSAGE_HERE"
# Check logs
curl "https://messageai-production.up.railway.app/logs"
```
