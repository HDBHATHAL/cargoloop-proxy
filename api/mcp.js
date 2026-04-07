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
const CACHE_TTL = {
  position: 15_000,    // 15s — GPS updates frequently
  loads:    60_000,    // 60s — load list
  load:     60_000,    // 60s — single load detail
  fleet:   300_000,    // 5min — drivers/tractors/trailers change rarely
  docs:     30_000,    // 30s — document list
};

function cacheGet(key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > 300_000) cache.delete(k);
    }
  }
}

// Invalidate all cached entries for a load and its sub-resources after a write
// Note: my_carriers are read-only from this proxy — no write invalidation needed
function cacheInvalidateLoad(load_id) {
  for (const k of cache.keys()) {
    if (k.includes(`/loads/${load_id}`) || k.includes("loads?") || k.endsWith("/loads")) {
      cache.delete(k);
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

function ttlForPath(path) {
  if (path.includes("/position")) return CACHE_TTL.position;
  if (path.includes("/documents")) return CACHE_TTL.docs;
  if (path.match(/^loads\/\d+$/)) return CACHE_TTL.load;
  if (path.startsWith("loads")) return CACHE_TTL.loads;
  if (path.startsWith("drivers") || path.startsWith("tractors") || path.startsWith("trailers") || path.startsWith("my_carriers")) return CACHE_TTL.fleet;
  return CACHE_TTL.loads;
}

async function lxFetch(path, params = {}) {
  const url = new URL(`${LX_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  // Never cache document content (base64 PDFs are huge and single-use)
  const noCache = path.match(/\/documents\/\d+$/);
  const cacheKey = url.toString();
  if (!noCache) {
    const cached = cacheGet(cacheKey, ttlForPath(path));
    if (cached) return cached;
  }
  const data = await lxRequest(() => fetch(url.toString(), { headers: lxHeaders() }));
  if (!noCache) cacheSet(cacheKey, data);
  return data;
}

async function lxWrite(method, path, body, contentType = "application/json") {
  const result = await lxRequest(() => fetch(`${LX_BASE}/${path}`, {
    method,
    headers: lxHeaders(contentType),
    body: contentType === "application/json" ? JSON.stringify(body) : body,
  }));
  // Invalidate cache for the affected load after any write
  const m = path.match(/loads\/(\d+)/);
  if (m) cacheInvalidateLoad(m[1]);
  // Also bust the loads list cache on create/delete
  if (path === "loads" && method === "POST") {
    for (const k of cache.keys()) { if (k.includes("/loads")) cache.delete(k); }
  }
  return result;
}

// Wrap raw DELETE calls through the rate limiter
async function lxDelete(path) {
  const result = await lxRequest(() => fetch(`${LX_BASE}/${path}`, { method: "DELETE", headers: lxHeaders() }));
  const m = path.match(/loads\/(\d+)/);
  if (m) cacheInvalidateLoad(m[1]);
  return result;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

// ── Inject readOnly-but-required defaults for LoadConnex ────
// The swagger marks stop_tracking_status and load_tracking_status as both
// "required" and "readOnly". The API sometimes rejects POSTs/PUTs without them.
function prepareStops(stops) {
  return stops.map(s => ({
    stop_tracking_status: "Pending",
    ...s,
  }));
}

function createServer() {
  const server = new McpServer({ name: "cargoloop-loadconnex", version: "2.7.0" });

  // ═══════════════════════════════════════════════════════════
  // SEGMENT 1 — LOADS (read + write)
  // ═══════════════════════════════════════════════════════════

  server.tool(
    "get_loads",
    "Fetch WPL load summaries. filter_life_cycle required. Dates: YYYY-MM-DDTHH:mmZ. Returns up to 100 per page.",
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
      per_page: z.number().int().min(1).max(100).default(100).describe("Results per page (1-100). Default 100."),
      page_no: z.number().int().min(1).default(1).describe("Page number. Default 1."),
    },
    async ({ filter_life_cycle, filter_customer_name, filter_load_number, filter_carrier_driver_tractor, filter_status, filter_pickup_date_time_local_from, filter_pickup_date_time_local_to, filter_delivery_date_time_local_from, filter_delivery_date_time_local_to, filter_pickup_city_state, filter_delivery_city_state, sort, per_page, page_no }) => {
      const data = await lxFetch("loads", { filter_life_cycle, filter_customer_name, filter_load_number, filter_carrier_driver_tractor, filter_status, filter_pickup_date_time_local_from, filter_pickup_date_time_local_to, filter_delivery_date_time_local_from, filter_delivery_date_time_local_to, filter_pickup_city_state, filter_delivery_city_state, sort, per_page: per_page ?? 100, page_no: page_no ?? 1 });
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
    "Create a load (POST /loads). First stop must be Pickup, last must be Delivery. Each stop's appointment_end must be after the previous. post_to_marketplace: no|private_carriers_only|private_with_brokers|public_no_brokers|all.",
    {
      member_load_number: z.string().describe("Your internal WPL load/job number (must be unique)").optional(),
      trailer_type: z.enum(["Dry Van","Refrigerated","Flatbed","Step Deck","Lowboy","Double Drop","Conestoga","Curtainside","Tanker","Pneumatic","Hopper","Dump","Other"]).describe("Type of trailer required"),
      weight: z.number().int().min(0).max(99999).describe("Shipment weight in lbs"),
      commodity: z.string().describe("Commodity description (e.g. 'Produce', 'Mushrooms')"),
      max_cargo_value: z.number().int().describe("Max cargo value in cents USD (e.g. 1000000 = $10,000). Required by LoadConnex."),
      post_to_marketplace: z.enum(["no","private_carriers_only","private_with_brokers","public_no_brokers","all"]).describe("Who to post the load to on the marketplace"),
      customer_code: z.string().describe("Customer code to link the load to a customer").optional(),
      customer_reference_number: z.string().describe("Customer's reference number for this load").optional(),
      additional_instructions: z.string().describe("Special instructions for the driver").optional(),
      billing_info: z.array(z.object({
        line_item: z.string().describe("Line item name (e.g. 'LINE HAUL', 'FUEL SURCHARGE', 'ACCESSORIALS')"),
        receivable: z.object({
          amount: z.number().int().describe("Amount in cents USD"),
          currency: z.enum(["USD"]).default("USD"),
        }).describe("Amount to invoice customer").optional(),
        payable: z.object({
          amount: z.number().int().describe("Amount in cents USD"),
          currency: z.enum(["USD"]).default("USD"),
        }).describe("Amount to pay carrier/broker").optional(),
      })).describe("Array of billing line items with receivable and/or payable amounts in cents USD").optional(),
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
    async ({ member_load_number, trailer_type, weight, commodity, max_cargo_value, post_to_marketplace, customer_code, customer_reference_number, additional_instructions, billing_info, stops }) => {
      const body = {
        trailer_type,
        weight,
        commodity,
        max_cargo_value: { amount: max_cargo_value, currency: "USD" },
        post_to_marketplace,
        load_tracking_status: "Pending",
        stops: prepareStops(stops),
      };
      if (member_load_number) body.member_load_number = member_load_number;
      if (customer_code) body.customer_code = customer_code;
      if (customer_reference_number) body.customer_reference_number = customer_reference_number;
      if (additional_instructions) body.additional_instructions = additional_instructions;
      if (billing_info) body.billing_info = billing_info;
      return ok(await lxWrite("POST", "loads", body));
    }
  );

  server.tool(
    "update_load",
    "Full replace of a load (PUT). ALL fields required — omitted fields are deleted. Use get_load first. Cannot update Transfer-stop loads or Load Connex-assigned loads.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      member_load_number: z.string().optional(),
      trailer_type: z.enum(["Dry Van","Refrigerated","Flatbed","Step Deck","Lowboy","Double Drop","Conestoga","Curtainside","Tanker","Pneumatic","Hopper","Dump","Other"]),
      weight: z.number().int().min(0).max(99999),
      commodity: z.string(),
      max_cargo_value: z.number().int().describe("Max cargo value in cents USD (e.g. 1000000 = $10,000). Required — omitting deletes the value."),
      customer_code: z.string().optional(),
      customer_reference_number: z.string().optional(),
      additional_instructions: z.string().optional(),
      billing_info: z.array(z.object({
        line_item: z.string().describe("Line item name (e.g. 'LINE HAUL', 'FUEL SURCHARGE', 'ACCESSORIALS')"),
        receivable: z.object({
          amount: z.number().int().describe("Amount in cents USD"),
          currency: z.enum(["USD"]).default("USD"),
        }).describe("Amount to invoice customer").optional(),
        payable: z.object({
          amount: z.number().int().describe("Amount in cents USD"),
          currency: z.enum(["USD"]).default("USD"),
        }).describe("Amount to pay carrier/broker").optional(),
      })).describe("Array of billing line items. Omitting deletes all billing.").optional(),
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
    async ({ load_id, stops, max_cargo_value, billing_info, ...fields }) => {
      const body = {
        ...fields,
        max_cargo_value: { amount: max_cargo_value, currency: "USD" },
        load_tracking_status: "Pending",
        stops: prepareStops(stops),
      };
      if (billing_info) body.billing_info = billing_info;
      return ok(await lxWrite("PUT", `loads/${load_id}`, body));
    }
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
    async ({ load_id }) => ok(await lxDelete(`loads/${load_id}`))
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
    "Get a document's base64 PDF content by document_id.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      document_id: z.string().describe("Document ID from get_documents"),
    },
    async ({ load_id, document_id }) => ok(await lxFetch(`loads/${load_id}/documents/${document_id}`))
  );

  server.tool(
    "upload_document",
    "Upload a PDF to a load. Fails if that type already exists — use replace_document instead. Max 15 MB.",
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
    "Replace a document's PDF content. Filename and type unchanged.",
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
    "Append base64 PDF pages to an existing document.",
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
    async ({ load_id, document_id }) => ok(await lxDelete(`loads/${load_id}/documents/${document_id}`))
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
    "List WPL drivers. Synced from ELD.",
    {
      filter_full_name: z.string().describe("Partial driver name").optional(),
      filter_available: z.boolean().describe("Filter by availability. Omit to get all drivers.").optional(),
      per_page: z.number().int().min(1).max(100).default(100).optional(),
      page_no: z.number().int().min(1).default(1).optional(),
      sort: z.string().describe("Sort keys: full_name, available, mobile_app_status. E.g. 'full_name:asc'").optional(),
    },
    async ({ filter_full_name, filter_available, per_page, page_no, sort }) =>
      ok(await lxFetch("drivers", { filter_full_name, filter_available, per_page: per_page ?? 100, page_no: page_no ?? 1, sort }))
  );

  server.tool(
    "get_driver",
    "Get full details for a single driver by their LoadConnex ID.",
    { driver_id: z.string().describe("LoadConnex driver ID") },
    async ({ driver_id }) => ok(await lxFetch(`drivers/${driver_id}`))
  );

  server.tool(
    "create_driver",
    "Create a driver. Name/email/phone/licence must be unique. Phone: (ddd) ddd-dddd. Dates: YYYY-MM-DD.",
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
    "Full replace of a driver (PUT). ALL fields required. Use get_driver first.",
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
    async ({ driver_id }) => ok(await lxDelete(`drivers/${driver_id}`))
  );

  // ── Tractors ──────────────────────────────────────────────

  server.tool(
    "list_tractors",
    "List WPL tractors. Synced from ELD.",
    {
      filter_unit_number: z.string().describe("Partial tractor unit number").optional(),
      filter_available: z.boolean().optional(),
      per_page: z.number().int().min(1).max(100).default(100).optional(),
      page_no: z.number().int().min(1).default(1).optional(),
      sort: z.string().describe("Sort keys: unit_number, vin, available").optional(),
    },
    async ({ filter_unit_number, filter_available, per_page, page_no, sort }) =>
      ok(await lxFetch("tractors", { filter_unit_number, filter_available, per_page: per_page ?? 100, page_no: page_no ?? 1, sort }))
  );

  server.tool(
    "get_tractor",
    "Get full details for a single tractor by its LoadConnex ID.",
    { tractor_id: z.string().describe("LoadConnex tractor ID") },
    async ({ tractor_id }) => ok(await lxFetch(`tractors/${tractor_id}`))
  );

  server.tool(
    "update_tractor",
    "Full replace of a tractor (PUT). ALL fields required. Use get_tractor first.",
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
      per_page: z.number().int().min(1).max(100).default(100).optional(),
      page_no: z.number().int().min(1).default(1).optional(),
      sort: z.string().describe("Sort keys: unit_number, trailer_type, available").optional(),
    },
    async ({ filter_unit_number, filter_trailer_type, filter_available, per_page, page_no, sort }) =>
      ok(await lxFetch("trailers", { filter_unit_number, filter_trailer_type, filter_available, per_page: per_page ?? 100, page_no: page_no ?? 1, sort }))
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
    "Full replace of a trailer (PUT). ALL fields required. Use get_trailer first.",
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
    async ({ trailer_id }) => ok(await lxDelete(`trailers/${trailer_id}`))
  );


  // ═══════════════════════════════════════════════════════════
  // SEGMENT 4 — MY CARRIERS
  // ═══════════════════════════════════════════════════════════

  server.tool(
    "list_my_carriers",
    "List My Carriers (trusted carriers with a direct member relationship). Sort keys: company_name, city, state.",
    {
      filter_company_name: z.string().describe("Partial carrier company name").optional(),
      sort: z.string().describe("Sort keys: company_name, city, state. E.g. 'company_name:asc'").optional(),
      per_page: z.number().int().min(1).max(100).default(100).optional(),
      page_no: z.number().int().min(1).default(1).optional(),
    },
    async ({ filter_company_name, sort, per_page, page_no }) =>
      ok(await lxFetch("my_carriers", { filter_company_name, sort, per_page: per_page ?? 100, page_no: page_no ?? 1 }))
  );

  server.tool(
    "get_my_carrier",
    "Get full details for a single My Carrier by ID. Returns company name, city, state, phone, and sub-resource URLs for their drivers/tractors/trailers.",
    { my_carrier_id: z.string().describe("My Carrier ID from list_my_carriers") },
    async ({ my_carrier_id }) => ok(await lxFetch(`my_carriers/${my_carrier_id}`))
  );

  server.tool(
    "list_my_carrier_drivers",
    "List drivers belonging to a specific My Carrier. Sort key: full_name.",
    {
      my_carrier_id: z.string().describe("My Carrier ID"),
      filter_full_name: z.string().describe("Partial driver name").optional(),
      sort: z.string().describe("Sort key: full_name. E.g. 'full_name:asc'").optional(),
      per_page: z.number().int().min(1).max(100).default(100).optional(),
      page_no: z.number().int().min(1).default(1).optional(),
    },
    async ({ my_carrier_id, filter_full_name, sort, per_page, page_no }) =>
      ok(await lxFetch(`my_carriers/${my_carrier_id}/drivers`, { filter_full_name, sort, per_page: per_page ?? 100, page_no: page_no ?? 1 }))
  );

  server.tool(
    "list_my_carrier_tractors",
    "List tractors belonging to a specific My Carrier. Sort key: unit_number.",
    {
      my_carrier_id: z.string().describe("My Carrier ID"),
      filter_unit_number: z.string().describe("Partial tractor unit number").optional(),
      sort: z.string().describe("Sort key: unit_number").optional(),
      per_page: z.number().int().min(1).max(100).default(100).optional(),
      page_no: z.number().int().min(1).default(1).optional(),
    },
    async ({ my_carrier_id, filter_unit_number, sort, per_page, page_no }) =>
      ok(await lxFetch(`my_carriers/${my_carrier_id}/tractors`, { filter_unit_number, sort, per_page: per_page ?? 100, page_no: page_no ?? 1 }))
  );

  server.tool(
    "list_my_carrier_trailers",
    "List trailers belonging to a specific My Carrier. Sort key: unit_number.",
    {
      my_carrier_id: z.string().describe("My Carrier ID"),
      filter_unit_number: z.string().describe("Partial trailer unit number").optional(),
      sort: z.string().describe("Sort key: unit_number").optional(),
      per_page: z.number().int().min(1).max(100).default(100).optional(),
      page_no: z.number().int().min(1).default(1).optional(),
    },
    async ({ my_carrier_id, filter_unit_number, sort, per_page, page_no }) =>
      ok(await lxFetch(`my_carriers/${my_carrier_id}/trailers`, { filter_unit_number, sort, per_page: per_page ?? 100, page_no: page_no ?? 1 }))
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
