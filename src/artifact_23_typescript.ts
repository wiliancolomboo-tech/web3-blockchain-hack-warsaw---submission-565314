import * as http from 'http';

const healthPort = process.env.HEALTH_PORT || 8080;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'HEALTHY', protocol: 'StreamGuard', uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(healthPort, () => console.log(`Health check listening on :${healthPort}`));