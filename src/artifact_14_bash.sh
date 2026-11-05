# Clone the repository
git clone https://github.com/aegispay/aegispay-solana.git
cd aegispay-solana

# Copy template env
cat <<EOF > .env
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_WS_RPC_URL=wss://api.devnet.solana.com
AEGIS_PROGRAM_ID=Aegis11111111111111111111111111111111111111
RESEND_API_KEY=re_test_000000000000000000000000
SLACK_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
DISCORD_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
NOTIFICATION_EMAIL=treasury@company.com
EOF