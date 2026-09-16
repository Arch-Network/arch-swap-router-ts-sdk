//! Offline Rust account/size fixtures. No SDK TypeScript code is used.
//! Layouts adapted from arch-swap-router revision 40dd9c6a5fa2dbbf7dc332dcb3d0500b7a0c8958:
//! tests/e2e_three_hop.rs, tests/common/{e2e,e2e_clamm,vault_instructions}.rs.

use arch_program::{account::AccountMeta, hash::Hash, instruction::Instruction, pubkey::Pubkey, sanitized::ArchMessage};
use serde_json::{json, Value};

// arch_program 0.8.7 leaves these logging-only runtime symbols unresolved in
// Windows host builds. They do not participate in PDA derivation or serialization.
#[cfg(windows)]
#[no_mangle]
pub extern "C" fn sol_log_64_(_: u64, _: u64, _: u64, _: u64, _: u64) {}
#[cfg(windows)]
#[no_mangle]
pub extern "C" fn sol_log_pubkey(_: *const u8) {}

const ROUTER: Pubkey = Pubkey::from_str_const("E5j9e2KTsP3cfde7ao8JvkCQzeMC2oKFB3JaaSVps2Uo");
const VAULT: Pubkey = Pubkey::from_str_const("DXSMCcZfjMXe1HTNF1m2CJ5L8zj1cLAKG8SrLvtb3mRa");
const CLAMM: Pubkey = Pubkey::from_str_const("g478Wr3iDLR4NSwE8jj2ufKWw5rZxyR4UCKtVJMBnNK");
const TOKEN: Pubkey = Pubkey::from_str_const("TokenT4em53UrV4gSvZ3nCS2mZeHaqTLapwt6iZt6Mk");
const ATA: Pubkey = Pubkey::from_str_const("ATok9pxLsNzM5zJJ3UQpXBrMriHpZiY5Yio3GKYU4we3");
const SYSTEM: Pubkey = Pubkey::from_str_const("11111111111111111111111111111111");
const USER: Pubkey = Pubkey::from_str_const("Gezw1yUcDjFhKQoJw6zq7nRJTc1MKhcUipNsUfrVpJKF");
const BTC: Pubkey = Pubkey::from_str_const("2yHWVNYyjnsxZqpnvTbPzWiHwpNQ2zBQU6BC4Lnbu7sW");
const USD: Pubkey = Pubkey::from_str_const("6mqUuwPYehXei6mGBY4bQ6XK1z7e6rrFAZRzYKdH8qkp");
const PRIME_BTC: Pubkey = Pubkey::from_str_const("5Ba27gr7DPWvR8oyNZ3q3Jn2cKK2KLEpSgcggzbTQ1fh");
const PRIME_USD: Pubkey = Pubkey::from_str_const("FynmgKXHUgVUToj9LSixpcXq8YirSekcxQjnebkeJ427");
const POOL: Pubkey = Pubkey::from_str_const("6wTjE3LPV8YcoDR4yPQEvpy8KmZEMo3g1iGXpTmpFYUJ");
const AMOUNT: u64 = 123_456;
const MINIMUM: u64 = 1;
const DEADLINE: u64 = 1_800_000_000_123;

fn pda(program: Pubkey, seeds: &[&[u8]]) -> Pubkey {
    Pubkey::try_find_program_address(seeds, &program).unwrap().0
}

fn ata(owner: Pubkey, mint: Pubkey) -> Pubkey {
    pda(ATA, &[owner.as_ref(), TOKEN.as_ref(), mint.as_ref()])
}

fn ro(key: Pubkey) -> AccountMeta { AccountMeta::new_readonly(key, false) }
fn rw(key: Pubkey) -> AccountMeta { AccountMeta::new(key, false) }

struct Hop {
    input: Pubkey,
    output: Pubkey,
    kind: &'static str,
    args: Value,
    data: Vec<u8>,
    accounts: Vec<AccountMeta>,
}

fn vault(share: Pubkey, asset: Pubkey, redeem: bool, separate_fees: bool) -> Hop {
    let vault = pda(VAULT, &[b"vault", share.as_ref()]);
    let manager = Pubkey::new_from_array([if share == PRIME_BTC { 41 } else { 42 }; 32]);
    let protocol = if separate_fees {
        Pubkey::new_from_array([if share == PRIME_BTC { 43 } else { 44 }; 32])
    } else { manager };
    let mut accounts = vec![ro(VAULT), rw(vault), rw(pda(VAULT, &[b"reserve", share.as_ref()]))];
    if redeem {
        accounts.extend([
            rw(pda(VAULT, &[b"escrow", share.as_ref()])),
            rw(pda(VAULT, &[b"redeem", vault.as_ref(), &42u64.to_le_bytes()])),
        ]);
    }
    accounts.extend([
        rw(ata(protocol, share)), rw(ata(manager, share)),
        ro(pda(VAULT, &[b"__event_authority"])),
    ]);
    if redeem { accounts.push(ro(SYSTEM)); }
    let kind = if redeem { "vaultRedeem" } else { "vaultMint" };
    Hop {
        input: if redeem { share } else { asset },
        output: if redeem { asset } else { share },
        kind, args: json!({"kind": kind}), data: vec![u8::from(redeem)], accounts,
    }
}

fn clamm(a_to_b: bool, boundary: bool, supplements: u8) -> Hop {
    // E2E spacing 128, current tick 65_599: base = 56_320, span = 11_264.
    // At the minimum boundary (-443_636), repeat the only valid array.
    let starts = if boundary { [-450_560; 3] } else if a_to_b {
        [56_320, 45_056, 33_792]
    } else { [56_320, 67_584, 78_848] };
    let mut accounts = vec![
        ro(CLAMM), rw(POOL), rw(Pubkey::new_from_array([31; 32])), rw(Pubkey::new_from_array([32; 32])),
    ];
    for start in starts {
        accounts.push(rw(pda(CLAMM, &[b"tick_array", POOL.as_ref(), start.to_string().as_bytes()])));
    }
    accounts.push(rw(pda(CLAMM, &[b"oracle", POOL.as_ref()])));
    for index in 0..supplements {
        accounts.push(rw(pda(CLAMM, &[b"tick_array", POOL.as_ref(), (-11_264 * (i32::from(index) + 1)).to_string().as_bytes()])));
    }
    let data = [vec![2, u8::from(a_to_b)], 0u128.to_le_bytes().to_vec(), vec![supplements]].concat();
    Hop {
        input: if a_to_b { BTC } else { USD }, output: if a_to_b { USD } else { BTC },
        kind: "clamm",
        args: json!({"kind":"clamm", "aToB":a_to_b, "sqrtPriceLimit":"0", "supplementalTickArrayCount":supplements}),
        data, accounts,
    }
}

fn meta(account: &AccountMeta) -> Value {
    json!({"pubkey": account.pubkey.to_string(), "is_signer": account.is_signer, "is_writable": account.is_writable})
}

fn instruction(ix: &Instruction) -> Value {
    json!({"programId": ix.program_id.to_string(), "accounts": ix.accounts.iter().map(meta).collect::<Vec<_>>(), "data": ix.data})
}

fn case(name: &str, hops: Vec<Hop>) -> Value {
    let mints: Vec<_> = std::iter::once(hops[0].input).chain(hops.iter().map(|hop| hop.output)).collect();
    let mut accounts = vec![AccountMeta::new(USER, true), ro(TOKEN)];
    for mint in &mints {
        let writable = hops.iter().any(|hop|
            (hop.kind == "vaultMint" && hop.output == *mint) || (hop.kind == "vaultRedeem" && hop.input == *mint)
        );
        accounts.extend([if writable { rw(*mint) } else { ro(*mint) }, rw(ata(USER, *mint))]);
    }
    for hop in &hops { accounts.extend(hop.accounts.clone()); }
    accounts.extend([ro(ATA), ro(SYSTEM)]);
    let mut data = vec![0];
    data.extend(AMOUNT.to_le_bytes());
    data.extend(MINIMUM.to_le_bytes());
    data.extend(DEADLINE.to_le_bytes());
    data.push(hops.len() as u8);
    for hop in &hops { data.extend(&hop.data); }
    let instructions = vec![
        Instruction { program_id: ATA, accounts: vec![AccountMeta::new(USER, true), rw(ata(USER, mints[0])), ro(USER), ro(mints[0]), ro(SYSTEM), ro(TOKEN)], data: vec![1] },
        Instruction { program_id: ROUTER, accounts, data },
    ];
    let message = ArchMessage::new(&instructions, Some(USER), Hash::default());
    // arch_sdk 0.8.7 RuntimeTransaction::serialize: u32 version, u8 signature
    // count, 64 bytes per signature, then the native serialized ArchMessage.
    let size = 4 + 1 + 64 * usize::from(message.header.num_required_signatures) + message.serialize().len();
    if name.starts_with("three-hop") {
        let separate = name.contains("distinct");
        assert_eq!(size, if separate { 1_275 } else { 1_211 });
        assert_eq!(message.account_keys.len(), if separate { 33 } else { 31 });
    }
    json!({
        "name":name, "user":USER.to_string(), "mints":mints.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "amountIn":AMOUNT.to_string(), "minAmountOut":MINIMUM.to_string(), "deadlineMs":DEADLINE,
        "hops":hops.iter().map(|hop| json!({"args":hop.args, "accounts":hop.accounts.iter().map(meta).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        "instructions":instructions.iter().map(instruction).collect::<Vec<_>>(),
        "expectedSignedSize":size, "expectedAccountKeys":message.account_keys.len(),
    })
}

fn main() {
    let mut cases = Vec::new();
    for (name, share, asset, other, other_share, direction) in [
        ("btc", PRIME_BTC, BTC, USD, PRIME_USD, true),
        ("usd", PRIME_USD, USD, BTC, PRIME_BTC, false),
    ] {
        cases.push(case(&format!("direct-mint-{name}"), vec![vault(share, asset, false, false)]));
        cases.push(case(&format!("direct-redeem-{name}"), vec![vault(share, asset, true, false)]));
        cases.push(case(&format!("direct-clamm-{name}"), vec![clamm(direction, false, 0)]));
        cases.push(case(&format!("two-hop-redeem-clamm-{name}"), vec![vault(share, asset, true, false), clamm(direction, false, 0)]));
        cases.push(case(&format!("two-hop-clamm-mint-{name}"), vec![clamm(direction, false, 0), vault(other_share, other, false, false)]));
        for separate in [false, true] {
            let fees = if separate { "distinct" } else { "shared" };
            cases.push(case(&format!("three-hop-{name}-{fees}"), vec![vault(share, asset, true, separate), clamm(direction, false, 0), vault(other_share, other, false, separate)]));
        }
    }
    cases.push(case("clamm-repeated-boundary-ticks", vec![clamm(true, true, 0)]));
    for count in 1..=3 {
        cases.push(case(&format!("clamm-supplements-{count}"), vec![clamm(true, false, count)]));
    }
    let output = json!({"routerRevision":"40dd9c6a5fa2dbbf7dc332dcb3d0500b7a0c8958", "archProgramVersion":"0.8.7", "cases":cases});
    let path = std::env::args().nth(1).expect("pass the output JSON path");
    std::fs::write(path, serde_json::to_string_pretty(&output).unwrap() + "\n").unwrap();
}
