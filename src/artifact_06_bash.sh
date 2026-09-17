# Set localnet RPC target
solana config set --url localhost

# Generate local deployment keypair if not already present
solana-keygen new --no-bip39-passphrase --force --outfile ~/.config/solana/id.json