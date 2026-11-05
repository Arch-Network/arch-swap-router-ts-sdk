//! Offline limit-order expectations from native PropAMM code. Never imports SDK TypeScript.
use arch_program::{hash::Hash, instruction::Instruction, pubkey::Pubkey, sanitized::ArchMessage};
use propammprogram::{
    instruction::{cancel_limit_order_instruction, create_limit_order_instruction},
    limit_math::minimum_output_at_limit,
    limit_order::{CreateLimitOrderParams, LimitOrder},
    quote::Side,
    utils::{
        derive_associated_token_address, derive_limit_order_escrow_pda, derive_limit_order_pda,
    },
};
use serde_json::{json, Value};

const CREATED_AT: u64 = 1_800_000_000;
const CLOSED_AT: u64 = 1_800_000_100;

fn key(value: &str) -> Pubkey {
    Pubkey::from_str_const(value)
}

fn side_name(side: Side) -> &'static str {
    if side == Side::Buy { "buy" } else { "sell" }
}

fn instruction(ix: &Instruction) -> Value {
    json!({
        "program_id": ix.program_id.to_string(),
        "accounts": ix.accounts.iter().map(|meta| json!({
            "pubkey": meta.pubkey.to_string(),
            "is_signer": meta.is_signer,
            "is_writable": meta.is_writable,
        })).collect::<Vec<_>>(),
        "data_hex": hex::encode(&ix.data),
    })
}

fn message(ix: &Instruction, payer: Pubkey) -> Value {
    let message = ArchMessage::new(&[ix.clone()], Some(payer), Hash::from([0; 32]));
    json!({
        "num_required_signatures": message.header.num_required_signatures,
        "message_hex": hex::encode(message.serialize()),
    })
}

fn main() {
    let networks = [
        (
            "testnet",
            key("9EqAsENtgBA4Uo4wbS8LVdaQJjMKPpagMxgDVhxEWtKq"),
            key("7X7QM1eEQwgE9b6tA4HMGxWGdzuTvcU9ip9FeZS338yn"),
            key("2yHWVNYyjnsxZqpnvTbPzWiHwpNQ2zBQU6BC4Lnbu7sW"),
            key("6mqUuwPYehXei6mGBY4bQ6XK1z7e6rrFAZRzYKdH8qkp"),
        ),
        (
            "mainnet",
            key("5KMw4VNavLhM5wxTxyQGm8hs5ymFhqMCZ5BpkHybcEBV"),
            key("3jwSNH8P5tNFMY72ZwFi5z3gEkK1vVor3xcAFvr4DHzr"),
            key("78s6DsmwRnCYiQDvAKbJoeAbGDa68zifa1cgqTb4tBbM"),
            key("DQcBfwHu8gr8KGt3BE5BDUfBjGgFuDJYm9ByVTDsrww9"),
        ),
    ];
    let owner = key("9CEiuSgdHtub59syFf4Usf5eEJaEN5eQqEjJNeCatrJs");
    let order_id: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(7).wrapping_add(1));
    let mut cases = Vec::new();
    for (network, program, config, base, quote) in networks {
        for side in [Side::Buy, Side::Sell] {
            let buy = side == Side::Buy;
            // 100 aUSD buys, or 0.001 aBTC sells, at a 100,000 aUSD/aBTC limit (8/6 decimals).
            let input_amount = if buy { 100_000_000 } else { 100_000 };
            let price = "100000";
            let min_output_amount = minimum_output_at_limit(side, input_amount, price, 8, 6).unwrap();
            let params = CreateLimitOrderParams {
                order_id,
                side,
                input_amount,
                min_output_amount,
                fill_allowance_lamports: 10_000,
            };
            let address = derive_limit_order_pda(&program, &config, &owner, &order_id).unwrap();
            let escrow = derive_limit_order_escrow_pda(&program, &address.0).unwrap();
            let (input_mint, output_mint) = if buy { (quote, base) } else { (base, quote) };
            let create =
                create_limit_order_instruction(program, config, owner, owner, base, quote, params.clone())
                    .unwrap();
            // The owner funds creation, so the owner is the recorded rent refund.
            let open = LimitOrder::new(config, owner, base, quote, owner, params, CREATED_AT).unwrap();
            let cancel = cancel_limit_order_instruction(program, owner, &open).unwrap();
            let mut filled = open.clone();
            filled.mark_filled(min_output_amount + 5, CLOSED_AT).unwrap();
            let mut cancelled = open.clone();
            cancelled.mark_cancelled(CLOSED_AT).unwrap();
            cases.push(json!({
                "network": network,
                "side": side_name(side),
                "program": program.to_string(),
                "config": config.to_string(),
                "owner": owner.to_string(),
                "base_mint": base.to_string(),
                "quote_mint": quote.to_string(),
                "order_id_hex": hex::encode(order_id),
                "limit_price": price,
                "base_decimals": 8,
                "quote_decimals": 6,
                "input_amount": input_amount.to_string(),
                "min_output_amount": min_output_amount.to_string(),
                "fill_allowance_lamports": "10000",
                "order": address.0.to_string(),
                "order_bump": address.1,
                "escrow": escrow.0.to_string(),
                "escrow_bump": escrow.1,
                "owner_input_ata": derive_associated_token_address(&owner, &input_mint).unwrap().0.to_string(),
                "owner_output_ata": derive_associated_token_address(&owner, &output_mint).unwrap().0.to_string(),
                "create": instruction(&create),
                "create_message": message(&create, owner),
                "cancel": instruction(&cancel),
                "cancel_message": message(&cancel, owner),
                "accounts": {
                    "open": {
                        "data_hex": hex::encode(borsh::to_vec(&open).unwrap()),
                        "created_at": CREATED_AT.to_string(),
                    },
                    "filled": {
                        "data_hex": hex::encode(borsh::to_vec(&filled).unwrap()),
                        "closed_at": CLOSED_AT.to_string(),
                        "output_amount": (min_output_amount + 5).to_string(),
                    },
                    "cancelled": {
                        "data_hex": hex::encode(borsh::to_vec(&cancelled).unwrap()),
                        "closed_at": CLOSED_AT.to_string(),
                    },
                },
            }));
        }
    }

    // Explicit cases from limit_math.rs tests, evaluated by the native function.
    let mut vectors = vec![
        (Side::Buy, 1_000_000_000, "100000".to_string(), 8, 6),
        (Side::Sell, 1_000_000, "100000".to_string(), 8, 6),
        (Side::Buy, 1_000_000, "0.00000292".to_string(), 5, 6),
        (Side::Sell, 100_000, "0.00000292".to_string(), 5, 6),
        (Side::Sell, u64::MAX, "2".to_string(), 0, 0),
        (Side::Buy, u64::MAX, "0.5".to_string(), 0, 0),
        (Side::Sell, u64::MAX, "340282366920938463463374607431768211455".to_string(), 0, 0),
    ];
    for side in [Side::Buy, Side::Sell] {
        vectors.push((side, u64::MAX, "0001.00000000000000000000".to_string(), 18, 18));
        for price in [
            "", "0", "0.000", "-1", "+1", ".1", "1.", "1e3", "NaN", "inf", " 1", "1 ", "1.2.3", "١",
        ] {
            vectors.push((side, 1, price.to_string(), 0, 0));
        }
        vectors.push((side, 0, "1".to_string(), 8, 6));
        vectors.push((side, 1, "1".to_string(), 39, 0));
        vectors.push((side, 1, "340282366920938463463374607431768211456".to_string(), 0, 0));
    }
    let math = vectors
        .into_iter()
        .map(|(side, input, price, base_decimals, quote_decimals)| {
            let result = minimum_output_at_limit(side, input, &price, base_decimals, quote_decimals);
            json!({
                "side": side_name(side),
                "input_amount": input.to_string(),
                "price": price,
                "base_decimals": base_decimals,
                "quote_decimals": quote_decimals,
                "output": result.as_ref().ok().map(|value| value.to_string()),
                "error": result.as_ref().err().map(|error| error.label()),
            })
        })
        .collect::<Vec<_>>();

    let fixture = json!({
        "source_revision": "2d7fa57e25f5f4583ba065878c0a38d1f290f450",
        "native_arch_sdk_version": "0.13.0",
        "cases": cases,
        "minimum_output_at_limit": math,
    });
    std::fs::write(
        std::env::args().nth(1).expect("output JSON path"),
        serde_json::to_string_pretty(&fixture).unwrap() + "\n",
    )
    .unwrap();
}
