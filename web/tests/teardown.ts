import { execSync } from "child_process";

export default async function globalTeardown() {
  const proc = (globalThis as any).__anvilProcess;
  if (proc) {
    proc.kill("SIGTERM");
    if (process.platform === "win32") {
      // Killing wsl.exe does not kill the anvil process inside WSL.
      try {
        execSync(`wsl.exe -e bash -c "pkill -f 'anvil.*8545' 2>/dev/null; true"`, {
          stdio: "ignore",
        });
      } catch {
        // ignore
      }
    }
    console.log("[Teardown] Anvil node stopped.");
  }
}
