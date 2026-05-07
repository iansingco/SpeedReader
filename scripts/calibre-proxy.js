/**
 * Tiny CORS proxy for Calibre Content Server.
 * Run alongside the Expo dev server when using the web app:
 *   node scripts/calibre-proxy.js
 *
 * Listens on localhost:8083 and forwards to the Calibre server,
 * injecting Access-Control-Allow-* headers so the browser accepts responses.
 *
 * Target port/host can be overridden:
 *   CALIBRE_HOST=192.168.1.10 CALIBRE_PORT=8082 node scripts/calibre-proxy.js
 */

const http = require("http");

const PROXY_PORT    = Number(process.env.PROXY_PORT)    || 8083;
const CALIBRE_HOST  = process.env.CALIBRE_HOST          || "localhost";
const CALIBRE_PORT  = Number(process.env.CALIBRE_PORT)  || 8082;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
};

http.createServer((req, res) => {
  // Pre-flight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const options = {
    hostname: CALIBRE_HOST,
    port:     CALIBRE_PORT,
    path:     req.url,
    method:   req.method,
    headers:  { ...req.headers, host: `${CALIBRE_HOST}:${CALIBRE_PORT}` },
  };

  const proxy = http.request(options, (upstream) => {
    res.writeHead(upstream.statusCode, {
      ...upstream.headers,
      ...CORS_HEADERS,
    });
    upstream.pipe(res);
  });

  proxy.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "text/plain", ...CORS_HEADERS });
    res.end(`Proxy error: ${err.message}\nIs Calibre running on ${CALIBRE_HOST}:${CALIBRE_PORT}?`);
  });

  req.pipe(proxy);

}).listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`\n⚡ Calibre CORS proxy`);
  console.log(`   Listening : http://localhost:${PROXY_PORT}`);
  console.log(`   Forwarding: http://${CALIBRE_HOST}:${CALIBRE_PORT}\n`);
});
