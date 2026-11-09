# Mainnet Prime sell responses

`quotes.json` contains unsigned responses from
`https://vaults.veloxapi.net/propamm/rfq/quote`, captured on 2026-11-09.
The caller is a dummy public key of 32 `01` bytes. No signatures, submissions
or funded execution were involved. `now` records the quote request time.

The public `/markets` catalog lists primeBTC/aUSD and primeUSD/aUSD with
custody accounts `5E6Dd3HcQoD6zQHbrCpVAXBYQ4W1hzw2tzyiFu1tqdqx` and
`28nmA1gp11VBdmbzdrGTNHe7h2Yo5PagxeJvV6vSC6P9`. Both use aUSD custody
`F49WGwEHaHhq4SDpkTGX3mwpMw6axmVdLv6c7gVPXbFL`. `/health` confirmed the
shared mainnet PropMM program, config and quote signer already pinned by
`src/config/rfq-deployment.ts`. A primeBTC/aBTC quote was rejected as an
unsupported pair. These fixtures demonstrate packet compatibility, not
acceptance of a signed router transaction by the co-signing service.
