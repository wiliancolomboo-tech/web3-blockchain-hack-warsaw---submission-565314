import * as http from "http";

const HEALTH_PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "HEALTHY", uptime: process.uptime(), timestamp: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(HEALTH_PORT, () => {
  console.log(`[HEALTH] Healthcheck server live on :${HEALTH_PORT}/health`);
});