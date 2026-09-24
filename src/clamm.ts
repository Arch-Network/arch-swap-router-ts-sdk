// Exact-input subset of arch-swap's CLAMM helpers, checked against native Rust.
// Provenance and independent fixtures: tests/fixtures/clamm/README.md.
import { base58 } from "@scure/base";
import type { NetworkConfig } from "./config/networks.js";
import type { Address } from "./types.js";
import { RouterSdkError } from "./errors.js";
import type { ResolvedStep } from "./transactions/types.js";
import {
  accountData, decodeAddress, decodeMint, deriveAddress, divRoundUp,
  readU128, u64, u128, u256, type AccountMap,
} from "./utils.js";

const MIN_TICK = -443636, MAX_TICK = 443636, ARRAY_SIZE = 88;
const Q64 = 1n << 64n, FEE_SCALE = 1_000_000n;
// Native tick_math.rs: positive factors use Q96, negative factors use Q64.
const POSITIVE = [
  79232123823359799118286999567n, 79236085330515764027303304731n,
  79244008939048815603706035061n, 79259858533276714757314932305n,
  79291567232598584799939703904n, 79355022692464371645785046466n,
  79482085999252804386437311141n, 79736823300114093921829183326n,
  80248749790819932309965073892n, 81282483887344747381513967011n,
  83390072131320151908154831281n, 87770609709833776024991924138n,
  97234110755111693312479820773n, 119332217159966728226237229890n,
  179736315981702064433883588727n, 407748233172238350107850275304n,
  2098478828474011932436660412517n, 55581415166113811149459800483533n,
  38992368544603139932233054999993551n,
];
const NEGATIVE = [
  18445821805675392311n, 18444899583751176498n, 18443055278223354162n,
  18439367220385604838n, 18431993317065449817n, 18417254355718160513n,
  18387811781193591352n, 18329067761203520168n, 18212142134806087854n,
  17980523815641551639n, 17526086738831147013n, 16651378430235024244n,
  15030750278693429944n, 12247334978882834399n, 8131365268884726200n,
  3584323654723342297n, 696457651847595233n, 26294789957452057n, 37481735321082n,
];

export function tickSqrtPrice(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RouterSdkError("INVALID_ACCOUNT", "CLAMM tick is out of range.");
  }
  const factors = tick >= 0 ? POSITIVE : NEGATIVE;
  const shift = tick >= 0 ? 96n : 64n;
  let ratio = 1n << shift;
  for (let bit = 0; bit < factors.length; bit++) {
    if ((Math.abs(tick) & (1 << bit)) !== 0) ratio = ratio * factors[bit]! >> shift;
  }
  return tick >= 0 ? ratio >> 32n : ratio;
}

export function decodePool(data: Uint8Array) {
  if (data.length !== 653 || ![63, 149, 209, 12, 225, 128, 99, 9].every((b, i) => data[i] === b)) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Invalid CLAMM pool length or discriminator.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tickSpacing = view.getUint16(41, true), tickCurrentIndex = view.getInt32(81, true);
  const sqrtPrice = readU128(view, 65);
  // A leftward crossing stores next_tick - 1, including at the minimum price.
  const priceTick = tickCurrentIndex === MIN_TICK - 1 ? MIN_TICK : tickCurrentIndex;
  if (tickSpacing === 0 || view.getUint16(43, true) !== tickSpacing
    || sqrtPrice < tickSqrtPrice(priceTick)
    || sqrtPrice > tickSqrtPrice(Math.min(tickCurrentIndex + 1, MAX_TICK))) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Invalid CLAMM tick spacing or price.");
  }
  const key = (offset: number) => base58.encode(data.subarray(offset, offset + 32));
  return {
    tickSpacing, tickCurrentIndex, sqrtPrice, liquidity: readU128(view, 49), feeRate: view.getUint16(45, true),
    tokenMintA: key(101), tokenVaultA: key(133), tokenMintB: key(181), tokenVaultB: key(213),
  };
}

type Pool = Pick<ReturnType<typeof decodePool>, "tickSpacing" | "tickCurrentIndex" | "sqrtPrice" | "liquidity" | "feeRate">;
export interface InitializedTick { readonly index: number; readonly liquidityNet: bigint }

/** Unique native window; instruction slots are padded by repeating its last array. */
export function tickWindow(tick: number, spacing: number, aToB: boolean): number[] {
  if (!Number.isInteger(spacing) || spacing <= 0 || spacing > 65535) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Invalid CLAMM tick spacing.");
  }
  tickSqrtPrice(tick === MIN_TICK - 1 ? MIN_TICK : tick);
  const span = ARRAY_SIZE * spacing;
  const base = Math.floor(tick / span) * span;
  const offsets = aToB ? [0, -1, -2] : tick + spacing >= base + span ? [1, 2, 3] : [0, 1, 2];
  return offsets.map((offset) => base + offset * span)
    .filter((start) => start >= Math.floor(MIN_TICK / span) * span && start <= MAX_TICK);
}

export function decodeTickArray(data: Uint8Array, start: number, spacing: number, poolAddress: Address): InitializedTick[] {
  if (data.length !== 9988 || ![69, 97, 189, 190, 110, 7, 66, 187].every((b, i) => data[i] === b)) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Invalid CLAMM tick array length or discriminator.");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getInt32(8, true) !== start || base58.encode(data.subarray(9956)) !== poolAddress) {
    throw new RouterSdkError("INVALID_ACCOUNT", "Tick array does not match the selected pool/window.");
  }
  const ticks: InitializedTick[] = [];
  for (let i = 0; i < ARRAY_SIZE; i++) {
    const offset = 12 + i * 113;
    if (data[offset]! > 1) throw new RouterSdkError("INVALID_ACCOUNT", "Invalid tick initialization flag.");
    if (data[offset] === 1) {
      const index = start + i * spacing;
      tickSqrtPrice(index);
      ticks.push({ index, liquidityNet: readU128(view, offset + 1, true) });
    }
  }
  return ticks;
}

/** To-target deltas can exceed u64: native exact-in uses that to select a partial step. */
function amountDelta(p: bigint, q: bigint, liquidity: bigint, tokenA: boolean, roundUp: boolean): bigint {
  const difference = p > q ? p - q : q - p;
  const numerator = tokenA ? u256(liquidity * difference * Q64) : liquidity * difference;
  const denominator = tokenA ? p * q : Q64;
  return roundUp ? divRoundUp(numerator, denominator) : numerator / denominator;
}

/** Pure native exact-in simulation. Ticks are supplied in traversal order. */
export function simulateClamm(pool: Pool, ticks: readonly InitializedTick[], amount: bigint, aToB: boolean, limit: bigint) {
  let remaining = amount, amountOut = 0n, feeAmount = 0n;
  let price = pool.sqrtPrice, liquidity = pool.liquidity;
  if (amount <= 0n || (aToB ? limit >= price : limit <= price)) {
    throw new RouterSdkError("INSUFFICIENT_LIQUIDITY", "No CLAMM swap window in this direction.");
  }
  const feeRate = BigInt(pool.feeRate);
  const candidates = ticks.filter((tick) => aToB ? tick.index <= pool.tickCurrentIndex : tick.index > pool.tickCurrentIndex);
  // The final synthetic target ends the quote at the loaded window, even with residual liquidity.
  for (const tick of [...candidates, null]) {
    const tickPrice = tick ? tickSqrtPrice(tick.index) : limit;
    const target = aToB ? (tickPrice < limit ? limit : tickPrice) : (tickPrice > limit ? limit : tickPrice);
    const available = remaining * (FEE_SCALE - feeRate) / FEE_SCALE;
    const toTarget = amountDelta(price, target, liquidity, aToB, true);
    let next = target;
    if (available < toTarget) {
      next = aToB
        ? available === 0n ? price : divRoundUp(u256(liquidity * price * Q64), liquidity * Q64 + available * price)
        : u128(price + available * Q64 / liquidity);
    }
    const spent = u64(next === target ? toTarget : amountDelta(price, next, liquidity, aToB, true));
    const received = u64(amountDelta(price, next, liquidity, !aToB, false));
    const fee = next === target ? divRoundUp(spent * feeRate, FEE_SCALE - feeRate) : remaining - spent;
    remaining = u64(remaining - spent - fee);
    amountOut = u64(amountOut + received);
    feeAmount = u64(feeAmount + fee);
    price = next;
    if (tick && next === tickPrice) liquidity = u128(liquidity + (aToB ? -tick.liquidityNet : tick.liquidityNet));
    if (remaining === 0n || price === limit) break;
  }
  return { amountIn: amount - remaining, amountOut, feeAmount, sqrtPrice: price, liquidity };
}

export function loadClamm(accounts: AccountMap, aToB: boolean, { programs, venues }: NetworkConfig) {
  const venue = venues.clamm;
  if (!venue) throw new RouterSdkError("NO_ROUTE", "CLAMM is not configured for this network.");
  const pool = decodePool(accountData(accounts, venue.address, programs.clammProgramId));
  if (pool.tokenMintA !== venue.tokenMintA || pool.tokenMintB !== venue.tokenMintB) {
    throw new RouterSdkError("INVALID_ACCOUNT", "CLAMM pool does not match the selected pair.");
  }
  for (const mint of [pool.tokenMintA, pool.tokenMintB]) decodeMint(accountData(accounts, mint, programs.tokenProgramId));
  const starts = tickWindow(pool.tickCurrentIndex, pool.tickSpacing, aToB);
  if (starts.length === 0) throw new RouterSdkError("INSUFFICIENT_LIQUIDITY", "No CLAMM tick window.");
  const last = starts[starts.length - 1]!;
  const limit = tickSqrtPrice(aToB ? Math.max(last, MIN_TICK) : Math.min(last + pool.tickSpacing * ARRAY_SIZE - 1, MAX_TICK));
  const poolKey = decodeAddress(venue.address);
  const addresses = starts.map((start) => deriveAddress(programs.clammProgramId, "tick_array", poolKey, new TextEncoder().encode(String(start))));
  const finalAddress = addresses[addresses.length - 1]!;
  const resolved: ResolvedStep = {
    kind: "clamm", outputMint: aToB ? pool.tokenMintB : pool.tokenMintA,
    pool: venue.address, tokenVaultA: pool.tokenVaultA, tokenVaultB: pool.tokenVaultB,
    tickArrays: [addresses[0]!, addresses[1] ?? finalAddress, addresses[2] ?? finalAddress],
    oracle: deriveAddress(programs.clammProgramId, "oracle", poolKey), aToB, sqrtPriceLimit: limit, supplementalTickArrays: [],
  };
  return { pool, starts, addresses, resolved, programs };
}

export function prepareClammQuote(state: ReturnType<typeof loadClamm>, accounts: AccountMap) {
  const { pool, starts, addresses, resolved, programs } = state;
  const ticks = addresses.flatMap((address, i) => {
    const info = accounts.get(address);
    if (info === null) return []; // Confirmed absence is a native zeroed tick array.
    if (info?.data.length === 0 && base58.encode(info.owner) === programs.systemProgramId && !info.is_executable) return [];
    return decodeTickArray(accountData(accounts, address, programs.clammProgramId), starts[i]!, pool.tickSpacing, resolved.pool);
  }).sort((a, b) => resolved.aToB ? b.index - a.index : a.index - b.index);
  return { resolved, estimate(amountIn: bigint) {
    const result = simulateClamm(pool, ticks, amountIn, resolved.aToB, resolved.sqrtPriceLimit);
    if (result.amountIn !== amountIn) throw new RouterSdkError("INSUFFICIENT_LIQUIDITY", "CLAMM window cannot consume the full input.");
    if (result.amountOut === 0n) throw new RouterSdkError("ZERO_OUTPUT", "CLAMM output rounds to zero.");
    return result.amountOut;
  } };
}
