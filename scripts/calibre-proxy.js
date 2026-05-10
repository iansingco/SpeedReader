/**
 * Tiny CORS proxy for Calibre Content Server.
 * Run alongside the Expo dev server when using the web app:
 *   npm run proxy
 *
 * Listens on localhost:8083, injects CORS headers, forwards to Calibre,
 * and follows redirects internally so the browser never sees a
 * cross-origin redirect (which would bypass the proxy and trigger CORS again).
 *
 * Override defaults via env vars:
 *   CALIBRE_HOST=192.168.1.10 CALIBRE_PORT=8082 node scripts/calibre-proxy.js
 */

const http = require("http");
const { URL } = require("url");

const PROXY_PORT   = Number(process.env.PROXY_PORT)   || 8083;
const CALIBRE_HOST = process.env.CALIBRE_HOST         || "localhost";
const CALIBRE_PORT = Number(process.env.CALIBRE_PORT) || 8082;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
};

function proxyRequest(path, clientReq, clientRes, depth = 0) {
  if (depth > 5) {
    clientRes.writeHead(508, CORS_HEADERS);
    clientRes.end("Too many redirects");
    return;
  }

  const options = {
    hostname: CALIBRE_HOST,
    port:     CALIBRE_PORT,
    path,
    method:   clientReq.method,
    headers:  { ...clientReq.headers, host: `${CALIBRE_HOST}:${CALIBRE_PORT}` },
  };

  const upstream = http.request(options, (res) => {
    // Follow redirects internally so they stay within the proxy origin
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      try {
        const loc     = res.headers.location;
        const target  = loc.startsWith("http")
          ? new URL(loc).pathname + (new URL(loc).search || "")
          : loc;
        res.resume(); // discard redirect body
        proxyRequest(target, clientReq, clientRes, depth + 1);
      } catch {
        clientRes.writeHead(502, CORS_HEADERS);
        clientRes.end("Bad redirect from Calibre");
      }
      return;
    }

    clientRes.writeHead(res.statusCode, { ...res.headers, ...CORS_HEADERS });
    res.pipe(clientRes);
  });

  upstream.on("error", (err) => {
    clientRes.writeHead(502, { "Content-Type": "text/plain", ...CORS_HEADERS });
    clientRes.end(`Proxy error: ${err.message}\nIs Calibre running on ${CALIBRE_HOST}:${CALIBRE_PORT}?`);
  });

  clientReq.pipe(upstream);
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  proxyRequest(req.url, req, res);
}).listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`\n⚡ Calibre CORS proxy`);
  console.log(`   Listening : http://localhost:${PROXY_PORT}`);
  console.log(`   Forwarding: http://${CALIBRE_HOST}:${CALIBRE_PORT}`);
  console.log(`   Redirects : followed internally\n`);
});
