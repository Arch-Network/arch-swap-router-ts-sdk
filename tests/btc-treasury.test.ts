import { base58, hex } from "@scure/base";
import { describe, expect, test } from "vitest";
import { MAINNET_AETH_USD, prepareBtcTreasuryBuy, prepareBtcTreasurySell, type BtcTreasuryRfqDeployment, type DirectRfqQuote } from "../src/index.js";
import { decodeAddress, deriveAddress } from "../src/utils.js";
import fixture from "./fixtures/btc-treasury/propamm-143.json" with { type: "json" };
import sellFixture from "./fixtures/btc-treasury/propamm-156-sell.json" with { type: "json" };

// The unsigned packet comes from PropAMM #143's Rust mock RFQ.
function setup() {
  const address = (key: string) => base58.encode(hex.decode(key));
  const programId = address(fixture.program), config = address(fixture.config);
  const baseMint = address(fixture.base_mint), quoteMint = address(fixture.quote_mint);
  const market: BtcTreasuryRfqDeployment = {
    ...MAINNET_AETH_USD,
    baseMint, quoteMint,
    quoteVault: deriveAddress(programId, "vault", decodeAddress(config), decodeAddress(quoteMint)),
    btcTreasury: {
      programId: address(fixture.bridge),
      initialAdmin: address(fixture.initial_admin),
      minter: address(fixture.minter),
    },
  };
  const expiry = Date.now() + 30_000;
  const request = {
    user: address(fixture.user), inputMint: quoteMint, outputMint: baseMint,
    amountIn: BigInt(fixture.quote.amount_in), slippageBps: 50, deadlineMs: expiry,
  };
  const quote: DirectRfqQuote = {
    expiresAtMs: BigInt(expiry), quoteId: fixture.quote.quote_id,
    estimatedAmountOut: BigInt(fixture.quote.amount_out),
    transaction: {
      version: fixture.quote.version, signatures: [],
      message: {
        header: { ...fixture.quote.header },
        account_keys: fixture.quote.keys.map(hex.decode),
        recent_blockhash: hex.decode(fixture.quote.blockhash),
        instructions: fixture.quote.instructions.map(ix => ({ ...ix, accounts: [...ix.accounts], data: hex.decode(ix.data) })),
      },
    },
  };
  return { market, request, quote };
}

describe("direct BTC treasury buy", () => {
  test("preserves the server message and binds the fixed payout to its quote ID", () => {
    const { market, request, quote } = setup();
    const result = prepareBtcTreasuryBuy(request, quote, market);
    expect(result.transaction).toBe(quote.transaction);
    expect(result.rfq.quoteId).toBe(quote.quoteId);
    expect(result.minAmountOut).toBe(quote.estimatedAmountOut);
  });

  test.each([0, 1, 2, 3, 4, 5])("rejects changes to instruction %i", index => {
    const { market, request, quote } = setup();
    const ix = quote.transaction.message.instructions[index]!;
    ix.data[ix.data.length - 1] = ix.data[ix.data.length - 1]! ^ 1;
    expect(() => prepareBtcTreasuryBuy(request, quote, market)).toThrow();
  });

  test("rejects mismatched destination, deployment, and expiry", () => {
    const { market, request, quote } = setup();
    const message = quote.transaction.message;
    const payout = message.instructions[5]!;
    const destination = payout.accounts[1]!;
    payout.accounts[1] = 0;
    expect(() => prepareBtcTreasuryBuy(request, quote, market)).toThrow();
    payout.accounts[1] = destination;
    expect(() => prepareBtcTreasuryBuy(request, quote, {
      ...market, btcTreasury: { ...market.btcTreasury, initialAdmin: request.user },
    })).toThrow();
    expect(() => prepareBtcTreasuryBuy(request, { ...quote, expiresAtMs: 1n }, market)).toThrow();
  });
});

function setupSell() {
  const expiry = Date.now() + 30_000;
  const request = {
    user: base58.encode(Uint8Array.from(sellFixture.message.account_keys[0]!)),
    inputMint: "Bg138vbUo1h3cvRBQ9yRdqbGX2Cm2pwRexj1LaVVTQYj",
    outputMint: "78s6DsmwRnCYiQDvAKbJoeAbGDa68zifa1cgqTb4tBbM",
    amountIn: BigInt(sellFixture.estimated_quote.base_amount), slippageBps: 50, deadlineMs: expiry,
  };
  const quote: DirectRfqQuote = {
    quoteId: sellFixture.quote_id, expiresAtMs: BigInt(expiry),
    estimatedAmountOut: BigInt(sellFixture.estimated_quote.quote_amount),
    transaction: {
      version: sellFixture.version, signatures: [], message: {
        header: { ...sellFixture.message.header },
        account_keys: sellFixture.message.account_keys.map(key => Uint8Array.from(key)),
        recent_blockhash: Uint8Array.from(sellFixture.message.recent_blockhash),
        instructions: sellFixture.message.instructions.map(ix => ({ ...ix, accounts: [...ix.accounts], data: Uint8Array.from(ix.data) })),
      },
    },
  };
  return { request, quote };
}

describe("direct BTC treasury sell", () => {
  test("preserves the wrapper-minted quote payout and the server's message", () => {
    const { request, quote } = setupSell();
    const result = prepareBtcTreasurySell(request, quote);
    expect(result.transaction).toBe(quote.transaction);
    expect(result.rfq.quoteId).toBe(quote.quoteId);
    expect(result.amountIn).toBe(1_000_000n);
    expect(result.estimatedAmountOut).toBe(1_005_000n);
    expect(result.minAmountOut).toBe(1_005_000n);
    expect(result.hops).toMatchObject([{ kind: "treasuryMint", inputMint: request.inputMint, outputMint: request.outputMint }]);
  });

  test.each([0, 1, 2, 3, 4, 5])("rejects changes to sell instruction %i", index => {
    const { request, quote } = setupSell();
    const ix = quote.transaction.message.instructions[index]!;
    ix.data[ix.data.length - 1] = ix.data[ix.data.length - 1]! ^ 1;
    expect(() => prepareBtcTreasurySell(request, quote)).toThrow();
  });

  test.each([[3, 1], [4, 4], [4, 5], [5, 1]])("rejects substituted vault, mint or recipient at %i/%i", (instruction, account) => {
    const { request, quote } = setupSell();
    quote.transaction.message.instructions[instruction]!.accounts[account] = 0;
    expect(() => prepareBtcTreasurySell(request, quote)).toThrow();
  });

  test("binds input, output, side, signer and expiry", () => {
    const { request, quote } = setupSell();
    expect(() => prepareBtcTreasurySell({ ...request, amountIn: request.amountIn + 1n }, quote)).toThrow();
    expect(() => prepareBtcTreasurySell(request, { ...quote, estimatedAmountOut: quote.estimatedAmountOut + 1n })).toThrow();
    expect(() => prepareBtcTreasurySell({ ...request, inputMint: request.outputMint, outputMint: request.inputMint }, quote)).toThrow();
    expect(() => prepareBtcTreasuryBuy(request, quote)).toThrow();
    expect(() => prepareBtcTreasurySell(request, { ...quote, expiresAtMs: 1n })).toThrow();
    quote.transaction.message.account_keys[1] = quote.transaction.message.account_keys[0]!;
    expect(() => prepareBtcTreasurySell(request, quote)).toThrow();
  });

  test("rejects router authorization and unexpected signer or writable privileges", () => {
    const { request, quote } = setupSell();
    expect(() => prepareBtcTreasurySell(request, { ...quote,
      treasuryAuthorization: { version: 1, minAmountIn: request.amountIn, maxAmountIn: request.amountIn },
    })).toThrow();
    quote.transaction.message.header.num_readonly_unsigned_accounts -= 1;
    expect(() => prepareBtcTreasurySell(request, quote)).toThrow();
  });
});
