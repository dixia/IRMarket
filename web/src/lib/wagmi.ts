import { http, createConfig } from "wagmi";
import { monadTestnet } from "wagmi/chains";
import { metaMask, injected } from "wagmi/connectors";

function requireEnv(name: string, val: string | undefined): string {
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const RPC_URL = requireEnv("NEXT_PUBLIC_RPC_URL", process.env.NEXT_PUBLIC_RPC_URL);
const CHAIN_ID = Number(requireEnv("NEXT_PUBLIC_CHAIN_ID", process.env.NEXT_PUBLIC_CHAIN_ID));

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