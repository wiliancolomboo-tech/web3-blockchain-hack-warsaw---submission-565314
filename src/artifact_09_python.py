#!/usr/bin/env python3
import time
from solana.rpc.api import Client
from solders.pubkey import Pubkey

RPC_URL = "https://api.devnet.solana.com"
client = Client(RPC_URL)
PROGRAM_ID = Pubkey.from_string("WSh1e1d111111111111111111111111111111111111")

print(f"[*] Warsaw Shield Keeper Online. Watching Program: {PROGRAM_ID}")

def run_crank():
    while True:
        try:
            # Query all stream accounts
            response = client.get_program_accounts(PROGRAM_ID)
            accounts = response.value
            print(f"[+] Active Escrow Streams: {len(accounts)}")
            # Processing logic for continuous settlement triggers goes here
            time.sleep(10)
        except KeyboardInterrupt:
            print("Keeper halted.")
            break
        except Exception as e:
            print(f"Error during keeper cycle: {e}")
            time.sleep(5)

if __name__ == "__main__":
    run_crank()