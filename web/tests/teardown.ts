export default async function globalTeardown() {
  const proc = (globalThis as any).__anvilProcess;
  if (proc) {
    proc.kill("SIGTERM");
    console.log("[Teardown] Anvil node stopped.");
  }
}
