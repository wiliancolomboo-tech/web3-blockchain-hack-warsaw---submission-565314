# Configure Environment
cp .env.example .env
# Edit RESEND_API_KEY and DISCORD_WEBHOOK_URL in .env

# Launch Turnkey Docker Service
docker compose up -d --build

# Inspect Daemon Execution Logs
docker compose logs -f vistula-daemon