// Compile the external validator, treasury authorization and native mint builder
// unchanged. These small context types/helpers stand in for the HTTP server.
// This replay does not sign, submit or execute transactions.
#![allow(dead_code)]
use arch_program::{pubkey::Pubkey, sanitize::Sanitize, sanitized::ArchMessage};
use propammprogram::{
    quote::{Quote, Side},
    utils::derive_vault_pda,
};

mod error {
    #[derive(Debug)]
    pub enum ServerError {
        RfqInvalidRouterTransaction(&'static str),
        MintPubkey {
            label: String,
            detail: String,
        },
        RfqTransactionSanitize {
            source: arch_program::sanitize::SanitizeError,
        },
        ProgramInstruction(propammprogram::error::PropAmmError),
        TreasuryMint(&'static str),
        NotEnoughInventoryForRequestedQuote {
            payout: u64,
            limit: u64,
        },
    }
    pub type Result<T> = std::result::Result<T, ServerError>;
}

mod market {
    pub struct Market {
        pub treasury_mint_program: Option<arch_program::pubkey::Pubkey>,
    }
}

mod chain {
    use super::*;
    #[derive(Clone, Copy)]
    pub struct BuiltQuoteEstimate {
        pub base_amount: u64,
        pub quote_amount: u64,
    }
    pub struct PreparedQuote {
        pub quote: Quote,
        pub message: ArchMessage,
        pub quote_vault_pubkey: Pubkey,
        pub estimated_quote: BuiltQuoteEstimate,
    }
    pub fn treasury_mint_bridge(market: &market::Market, side: Side) -> Option<Pubkey> {
        market.treasury_mint_program.filter(|_| side == Side::Buy)
    }
}

mod rfq {
    use super::*;
    pub struct IssuedRfqQuote {
        pub prepared: chain::PreparedQuote,
        pub market: market::Market,
        pub treasury_authorization: Option<treasury_routing::TreasuryAuthorization>,
        pub payout_limit: Option<u64>,
    }
    pub fn validate_payout_limit(
        side: Side,
        estimate: chain::BuiltQuoteEstimate,
        limit: Option<u64>,
    ) -> error::Result<()> {
        let payout = if side == Side::Buy {
            estimate.base_amount
        } else {
            estimate.quote_amount
        };
        if let Some(limit) = limit {
            if payout > limit {
                return Err(error::ServerError::NotEnoughInventoryForRequestedQuote {
                    payout,
                    limit,
                });
            }
        }
        Ok(())
    }
}

#[path = __VALIDATOR_PATH__]
mod router_transaction;
#[path = __TREASURY_MINT_PATH__]
mod treasury_mint;
#[path = __TREASURY_ROUTING_PATH__]
mod treasury_routing;

fn key(value: &str) -> Pubkey {
    Pubkey::from_slice(&bs58::decode(value).into_vec().unwrap())
}

fn main() {
    let path = std::env::args().nth(1).expect("SDK packet JSON path");
    let data: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let text = |name: &str| data[name].as_str().unwrap();
    let programs = router_transaction::RouterPrograms {
        router: key(text("router")),
        vault: Some(key(text("vault"))),
        clamm: Some(key(text("clamm"))),
    };
    let (propamm, config, user) = (key(text("program")), key(text("config")), key(text("user")));
    let bridge = key(text("bridge"));
    let now = data["now"].as_u64().unwrap();
    for item in data["results"].as_array().unwrap() {
        let base = key(item["baseMint"].as_str().unwrap());
        let quote_mint = key(item["quoteMint"].as_str().unwrap());
        let treasury = item["treasury"].as_bool().unwrap();
        let maker = key(text(if treasury {
            "treasuryAuthority"
        } else {
            "maker"
        }));
        let number = |name: &str| {
            item["terms"][name]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        };
        let side = match item["terms"]["side"].as_str().unwrap() {
            "buy" => Side::Buy,
            "sell" => Side::Sell,
            _ => panic!("invalid side"),
        };
        let quote = Quote {
            base_mint: base,
            quote_mint,
            side,
            base_amount: number("baseAmount"),
            quote_amount: number("quoteAmount"),
            user_pubkey: user,
            expiry_ts: number("expiry"),
            nonce: number("nonce"),
        };
        let native: arch_sdk::RuntimeTransaction =
            serde_json::from_value(item["nativeTransaction"].clone()).unwrap();
        let mut issued = rfq::IssuedRfqQuote {
            prepared: chain::PreparedQuote {
                estimated_quote: chain::BuiltQuoteEstimate {
                    base_amount: quote.base_amount,
                    quote_amount: quote.quote_amount,
                },
                quote,
                message: native.message,
                quote_vault_pubkey: derive_vault_pda(&propamm, &config, &quote_mint).unwrap().0,
            },
            market: market::Market {
                treasury_mint_program: treasury.then_some(bridge),
            },
            treasury_authorization: None,
            payout_limit: None,
        };
        // Derive authorization with the actual server code, independently of the
        // SDK's encoded terms, then compare the original provider metadata.
        issued.treasury_authorization = treasury_routing::authorize(
            &issued.prepared,
            &issued.market,
            item["allowanceBps"].as_u64().unwrap() as u16,
            issued.payout_limit,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(issued.treasury_authorization).unwrap(),
            item["authorization"]
        );

        let tx: arch_sdk::RuntimeTransaction =
            serde_json::from_value(item["transaction"].clone()).unwrap();
        tx.sanitize().unwrap();
        assert_eq!(
            tx.serialize_with_size_limit().unwrap().len() as u64,
            item["signedSize"].as_u64().unwrap()
        );
        assert_eq!(
            tx.message.account_keys.len() as u64,
            item["accounts"].as_u64().unwrap()
        );
        let expected = item["rfqFirst"]
            .as_bool()
            .unwrap()
            .then(|| issued.prepared.quote.input_amount());
        let validate = |message: &ArchMessage, programs| {
            if treasury {
                router_transaction::validate_treasury(
                    message, &issued, programs, propamm, config, maker, now,
                )
            } else {
                router_transaction::validate(
                    message, &issued, programs, propamm, config, maker, now,
                )
                .map(|amount| assert_eq!(amount, expected))
            }
        };
        validate(&tx.message, programs).unwrap();
        assert_eq!(
            tx.message.instructions.last().unwrap().data[25] as u64,
            item["hops"].as_u64().unwrap()
        );
        if treasury {
            assert!(router_transaction::validate(
                &tx.message,
                &issued,
                programs,
                propamm,
                config,
                maker,
                now
            )
            .is_err());
        } else {
            let checked = router_transaction::check_route(
                &tx.message,
                tx.message.instructions.len() - 1,
                &issued,
                programs,
                propamm,
                config,
                maker,
                now,
            )
            .unwrap();
            assert_eq!(checked.step_count as u64, item["hops"].as_u64().unwrap());
        }

        // Treasury: issuance ID, nominal input/output, both bounds and expiry.
        let offset = item["rfqOffset"].as_u64().unwrap() as usize;
        let fields: &[usize] = if treasury {
            &[1, 33, 41, 49, 57, 65]
        } else {
            &[2]
        };
        for field in fields {
            let mut wrong_terms = tx.message.clone();
            wrong_terms.instructions.last_mut().unwrap().data[offset + field] ^= 1;
            assert!(
                validate(&wrong_terms, programs).is_err(),
                "accepted altered field {field}"
            );
        }
        if treasury {
            let mut readonly_signer = tx.message.clone();
            readonly_signer.header.num_readonly_signed_accounts = 1;
            assert!(validate(&readonly_signer, programs).is_err());
            let recipient = propammprogram::utils::derive_associated_token_address(&user, &base)
                .unwrap()
                .0;
            for target in [
                bridge,
                maker,
                base,
                issued.prepared.quote_vault_pubkey,
                recipient,
            ] {
                let mut substituted = tx.message.clone();
                let position = substituted
                    .account_keys
                    .iter()
                    .position(|k| *k == target)
                    .unwrap();
                substituted.account_keys[position] = Pubkey::new_from_array([0xab; 32]);
                assert!(validate(&substituted, programs).is_err());
            }
            if item["allowanceBps"].as_u64().unwrap() != 0 {
                // Regression: invented nominal-only bounds cannot replace the
                // interval frozen under the original quote ID.
                let mut fixed = tx.message.clone();
                let route = &mut fixed.instructions.last_mut().unwrap().data;
                let nominal = issued.prepared.quote.quote_amount.to_le_bytes();
                route[offset + 49..offset + 57].copy_from_slice(&nominal);
                route[offset + 57..offset + 65].copy_from_slice(&nominal);
                assert!(validate(&fixed, programs).is_err());
            }
        }
        if item["mixed"].as_bool().unwrap() {
            assert!(validate(
                &tx.message,
                router_transaction::RouterPrograms {
                    clamm: None,
                    ..programs
                }
            )
            .is_err());
            let oracle = Pubkey::try_find_program_address(
                &[b"oracle", key(text("pool")).as_ref()],
                &programs.clamm.unwrap(),
            )
            .unwrap()
            .0;
            for target in [programs.clamm.unwrap(), oracle] {
                let mut invalid = tx.message.clone();
                let position = invalid
                    .account_keys
                    .iter()
                    .position(|k| *k == target)
                    .unwrap();
                invalid.account_keys[position] = Pubkey::new_from_array([0xab; 32]);
                assert!(validate(&invalid, programs).is_err());
            }
        }
        println!("accepted {} {} -> {}: {} hops, {} reads, {} signed bytes, {} accounts, {} bps; tampering rejected",
            if treasury { "treasury" } else { "native" },
            item["inputMint"].as_str().unwrap(), item["outputMint"].as_str().unwrap(),
            item["hops"], item["reads"], item["signedSize"], item["accounts"], item["allowanceBps"]);
        if treasury {
            issued.treasury_authorization = None;
            assert!(router_transaction::validate_treasury(
                &tx.message,
                &issued,
                programs,
                propamm,
                config,
                maker,
                now
            )
            .is_err());
        }
    }
}
