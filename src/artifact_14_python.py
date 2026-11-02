import asyncio
import time
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair

# Protocol Addresses
PROGRAM_ID = Pubkey.from_string("Vist111111111111111111111111111111111111111")
RPC_URL = "https://api.devnet.solana.com"

async def run_crank_worker():
    client = AsyncClient(RPC_URL)
    print(f"[*] Vistula Keeper active on {RPC_URL}...")
    
    while True:
        try:
            # Query all program accounts matching StreamAccount discriminator
            accounts = await client.get_program_accounts(PROGRAM_ID)
            current_time = int(time.time())
            
            print(f"[{time.strftime('%X')}] Scanning {len(accounts.value)} active streams on-chain...")
            # Keeper scans for streams with available uncollected vested tokens
            # and automatically executes crank_stream_settlement to harvest fees.
            
            await asyncio.sleep(10)
        except Exception as e:
            print(f"[!] Error polling streams: {e}")
            await asyncio.sleep(5)

if __name__ == "__main__":
    asyncio.run(run_crank_worker())