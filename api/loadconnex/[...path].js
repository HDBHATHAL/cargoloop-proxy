export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-key-vendor, X-API-key-member");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const vendorKey = req.headers["x-api-key-vendor"];
  const memberKey = req.headers["x-api-key-member"];

  if (!vendorKey || !memberKey) {
    return res.status(401).json({ error: "Missing API keys" });
  }

  const pathSegments = req.url.replace(/^\/api\/loadconnex\/?/, "");
  const targetUrl = `https://lx-api.loadconnex.com/v1/${pathSegments}`;

  try {
    const fetchOpts = {
      method: req.method,
      headers: {
        "X-API-key-vendor": vendorKey,
        "X-API-key-member": memberKey,
        Accept: "application/json",
      },
    };

    if (["POST", "PUT", "PATCH"].includes(req.method) && req.body) {
      fetchOpts.headers["Content-Type"] = "application/json";
      fetchOpts.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOpts);
    const data = await response.text();

    res.status(response.status);
    try {
      res.json(JSON.parse(data));
    } catch {
      res.send(data);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
