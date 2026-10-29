// Mainnet deployment verified on 2026-10-27. Its aUSD and PropAMM program are mainnet-v2's (config/networks.ts);
// its PropAMM config is its own.
export const MAINNET_AETH_USD = Object.freeze({
  baseMint: "AzuWEhnYUv6NTAFrC2MtzKb4nASh6sCMcD15WUmoFR45",
  baseDecimals: 6,
  quoteMint: "DQcBfwHu8gr8KGt3BE5BDUfBjGgFuDJYm9ByVTDsrww9",
  quoteDecimals: 6,
  programId: "5KMw4VNavLhM5wxTxyQGm8hs5ymFhqMCZ5BpkHybcEBV",
  config: "3jwSNH8P5tNFMY72ZwFi5z3gEkK1vVor3xcAFvr4DHzr",
  baseVault: "sbpAiun9koRG6WM3TqPH1QrzvqVTZG1B4A5HvjGjKx1",
  quoteVault: "F49WGwEHaHhq4SDpkTGX3mwpMw6axmVdLv6c7gVPXbFL",
  quoteSigner: "A97DopD3nWbcwj89Suma32AhGfGUiLYZZzKqpP3H1PiG",
  treasuryAuthority: "G31RGX9tmr7wE43aDPBHCLigAGn1EvvFQCvayZZm8kSK",
  bridgeProgramId: "BDPQ6wpXukc8YrjRBYFwCHBspWnHSLQjPFPEjgRJ8Riy",
  tokenProgramId: "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk",
  associatedTokenProgramId: "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3",
  systemProgramId: "11111111111111111111111111111111",
} as const);
