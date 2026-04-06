const https = require("https");

exports.handler = async function(event, context) {
  // Extend timeout
  context.callbackWaitsForEmptyEventLoop = false;

  const headers = {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "{}" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "No API key configured" }) };
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON: " + e.message }) };
  }

  // Use haiku instead of sonnet - faster, cheaper, less likely to timeout
  if (parsedBody.model && parsedBody.model.includes("sonnet")) {
    parsedBody.model = "claude-haiku-4-5-20251001";
  }

  const postData = JSON.stringify(parsedBody);

  return new Promise((resolve) => {
    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      timeout: 25000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (!data || data.trim() === "") {
          resolve({ 
            statusCode: 502, 
            headers, 
            body: JSON.stringify({ error: "Empty response", httpStatus: res.statusCode }) 
          });
          return;
        }
        try {
          JSON.parse(data); // validate it's JSON
          resolve({ statusCode: res.statusCode, headers, body: data });
        } catch(e) {
          resolve({ 
            statusCode: 502, 
            headers, 
            body: JSON.stringify({ error: "Non-JSON from Anthropic", preview: data.slice(0, 200) }) 
          });
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ statusCode: 504, headers, body: JSON.stringify({ error: "Request timed out after 25s" }) });
    });

    req.on("error", (err) => {
      resolve({ statusCode: 500, headers, body: JSON.stringify({ error: err.message }) });
    });

    req.write(postData);
    req.end();
  });
};
