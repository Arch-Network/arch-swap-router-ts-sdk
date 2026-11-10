import { base58, hex } from "@scure/base";
import { describe, expect, test } from "vitest";
import { MAINNET_AETH_USD, prepareBtcTreasuryBuy, type BtcTreasuryRfqDeployment, type DirectRfqQuote } from "../src/index.js";
import { decodeAddress, deriveAddress } from "../src/utils.js";
import fixture from "./fixtures/btc-treasury/propamm-143.json" with { type: "json" };

// The unsigned packet comes from PropAMM #143's Rust mock RFQ.
function setup() {
  const address = (key: string) => base58.encode(hex.decode(key));
  const programId = address(fixture.program), config = address(fixture.config);
  const baseMint = address(fixture.base_mint), quoteMint = address(fixture.quote_mint);
  const market: BtcTreasuryRfqDeployment = {
    ...MAINNET_AETH_USD,
    programId, config, baseMint, quoteMint, baseDecimals: 8,
    quoteSigner: address(fixture.quote_signer),
    baseVault: deriveAddress(programId, "vault", decodeAddress(config), decodeAddress(baseMint)),
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
