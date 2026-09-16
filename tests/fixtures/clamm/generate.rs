//! Offline expectations from native CLAMM/vault code. Never imports SDK TypeScript.
use arch_satellite_lang::{prelude::Pubkey, AccountSerialize, Discriminator};
use serde_json::{json, Value};
use std::cell::RefCell;
use whirlpool::{
    manager::swap_manager::swap,
    math::sqrt_price_from_tick_index,
    state::{Tick, TickArray, Whirlpool},
    util::SwapTickSequence,
};

const POOL: Pubkey = Pubkey::from_str_const("6wTjE3LPV8YcoDR4yPQEvpy8KmZEMo3g1iGXpTmpFYUJ");
const BTC: Pubkey = Pubkey::from_str_const("2yHWVNYyjnsxZqpnvTbPzWiHwpNQ2zBQU6BC4Lnbu7sW");
const USD: Pubkey = Pubkey::from_str_const("6mqUuwPYehXei6mGBY4bQ6XK1z7e6rrFAZRzYKdH8qkp");

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

fn pool(tick: i32, spacing: u16, liquidity: u128, fee: u16) -> Whirlpool {
    Whirlpool {
        whirlpools_config: Pubkey::from_str_const("7K98fNhABYBGnRoFKkq9KaJEdLN4c18B9BcF6mC9p8MM"),
        whirlpool_bump: [255], tick_spacing: spacing, tick_spacing_seed: spacing.to_le_bytes(),
        fee_rate: fee, liquidity, sqrt_price: sqrt_price_from_tick_index(tick), tick_current_index: tick,
        token_mint_a: BTC, token_mint_b: USD,
        token_vault_a: Pubkey::new_from_array([31; 32]), token_vault_b: Pubkey::new_from_array([32; 32]),
        ..Default::default()
    }
}

// Native sparse_swap.rs selector is private; match the router's independent e2e selector.
fn starts(pool: &Whirlpool, a_to_b: bool) -> Vec<i32> {
    let span = 88 * i32::from(pool.tick_spacing);
    let base = pool.tick_current_index.div_euclid(span) * span;
    let offsets = if a_to_b { [0, -1, -2] }
        else if pool.tick_current_index + i32::from(pool.tick_spacing) >= base + span { [1, 2, 3] }
        else { [0, 1, 2] };
    offsets.into_iter().map(|o| base + o * span)
        .filter(|s| Tick::check_is_valid_start_tick(*s, pool.tick_spacing)).collect()
}

fn case(name: &str, pool: &Whirlpool, amount: u64, a_to_b: bool, ticks: &[(i32, i128)]) -> Value {
    let starts = starts(pool, a_to_b);
    let last = *starts.last().unwrap();
    let bound = if a_to_b { last.max(-443636) } else { (last + 88 * i32::from(pool.tick_spacing) - 1).min(443636) };
    let limit = sqrt_price_from_tick_index(bound);
    let arrays: Vec<_> = starts.iter().map(|start| {
        let mut array = TickArray { start_tick_index: *start, whirlpool: POOL, ..Default::default() };
        for &(index, liquidity_net) in ticks {
            let offset = (index - start) / i32::from(pool.tick_spacing);
            if index >= *start && offset < 88 {
                assert_eq!((index - start) % i32::from(pool.tick_spacing), 0);
                array.ticks[offset as usize] = Tick { initialized: true, liquidity_net,
                    liquidity_gross: liquidity_net.unsigned_abs(), ..Default::default() };
            }
        }
        RefCell::new(array)
    }).collect();
    let mut bytes = Vec::new(); pool.try_serialize(&mut bytes).unwrap();
    let mut sequence = SwapTickSequence::new(arrays[0].borrow_mut(), arrays.get(1).map(|a| a.borrow_mut()), arrays.get(2).map(|a| a.borrow_mut()));
    let result = swap(pool, &mut sequence, amount, limit, true, a_to_b, 0);
    let expected = match result {
        Ok(result) => json!({
            "amountIn": (if a_to_b { result.amount_a } else { result.amount_b }).to_string(),
            "amountOut": (if a_to_b { result.amount_b } else { result.amount_a }).to_string(),
            "sqrtPrice": result.next_sqrt_price.to_string(), "liquidity": result.next_liquidity.to_string(),
        }),
        Err(error) => json!({ "error": error.to_string() }),
    };
    let ticks: Vec<_> = ticks.iter().map(|(index, net)| json!({"index": index, "liquidityNet": net.to_string()})).collect();
    json!({ "name": name, "pool": hex(&bytes), "starts": starts, "ticks": ticks,
        "amount": amount.to_string(), "aToB": a_to_b, "limit": limit.to_string(), "expected": expected })
}

fn main() {
    let baseline = pool(65599, 128, 1_000_000_000_000, 3000);
    let mut cases = vec![];
    for (name, a_to_b) in [("baseline-a-to-b", true), ("baseline-b-to-a", false)] {
        cases.push(case(name, &baseline, 1_000_000_000, a_to_b, &[]));
    }
    for (name, tick, spacing, liquidity, fee, amount, a_to_b) in [
        ("negative-a-to-b", -129, 128, 1_000_000, 3000, 1000, true),
        ("negative-b-to-a", -129, 128, 1_000_000, 3000, 1000, false),
        ("shifted-b-to-a", -128, 128, 1_000_000, 3000, 1000, false),
        ("lower-bound", -443630, 128, 1_000_000_000_000, 3000, 1000, true),
        ("upper-bound", 443630, 128, 1_000_000_000_000, 3000, 1000, false),
        ("window-exhausted", 0, 128, 1000, 3000, 1_000_000, true),
        ("zero-liquidity", 0, 128, 0, 3000, 1000, false),
        ("fee-dust", 0, 128, 1_000_000, 3000, 1, true),
        ("zero-fee", 0, 128, 1_000_000, 0, 1000, true),
        ("u64-input", 0, 128, 1u128 << 110, 10000, u64::MAX, false),
        ("u256-overflow", 443500, 1, 1u128 << 110, 10000, u64::MAX, true),
        ("limit-equals-price", -443636, 128, 1_000_000, 0, 1000, true),
    ] { cases.push(case(name, &pool(tick, spacing, liquidity, fee), amount, a_to_b, &[])); }
    cases.push(case("cross-gap-right", &pool(500, 8, 100_000, 3000), 2500, false,
        &[(448, 100_000), (768, -100_000), (1120, 100_000), (1536, -100_000)]));
    cases.push(case("cross-gap-left", &pool(1500, 8, 100_000, 3000), 4000, true,
        &[(1280, 100_000), (768, -100_000), (-128, 50_000)]));
    cases.push(case("zero-start-cross", &pool(500, 8, 0, 3000), 1000, false,
        &[(768, 100_000), (1120, -100_000)]));
    cases.push(case("inclusive-left", &pool(0, 8, 100_000, 3000), 1000, true, &[(0, 50_000)]));
    cases.push(case("exclusive-right", &pool(0, 8, 100_000, 3000), 1000, false, &[(0, 50_000)]));
    cases.push(case("liquidity-underflow", &pool(0, 8, 1000, 0), 1000, true, &[(0, 2000)]));
    // Native swap_manager stores next_tick_index - 1 after crossing left at MIN_TICK.
    let mut at_minimum = pool(-443636, 128, 1_000_000, 0);
    at_minimum.tick_current_index = -443637;
    cases.push(case("recover-from-minimum", &at_minimum, 1, false, &[]));

    // Compose native vault plans and native CLAMM swaps, independently of SDK route code.
    let paths = [
        ("aBTC", "primeBTC", vec!["mint"]), ("primeBTC", "aBTC", vec!["redeem"]),
        ("aUSD", "primeUSD", vec!["mint"]), ("primeUSD", "aUSD", vec!["redeem"]),
        ("aBTC", "aUSD", vec!["clamm"]), ("aUSD", "aBTC", vec!["clamm"]),
        ("primeBTC", "aUSD", vec!["redeem", "clamm"]), ("aUSD", "primeBTC", vec!["clamm", "mint"]),
        ("primeUSD", "aBTC", vec!["redeem", "clamm"]), ("aBTC", "primeUSD", vec!["clamm", "mint"]),
        ("primeBTC", "primeUSD", vec!["redeem", "clamm", "mint"]),
        ("primeUSD", "primeBTC", vec!["redeem", "clamm", "mint"]),
    ];
    let routes: Vec<_> = paths.into_iter().map(|(input, output, steps)| {
        use vault_core::{logic::{plan_mint, plan_fill, FillPlan}, state::FeeType};
        let mut amount = 1_000_000_000u64;
        let mut hops = vec![];
        for step in steps {
            amount = match step {
                "mint" => plan_mint(false, amount, 0, 1000, 1000, 60, FeeType::Percentage { bps: 100 },
                    1_000_000_000, 0, 1_000_000_000_000, u64::MAX).unwrap().shares_out,
                "redeem" => match plan_fill(1_000_000_000, 1_000_000_000_000, amount, 0,
                    1_000_000_000, FeeType::Percentage { bps: 30 }).unwrap() {
                        FillPlan::Fill { net, closes: true, .. } => net, _ => panic!("expected full redeem"),
                    },
                _ => {
                    let c = case("route", &baseline, amount, input.ends_with("BTC"), &[]);
                    assert_eq!(c["expected"]["amountIn"], amount.to_string());
                    c["expected"]["amountOut"].as_str().unwrap().parse().unwrap()
                },
            };
            hops.push(amount.to_string());
        }
        json!({"input": input, "output": output, "amountIn": "1000000000", "hops": hops,
            "amountOut": amount.to_string(), "minAmountOut": (u128::from(amount) * 9950 / 10000).to_string() })
    }).collect();
    let ticks: Vec<_> = [-443636, -223027, -11265, -128, -1, 0, 1, 128, 65599, 223027, 443636]
        .into_iter().map(|tick| json!({ "tick": tick, "sqrtPrice": sqrt_price_from_tick_index(tick).to_string() })).collect();
    let mut array = TickArray { start_tick_index: -11264, whirlpool: POOL, ..Default::default() };
    array.ticks[0] = Tick { initialized: true, liquidity_net: -123456789012345678901, liquidity_gross: 123456789012345678901, ..Default::default() };
    array.ticks[87] = Tick { initialized: true, liquidity_net: 987654321, liquidity_gross: 987654321, ..Default::default() };
    let mut bytes = TickArray::DISCRIMINATOR.to_vec(); bytes.extend_from_slice(bytemuck::bytes_of(&array));
    let fixtures = json!({"clammRevision": "6aa46649bc50228e0ba5e37e7219e34125c9b63c", "ticks": ticks, "tickArray": hex(&bytes), "cases": cases, "routes": routes});
    std::fs::write(std::env::args().nth(1).expect("output JSON path"), serde_json::to_string_pretty(&fixtures).unwrap() + "\n").unwrap();
}
