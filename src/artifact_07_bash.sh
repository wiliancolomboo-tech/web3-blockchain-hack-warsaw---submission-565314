# 1. Clone repository and navigate to root
git clone https://github.com/aegis-stream/aegis-core.git
cd aegis-core

# 2. Build Anchor Smart Contract
anchor build

# 3. Deploy to Solana Devnet or Localnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 4. Copy Program ID into Anchor.toml and programs/aegis_stream/src/lib.rs
# 5. Run Verification & Full Test Suite
anchor test