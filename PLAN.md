# MessageAI - SMS-Based AI Assistant

## Project Overview
A personal AI assistant accessible via text message (similar to Rabbit R1). Users text a phone number, and the AI can understand requests, make recommendations, and execute actions like ordering food.

---

## Architecture Overview

```
[User's Phone] <-> [Twilio SMS] <-> [Your Server] <-> [Claude API]
                                         |
                                         v
                                   [Database]
                                   - Users (encrypted)
                                   - Sessions
                                   - Order History
                                         |
                                         v
                                   [DoorDash Integration]
```

---

## Phase 1: Foundation (Days 1-3)

### Day 1: Project Setup & Twilio Integration
- [ ] Initialize Node.js/Python project
- [ ] Set up Twilio account (free trial gives you a number)
- [ ] Create webhook endpoint to receive SMS
- [ ] Send/receive basic text messages
- [ ] Test: Send "hello" -> receive "Hello back!"

**Deliverable:** Can send a text to your Twilio number and get a response

### Day 2: Claude AI Integration
- [ ] Set up Anthropic API connection
- [ ] Create conversation handler
- [ ] Implement basic conversation flow
- [ ] Add conversation memory (session-based)
- [ ] Test: Have a basic conversation via SMS

**Deliverable:** Can have an AI conversation via text message

### Day 3: Database & User System
- [ ] Set up PostgreSQL or SQLite database
- [ ] Create user schema (phone number as identifier)
- [ ] Implement session management
- [ ] Add conversation history storage
- [ ] Auto-create user on first message

**Deliverable:** System remembers who you are between conversations

---

## Phase 2: Authentication & Security (Days 4-6)

### Day 4: User Authentication
- [ ] Design auth flow (PIN-based or magic link)
- [ ] Implement registration via SMS
- [ ] Create login verification system
- [ ] Add session tokens/expiry
- [ ] Test: Register and login via text

**Deliverable:** Users can create accounts and authenticate

### Day 5: Encryption & Secure Storage
- [ ] Set up encryption for sensitive data (AES-256)
- [ ] Implement encrypted address storage
- [ ] Add secure payment method references (tokens only)
- [ ] Create key management system
- [ ] Never store raw sensitive data

**Deliverable:** User data is encrypted at rest

### Day 6: Profile Management
- [ ] Add commands: "set address", "update address"
- [ ] Implement address validation (Google Maps API)
- [ ] Add payment method linking (via web portal)
- [ ] Create "my profile" command
- [ ] Test full profile flow

**Deliverable:** Users can manage their profile via SMS

---

## Phase 3: DoorDash Integration (Days 7-11)

### Day 7: DoorDash Research & Setup
- [ ] Research DoorDash API options:
  - Official DoorDash Drive API (for merchants)
  - Unofficial approaches (web automation)
  - Third-party aggregators (Deliverect, etc.)
- [ ] Decide on integration approach
- [ ] Set up necessary accounts/credentials

**Note:** DoorDash doesn't have a public consumer API. Options:
1. Use DoorDash Drive API (merchant-focused)
2. Browser automation with Playwright
3. Partner with a food ordering aggregator

**Deliverable:** Clear integration path decided

### Day 8: Restaurant Search
- [ ] Implement location-based restaurant search
- [ ] Add cuisine filtering (mexican, chinese, etc.)
- [ ] Calculate delivery times/distances
- [ ] Format results for SMS (short, readable)
- [ ] Test: "Find mexican food near me"

**Deliverable:** Can search restaurants via SMS

### Day 9: Menu Browsing
- [ ] Fetch menu for selected restaurant
- [ ] Implement menu navigation via text
- [ ] Handle item selection
- [ ] Support customizations (size, toppings)
- [ ] Test: Browse menu and select items

**Deliverable:** Can browse menus and select items

### Day 10: Cart & Checkout
- [ ] Implement shopping cart
- [ ] Add/remove items via text
- [ ] Calculate totals (including fees, tip)
- [ ] Create order confirmation flow
- [ ] Test: Build a complete order

**Deliverable:** Can build a cart and see totals

### Day 11: Order Placement
- [ ] Implement order submission
- [ ] Handle payment processing
- [ ] Send order confirmation
- [ ] Implement order status updates
- [ ] Test: Place a real test order

**Deliverable:** Can place an actual order via SMS

---

## Phase 4: Intelligence & UX (Days 12-14)

### Day 12: Smart Recommendations
- [ ] Track order history
- [ ] Implement preference learning
- [ ] Add "surprise me" feature
- [ ] Time-based suggestions (lunch vs dinner)
- [ ] Test: Get personalized recommendations

**Deliverable:** AI makes smart, personalized suggestions

### Day 13: Natural Language Understanding
- [ ] Handle varied phrasing ("I'm hungry", "get me food", "order dinner")
- [ ] Implement confirmation flows
- [ ] Add error handling and clarification
- [ ] Support quick reorders ("order my usual")
- [ ] Test: Natural conversation flows

**Deliverable:** Conversational, natural interactions

### Day 14: Order Tracking & Notifications
- [ ] Implement order status polling
- [ ] Send proactive status updates
- [ ] "Where's my food?" command
- [ ] Delivery completion notification
- [ ] Test: Track a live order

**Deliverable:** Real-time order updates via SMS

---

## Phase 5: Polish & Expand (Days 15+)

### Day 15: Error Handling & Edge Cases
- [ ] Handle API failures gracefully
- [ ] Implement retry logic
- [ ] Add timeout handling
- [ ] User-friendly error messages
- [ ] Comprehensive logging

### Day 16+: Future Features
- [ ] Add more services (Uber Eats, Grubhub)
- [ ] Grocery ordering (Instacart)
- [ ] Ride sharing integration
- [ ] Calendar/reminder features
- [ ] Home automation hooks

---

## Tech Stack Recommendation

```
Backend:        Node.js + Express  OR  Python + FastAPI
Database:       PostgreSQL (with encryption)
SMS Provider:   Twilio
AI:             Anthropic Claude API
Hosting:        Railway, Render, or AWS
Encryption:     libsodium or Node crypto
Food APIs:      DoorDash Drive / Playwright automation
```

---

## Key Challenges & Solutions

### Challenge 1: DoorDash has no public consumer API
**Solution:** Use browser automation (Playwright) to interact with DoorDash, or integrate with DoorDash Drive API if you register as a merchant.

### Challenge 2: iMessage specifically
**Solution:** Twilio only supports SMS, not iMessage directly. However, SMS works seamlessly on iPhone - messages just appear in the same app. True iMessage would require Apple Business Chat (enterprise).

### Challenge 3: Payment Security
**Solution:** Never store card numbers. Use tokenization through a payment processor (Stripe). Link accounts via secure web portal, not SMS.

### Challenge 4: Address Security
**Solution:** Encrypt addresses using AES-256 with keys stored separately (environment variables or key management service).

---

## SMS Command Reference (Future)

```
ACCOUNT COMMANDS:
- "login" - Start authentication
- "my profile" - View your info
- "set address [address]" - Update delivery address
- "logout" - End session

FOOD COMMANDS:
- "I want [cuisine]" - Search restaurants
- "what's nearby?" - See close restaurants
- "show menu" - View current restaurant menu
- "add [item]" - Add to cart
- "my cart" - View current cart
- "checkout" - Place order
- "order my usual" - Reorder last order

TRACKING:
- "where's my food?" - Order status
- "order history" - Past orders

HELP:
- "help" - List commands
- "cancel" - Cancel current action
```

---

## Getting Started Checklist

1. [ ] Sign up for Twilio (twilio.com) - get a phone number
2. [ ] Sign up for Anthropic API (console.anthropic.com)
3. [ ] Choose hosting platform (Railway recommended for beginners)
4. [ ] Set up local development environment
5. [ ] Start with Day 1 tasks

---

## Estimated Costs (Monthly)

- Twilio SMS: ~$1/month for number + $0.0079/message
- Anthropic API: ~$5-20 depending on usage
- Hosting: $5-20 (Railway/Render)
- Database: Free tier usually sufficient
- **Total: ~$15-50/month for personal use**

---

## Notes

- Start simple, iterate
- Test each phase thoroughly before moving on
- Keep conversation logs for debugging
- Consider rate limiting to prevent abuse
- This is a personal project, but build it like it could scale
