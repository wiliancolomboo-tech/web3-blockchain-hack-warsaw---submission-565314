# Configure Solana CLI for devnet
solana config set --url https://api.devnet.solana.com

# Ensure deployer wallet is funded
solana airdrop 2

# Deploy VeriHack Warsaw program to Devnet
anchor deploy --provider.cluster devnet