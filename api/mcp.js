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
    version: "1.0.0",
  });

  // ── Tool: get_loads ────────────────────────────────────────────────────────
  server.tool(
    "get_loads",
    "Fetch loads from LoadConnex. Use filter_life_cycle to narrow results (e.g. 'In Transit', 'Delivered'). Returns load summaries including status, stops, carrier, and tracking info.",
    {
      filter_life_cycle: z
        .enum(["In Transit", "Delivered", "Pending", "Cancelled", "Completed"])
        .describe("Lifecycle stage to filter by")
        .optional(),
      filter_customer_name: z
        .string()
        .describe("Partial customer name to filter by (e.g. 'Mastronardi')")
        .optional(),
      filter_load_number: z
        .string()
        .describe("Partial WPL load number to filter by")
        .optional(),
    },
    async ({ filter_life_cycle, filter_customer_name, filter_load_number }) => {
      const data = await lxFetch("loads", {
        filter_life_cycle,
        filter_customer_name,
        filter_load_number,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── Tool: get_load ─────────────────────────────────────────────────────────
  server.tool(
    "get_load",
    "Fetch full details for a single load by its internal LoadConnex ID. Returns all stops, carrier info, tracking status, and document links.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID (numeric string)"),
    },
    async ({ load_id }) => {
      const data = await lxFetch(`loads/${load_id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── Tool: get_position ────────────────────────────────────────────────────
  server.tool(
    "get_position",
    "Get the latest GPS position for a load. Returns latitude, longitude, and timestamp. Note: may return empty strings if GPS signal is lost — use telematics as fallback in that case.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID (numeric string)"),
    },
    async ({ load_id }) => {
      const data = await lxFetch(`loads/${load_id}/position`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── Tool: get_documents ───────────────────────────────────────────────────
  server.tool(
    "get_documents",
    "List documents attached to a load (BOL, rate confirmation, delivery receipts, etc.).",
    {
      load_id: z.string().describe("Internal LoadConnex load ID (numeric string)"),
    },
    async ({ load_id }) => {
      const data = await lxFetch(`loads/${load_id}/documents`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // ── Tool: update_load_status ──────────────────────────────────────────────
  server.tool(
    "update_load_status",
    "Update the tracking status or notes on a load in LoadConnex.",
    {
      load_id: z.string().describe("Internal LoadConnex load ID"),
      tracking_status: z
        .enum(["Ready", "On Time", "Predicted Late", "Late", "Verifying Arrival", "At Stop", "Final Stop", "Delivered", "GPS Signal Lost"])
        .describe("New tracking status")
        .optional(),
      notes: z.string().describe("Internal notes to add to the load").optional(),
    },
    async ({ load_id, tracking_status, notes }) => {
      const url = new URL(`${LX_BASE}/loads/${load_id}`);
      const body = {};
      if (tracking_status) body.tracking_status = tracking_status;
      if (notes) body.notes = notes;
      const res = await fetch(url.toString(), {
        method: "PATCH",
        headers: lxHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  return server;
}

// Vercel serverless entry point
export default async function handler(req, res) {
  if (!process.env.LOADCONNEX_VENDOR_KEY || !process.env.LOADCONNEX_MEMBER_KEY) {
    return res.status(500).json({ error: "LOADCONNEX_VENDOR_KEY and LOADCONNEX_MEMBER_KEY env vars required" });
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — new session per request
  });

  res.on("close", () => transport.close());

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
