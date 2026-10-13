// Real display names for the mock asset tokens (ticker → name).
// MockERC20 tokens are deployed with name == symbol, so the UI maps the ticker to the
// underlying asset's real name for display.
export const ASSET_NAMES: Record<string, string> = {
  NVDA: "NVIDIA",
  SNDK: "SanDisk",
  DEEPSEEK: "DeepSeek",
  LLM: "Liuliumei (06658.HK)",
};

export function assetName(symbol: string): string {
  return ASSET_NAMES[symbol.toUpperCase()] ?? symbol;
}
