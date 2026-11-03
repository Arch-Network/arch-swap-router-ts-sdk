// Compiles the external server's unmodified validator, with only its surrounding
// error/issued-quote types stubbed. No HTTP, signatures, submission or execution.
#![allow(dead_code)]
use arch_program::sanitize::Sanitize;
mod error {
    #[derive(Debug)]
    pub enum ServerError {
        RfqInvalidRouterTransaction(&'static str),
        MintPubkey { label: String, detail: String },
        RfqTransactionSanitize { source: arch_program::sanitize::SanitizeError },
        ProgramInstruction(propammprogram::error::PropAmmError),
    }
    pub type Result<T> = std::result::Result<T, ServerError>;
}
mod rfq {
    pub struct Prepared { pub quote: propammprogram::quote::Quote }
    pub struct IssuedRfqQuote { pub prepared: Prepared }
}
#[path = __VALIDATOR_PATH__]
mod router_transaction;

fn key(value: &str) -> arch_program::pubkey::Pubkey {
    arch_program::pubkey::Pubkey::from_slice(&bs58::decode(value).into_vec().unwrap())
}
fn main() {
    let path = std::env::args().nth(1).expect("SDK packet JSON path");
    let data: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let text = |name: &str| data[name].as_str().unwrap();
    let number = |name: &str| text(name).parse::<u64>().unwrap();
    let issued = rfq::IssuedRfqQuote { prepared: rfq::Prepared { quote: propammprogram::quote::Quote {
        base_mint: key(text("base")), quote_mint: key(text("quote")), side: propammprogram::quote::Side::Sell,
        base_amount: number("baseAmount"), quote_amount: number("quoteAmount"), user_pubkey: key(text("user")),
        expiry_ts: number("expiry"), nonce: number("nonce"),
    } } };
    let programs = router_transaction::RouterPrograms {
        router: key(text("router")), vault: Some(key(text("vault"))), clamm: Some(key(text("clamm"))),
    };
    for item in data["results"].as_array().unwrap() {
        let tx: arch_sdk::RuntimeTransaction = serde_json::from_value(item["transaction"].clone()).unwrap();
        tx.sanitize().unwrap();
        assert_eq!(tx.serialize_with_size_limit().unwrap().len() as u64, item["signedSize"].as_u64().unwrap());
        assert_eq!(tx.message.account_keys.len() as u64, item["accounts"].as_u64().unwrap());
        let validate = |message: &arch_program::sanitized::ArchMessage, programs| {
            router_transaction::validate(message, &issued, programs, key(text("program")),
                key(text("config")), key(text("maker")), data["now"].as_u64().unwrap())
        };
        assert_eq!(validate(&tx.message, programs).unwrap(), Some(number("baseAmount")));
        let checked = router_transaction::check_route(&tx.message, tx.message.instructions.len() - 1,
            &issued, programs, key(text("program")), key(text("config")), key(text("maker")),
            data["now"].as_u64().unwrap()).unwrap();
        assert_eq!(checked.step_count as u64, item["hops"].as_u64().unwrap());
        let mut wrong_terms = tx.message.clone();
        wrong_terms.instructions.last_mut().unwrap().data[28] ^= 1;
        assert!(validate(&wrong_terms, programs).is_err());
        if item["mixed"].as_bool().unwrap() {
            assert!(validate(&tx.message, router_transaction::RouterPrograms { clamm: None, ..programs }).is_err());
            let oracle = arch_program::pubkey::Pubkey::try_find_program_address(
                &[b"oracle", key(text("pool")).as_ref()], &programs.clamm.unwrap()).unwrap().0;
            for target in [programs.clamm.unwrap(), oracle] {
                let mut invalid = tx.message.clone();
                let position = invalid.account_keys.iter().position(|k| *k == target).unwrap();
                invalid.account_keys[position] = arch_program::pubkey::Pubkey::from_slice(&[0xab; 32]);
                assert!(validate(&invalid, programs).is_err());
            }
        }
        println!("accepted {}: {} hops, {} reads, {} signed bytes, {} accounts; tampering rejected",
            item["outputMint"].as_str().unwrap(), item["hops"], item["reads"], item["signedSize"], item["accounts"]);
    }
}
