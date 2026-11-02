# 1. Build smart contract binary
anchor build

# 2. Synchronize Program ID keys
solana address -k target/deploy/warsaw_arbiter-keypair.json
anchor keys sync

# 3. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster Devnet

# 4. Compile Client & Launch Daemon
npm install
npm run build
docker-compose up -d --build

# 5. Verify Daemon Health
curl http://localhost:8080/health