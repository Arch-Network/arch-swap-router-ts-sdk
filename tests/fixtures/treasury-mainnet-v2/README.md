# Treasury mint deployment verification

Step 1 of the [treasury routing plan](../../../TREASURY_MINT_ROUTING_IMPLEMENTATION_PLAN.md)
was verified on 2026-11-03 using the actual service at
`https://vaults.veloxapi.net/propamm` and `https://rpc.mainnet.arch.network`.

`deployment.json` contains public account images, unsigned dummy-user buy/sell
quotes, the public service health/markets responses, published IDLs, deployed
ELF fingerprints and decoded issuance receipts. Observations were collected
between approximately 21:28 and 21:35 UTC; they are not a synchronized liquidity
snapshot. The buy and sell quotes are historical and must not be submitted.

## Verified deployment matrix

| Identity | Verified value |
|---|---|
| Serving build reported by health | `ced1e64a5982e8897a44e23b59481615da4f2813` (`origin/prime-markets`) |
| Arch mainnet RPC version | `0.13.0` |
| Bridge program | `F5uRFVRuupfFgw1L5x7uWt41ug7MTZr2BfnfZiFj12fk` |
| Bridge config | `37Bbu2eEudSUi5YpEtZiCn4kj2h29QbCNE9AYQNLgctU` |
| aETH asset config | `BxuQNjDHJV8JZfiL576Ps1F6d9f2YS6qmZR2MqfUTTXA` |
| Treasury authority | `GPoZuMS41Ct92nUUqWyu8dqCY74QkfHRX8N3RsYiTCAT` |
| aETH mint authority | `6QhvPC7TYAurSnQgQ2cmeBpJNzDRkNTnwHSjmEGmkHA7` |
| aETH mint / decimals | `7g1nPCjKW7zzZ4q7mcABeFXaPSLfBQ6syrz4HnPGAVYt` / 9 |
| aUSD mint / decimals | `DQcBfwHu8gr8KGt3BE5BDUfBjGgFuDJYm9ByVTDsrww9` / 6 |
| PropAMM program | `5KMw4VNavLhM5wxTxyQGm8hs5ymFhqMCZ5BpkHybcEBV` |
| PropAMM config | `3jwSNH8P5tNFMY72ZwFi5z3gEkK1vVor3xcAFvr4DHzr` |
| PropAMM quote signer | `A97DopD3nWbcwj89Suma32AhGfGUiLYZZzKqpP3H1PiG` |
| aUSD payment vault | `F49WGwEHaHhq4SDpkTGX3mwpMw6axmVdLv6c7gVPXbFL` |
| Router program | `Bu8JuhykFEtJmUqYV98zJDtPr2J7LBMbEJX8DeT7XSeT` |
| Vault program | `BtPdgu3v6ruKYbhiuGLEx7Fa4rU6f15maftGhNRTP32L` |
| CLAMM program | `AzvVQ4qV2DnokUgtxskJ2V11BP5M5Fvx51G3aUgnZm7A` |
| Token program | `TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk` |
| ATA program | `ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3` |

The program accounts above are executable, owned by the BPF loader and have
loader status `Deployed`. The JSON records their payload SHA-256 values and
loader authorities. Router/vault/CLAMM identities match the router workflow's
`mainnet-v2` bindings and the SDK deployment registry. This does not establish
which optional router bindings the serving server has enabled.

The live build is one commit above the pinned `minting` implementation
`de11093e3291c4d18ec211a85038c7e7c80301b3`. Its addition is the market-level
`engine_asset` override. The reported build does not contain the newer CLAMM
validator from local PropAMM `6d700698691113117252d3e896707de88574979a`.
Step 2 must integrate those changes while preserving the active market behavior.

## Account and ABI evidence

- The aETH asset is a bridge-owned tag-11 account. It binds the expected mint,
  9 decimals, canonical mint-authority bump and the dedicated treasury authority.
- The initialized token mint's actual mint authority equals the bridge PDA
  `["mint-authority", aETH]`. That PDA has no allocated account, which is normal:
  the bridge uses it as a CPI signer.
- Bridge config is tag 7 with pause flags 0. The aETH supply limit is
  `5000000000000` base units; observed supply was `98044939`. The unsigned buy's
  nominal mint fits this cap. Treasury authority had `4976636` lamports; this is
  a point-in-time balance, not a rent guarantee for a later swap.
- PropAMM config is v3/115 bytes, owned by the expected program, and its PDA
  derives from its stored config ID. It has a 30,000 ms maximum quote TTL and
  zero inventory skew. Health reports the legacy default input allowance of
  50 bps and default minimum-output slippage of 200 bps. A v4 config migration
  is not required merely to read these defaults.
- The payment vault is an initialized APL token account for aUSD, with the
  PropAMM config as token authority. Its canonical vault PDA matches both the
  service response and SDK pin.
- Canonical bridge IDL address is
  `6QUKnTJnHpqmXf2NvuoNV4PAddgVXDXp8dANcDkxaZM9`. Its owner, discriminator and
  declared compressed payload were validated. Its authority matches the bridge
  loader authority and public mainnet-v2 target:
  `5piVEuw4aoA8LdAGWgAChKxDoLpBPHPtwZbbLKmLtMbL`.
- The entire deployed bridge IDL matches the local v0.4.3 template at bridge
  `399375a5e76c774b06cd7063defd56dabf0c4c18`, after injecting the deployed address
  and metadata spec as the native verifier does. The treasury instruction is
  tag 21 with 11 accounts and arguments `[u8; 32]`, `u64`, `pubkey`.
- Four existing tag-12 treasury receipts were read; two are for aETH and name
  the expected treasury authority. Every receipt's address and bump match
  `["treasury_mint", issuance_id]`, without a mint seed. Their layout matches
  the local permanent-receipt type. This establishes existing on-chain receipt
  state and the replay namespace; fresh replay rejection remains an execution
  test in Step 6.

The old SDK bridge pin `5n1fsUDhPiaALmxpaFCJeFdyTkZkxWXecgurV6dSxMq3` still names
an executable program, but its generic bridge config and aETH asset PDAs are
absent. The old treasury pin `G31RGX9tmr7wE43aDPBHCLigAGn1EvvFQCvayZZm8kSK`
remains the PropAMM config authority, not the current aETH treasury minter.
SDK treasury pins and the independent Rust-generated buy fixture now use the
verified bridge and dedicated signer. Native quote-signer pins are unchanged.

## Quote and runtime evidence

The buy request used a dummy public key and spent `1000000` aUSD base units.
It returned HTTP 200 with:

- a 9-byte APL transfer to the verified payment vault;
- a 73-byte bridge mint, tag 21, paying `435614` aETH base units;
- canonical bridge PDAs, recipient and user ATAs;
- two writable signers: dummy user and dedicated treasury authority;
- 14 unique keys and a measured 738-byte transaction with both signature slots.

The sell request also returned HTTP 200. It remains a native 50-byte
`ExecuteTrade` with the expected PropAMM program, config and quote signer.
Neither quote includes the future `treasury_authorization` extension.

Mainnet `get_version` reports `0.13.0`. The SDK 0.13 constants and matching Arch
source (`4ce467132d6d62635bbd9bbb0099674bf1fc73ad`) specify 4,096 signed bytes and
50 account keys. Those limits were not probed by submitting boundary packets.

The service health response was HTTP 503 with `status = "starting"`,
`price_feed_active = false` and `vault_cache_ready = true`. Both aETH quote
directions nevertheless succeeded. Treat this as a separate service-readiness
finding and recheck before Step 7; it is not evidence that treasury routing is
already executable.

## Evidence collection and limits

Read-only collection used:

1. `GET /health` and `GET /markets` on the actual service URL.
2. `POST /rfq/quote` with the dummy requests retained in `deployment.json`.
3. Mainnet `get_version` and `get_multiple_accounts` for the matrix identities,
   canonical IDLs and account PDAs.
4. `get_program_accounts` for the bridge with filters
   `[{"DataSize":146},{"DataContent":{"offset":0,"bytes":[12]}}]`.
5. Independent PDA derivation, integer decoding, IDL decompression/comparison,
   loader-payload hashing and full-transaction size measurement.

The service's effective public configuration is recorded here. Its raw TOML
path, treasury key filename, pricing-engine URL and enabled router bindings are
not exposed by the public API. The checked-in PropAMM `mainnet-v2.toml` serves
only aBTC at the inspected revisions and is not a substitute for that evidence.
Confirm the actual serving configuration and router/CLAMM bindings during the
server rollout in Step 7.

Published IDL equality proves the declared ABI, not byte-for-byte equivalence
between the deployed ELF and a local build. The observed ELF hashes are retained
without claiming a reproducible-build attestation. No wallet or server signatures
were requested, and no swaps, deployment changes or replay attempts were submitted.

The treasury buy/sell fixtures in `../aeth-usd/transactions.json` were regenerated
with the real Rust builders at `de11093…` and Arch/APL 0.13.0. Verification after
the pin refresh: 940 offline SDK tests passed; 20 live tests and the optional
external-validator test were skipped. Typecheck and package build passed.
