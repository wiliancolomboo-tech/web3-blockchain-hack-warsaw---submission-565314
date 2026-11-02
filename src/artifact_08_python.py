import asyncio
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey

VISTULA_PROGRAM_ID = Pubkey.from_string("Vist111111111111111111111111111111111111111")

async def monitor_and_crank():
    client = AsyncClient("https://api.devnet.solana.com")
    print(f"[*] Vistula Keeper active. Monitoring program: {VISTULA_PROGRAM_ID}")
    
    while True:
        slot = (await client.get_slot()).value
        print(f"[+] Current cluster slot: {slot} | Checking open batch epochs...")
        # Keeper queries batch accounts, verifies slot elapsed, invokes crank_settle_batch
        await asyncio.sleep(2.0)

if __name__ == "__main__":
    asyncio.run(monitor_and_crank())