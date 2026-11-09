/** Shared mainnet maker and treasury identities; markets bind their own base mint/vault. */
export const MAINNET_RFQ_DEPLOYMENT = Object.freeze({
  quoteMint: "DQcBfwHu8gr8KGt3BE5BDUfBjGgFuDJYm9ByVTDsrww9",
  quoteDecimals: 6,
  programId: "5KMw4VNavLhM5wxTxyQGm8hs5ymFhqMCZ5BpkHybcEBV",
  config: "3jwSNH8P5tNFMY72ZwFi5z3gEkK1vVor3xcAFvr4DHzr",
  quoteVault: "F49WGwEHaHhq4SDpkTGX3mwpMw6axmVdLv6c7gVPXbFL",
  quoteSigner: "A97DopD3nWbcwj89Suma32AhGfGUiLYZZzKqpP3H1PiG",
  treasuryAuthority: "GPoZuMS41Ct92nUUqWyu8dqCY74QkfHRX8N3RsYiTCAT",
  bridgeProgramId: "F5uRFVRuupfFgw1L5x7uWt41ug7MTZr2BfnfZiFj12fk",
  tokenProgramId: "TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk",
  associatedTokenProgramId: "ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3",
  systemProgramId: "11111111111111111111111111111111",
} as const);
