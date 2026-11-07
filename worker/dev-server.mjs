// Local API for browser checks. Not used in production.
// Listens on http://127.0.0.1:8787 and allows the local Pages preview origin.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { handle } from "./src/index.js";
import { wrap } from "./test/d1.js";
import { SECRET_NAMES } from "./src/billing.js";

const db = new DatabaseSync(new URL("./local.sqlite", import.meta.url).pathname);
db.exec("PRAGMA foreign_keys = ON");
const migrations = new URL("./migrations/", import.meta.url);
for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
  db.exec(readFileSync(new URL(name, migrations), "utf8"));
}

const billingMode = process.env.BILLING_MODE === "sandbox" || process.env.BILLING_MODE === "live" ? process.env.BILLING_MODE : "off";
const env = {
  DB: wrap(db),
  BILLING_MODE: billingMode,
  ALLOWED_ORIGINS: "http://127.0.0.1:5187,http://localhost:5187,https://quasihydra.lalaayenglobalplaza.com,https://www.quasihydra.lalaayenglobalplaza.com",
  PBKDF2_ITERATIONS: process.env.PBKDF2_ITERATIONS || "100000",
};
for (const name of SECRET_NAMES) {
  if (process.env[name]) env[name] = process.env[name];
}

const port = Number(process.env.PORT || 8787);
createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null || key === "host" || key === "content-length") continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const init = { method: req.method, headers };
    if (body.length && req.method !== "GET" && req.method !== "HEAD") init.body = body;
    const response = await handle(new Request(`http://127.0.0.1:${port}${req.url}`, init), env);
    const out = Buffer.from(await response.arrayBuffer());
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    res.writeHead(response.status, responseHeaders);
    res.end(out);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Server error" }));
    console.error(JSON.stringify({ message: "local server failed", error: error instanceof Error ? error.message : String(error) }));
  }
}).listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ message: "quasi local api", url: `http://127.0.0.1:${port}`, billing: billingMode }));
});
