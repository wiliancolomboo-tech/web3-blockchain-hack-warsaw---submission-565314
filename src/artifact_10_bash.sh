# Switch to Solana Devnet
solana config set --url https://api.devnet.solana.com

# Fund deployment wallet
solana airdrop 2

# Deploy
anchor deploy --provider.cluster devnet