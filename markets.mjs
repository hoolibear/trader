/**
 * markets.mjs — which symbols trade 24/7 (crypto) and which follow the stock
 * market session. Used by the CLI runner and the desktop scheduler.
 */

// Crypto tickers traded on 24/7 markets (Hyperliquid perps)
export const CRYPTO_TICKERS = new Set([
  "BTC","ETH","SOL","BNB","XRP","ADA","AVAX","DOT","MATIC","POL","LINK","UNI",
  "ATOM","LTC","DOGE","SHIB","TRX","TON","SUI","APT","OP","ARB","INJ","SEI",
  "TIA","JUP","WIF","BONK","PEPE","NEAR","FIL","ICP","HBAR","VET","ALGO","XLM",
  "XMR","ETC","BCH","AAVE","CRV","MKR","SNX","LDO","RETH","STETH","WBTC","VVV","VULT","ZEC",
]);

export function isCrypto(symbol) {
  // Strip exchange suffix: "BTC-USD" → "BTC", "ETH/USD" → "ETH"
  const base = symbol.toUpperCase().replace(/-USD$/, "").replace(/\/USD$/, "");
  return CRYPTO_TICKERS.has(base);
}
