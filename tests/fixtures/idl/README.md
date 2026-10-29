# Router IDL

`arch_swap_router.idl.json` is `idl/arch_swap_router.idl.json` from `Arch-Network/arch-swap-router` at
`63c37f5600223d616b1c2e2fdfc227d3ff46086d` (unchanged through `c1d58dd`), sha256 `0f4d6ba8…de42ab`. The program's
`tests/idl.rs::idl_matches_program_identity_accounts_errors_and_return_data` checks its `errors` against
`src/error.rs` `RouterError`. `tests/program-errors.test.ts` requires `src/program-errors.ts` `ROUTER_ERRORS` to equal
this copy; refresh the copy from the router repository when its error enum changes. Its `address` is the program's
compiled-in testnet id (`E5j9e…`), not a deployment record.
