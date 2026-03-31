import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const LX_BASE = "https://lx-api.loadconnex.com/v1";

// ── Rate limiter ────────────────────────────────────────────
// LoadConnex limit: 1 req/sec, 10 req/min
// Token bucket: refills 1 token/sec, max burst of 1.
// Per-minute bucket: 10 tokens, refills fully every 60s.
const rateLimiter = {
  perSecTokens: 1,
  perSecLastRefill: Date.now(),
  perMinTokens: 10,
  perMinLastRefill: Date.now(),

  async acquire() {
    while (true) {
      const now = Date.now();

      // Refill per-second bucket
      const secElapsed = (now - this.perSecLastRefill) / 1000;
      this.perSecTokens = Math.min(1, this.perSecTokens + secElapsed);
      this.perSecLastRefill = now;

      // Refill per-minute bucket
      const minElapsed = (now - this.perMinLastRefill) / 60000;
      this.perMinTokens = Math.min(10, this.perMinTokens + minElapsed * 10);
      this.perMinLastRefill = now;

      if (this.perSecTokens >= 1 && this.perMinTokens >= 1) {
        this.perSecTokens -= 1;
        this.perMinTokens -= 1;
        return;
      }

      // Calculate wait: whichever bucket needs longer to refill
      const waitForSec = this.perSecTokens < 1 ? (1 - this.perSecTokens) * 1000 : 0;
      const waitForMin = this.perMinTokens < 1 ? ((1 - this.perMinTokens) / 10) * 60000 : 0;
      const waitMs = Math.max(waitForSec, waitForMin);
      await new Promise(r => setTimeout(r, Math.ceil(waitMs) + 50)); // +50ms safety margin
    }
  },
};

// ── Response cache (read-only, 60s TTL) ─────────────────────
const cache = new Map();
const CACHE_TTL_MS = 60_000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Evict entries older than TTL to prevent unbounded growth
  if (cache.size > 200) {
    for (const [k, v] of cache) {
      if (Date.now() - v.ts > CACHE_TTL_MS) cache.delete(k);
    }
  }
}

// ── Core fetch with rate limiting + retry ───────────────────
async function lxRequest(fetchFn, retries = 3) {
  await rateLimiter.acquire();
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchFn();
    if (res.status === 429) {
      if (attempt === retries) throw new Error("LoadConnex rate limit exceeded after retries");
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(`LoadConnex 429 — backing off ${Math.round(backoff)}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, backoff));
      await rateLimiter.acquire(); // re-acquire token after backoff
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LoadConnex ${res.status}: ${text}`);
    }
    return res.json();
  }
}

function lxHeaders(contentType = "application/json") {
  return {
    "X-API-key-vendor": process.env.LOADCONNEX_VENDOR_KEY,
    "X-API-key-member": process.env.LOADCONNEX_MEMBER_KEY,
    "Accept": "application/json",
    "Content-Type": contentType,
  };
}

async function lxFetch(path, params = {}) {
  const url = new URL(`${LX_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await lxRequest(() => fetch(url.toString(), { headers: lxHeaders() }));
  cacheSet(cacheKey, data);
  return data;
}

async function lxWrite(method, path, body, contentType = "application/json") {
  return lxRequest(() => fetch(`${LX_BASE}/${path}`, {
    method,
    headers: lxHeaders(contentType),
    body: contentType === "application/json" ? JSON.stringify(body) : body,
  }));
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function createServer() {
  const server = new McpServer({ name: "cargoloop-loadconnex", version: "2.1.0" });

  // ═══════════════════════════════════════════════════════════
  // SEGMENT 1 — LOADS (read + write)
  // ═══════════════════════════════════════════════════════════

  server.tool(
    "get_loads",
    `Fetch load summaries from LoadConnex with full filtering, sorting, and pagination.
Default per_page is 25 — always set this explicitly to avoid large data dumps.
Dates use RFC 3339 format: YYYY-MM-DDTHH:mmZ (e.g. 2026-03-27T00:00Z).
filter_status filters by tracking status (e.g. 'Late', 'GPS Signal Lost').
filter_life_cycle is required — use 'In Transit' for active loads.`,
    {
      filter_life_cycle: z.enum(["In Transit", "Delivered", "Pending", "Cancelled", "Completed"]).describe("Required. Lifecycle stage to filter by."),
      filter_customer_name: z.string().describe("Partial customer name (e.g. 'Mastronardi', 'Sunset')").optional(),
      filter_load_number: z.string().describe("Partial WPL member load number (not LX load number)").optional(),
      filter_carrier_driver_tractor: z.string().describe("Partial carrier company name, driver full name, or tractor unit number").optional(),
      filter_status: z.enum(["Ready","On Time","Predicted Late","Late","Verifying Arrival","At Stop","Final Stop","Delivered","GPS Signal Lost"]).describe("Filter by current tracking status").optional(),
      filter_pickup_date_time_local_from: z.string().describe("Pickup date range start, RFC 3339: YYYY-MM-DDTHH:mmZ").optional(),
      filter_pickup_date_time_local_to: z.string().describe("Pickup date range end, RFC 3339: YYYY-MM-DDTHH:mmZ").optional(),
      filter_delivery_date_time_local_from: z.string().describe("Delivery date range start, RFC 3339: YYYY-MM-DDTHH:mmZ").optional(),
      filter_delivery_date_time_local_to: z.string().describe("Delivery date range end, RFC 3339: YYYY-MM-DDTHH:mmZ").optional(),
      filter_pickup_city_state: z.string().describe("Pickup city and state (e.g. 'Oxnard, CA')").optional(),
      filter_delivery_city_state: z.string().describe("Delivery city and state (e.g. 'Philadelphia, PA')").optional(),
      sort: z.string().describe("Comma-separated sort keys with optional :asc/:desc. Allowed: member_load_number, customer_name, pickup_date_time_local, pickup_city_state, delivery_date_time_local, delivery_city_state, load_tracking_status, carrier_name, driver_name, tractor_unit_number. Max 3.").optional(),
      per_page: z.number().int().min(1).max(100).default(25).describe("Results per page (1-100). Default 25."),
      page_no: z.number().int().min(1).default(1).describe("Page number. Default 1."),
    },
    async ({ filter_life_cycle, filter_customer_name, filter_load_number, filter_carrier_driver_tractor, filter_status, filter_pickup_date_time_local_from, filter_pickup_date_time_local_to, filter_delivery_date_time_local_from, filter_delivery_date_time_local_to, filter_pickup_city_state, filter_delivery_city_state, sort, per_page, page_no }) => {
      const data = await lxFetch("loads", { filter_life_cycle, filter_customer_name, filter_load_number, filter_carrier_driver_tractor, filter_status, filter_pickup_date_time_local_from, filter_pickup_date_time_local_to, filter_delivery_date_time_local_from, filter_delivery_date_time_local_to, filter_pickup_city_state, filter_delivery_city_state, sort, per_page: per_page ?? 25, page_no: page_no ?? 1 });
      return ok(data);
    }
  );

  server.tool(
    "get_load",
    "Fetch full details for a single load by its internal LoadConnex ID. Returns all stops, carrier info, tracking status, and document links.",
    { load_id: z.string().describe("Internal LoadConnex load ID — numeric 'id' field from get_loads, NOT lx_load_number") },
    async ({ load_id }) => ok(await lxFetch(`loads/${load_id}`))
  );

  server.tool(
    "create_load",
    `Create a new load in LoadConnex (POST /loads).
Required: trailer_type, weight, commodity, post_to_marketplace, stops (min 2: first must be Pickup, last must be Delivery).
Stop fields required: stop_no (starting 1), type, country (US/MX/CA), location_name, location_address, appointment_start_date_time_local, appointment_end_date_time_local.
Dates: RFC 3339 YYYY-MM-DDTHH:mmZ. Each stop's appointment_end must be after the previous stop's.
post_to_marketplace values: 'no', 'private_carriers_only', 'private_with_brokers', 'public_no_brokers', 'all'.`,
    {
      member_load_number: z.string().describe("Your internal WPL load/job number (must be unique)").optional(),
      trailer_type: z.enum(["Dry Van","Refrigerated","Flatbed","Step Deck","Lowboy","Double Drop","Conestoga","Curtainside","Tanker","Pneumatic","Hopper","Dump","Other"]).describe("Type of trailer required"),
      weight: z.number().int().min(0).max(99999).describe("Shipment weight in lbs"),
      commodity: z.string().describe("Commodity description (e.g. 'Produce', 'Mushrooms')"),
      post_to_marketplace: z.enum(["no","private_carriers_only","private_with_brokers","public_no_brokers","all"]).describe("Who to post the load to on the marketplace"),
      customer_code: z.string().describe("Customer code to link the load to a customer").optional(),
      customer_reference_number: z.string().describe("Customer's reference number for this load").optional(),
      additional_instructions: z.string().describe("Special instructions for the driver").optional(),
      stops: z.array(z.object({
        stop_no: z.number().int().min(1).max(10),
        type: z.enum(["Pickup","Delivery"]),
        country: z.enum(["US","MX","CA"]),
        location_name: z.string(),
        location_address: z.string().describe("Full address — must be geocodable by Google"),
        appointment_start_date_time_local: z.string().describe("RFC 3339: YYYY-MM-DDTHH:mmZ"),
        appointment_end_date_time_local: z.string().describe("RFC 3339: YYYY-MM-DDTHH:mmZ"),
        pieces: z.number().int().optional(),
        weight: z.number().int().optional(),
        number: z.string().describe("Pickup/delivery number at location").optional(),
        contact_name: z.string().optional(),
      })).min(2).max(10).describe("Array of stops. First must be Pickup, last must be Delivery."),
    },
    async ({ member_load_number, trailer_type, weight, commodity, post_to_marketplace, customer_code, customer_reference_number, additional_instructions, stops }) => {
      const body = { trailer_type, weight, commodity, post_to_marketplace, stops, load_tracking_status: "Ready" };
      if (member_load_number) body.member_load_number = member_load_number;
      if (customer_code) body.customer_code = customer_code;
      if (customer_reference_number) body.customer_reference_number = customer_reference_number;
      if (additional_instructions) body.additional_instructions = additional_instructions;
      return ok(await lxWrite("POST", "loads", body));
    }
  );

  server.tool(
    "update_load",
    `Full update of an existing load (PUT /loads/{id}). Must include ALL fields — any omitted field will be deleted.
Use get_load first to retrieve current values, then send the full object with your changes.
Cannot update loads with Transfer stops via API (use the UI).
Cannot update loads assigned to Load Connex carrier.`,
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      member_load_number: z.string().optional(),
      trailer_type: z.enum(["Dry Van","Refrigerated","Flatbed","Step Deck","Lowboy","Double Drop","Conestoga","Curtainside","Tanker","Pneumatic","Hopper","Dump","Other"]),
      weight: z.number().int().min(0).max(99999),
      commodity: z.string(),
      customer_code: z.string().optional(),
      customer_reference_number: z.string().optional(),
      additional_instructions: z.string().optional(),
      post_to_marketplace: z.enum(["no","private_carriers_only","private_with_brokers","public_no_brokers","all","no_change"]),
      stops: z.array(z.object({
        stop_no: z.number().int().min(1).max(10),
        type: z.enum(["Pickup","Delivery"]),
        country: z.enum(["US","MX","CA"]),
        location_name: z.string(),
        location_address: z.string(),
        appointment_start_date_time_local: z.string(),
        appointment_end_date_time_local: z.string(),
        pieces: z.number().int().optional(),
        weight: z.number().int().optional(),
        number: z.string().optional(),
        contact_name: z.string().optional(),
      })).min(2).max(10),
    },
    async ({ load_id, ...fields }) => ok(await lxWrite("PUT", `loads/${load_id}`, fields))
  );

  server.tool(
    "update_load_status",
    "Update the tracking status or notes on a load.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      tracking_status: z.enum(["Ready","On Time","Predicted Late","Late","Verifying Arrival","At Stop","Final Stop","Delivered","GPS Signal Lost"]).optional(),
      notes: z.string().optional(),
    },
    async ({ load_id, tracking_status, notes }) => {
      const body = {};
      if (tracking_status) body.tracking_status = tracking_status;
      if (notes) body.notes = notes;
      return ok(await lxWrite("PATCH", `loads/${load_id}`, body));
    }
  );

  server.tool(
    "delete_load",
    "Delete a load from LoadConnex. This is permanent and cannot be undone.",
    { load_id: z.string().describe("Internal LoadConnex load ID") },
    async ({ load_id }) => {
      const res = await fetch(`${LX_BASE}/loads/${load_id}`, { method: "DELETE", headers: lxHeaders() });
      if (!res.ok) { const t = await res.text(); throw new Error(`LoadConnex ${res.status}: ${t}`); }
      return ok(await res.json());
    }
  );

  server.tool(
    "get_position",
    "Get the latest GPS position for a load. Returns empty strings if GPS signal is lost.",
    { load_id: z.string().describe("Internal LoadConnex load ID") },
    async ({ load_id }) => ok(await lxFetch(`loads/${load_id}/position`))
  );

  // ═══════════════════════════════════════════════════════════
  // SEGMENT 2 — DOCUMENTS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    "get_documents",
    "List all documents attached to a load (BOL, rate confirmation, delivery receipts, etc.). Returns id, filename, type, and url_for_api for each.",
    { load_id: z.string().describe("Internal LoadConnex load ID") },
    async ({ load_id }) => ok(await lxFetch(`loads/${load_id}/documents`))
  );

  server.tool(
    "get_document",
    "Retrieve a specific document's content as base64-encoded PDF. Use the document id from get_documents.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      document_id: z.string().describe("Document ID from get_documents"),
    },
    async ({ load_id, document_id }) => ok(await lxFetch(`loads/${load_id}/documents/${document_id}`))
  );

  server.tool(
    "upload_document",
    `Upload a new PDF document to a load (POST /loads/{id}/documents).
Accepted types: 'Rate Confirmation', 'Internal', 'From Driver', 'To Customer'.
Note: POST will fail if a document of that type already exists — use replace_document instead.
pdf_base64: base64-encoded PDF string. Max file size 15 MB.`,
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      filename: z.string().describe("File name (e.g. 'bol_5655802.pdf')"),
      type: z.enum(["Rate Confirmation","Internal","From Driver","To Customer"]).describe("Document type"),
      pdf_base64: z.string().describe("Base64-encoded PDF content"),
    },
    async ({ load_id, filename, type, pdf_base64 }) =>
      ok(await lxWrite("POST", `loads/${load_id}/documents`, { filename, type, pdf_base64 }))
  );

  server.tool(
    "replace_document",
    "Replace the content of an existing document (PUT). The filename and type remain unchanged — only the PDF content is replaced. Send raw base64-encoded PDF.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      document_id: z.string().describe("Document ID from get_documents"),
      pdf_base64: z.string().describe("Base64-encoded PDF content to replace with"),
    },
    async ({ load_id, document_id, pdf_base64 }) =>
      ok(await lxWrite("PUT", `loads/${load_id}/documents/${document_id}`, pdf_base64, "application/pdf"))
  );

  server.tool(
    "append_document",
    "Append pages to the end of an existing document (PATCH). Send raw base64-encoded PDF pages to append.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      document_id: z.string().describe("Document ID from get_documents"),
      pdf_base64: z.string().describe("Base64-encoded PDF pages to append"),
    },
    async ({ load_id, document_id, pdf_base64 }) =>
      ok(await lxWrite("PATCH", `loads/${load_id}/documents/${document_id}`, pdf_base64, "application/pdf"))
  );

  server.tool(
    "delete_document",
    "Delete a document from a load. Permanent.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      document_id: z.string().describe("Document ID from get_documents"),
    },
    async ({ load_id, document_id }) => {
      const res = await fetch(`${LX_BASE}/loads/${load_id}/documents/${document_id}`, { method: "DELETE", headers: lxHeaders() });
      if (!res.ok) { const t = await res.text(); throw new Error(`LoadConnex ${res.status}: ${t}`); }
      return ok(await res.json());
    }
  );

  server.tool(
    "share_document_to_customer",
    "Email the 'To Customer' document for a load to the customer's users in LoadConnex.",
    { load_id: z.string().describe("Internal LoadConnex load ID") },
    async ({ load_id }) => ok(await lxWrite("POST", `loads/${load_id}/documents/share_to_customer`, {}))
  );

  // ═══════════════════════════════════════════════════════════
  // SEGMENT 3 — FLEET (drivers, tractors, trailers)
  // ═══════════════════════════════════════════════════════════

  // ── Drivers ──────────────────────────────────────────────

  server.tool(
    "list_drivers",
    "List WPL drivers. Filter by name or availability. Drivers are synced from ELD — use update_driver to edit details.",
    {
      filter_full_name: z.string().describe("Partial driver name").optional(),
      filter_available: z.boolean().describe("Filter by availability. Omit to get all drivers.").optional(),
      per_page: z.number().int().min(1).max(100).default(25).optional(),
      page_no: z.number().int().min(1).default(1).optional(),
      sort: z.string().describe("Sort keys: full_name, available, mobile_app_status. E.g. 'full_name:asc'").optional(),
    },
    async ({ filter_full_name, filter_available, per_page, page_no, sort }) =>
      ok(await lxFetch("drivers", { filter_full_name, filter_available, per_page: per_page ?? 25, page_no: page_no ?? 1, sort }))
  );

  server.tool(
    "get_driver",
    "Get full details for a single driver by their LoadConnex ID.",
    { driver_id: z.string().describe("LoadConnex driver ID") },
    async ({ driver_id }) => ok(await lxFetch(`drivers/${driver_id}`))
  );

  server.tool(
    "create_driver",
    `Create a new driver (POST /drivers). Required: first_name, available.
Name, email, mobile phone, and licence number must be unique per member.
Phone format: (ddd) ddd-dddd. Dates: YYYY-MM-DD.`,
    {
      first_name: z.string().describe("Driver first name (required)"),
      last_name: z.string().optional(),
      email: z.string().email().optional(),
      mobile_phone: z.string().describe("Format: (ddd) ddd-dddd").optional(),
      available: z.boolean().describe("Whether driver is available for assignment"),
      driver_licence_number: z.string().optional(),
      driver_licence_state: z.string().describe("2-letter US state code").optional(),
      driver_licence_expiration_date: z.string().describe("YYYY-MM-DD").optional(),
      medical_expiration_date: z.string().describe("YYYY-MM-DD").optional(),
    },
    async (fields) => ok(await lxWrite("POST", "drivers", fields))
  );

  server.tool(
    "update_driver",
    "Full replace of a driver record (PUT). Must include ALL fields — omitted fields are deleted. Use get_driver first to retrieve current values.",
    {
      driver_id: z.string().describe("LoadConnex driver ID"),
      first_name: z.string(),
      last_name: z.string().optional(),
      email: z.string().email().optional(),
      mobile_phone: z.string().describe("Format: (ddd) ddd-dddd").optional(),
      available: z.boolean(),
      driver_licence_number: z.string().optional(),
      driver_licence_state: z.string().optional(),
      driver_licence_expiration_date: z.string().describe("YYYY-MM-DD").optional(),
      medical_expiration_date: z.string().describe("YYYY-MM-DD").optional(),
    },
    async ({ driver_id, ...fields }) => ok(await lxWrite("PUT", `drivers/${driver_id}`, fields))
  );

  server.tool(
    "delete_driver",
    "Delete a driver from LoadConnex. Permanent.",
    { driver_id: z.string().describe("LoadConnex driver ID") },
    async ({ driver_id }) => {
      const res = await fetch(`${LX_BASE}/drivers/${driver_id}`, { method: "DELETE", headers: lxHeaders() });
      if (!res.ok) { const t = await res.text(); throw new Error(`LoadConnex ${res.status}: ${t}`); }
      return ok(await res.json());
    }
  );

  // ── Tractors ──────────────────────────────────────────────

  server.tool(
    "list_tractors",
    "List WPL tractors. Tractors are synced from ELD provider.",
    {
      filter_unit_number: z.string().describe("Partial tractor unit number").optional(),
      filter_available: z.boolean().optional(),
      per_page: z.number().int().min(1).max(100).default(25).optional(),
      page_no: z.number().int().min(1).default(1).optional(),
      sort: z.string().describe("Sort keys: unit_number, vin, available").optional(),
    },
    async ({ filter_unit_number, filter_available, per_page, page_no, sort }) =>
      ok(await lxFetch("tractors", { filter_unit_number, filter_available, per_page: per_page ?? 25, page_no: page_no ?? 1, sort }))
  );

  server.tool(
    "get_tractor",
    "Get full details for a single tractor by its LoadConnex ID.",
    { tractor_id: z.string().describe("LoadConnex tractor ID") },
    async ({ tractor_id }) => ok(await lxFetch(`tractors/${tractor_id}`))
  );

  server.tool(
    "update_tractor",
    "Full replace of a tractor record (PUT). Must include ALL fields — omitted fields are deleted. Use get_tractor first.",
    {
      tractor_id: z.string().describe("LoadConnex tractor ID"),
      unit_number: z.string().describe("Tractor unit number (must be unique)"),
      available: z.boolean().describe("Whether tractor can be assigned to a load"),
      vin: z.string().optional(),
      licence_plate_number: z.string().optional(),
      licence_plate_state: z.string().describe("2-letter US state code").optional(),
    },
    async ({ tractor_id, ...fields }) => ok(await lxWrite("PUT", `tractors/${tractor_id}`, fields))
  );

  // ── Trailers ──────────────────────────────────────────────

  server.tool(
    "list_trailers",
    "List WPL trailers.",
    {
      filter_unit_number: z.string().optional(),
      filter_trailer_type: z.string().optional(),
      filter_available: z.boolean().optional(),
      per_page: z.number().int().min(1).max(100).default(25).optional(),
      page_no: z.number().int().min(1).default(1).optional(),
      sort: z.string().describe("Sort keys: unit_number, trailer_type, available").optional(),
    },
    async ({ filter_unit_number, filter_trailer_type, filter_available, per_page, page_no, sort }) =>
      ok(await lxFetch("trailers", { filter_unit_number, filter_trailer_type, filter_available, per_page: per_page ?? 25, page_no: page_no ?? 1, sort }))
  );

  server.tool(
    "get_trailer",
    "Get full details for a single trailer by its LoadConnex ID.",
    { trailer_id: z.string().describe("LoadConnex trailer ID") },
    async ({ trailer_id }) => ok(await lxFetch(`trailers/${trailer_id}`))
  );

  server.tool(
    "create_trailer",
    "Create a new trailer (POST /trailers). Unit number must be unique.",
    {
      unit_number: z.string().describe("Trailer unit number (must be unique)"),
      trailer_type: z.enum(["Dry Van","Refrigerated","Flatbed","Step Deck","Lowboy","Double Drop","Conestoga","Curtainside","Tanker","Pneumatic","Hopper","Dump","Other"]),
      available: z.boolean().describe("Whether trailer can be assigned to a load"),
    },
    async (fields) => ok(await lxWrite("POST", "trailers", fields))
  );

  server.tool(
    "update_trailer",
    "Full replace of a trailer record (PUT). Must include ALL fields. Use get_trailer first.",
    {
      trailer_id: z.string().describe("LoadConnex trailer ID"),
      unit_number: z.string(),
      trailer_type: z.enum(["Dry Van","Refrigerated","Flatbed","Step Deck","Lowboy","Double Drop","Conestoga","Curtainside","Tanker","Pneumatic","Hopper","Dump","Other"]),
      available: z.boolean(),
    },
    async ({ trailer_id, ...fields }) => ok(await lxWrite("PUT", `trailers/${trailer_id}`, fields))
  );

  server.tool(
    "delete_trailer",
    "Delete a trailer from LoadConnex. Permanent.",
    { trailer_id: z.string().describe("LoadConnex trailer ID") },
    async ({ trailer_id }) => {
      const res = await fetch(`${LX_BASE}/trailers/${trailer_id}`, { method: "DELETE", headers: lxHeaders() });
      if (!res.ok) { const t = await res.text(); throw new Error(`LoadConnex ${res.status}: ${t}`); }
      return ok(await res.json());
    }
  );

  return server;
}

// ── Vercel serverless entry point ──────────────────────────
export default async function handler(req, res) {
  if (!process.env.LOADCONNEX_VENDOR_KEY || !process.env.LOADCONNEX_MEMBER_KEY) {
    return res.status(500).json({ error: "LOADCONNEX_VENDOR_KEY and LOADCONNEX_MEMBER_KEY env vars required" });
  }
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
