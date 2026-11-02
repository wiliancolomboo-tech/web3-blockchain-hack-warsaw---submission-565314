# 1. Clone repository & install dependencies
git clone https://github.com/enterprise-wsv/warsaw-stream-vault.git
cd warsaw-stream-vault
npm install

# 2. Build Anchor smart contract
anchor build

# 3. Execute comprehensive QA test suite
anchor test

# 4. Deploy program to Solana Devnet
solana program deploy ./target/deploy/stream_vault.so \
  --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/id.json