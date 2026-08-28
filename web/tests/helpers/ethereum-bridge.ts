/**
 * Injected into browser via Playwright addInitScript().
 * Creates window.ethereum that proxies JSON-RPC to local Anvil node.
 *
 * Anvil Default Account #0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
 * Anvil Default Account #1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
 */
export const ETHEREUM_BRIDGE_SCRIPT = `
(function () {
  "use strict";
  var RPC = "http://localhost:8545";
  var _id = 0;
  var CHAIN_ID = "0x7A69"; // 31337
  var ACCOUNTS = [
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  ];

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

  function handleWalletMethod(method, params) {
    if (method === "eth_requestAccounts" || method === "eth_accounts") {
      return Promise.resolve(ACCOUNTS);
    }
    if (method === "wallet_requestPermissions") {
      return Promise.resolve([{ parentCapability: "eth_accounts", caveats: [], invoker: ACCOUNTS[0] }]);
    }
    if (method === "wallet_getPermissions") {
      return Promise.resolve([{ parentCapability: "eth_accounts", invoker: ACCOUNTS[0] }]);
    }
    return null;
  }

  var provider = {
    isMetaMask: true,
    chainId: CHAIN_ID,
    networkVersion: "31337",
    selectedAddress: ACCOUNTS[0],

    request: function (args) {
      var method = args.method;
      var params = args.params || [];
      var handled = handleWalletMethod(method, params);
      if (handled !== null) return handled;
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
