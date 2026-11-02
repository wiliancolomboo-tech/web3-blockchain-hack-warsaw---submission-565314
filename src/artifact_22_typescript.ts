import http from "http";

const HEALTH_PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/ready") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now(), uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(HEALTH_PORT, () => {
  console.log(`[Healthcheck] Listening on port ${HEALTH_PORT}`);
});