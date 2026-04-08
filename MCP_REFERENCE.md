# CargoLoop LoadConnex MCP — Agent Reference Guide

> This document is the authoritative reference for any AI agent connecting to the CargoLoop LoadConnex MCP proxy. Read this before making any tool calls.

**MCP Endpoint:** `https://cargoloop-proxy.vercel.app/api/mcp`
**Protocol:** MCP Streamable HTTP
**API Version:** 2.7.0+

---

## Table of Contents

1. [Address Formatting](#address-formatting)
2. [Currency & Money Fields](#currency--money-fields)
3. [Billing Info](#billing-info)
4. [Valid Enums](#valid-enums)
5. [Rate Limits](#rate-limits)
6. [Stop Rules](#stop-rules)
7. [Tool-Specific Notes](#tool-specific-notes)
8. [Known API Quirks](#known-api-quirks)
9. [REST Proxy Fallback](#rest-proxy-fallback)

---

## Address Formatting

LoadConnex geocodes `location_address` via Google Maps API. Addresses that fail geocoding cause `400 "Address not inserted"` or `500 NullReferenceException`.

### Required Format

Full street address with city, state, ZIP, and country:

```
1000 Farristown Industrial Dr, Berea, KY 40403, USA
820 Keystone Blvd, Pottsville, PA 17901, USA
4500 E Basford Rd, Frederick, MD 21703, USA
3191 NW 72nd Ave, Miami, FL 33122, USA
```

### What Fails

| Pattern | Result |
|---------|--------|
| City-only (`Berea, KY 40403, USA`) | 400 Address not inserted |
| Missing country suffix | Inconsistent — may fail |
| Rural/obscure addresses | 400 Address not inserted |
| Non-existent street numbers | 500 NullReferenceException |

### Best Practice

Use addresses from previously successful loads or well-known commercial locations. When in doubt, verify the address returns results on Google Maps before using it.

---

## Currency & Money Fields

All monetary values use **cents USD** (smallest denomination).

| Dollar Amount | Cents Value |
|--------------|-------------|
| $1,500.00 | `150000` |
| $3,850.00 | `385000` |
| $100,000.00 | `10000000` |

### max_cargo_value

- **Input to MCP tool:** flat integer (e.g., `10000000`)
- **Proxy transforms to:** `{ "amount": 10000000, "currency": "USD" }`
- **Valid range:** `0` to `10000000` (max $100,000.00)
- Values above 10,000,000 return `400 invalid_value`

---

## Billing Info

Optional array of line items on `create_load` and `update_load`. Each item has a name and optional `receivable` (invoice to customer) and/or `payable` (pay to carrier).

### Common Line Items

| Line Item | Description |
|-----------|-------------|
| `LINE HAUL` | Base freight rate |
| `FUEL SURCHARGE` | Fuel cost adjustment (typically 15% of line haul) |
| `DETENTION` | Waiting time charges at pickup/delivery |
| `ACCESSORIALS` | Extra services (liftgate, inside delivery, etc.) |

### Example

```json
[
  {
    "line_item": "LINE HAUL",
    "receivable": { "amount": 385000 },
    "payable": { "amount": 340000 }
  },
  {
    "line_item": "FUEL SURCHARGE",
    "receivable": { "amount": 57750 },
    "payable": { "amount": 51000 }
  },
  {
    "line_item": "DETENTION",
    "receivable": { "amount": 15000 },
    "payable": { "amount": 15000 }
  }
]
```

- Currency defaults to `"USD"` automatically — no need to specify it.
- At least one of `receivable` or `payable` should be present per line item.

---

## Valid Enums

### trailer_type

```
Van or Refrigerated | Van | Refrigerated | Flatbed | No Trailer / Power Only
```

All other values (Dry Van, Step Deck, Lowboy, Conestoga, etc.) are rejected by LoadConnex.

### filter_life_cycle (get_loads)

```
Upcoming | In Transit | Delivered | Cancelled | Completed
```

Note: LoadConnex also accepts `"Posted to Marketplace"` but this value is not currently in the MCP schema.

### post_to_marketplace

| Context | Valid Values |
|---------|-------------|
| create_load | `no`, `private_carriers_only`, `private_with_brokers`, `public_no_brokers`, `all` |
| update_load | Same as above plus `no_change` |

### load_tracking_status (update_load_status)

```
Ready | On Time | Predicted Late | Late | Verifying Arrival | At Stop | Final Stop | Delivered | GPS Signal Lost
```

---

## Rate Limits

LoadConnex enforces **1 request/second** and **10 requests/minute**.

- The proxy has a built-in token bucket rate limiter with automatic exponential backoff on 429 responses.
- When creating multiple loads in sequence, expect throttling after 8-10 rapid calls.
- **Recommendation:** Allow 30-60 seconds cooldown between batches of write operations.
- Read operations (get_loads, get_load) are cached for 15-60 seconds to reduce API calls.

---

## Stop Rules

| Rule | Detail |
|------|--------|
| Minimum stops | 2 |
| Maximum stops | 10 |
| First stop | Must be `type: "Pickup"` |
| Last stop | Must be `type: "Delivery"` |
| Stop numbers | Start at 1, increment by 1 |
| Date ordering | Each stop's `appointment_end_date_time_local` must be after the previous stop's |
| Date format | RFC 3339: `YYYY-MM-DDTHH:mmZ` (e.g., `2026-04-10T13:00Z`) |
| Multi-stop | Middle stops can be `Pickup` or `Delivery` |

---

## Tool-Specific Notes

### create_load

- `max_cargo_value` is required (integer in cents, proxy wraps it)
- `billing_info` is optional but recommended
- `load_tracking_status` is injected automatically as `"Pending"`
- `stop_tracking_status` is injected automatically for each stop

### update_load (PUT — Full Replace)

- **All fields are required.** Omitted fields are deleted on LoadConnex's side.
- Always call `get_load` first to capture current values.
- `max_cargo_value` and `billing_info` are supported with the same transformation as create.
- Cannot update loads with Transfer stops or loads assigned to Load Connex.

### get_loads

- `filter_life_cycle` is required — cannot list all loads without it.
- Returns up to 100 results per page. Use `page_no` for pagination.
- Use `filter_load_number` for partial member load number search.

### delete_load

- Permanent and irreversible.
- Only works on loads not currently in transit or assigned.

### Documents

- `upload_document` fails if a document of that type already exists — use `replace_document` instead.
- Document types: `Rate Confirmation`, `Internal`, `From Driver`, `To Customer`
- Max file size: 15 MB
- Format: Base64-encoded PDF

---

## Known API Quirks

### 500 Response But Load Created

LoadConnex occasionally returns HTTP 500 `"Object reference not set to an instance of an object."` but the load IS successfully created. This is a server-side bug in their response generation, not a proxy issue.

**Agent behavior:** If `create_load` returns 500, check `get_loads` with `filter_life_cycle=Upcoming` and `filter_load_number=<your_member_load_number>` to verify whether the load was actually created before retrying.

### readOnly-but-required Fields

`load_tracking_status` and `stop_tracking_status` are marked both `required` and `readOnly` in the LoadConnex swagger. The proxy injects `"Pending"` for both. These should not be sent by the agent — the proxy handles it.

### Address Geocoding Failures

LoadConnex's geocoding can fail silently. A 400 with `"Address not inserted"` means geocoding failed. A 500 NullReferenceException can also indicate a geocoding failure in a different code path. See [Address Formatting](#address-formatting) for guidance.

---

## REST Proxy Fallback

If the MCP schema's Zod validation blocks a valid LoadConnex value (e.g., a new trailer type or lifecycle value added by LoadConnex), the REST proxy endpoint bypasses schema validation:

```
GET/POST https://cargoloop-proxy.vercel.app/api/lx?p=<path>&<params>
```

Example: `?p=loads&filter_life_cycle=Posted+to+Marketplace&per_page=25`

This endpoint forwards requests directly to LoadConnex with authentication headers but no input validation. Use for debugging or when the MCP schema is out of date.
