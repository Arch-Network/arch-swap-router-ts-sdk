//! Standalone native buy exporter against the current PropAMM program crate.
use arch_program::{hash::Hash, pubkey::Pubkey, sanitize::Sanitize, sanitized::ArchMessage};
use arch_sdk::{RuntimeTransaction, Signature};
use propammprogram::{
    instruction::execute_trade_instruction,
    quote::{Quote, Side},
    utils::{derive_associated_token_address, derive_user_nonce_pda, derive_vault_pda},
};

fn key(value: &str) -> Pubkey { Pubkey::from_str_const(value) }

fn main() {
    let program = key("5KMw4VNavLhM5wxTxyQGm8hs5ymFhqMCZ5BpkHybcEBV");
    let config = key("3jwSNH8P5tNFMY72ZwFi5z3gEkK1vVor3xcAFvr4DHzr");
    let maker = key("A97DopD3nWbcwj89Suma32AhGfGUiLYZZzKqpP3H1PiG");
    let base = key("7g1nPCjKW7zzZ4q7mcABeFXaPSLfBQ6syrz4HnPGAVYt");
    let quote_mint = key("DQcBfwHu8gr8KGt3BE5BDUfBjGgFuDJYm9ByVTDsrww9");
    let user = key("9CEiuSgdHtub59syFf4Usf5eEJaEN5eQqEjJNeCatrJs");
    let now = 1_800_000_000_000u64;
    let quote = Quote {
        base_mint: base, quote_mint, side: Side::Buy,
        base_amount: 400_000, quote_amount: 1_000_000, user_pubkey: user,
        expiry_ts: now + 30_000, nonce: now,
    };
    let min_out = quote.base_amount * 99 / 100;
    let instruction = execute_trade_instruction(
        quote.clone(), quote.input_amount(), Some(min_out), program, config, maker, user,
        derive_user_nonce_pda(&program, &config, &user).unwrap().0,
        derive_vault_pda(&program, &config, &base).unwrap().0,
        derive_vault_pda(&program, &config, &quote_mint).unwrap().0,
        derive_associated_token_address(&user, &base).unwrap().0,
        derive_associated_token_address(&user, &quote_mint).unwrap().0,
        base, quote_mint, arch_program::system_program::SYSTEM_PROGRAM_ID, apl_token::id(),
    ).unwrap();
    let message = ArchMessage::new(&[instruction], Some(user), Hash::from([0x55; 32]));
    let transaction = RuntimeTransaction { version: 0, signatures: vec![], message };
    let mut measured = transaction.clone();
    measured.signatures = vec![Signature([0; 64]), Signature([0; 64])];
    measured.sanitize().unwrap();
    let fixture = serde_json::json!({
        "source_revision": "6d700698691113117252d3e896707de88574979a",
        "native_arch_sdk_version": "0.13.0", "now_ms": now, "user": user.to_string(),
        "input_mint": quote_mint.to_string(), "output_mint": base.to_string(),
        "amount_in": quote.input_amount().to_string(), "estimated_amount_out": quote.base_amount.to_string(),
        "min_amount_out": min_out.to_string(), "expires_at_ms": quote.expiry_ts,
        "server_signer": maker.to_string(), "signed_size": measured.serialize().len(),
        "transaction_hex": hex::encode(transaction.serialize()),
    });
    std::fs::write(std::env::args().nth(1).expect("output JSON path"),
        serde_json::to_string_pretty(&fixture).unwrap() + "\n").unwrap();
}
