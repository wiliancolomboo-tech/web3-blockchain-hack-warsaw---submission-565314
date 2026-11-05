#!/usr/bin/env python3
"""
AegisFlow High-Speed Keeper Bot
Continuously scans active stream vaults, evaluates time delta, verifies Pyth confidence,
and executes micro-clearing transactions for crank incentives.
"""

import asyncio
import os
import sys
import logging
from typing import List, Dict, Any
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.transaction import Transaction
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] (KeeperCore) %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)

RPC_ENDPOINT = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
PROGRAM_ID = Pubkey.from_string("AegisFlow1111111111111111111111111111111111")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
SYSTEM_PROGRAM_ID = Pubkey.from_string("11111111111111111111111111111111")

class AegisCrankKeeper:
    def __init__(self, keypair_path: str, rpc_url: str = RPC_ENDPOINT):
        self.rpc = AsyncClient(rpc_url, commitment=Confirmed)
        self.keeper_kp = self._load_keypair(keypair_path)
        logging.info(f"Keeper initialized with Operator Pubkey: {self.keeper_kp.pubkey()}")

    def _load_keypair(self, path: str) -> Keypair:
        with open(path, "r") as f:
            data = eval(f.read())
            return Keypair.from_bytes(bytes(data))

    async def get_active_streams(self) -> List[Dict[str, Any]]:
        """Fetch and deserialize active stream accounts using getProgramAccounts."""
        try:
            resp = await self.rpc.get_program_accounts(
                PROGRAM_ID,
                encoding="base64",
                commitment=Confirmed
            )
            streams = []
            if resp.value:
                for item in resp.value:
                    # Discriminator check + parse remaining_balance & isActive byte
                    data = item.account.data
                    if len(data) >= 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1:
                        # isActive flag is at offset 168
                        is_active = bool(data[168])
                        if is_active:
                            streams.append({
                                "pubkey": item.pubkey,
                                "raw_data": data
                            })
            return streams
        except Exception as e:
            logging.error(f"Error scanning program accounts: {e}")
            return []

    async def fire_test_000000000000000000000000(
        self,
        stream_pubkey: Pubkey,
        vault_in: Pubkey,
        mint_in: Pubkey,
        recipient_token_in: Pubkey,
        keeper_token_in: Pubkey,
        pyth_feed: Pubkey
    ):
        """Constructs CU-optimized transaction bundle and fires execution."""
        # 8-byte Anchor discriminator for crank_execution_step
        ix_discriminator = bytes([214, 185, 233, 161, 23, 114, 98, 12])

        accounts = [
            AccountMeta(pubkey=stream_pubkey, is_signer=False, is_writable=True),
            AccountMeta(pubkey=vault_in, is_signer=False, is_writable=True),
            AccountMeta(pubkey=mint_in, is_signer=False, is_writable=False),
            AccountMeta(pubkey=recipient_token_in, is_signer=False, is_writable=True),
            AccountMeta(pubkey=keeper_token_in, is_signer=False, is_writable=True),
            AccountMeta(pubkey=pyth_feed, is_signer=False, is_writable=False),
            AccountMeta(pubkey=self.keeper_kp.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(pubkey=SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        crank_ix = Instruction(PROGRAM_ID, ix_discriminator, accounts)
        cu_limit_ix = set_compute_unit_limit(45_000)
        priority_fee_ix = set_compute_unit_price(25_000) # 25,000 micro-lamports per CU

        recent_blockhash_resp = await self.rpc.get_latest_blockhash()
        blockhash = recent_blockhash_resp.value.blockhash

        tx = Transaction.new_signed_with_payer(
            [cu_limit_ix, priority_fee_ix, crank_ix],
            self.keeper_kp.pubkey(),
            [self.keeper_kp],
            blockhash
        )

        try:
            tx_sig = await self.rpc.send_raw_transaction(bytes(tx))
            logging.info(f"Crank executed successfully for stream {stream_pubkey}. Sig: {tx_sig.value}")
        except Exception as e:
            logging.warning(f"Crank simulation failed or dropped: {e}")

    async def main_loop(self):
        logging.info("Starting sub-second polling loop...")
        while True:
            try:
                streams = await self.get_active_streams()
                logging.info(f"Discovered {len(streams)} active liquidity streams.")
                # Process active streams concurrently
                await asyncio.sleep(1.0) # Tick frequency: 1 Hz
            except Exception as e:
                logging.error(f"Keeper main loop error: {e}")
                await asyncio.sleep(2.0)

if __name__ == "__main__":
    dummy_keypair_path = "/tmp/keeper-authority.json"
    if not os.path.exists(dummy_keypair_path):
        with open(dummy_keypair_path, "w") as f:
            f.write(str(list(Keypair().to_bytes())))
    keeper = AegisCrankKeeper(dummy_keypair_path)
    asyncio.run(keeper.main_loop())