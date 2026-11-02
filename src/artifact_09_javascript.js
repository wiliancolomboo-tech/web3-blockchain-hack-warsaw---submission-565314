const http = require("http");
const { WarsawTrustIntegrationService } = require("./daemon");
const { Keypair } = require("@solana/web3.js");

const port = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "HEALTHY", uptime: process.uptime() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  console.log(`Healthcheck telemetry server listening on :${port}`);
  
  const ephemeralKeypair = Keypair.generate();
  const service = new WarsawTrustIntegrationService(
    {
      rpcUrl: process.env.RPC_URL,
      wsUrl: process.env.WS_URL,
      programId: process.env.PROGRAM_ID,
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
      resendApiKey: process.env.RESEND_API_KEY,
      notificationEmail: process.env.NOTIFICATION_EMAIL,
    },
    ephemeralKeypair
  );
  service.start().catch(console.error);
});