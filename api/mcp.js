import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const LX_BASE = "https://lx-api.loadconnex.com/v1";

function lxHeaders() {
  return {
    "X-API-key-vendor": process.env.LOADCONNEX_VENDOR_KEY,
    "X-API-key-member": process.env.LOADCONNEX_MEMBER_KEY,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
}

async function lxFetch(path, params = {}) {
  const url = new URL(`${LX_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { headers: lxHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LoadConnex ${res.status}: ${text}`);
  }
  return res.json();
}

function createServer() {
  const server = new McpServer({
    name: "cargoloop-loadconnex",
    version: "1.1.0",
  });

  server.tool(
    "get_loads",
    `Fetch load summaries from LoadConnex with full filtering, sorting, and pagination.
Default per_page is 25 — always set this explicitly to avoid large data dumps.
Dates use RFC 3339 format: YYYY-MM-DDTHH:mmZ (e.g. 2026-03-27T00:00Z).
filter_status filters by tracking status (e.g. 'Late', 'GPS Signal Lost').
filter_life_cycle is required — use 'In Transit' for active loads.`,
    {
      filter_life_cycle: z
        .enum(["In Transit", "Delivered", "Pending", "Cancelled", "Completed"])
        .describe("Required. Lifecycle stage to filter by."),
      filter_customer_name: z
        .string()
        .describe("Partial customer name (e.g. 'Mastronardi', 'Sunset')")
        .optional(),
      filter_load_number: z
        .string()
        .describe("Partial WPL member load number (not LX load number)")
        .optional(),
      filter_carrier_driver_tractor: z
        .string()
        .describe("Partial carrier company name, driver full name, or tractor unit number")
        .optional(),
      filter_status: z
        .enum([
          "Ready", "On Time", "Predicted Late", "Late",
          "Verifying Arrival", "At Stop", "Final Stop",
          "Delivered", "GPS Signal Lost",
        ])
        .describe("Filter by current tracking status")
        .optional(),
      filter_pickup_date_time_local_from: z
        .string()
        .describe("Pickup date range start, RFC 3339: YYYY-MM-DDTHH:mmZ")
        .optional(),
      filter_pickup_date_time_local_to: z
        .string()
        .describe("Pickup date range end, RFC 3339: YYYY-MM-DDTHH:mmZ")
        .optional(),
      filter_delivery_date_time_local_from: z
        .string()
        .describe("Delivery date range start, RFC 3339: YYYY-MM-DDTHH:mmZ")
        .optional(),
      filter_delivery_date_time_local_to: z
        .string()
        .describe("Delivery date range end, RFC 3339: YYYY-MM-DDTHH:mmZ")
        .optional(),
      filter_pickup_city_state: z
        .string()
        .describe("Pickup city and state (e.g. 'Oxnard, CA')")
        .optional(),
      filter_delivery_city_state: z
        .string()
        .describe("Delivery city and state (e.g. 'Philadelphia, PA')")
        .optional(),
      sort: z
        .string()
        .describe(
          "Comma-separated sort keys with optional :asc/:desc. Allowed: member_load_number, " +
          "customer_name, pickup_date_time_local, pickup_city_state, delivery_date_time_local, " +
          "delivery_city_state, load_tracking_status, carrier_name, driver_name, tractor_unit_number. " +
          "Example: 'pickup_date_time_local:desc'. Max 3 keys."
        )
        .optional(),
      per_page: z
        .number().int().min(1).max(100).default(25)
        .describe("Results per page (1-100). Default 25. Use lower values for quick lookups."),
      page_no: z
        .number().int().min(1).default(1)
        .describe("Page number. Default 1."),
    },
    async ({
      filter_life_cycle, filter_customer_name, filter_load_number,
      filter_carrier_driver_tractor, filter_status,
      filter_pickup_date_time_local_from, filter_pickup_date_time_local_to,
      filter_delivery_date_time_local_from, filter_delivery_date_time_local_to,
      filter_pickup_city_state, filter_delivery_city_state,
      sort, per_page, page_no,
    }) => {
      const data = await lxFetch("loads", {
        filter_life_cycle,
        filter_customer_name,
        filter_load_number,
        filter_carrier_driver_tractor,
        filter_status,
        filter_pickup_date_time_local_from,
        filter_pickup_date_time_local_to,
        filter_delivery_date_time_local_from,
        filter_delivery_date_time_local_to,
        filter_pickup_city_state,
        filter_delivery_city_state,
        sort,
        per_page: per_page ?? 25,
        page_no: page_no ?? 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_load",
    "Fetch full details for a single load by its internal LoadConnex ID. Returns all stops, carrier info, tracking status, and document links.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID — the numeric 'id' field from get_loads, NOT the lx_load_number"),
    },
    async ({ load_id }) => {
      const data = await lxFetch(`loads/${load_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_position",
    "Get the latest GPS position for a load. Returns latitude, longitude, and timestamp. Returns empty strings if GPS signal is lost.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
    },
    async ({ load_id }) => {
      const data = await lxFetch(`loads/${load_id}/position`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_documents",
    "List documents attached to a load (BOL, rate confirmation, delivery receipts, etc.).",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
    },
    async ({ load_id }) => {
      const data = await lxFetch(`loads/${load_id}/documents`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_load_status",
    "Update the tracking status or notes on a load in LoadConnex.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      tracking_status: z
        .enum([
          "Ready", "On Time", "Predicted Late", "Late",
          "Verifying Arrival", "At Stop", "Final Stop",
          "Delivered", "GPS Signal Lost",
        ])
        .describe("New tracking status")
        .optional(),
      notes: z.string().describe("Internal notes to add to the load").optional(),
    },
    async ({ load_id, tracking_status, notes }) => {
      const body = {};
      if (tracking_status) body.tracking_status = tracking_status;
      if (notes) body.notes = notes;
      const res = await fetch(`${LX_BASE}/loads/${load_id}`, {
        method: "PATCH",
        headers: lxHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

export default async function handler(req, res) {
  if (!process.env.LOADCONNEX_VENDOR_KEY || !process.env.LOADCONNEX_MEMBER_KEY) {
    return res.status(500).json({
      error: "LOADCONNEX_VENDOR_KEY and LOADCONNEX_MEMBER_KEY env vars required",
    });
  }
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
