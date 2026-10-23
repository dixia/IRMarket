// Real display names for the mock asset tokens (ticker → name).
// MockERC20 tokens are deployed with name == symbol, so the UI maps the ticker to the
// underlying asset's real name for display.
export const ASSET_NAMES: Record<string, string> = {
  NVDA: "NVIDIA",
  SNDK: "SanDisk",
  SOXX: "iShares Semiconductor ETF",
  GLM: "Zhipu Technology (Z.AI) · 02513.HK",
  DEEPSEEK: "DeepSeek",
  LLM: "Liuliumei (06658.HK)",
  // Nebius spot GPU prices, USD per GPU-hour (bot/price_feed.py NebiusSource).
  B300: "Nebius B300 GPU · spot /hr",
  B200: "Nebius B200 GPU · spot /hr",
  H200: "Nebius H200 GPU · spot /hr",
  H100: "Nebius H100 GPU · spot /hr",
  "RTX PRO 6000": "Nebius RTX PRO 6000 · spot /hr",
};

export function assetName(symbol: string): string {
  return ASSET_NAMES[symbol.toUpperCase()] ?? symbol;
}
