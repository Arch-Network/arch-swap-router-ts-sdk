//! Standalone exporter; copy the pinned server's treasury_mint.rs alongside this file.
#![allow(dead_code)]

mod error {
    #[derive(Debug)]
    pub enum ServerError {
        TreasuryMint(&'static str),
    }
    pub type Result<T> = std::result::Result<T, ServerError>;
}
mod treasury_mint;

use arch_program::{hash::Hash, pubkey::Pubkey, sanitize::Sanitize, sanitized::ArchMessage};
use arch_sdk::{RuntimeTransaction, Signature};
use propammprogram::{
    instruction::execute_trade_instruction,
    quote::{Quote, Side},
    utils::{derive_associated_token_address, derive_user_nonce_pda, derive_vault_pda},
};
use serde_json::json;

const NOW_MS: u64 = 1_800_000_000_000;
const EXPIRY_MS: u64 = NOW_MS + 30_000;

fn key(value: &str) -> Pubkey {
    Pubkey::from_str_const(value)
}

fn main() {
    let program = key("5KMw4VNavLhM5wxTxyQGm8hs5ymFhqMCZ5BpkHybcEBV");
    let config = key("3jwSNH8P5tNFMY72ZwFi5z3gEkK1vVor3xcAFvr4DHzr");
    let maker = key("A97DopD3nWbcwj89Suma32AhGfGUiLYZZzKqpP3H1PiG");
    let treasury = key("G31RGX9tmr7wE43aDPBHCLigAGn1EvvFQCvayZZm8kSK");
    let bridge = key("BDPQ6wpXukc8YrjRBYFwCHBspWnHSLQjPFPEjgRJ8Riy");
    let base = key("AzuWEhnYUv6NTAFrC2MtzKb4nASh6sCMcD15WUmoFR45");
    let quote_mint = key("DQcBfwHu8gr8KGt3BE5BDUfBjGgFuDJYm9ByVTDsrww9");
    let user = key("9CEiuSgdHtub59syFf4Usf5eEJaEN5eQqEjJNeCatrJs");
    let base_vault = derive_vault_pda(&program, &config, &base).unwrap().0;
    let quote_vault = derive_vault_pda(&program, &config, &quote_mint).unwrap().0;
    let mut cases = Vec::new();

    for side in [Side::Buy, Side::Sell] {
        let buy = side == Side::Buy;
        let quote = Quote {
            base_mint: base,
            quote_mint,
            side,
            base_amount: if buy { 400 } else { 1_000 },
            quote_amount: if buy { 1_000_000 } else { 2_500_000 },
            user_pubkey: user,
            expiry_ts: EXPIRY_MS,
            nonce: NOW_MS,
        };
        let payout = if buy { quote.base_amount } else { quote.quote_amount };
        let min_out = if buy { payout } else { payout * 99 / 100 };
        let instructions = if buy {
            treasury_mint::buy_instructions(bridge, treasury, &quote, quote_vault, [0x44; 32])
                .unwrap()
        } else {
            vec![execute_trade_instruction(
                quote.clone(),
                quote.input_amount(),
                Some(min_out),
                program,
                config,
                maker,
                user,
                derive_user_nonce_pda(&program, &config, &user).unwrap().0,
                base_vault,
                quote_vault,
                derive_associated_token_address(&user, &base).unwrap().0,
                derive_associated_token_address(&user, &quote_mint).unwrap().0,
                base,
                quote_mint,
                arch_program::system_program::SYSTEM_PROGRAM_ID,
                apl_token::id(),
            )
            .unwrap()]
        };
        let message = ArchMessage::new(&instructions, Some(user), Hash::from([0x55; 32]));
        let transaction = RuntimeTransaction { version: 0, signatures: vec![], message };
        let mut measured = transaction.clone();
        measured.signatures = vec![Signature([0; 64]), Signature([0; 64])];
        measured.sanitize().unwrap();
        cases.push(json!({
            "side": if buy { "buy" } else { "sell" },
            "input_mint": if buy { quote_mint } else { base }.to_string(),
            "output_mint": if buy { base } else { quote_mint }.to_string(),
            "amount_in": quote.input_amount().to_string(),
            "estimated_amount_out": payout.to_string(),
            "min_amount_out": min_out.to_string(),
            "expires_at_ms": EXPIRY_MS,
            "server_signer": if buy { treasury } else { maker }.to_string(),
            "signed_size": measured.serialize().len(),
            "transaction_hex": hex::encode(transaction.serialize()),
        }));
    }
    let fixture = json!({
        "source_revision": "dfdbc9a36646066cbec067fa9e9a700232804855",
        "native_arch_sdk_version": "0.12.0",
        "now_ms": NOW_MS,
        "user": user.to_string(),
        "cases": cases,
    });
    std::fs::write(
        std::env::args().nth(1).expect("output JSON path"),
        serde_json::to_string_pretty(&fixture).unwrap() + "\n",
    )
    .unwrap();
}
