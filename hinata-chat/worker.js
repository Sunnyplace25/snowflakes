const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

function jsonResponse(data, status) {
  if (status === undefined) { status = 200; }
  var headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
  return new Response(JSON.stringify(data), { status: status, headers: headers });
}

async function verifyStripe(bodyText, sigHeader, secret) {
  var parts = sigHeader.split(",");
  var timestamp = "";
  var v1sig = "";
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].indexOf("t=") === 0) { timestamp = parts[i].slice(2); }
    if (parts[i].indexOf("v1=") === 0) { v1sig = parts[i].slice(3); }
  }
  var payload = timestamp + "." + bodyText;
  var enc = new TextEncoder();
  var key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  var sigBytes = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  var hexArr = Array.from(new Uint8Array(sigBytes));
  var hex = hexArr.map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
  return hex === v1sig;
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/api/check-sub") {
      var subEmail = "";
      if (request.method === "POST") {
        var subBody;
        try { subBody = await request.json(); } catch (e) { return jsonResponse({ active: false }, 400); }
        subEmail = subBody.email || "";
      } else {
        subEmail = url.searchParams.get("email") || "";
      }
      if (!subEmail) { return jsonResponse({ active: false }, 403); }
      try {
        var row = await env.DB.prepare(
          "SELECT email FROM subscribers WHERE email = ? AND status = ?"
        ).bind(subEmail.toLowerCase(), "active").first();
        return jsonResponse({ active: row ? true : false });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (path === "/api/chat" && request.method === "POST") {
      var body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: "Invalid JSON" }, 400); }
      var messages = body.messages;
      var system = body.system;
      var max_tokens = body.max_tokens || 300;
      var chatEmail = body.email;
      if (!chatEmail) { return jsonResponse({ error: "Subscription required" }, 403); }
      try {
        var subRow = await env.DB.prepare(
          "SELECT email FROM subscribers WHERE email = ? AND status = ?"
        ).bind(chatEmail.toLowerCase(), "active").first();
        if (!subRow) { return jsonResponse({ error: "Subscription required" }, 403); }
      } catch (e2) {
        return jsonResponse({ error: e2.message }, 500);
      }
      try {
        var apiRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: max_tokens,
            system: system,
            messages: messages
          })
        });
        var apiData = await apiRes.json();
        return jsonResponse(apiData);
      } catch (e3) {
        return jsonResponse({ error: "API error" }, 500);
      }
    }

    if (path === "/api/stripe-webhook" && request.method === "POST") {
      var rawBody = await request.text();
      var stripesig = request.headers.get("stripe-signature");
      try {
        var valid = await verifyStripe(rawBody, stripesig, env.STRIPE_WEBHOOK_SECRET);
        if (!valid) { return jsonResponse({ error: "Invalid signature" }, 400); }
      } catch (e4) {
        return jsonResponse({ error: "Signature error" }, 400);
      }
      var event = JSON.parse(rawBody);
      var getEmail = async function(customerId) {
        var r = await fetch("https://api.stripe.com/v1/customers/" + customerId, {
          headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY }
        });
        var c = await r.json();
        return c.email ? c.email.toLowerCase() : null;
      };
      try {
        if (event.type === "customer.subscription.created" || event.type === "invoice.payment_succeeded") {
          var addEmail = await getEmail(event.data.object.customer);
          if (addEmail) {
            await env.DB.prepare(
              "INSERT INTO subscribers (email, status) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET status = ?"
            ).bind(addEmail, "active", "active").run();
          }
        } else if (event.type === "customer.subscription.deleted") {
          var delEmail = await getEmail(event.data.object.customer);
          if (delEmail) {
            await env.DB.prepare(
              "UPDATE subscribers SET status = ? WHERE email = ?"
            ).bind("cancelled", delEmail).run();
          }
        }
      } catch (e5) {
        console.error("DB error:", e5);
      }
      return jsonResponse({ received: true });
    }

    if (path === "/api/add-sub" && request.method === "POST") {
      var authHeader = request.headers.get("Authorization");
      if (authHeader !== "Bearer " + env.ADMIN_SECRET) { return jsonResponse({ error: "Unauthorized" }, 401); }
      var addBody;
      try { addBody = await request.json(); } catch (e6) { return jsonResponse({ error: "Invalid JSON" }, 400); }
      var newEmail = (addBody.email || "").toLowerCase();
      if (!newEmail) { return jsonResponse({ error: "email required" }, 400); }
      await env.DB.prepare(
        "INSERT INTO subscribers (email, status) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET status = ?"
      ).bind(newEmail, "active", "active").run();
      return jsonResponse({ ok: true, email: newEmail });
    }

    if (path === "/api/remove-sub" && request.method === "POST") {
      var authHeader2 = request.headers.get("Authorization");
      if (authHeader2 !== "Bearer " + env.ADMIN_SECRET) { return jsonResponse({ error: "Unauthorized" }, 401); }
      var remBody;
      try { remBody = await request.json(); } catch (e7) { return jsonResponse({ error: "Invalid JSON" }, 400); }
      var remEmail = (remBody.email || "").toLowerCase();
      if (!remEmail) { return jsonResponse({ error: "email required" }, 400); }
      await env.DB.prepare(
        "UPDATE subscribers SET status = ? WHERE email = ?"
      ).bind("cancelled", remEmail).run();
      return jsonResponse({ ok: true, email: remEmail });
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};
