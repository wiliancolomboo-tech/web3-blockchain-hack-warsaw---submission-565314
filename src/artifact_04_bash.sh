# 1. Clone repository & enter directory
git clone https://github.com/hack-warsaw/chronoflow.git
cd chronoflow

# 2. Install dependencies
yarn install

# 3. Generate Program ID keypair if building clean
solana-keygen new -o target/deploy/chronoflow-keypair.json --no-bip39-passphrase --force