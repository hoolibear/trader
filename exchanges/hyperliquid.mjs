/**
 * exchanges/hyperliquid.mjs
 * Wraps hyperliquid.mjs in the standard exchange interface.
 */
import { privateKeyToAccount } from "viem/accounts";
import {
  getMidPrice as hlGetMidPrice,
  getPosition as hlGetPosition,
  placeMarketOrder as hlPlaceOrder,
  placeLimitOrder as hlPlaceLimitOrder,
  placeStopOrder as hlPlaceStopOrder,
  closePosition as hlClose,
  setLeverage as hlSetLeverage,
  getOpenOrders as hlGetOpenOrders,
  getStopOrders as hlGetStopOrders,
  cancelOrder as hlCancelOrder,
  getCandleSnapshots as hlGetCandles,
} from "../hyperliquid.mjs";

export class HyperliquidExchange {
  // signer: 0x private-key string, OR a viem-style account ({ address, signTypedData })
  // such as a Vultisig MPC account from loadVultisigAccount().
  constructor(signer) {
    this.signer = signer;
    this.address = typeof signer === "string"
      ? privateKeyToAccount(signer).address
      : signer.address;
  }

  get name() { return "Hyperliquid"; }

  async getMidPrice(asset) {
    return hlGetMidPrice(asset);
  }

  async getPosition(asset) {
    return hlGetPosition(this.address, asset);
    // Returns { szi, entryPx, ... } or null
  }

  async setLeverage(asset, leverage) {
    return hlSetLeverage(this.signer, asset, leverage);
  }

  async placeMarketOrder(asset, side, size) {
    return hlPlaceOrder(this.signer, asset, side, size);
  }

  async placeLimitOrder(asset, side, size, limitPrice) {
    return hlPlaceLimitOrder(this.signer, asset, side, size, limitPrice);
  }

  async placeStopOrder(asset, isLong, size, triggerPrice) {
    return hlPlaceStopOrder(this.signer, asset, isLong, size, triggerPrice);
  }

  async getOpenOrders() {
    return hlGetOpenOrders(this.address);
  }

  async getStopOrders(asset) {
    return hlGetStopOrders(this.address, asset);
  }

  async cancelOrder(orderId, asset) {
    return hlCancelOrder(this.signer, asset, Number(orderId));
  }

  async editOrder(orderId, asset, side, size, limitPrice) {
    console.log(`[hyperliquid] Editing order ${orderId} (cancel + replace): ${size} ${asset} @ $${limitPrice}`);
    await hlCancelOrder(this.signer, asset, Number(orderId));
    return hlPlaceLimitOrder(this.signer, asset, side, size, limitPrice);
  }

  async closePosition(asset) {
    return hlClose(this.signer, asset);
  }

  async getCandles(asset, interval, count) {
    return hlGetCandles(asset, interval, count);
  }
}
