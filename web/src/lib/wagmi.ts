import { http, createConfig } from "wagmi";
import { monadTestnet } from "wagmi/chains";
import { metaMask, injected } from "wagmi/connectors";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);

const chain = {
  ...monadTestnet,
  id: CHAIN_ID,
  // Multicall3 is deployed at the canonical address on Monad testnet. Without it,
  // wagmi's `useReadContracts` (used by useMarkets) throws "multicallAddress is
  // required" and the market list renders empty.
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" as `0x${string}` },
  },
  rpcUrls: {
    ...monadTestnet.rpcUrls,
    default: {
      ...monadTestnet.rpcUrls.default,
      http: [RPC_URL],
    },
  },
};

export const config = createConfig({
  chains: [chain],
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