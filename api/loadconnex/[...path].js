module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const vendorKey = process.env.LOADCONNEX_VENDOR_KEY;
  const memberKey = process.env.LOADCONNEX_MEMBER_KEY;

  if (!vendorKey || !memberKey) {
    return res.status(500).json({ error: "API keys not configured in environment variables" });
  }

  const pathSegments = req.url.replace(/^\/api\/loadconnex\/?/, "");
  const targetUrl = "https://lx-api.loadconnex.com/v1/" + pathSegments;

  try {
    const fetchOpts = {
      method: req.method,
      headers: {
        "X-API-key-vendor": vendorKey,
        "X-API-key-member": memberKey,
        "Accept": "application/json"
      }
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
    } catch (e) {
      res.send(data);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
