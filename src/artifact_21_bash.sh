# 1. Clone repository and install dependencies
git clone https://github.com/vistula-protocol/vistula-settlement.git
cd vistula-settlement
yarn install

# 2. Build Anchor Smart Contracts
anchor build

# 3. Synchronize Program ID keys
solana address -k target/deploy/vistula_settlement-keypair.json
# Ensure declare_id matches in src/lib.rs and Anchor.toml

# 4. Run full test matrix on local validator
anchor test

# 5. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet