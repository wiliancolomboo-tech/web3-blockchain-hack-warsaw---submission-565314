import * as http from "http";

const HEALTH_PORT = process.env.PORT || 8080;
http.createServer(async (req, res) => {
  if (req.url === "/health") {
    try {
      const isRpcAlive = await connection.getVersion();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", solanaVersion: isRpcAlive["solana-core"] }));
    } catch {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "unhealthy", reason: "RPC connection degraded" }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(HEALTH_PORT, () => {
  console.log(`[HEALTHCHECK] Telemetry listening on :${HEALTH_PORT}/health`);
});