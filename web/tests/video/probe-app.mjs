import { chromium } from "@playwright/test";
import { ethereumBridgeScript } from "../helpers/ethereum-bridge.ts";
import fs from "fs";
import path from "path";

const webDir = path.resolve(import.meta.dirname, "..", "..");
const addresses = JSON.parse(fs.readFileSync(path.join(webDir, "tests", "helpers", "addresses.json"), "utf8"));

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const calls = new Set();
page.on("request", (r) => {
  if (r.url().includes("8545") && r.method() === "POST") {
    try {
      const p = r.postDataJSON();
      const to = p?.params?.[0]?.to ?? p?.params?.[0];
      calls.add(`${p?.method} ${to}`);
    } catch {}
  }
});
page.on("console", (m) => { if (m.type() === "error") console.log("PAGE-ERR:", m.text().slice(0, 200)); });

await page.addInitScript(ethereumBridgeScript(0));
await page.goto("http://localhost:3000/vault");
await page.waitForTimeout(9000);

console.log("--- rendered body ---");
console.log((await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 700));
console.log("--- unique RPC targets ---");
console.log([...calls].slice(0, 20).join("\n") || "(none)");

await browser.close();
