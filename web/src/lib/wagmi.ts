import { http, createConfig } from "wagmi";
import { monadTestnet } from "wagmi/chains";
import { metaMask, injected } from "wagmi/connectors";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);

const chain = {
  ...monadTestnet,
  id: CHAIN_ID,
  contracts: {},
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