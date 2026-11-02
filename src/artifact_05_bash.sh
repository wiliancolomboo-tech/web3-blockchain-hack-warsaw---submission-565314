# 1. Install prerequisites (Solana CLI, Rust, Anchor)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1 && avm use 0.30.1

# 2. Build on-chain Solana program
anchor build

# 3. Synchronize program keys and deploy to Devnet
anchor keys sync
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 4. Verify deployment signature
solana program show <PROGRAM_ID>