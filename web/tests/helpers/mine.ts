import { http, type Hex } from "viem";

/**
 * Mine blank blocks on the Anvil node to advance block.number.
 */
export async function mineBlocks(count: number): Promise<void> {
  const RPC = "http://localhost:8545";
  for (let i = 0; i < count; i++) {
    await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "evm_mine",
        params: [],
      }),
    });
  }
}
