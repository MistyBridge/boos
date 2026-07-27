// packyapi 代理 — Linux OpenViking 通过此代理调用 LLM
// node "D:\AI IDE\CC_BOOS\proxy-packyapi.js"
const http = require("http");
const https = require("https");

const TARGET = "https://www.packyapi.com";
const PORT = 8899;
const TIMEOUT = 120_000; // 120s for LLM responses

const agent = new https.Agent({ keepAlive: true });

const server = http.createServer((req, res) => {
  const opts = {
    method: req.method,
    headers: { ...req.headers, host: "www.packyapi.com" },
    timeout: TIMEOUT,
    agent,
  };

  const proxy = https.request(TARGET + req.url, opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxy.on("timeout", () => {
    proxy.destroy();
    res.writeHead(504);
    res.end("upstream timeout");
  });

  proxy.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502);
    res.end("proxy: " + e.message);
  });

  res.on("close", () => proxy.destroy());
  req.pipe(proxy);
});

server.timeout = TIMEOUT;
server.listen(PORT, "0.0.0.0", () => console.log("[proxy] 0.0.0.0:" + PORT + " -> " + TARGET));
