/**
 * testnet-bridge.ts — injected wallet for running Playwright against a LIVE deployment
 * (Vercel preview) on Monad testnet.
 *
 * The local-Anvil bridge (ethereum-bridge.ts) hardcodes http://127.0.0.1:8545 with
 * chainId 31337 and lets the node sign `eth_sendTransaction`. A public testnet RPC can do
 * neither, so this bridge:
 *   - reports the REAL chain id (10143) so wagmi accepts the network instead of asking to
 *     switch,
 *   - proxies reads straight to the testnet RPC — the same browser fetch the app already
 *     performs in production (wagmi http transport), so CORS is already required and
 *     satisfied by the app itself,
 *   - relays `eth_sendTransaction` to a Node-side signer exposed by the spec via
 *     `page.exposeBinding("__e2eSendTx", ...)`. The burner key NEVER enters the browser —
 *     the page only ever sees the address, so a leaked page/DOM dump cannot leak the key.
 *
 * Wiring (`wireTestnetWallet`) must happen before `page.goto`.
 */
import type { Page } from "@playwright/test";
import { createPublicClient, createWalletClient, http, type Chain, type Hex } from "viem";
import { signTransaction } from "viem/actions";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji, monadTestnet } from "viem/chains";

export interface TestnetWalletOptions {
  /** Testnet RPC the page reads through (CORS-open: the app fetches it in production). */
  rpc: string;
  /** Burner PRIVATE key. Node side only — never injected into the page. */
  key: `0x${string}`;
  /** Chain the signer targets. Defaults to Monad testnet for the existing callers. */
  chain?: Chain;
  /** Chain id the bridge reports; must match the app's NEXT_PUBLIC_CHAIN_ID. */
  chainId?: number;
}

export { avalancheFuji, monadTestnet };

/**
 * The in-page provider. Same shape as ethereum-bridge.ts (the app's `useHydrated` /
 * wagmi injected connector expect `isMetaMask`, `request`, `enable`, legacy `send`).
 */
export function testnetBridgeScript(opts: { rpc: string; burner: string; chainId?: number }): string {
  const chainId = opts.chainId ?? 10143;
  const chainIdHex = `0x${chainId.toString(16)}`;
  const rpc = JSON.stringify(opts.rpc);
  const burner = JSON.stringify(opts.burner);
  return `
(function () {
  "use strict";
  var RPC = ${rpc};
  var CHAIN_ID_HEX = ${JSON.stringify(chainIdHex)};
  var ACCOUNTS = [${burner}];
  var _id = 0;

  function rpcRequest(method, params) {
    return fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++_id, method: method, params: params || [] }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          var err = new Error(data.error.message || "RPC Error");
          err.code = data.error.code;
          err.data = data.error.data;
          throw err;
        }
        return data.result;
      });
  }

  function handleWalletMethod(method) {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return Promise.resolve(ACCOUNTS);
      case "eth_chainId":
        return Promise.resolve(CHAIN_ID_HEX);
      case "net_version":
        return Promise.resolve(String(parseInt(CHAIN_ID_HEX, 16)));
      case "wallet_requestPermissions":
      case "wallet_getPermissions":
        return Promise.resolve([{ parentCapability: "eth_accounts", caveats: [], invoker: ACCOUNTS[0] }]);
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return Promise.resolve(null);
      default:
        return null;
    }
  }

  var provider = {
    isMetaMask: true,
    chainId: CHAIN_ID_HEX,
    networkVersion: String(parseInt(CHAIN_ID_HEX, 16)),
    selectedAddress: ACCOUNTS[0],

    request: function (args) {
      var method = args.method;
      var params = args.params || [];
      var handled = handleWalletMethod(method);
      if (handled !== null) return handled;
      if (method === "eth_sendTransaction") {
        var tx = params[0] || {};
        if (typeof window.__e2eSendTx !== "function") {
          return Promise.reject(new Error("e2e: __e2eSendTx not wired (call wireTestnetWallet first)"));
        }
        return window.__e2eSendTx({ to: tx.to, data: tx.data, gas: tx.gas, value: tx.value });
      }
      return rpcRequest(method, params);
    },

    on: function () {},
    removeListener: function () {},

    send: function (methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === "string") {
        return this.request({ method: methodOrPayload, params: paramsOrCallback });
      }
      var payload = methodOrPayload;
      this.request(payload)
        .then(function (r) { if (paramsOrCallback) paramsOrCallback(null, { id: payload.id, jsonrpc: "2.0", result: r }); })
        .catch(function (e) { if (paramsOrCallback) paramsOrCallback(e); });
    },
    sendAsync: function (payload, callback) {
      this.request(payload)
        .then(function (r) { callback(null, { id: payload.id, jsonrpc: "2.0", result: r }); })
        .catch(function (e) { callback(e); });
    },
    enable: function () {
      return this.request({ method: "eth_requestAccounts" });
    },
  };

  Object.defineProperty(window, "ethereum", {
    value: provider,
    writable: false,
    configurable: true,
    enumerable: true,
  });
})();
`;
}

/**
 * Injects the bridge and wires the Node-side signer. Must be called before `goto`.
 *
 * The signing side uses viem (web's own dependency — the repo root's ethers is not
 * installed under web/). Legacy txs only: the app sends fixed `gas` + no fee fields, and
 * Monad prices legacy `gasPrice` identically to EIP-1559's effective price.
 */
export async function wireTestnetWallet(page: Page, opts: TestnetWalletOptions): Promise<void> {
  const chain = opts.chain ?? monadTestnet;
  const chainId = opts.chainId ?? chain.id;
  const account = privateKeyToAccount(opts.key);
  if (chainId !== chain.id) {
    // The signer's chain object is fixed; a different id would need a custom chain
    // definition. Fail loudly rather than sign for the wrong chain.
    throw new Error(`testnet-bridge: chainId ${chainId} != viem chain ${chain.name} ${chain.id}`);
  }

  const walletClient = createWalletClient({ account, chain, transport: http(opts.rpc) });
  const publicClient = createPublicClient({ chain, transport: http(opts.rpc) });

  await page.addInitScript(testnetBridgeScript({ rpc: opts.rpc, burner: account.address, chainId }));

  await page.exposeBinding("__e2eSendTx", async (_source, tx: { to?: string; data?: string; gas?: string; value?: string }) => {
    if (!tx?.to) throw new Error("e2eSendTx: missing `to`");
    const [gasPrice, nonce0] = await Promise.all([
      publicClient.getGasPrice(),
      publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    ]);
    let nonce = nonce0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await signTransaction(walletClient, {
          to: tx.to as Hex,
          data: (tx.data ?? "0x") as Hex,
          value: tx.value ? BigInt(tx.value) : 0n,
          gas: tx.gas ? BigInt(tx.gas) : 300_000n,
          gasPrice,
          nonce,
          type: "legacy",
        });
        return await publicClient.sendRawTransaction({ serializedTransaction: raw });
      } catch (e) {
        // The burner only ever sends from this page (sequential, receipt-per-action), so a
        // nonce clash is unexpected — but a retry is cheap and self-healing.
        const msg = String(e).toLowerCase();
        if (msg.includes("nonce") || msg.includes("replacement") || msg.includes("already known")) {
          nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
          continue;
        }
        throw e;
      }
    }
    throw new Error("e2eSendTx: nonce retries exhausted");
  });

  return;
}
