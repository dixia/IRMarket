import { http, createConfig } from "wagmi";
import { avalancheFuji, monadTestnet } from "viem/chains";
import type { Chain } from "viem";
import { metaMask, injected } from "wagmi/connectors";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

// Pick the base chain by id. Do NOT spread a single hardcoded chain: that would give the
// other network's metadata (name / native currency / explorer / icon) while overriding only
// id + RPC — the exact mismatch this module exists to prevent. Unknown chains get a bare
// object with neutral metadata.
const BASE_CHAINS: Record<number, Chain> = {
  10143: monadTestnet,
  43113: avalancheFuji,
};

const base = BASE_CHAINS[CHAIN_ID];

const chain: Chain = base
  ? {
      ...base,
      id: CHAIN_ID,
      contracts: {
        ...base.contracts,
        multicall3: { address: MULTICALL3 },
      },
      rpcUrls: {
        ...base.rpcUrls,
        default: {
          ...base.rpcUrls.default,
          http: [RPC_URL],
        },
      },
    }
  : {
      id: CHAIN_ID,
      name: `Chain ${CHAIN_ID}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
      contracts: { multicall3: { address: MULTICALL3 } },
    };

export const config = createConfig({
  chains: [chain] as const,
  connectors: [injected(), metaMask()],
  transports: {
    [chain.id]: http(RPC_URL),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
