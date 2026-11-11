`ahype-usd.json` records an unsigned mainnet `/rfq/quote` sell packet from 2026-11-11.
Its two instructions pay aHYPE into the maker's aHYPE vault and treasury-mint aUSD.
No transaction was signed or submitted. The captured server predates sell routing
authorization, so the tests add synthetic bounds and expiry metadata explicitly.
The aETH cases rebind the input mint, its vault and the user's input token account;
their output rate and the core vault/pool state are synthetic.
