import asyncio
import struct
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair

PROGRAM_ID = Pubkey.from_string("Aegis111111111111111111111111111111111111111")
RPC_URL = "https://api.devnet.solana.com"

async def monitor_and_liquidate():
    client = AsyncClient(RPC_URL)
    print(f"[*] Aegis Stream Keeper initialized. Monitoring Program: {PROGRAM_ID}")
    
    while True:
        try:
            # Query all user position program accounts
            accounts = await client.get_program_accounts(PROGRAM_ID)
            for acc in accounts.value:
                raw_data = acc.account.data
                # Position discriminator + 32 (owner) + 32 (market) = 72 bytes offset
                if len(raw_data) >= 88:
                    collateral_amt, debt_amt = struct.unpack_from("<QQ", raw_data, 72)
                    if debt_amt > 0:
                        # Quick health check calculation...
                        print(f"-> Position {acc.pubkey}: Collateral={collateral_amt}, Debt={debt_amt}")
            await asyncio.sleep(2)
        except Exception as e:
            print(f"[!] Error reading state: {e}")
            await asyncio.sleep(5)

if __name__ == "__main__":
    asyncio.run(monitor_and_liquidate())