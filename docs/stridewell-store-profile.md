# Stridewell: Fictional Store Profile

**Everything here is fictional.** Stridewell is an invented retailer for the voice demo. No real brand, address, phone number, or customer is described. Where a real street address is needed in Shopify, use a public civic address and do not imply a real retail presence.

## Snapshot

| | |
|---|---|
| **What it is** | A running and outdoor gear retailer with four neighborhood stores in the Bay Area |
| **Tagline** | "Find your stride." |
| **Customers** | Everyday runners, new runners, and weekend trail hikers |
| **Edge** | Knowledgeable staff and a phone line that answers instantly, any hour |
| **Tone** | Friendly, practical, never pushy. A running buddy, not a salesperson |

## The four stores

| ID | Store | Phone (fictional) | Hours | Role in the demo |
|---|---|---|---|---|
| SC | Stridewell Santa Clara | +1 408 555 0101 | Mon-Sat 10am-8pm, Sun 11am-6pm | The default demo store |
| SJ | Stridewell San Jose | +1 408 555 0102 | Mon-Sat 10am-8pm, Sun 11am-6pm | Also out of the key shoe; shows the fallback skips it |
| PA | Stridewell Palo Alto | +1 650 555 0103 | Mon-Sat 10am-7pm, Sun 11am-5pm | Has the shoe; the "saved sale" store and the transfer target |
| SF | Stridewell San Francisco | +1 415 555 0104 | Mon-Sat 10am-8pm, Sun 11am-6pm | Far from the others; proves distance matters |

Each store has its own number. The number a customer dials identifies the store before they speak.

Approximate distances between stores are demo values: Santa Clara to San Jose 8 miles, to Palo Alto 14, to San Francisco 45.

## Catalog

| Product | SKU prefix | Type | Price |
|---|---|---|---|
| Veloce Glide 4 | GLIDE4 | Road, everyday trainer | $140 |
| Tern Cloud Runner 2 | CLOUD2 | Road, cushioned | $130 |
| Ridgeline Trail Pro | RIDGE1 | Trail | $155 |

All three come in US sizes 9, 10, and 11. Brands and models are invented so the demo implies no real partnership.

**The hero scenario:** the Veloce Glide 4 in size 10 is out at Santa Clara and San Jose and in stock at Palo Alto.

## Store policies (demo assumptions)

- **Pickup:** items are usually ready within about 24 hours.
- **Holds:** a held pair is kept for 24 hours. This is an assumption; how a hold is recorded is still an open item.
- **Returns and fit questions:** handled by store staff, so the assistant connects the caller to the store.
- **Payment:** never taken over the phone. The assistant never asks for card details.

## The AI assistant

| | |
|---|---|
| **Role** | Answers calls to any Stridewell store line |
| **Introduces itself** | As the store's AI assistant, at the start of every call |
| **Can do** | Confirm the store, check stock for a model and size, name the nearest store that has it, hold a pair, text a confirmation, connect the caller to a store |
| **Does not do** | Take payment, discuss anything off-topic, guess a size or stock level, read a caller's number back |
| **Style** | Short sentences, one question at a time, easy to interrupt |

## Sample caller lines

- "Do you have the Glide 4 in a 10?"
- "Which store is closest to me?"
- "Actually, what about the Cloud Runner?" (said mid-answer)
- "Yes, hold a pair for me."
- "Can I talk to someone about fit?"

## How the business story ends

A caller who would have walked away from an out-of-stock shelf leaves with a held pair at the next-nearest store, a text confirmation, and, if they want, a human on the line. The assistant is the voice; the phone system, routing, texting, and records behind it are the business capability.
