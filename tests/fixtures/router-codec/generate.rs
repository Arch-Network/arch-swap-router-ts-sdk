//! Standalone fixture producer; no TypeScript implementation or dependencies.
//! Adapted from arch-swap-router at 40dd9c6a5fa2dbbf7dc332dcb3d0500b7a0c8958:
//! tests/idl.rs, tests/instruction_dispatch.rs, tests/route_result.rs, src/result.rs.
//! See README.md for provenance, additional boundary cases, and regeneration.

use std::fmt::Write;

#[derive(Clone)]
enum Step {
    Mint,
    Redeem,
    Clamm(bool, u128, u8),
}

impl Step {
    fn bytes(&self) -> Vec<u8> {
        match self {
            Self::Mint => vec![0],
            Self::Redeem => vec![1],
            Self::Clamm(a_to_b, limit, supplements) => [
                vec![2, u8::from(*a_to_b)],
                limit.to_le_bytes().to_vec(),
                vec![*supplements],
            ]
            .concat(),
        }
    }

    fn json(&self) -> String {
        match self {
            Self::Mint => r#"{"kind":"vaultMint"}"#.into(),
            Self::Redeem => r#"{"kind":"vaultRedeem"}"#.into(),
            Self::Clamm(a_to_b, limit, supplements) => format!(
                r#"{{"kind":"clamm","aToB":{a_to_b},"sqrtPriceLimit":"{limit}","supplementalTickArrayCount":{supplements}}}"#,
            ),
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::new();
    for byte in bytes {
        write!(output, "{byte:02x}").unwrap();
    }
    output
}

fn instruction(name: &str, amount: u64, minimum: u64, deadline: u64, steps: Vec<Step>) -> String {
    // Framing copied from tests/idl.rs's independent fixture construction.
    let mut data = vec![0];
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&minimum.to_le_bytes());
    data.extend_from_slice(&deadline.to_le_bytes());
    data.push(steps.len() as u8);
    for step in &steps {
        data.extend(step.bytes());
    }
    let steps = steps.iter().map(Step::json).collect::<Vec<_>>().join(",");
    let wire = hex(&data);
    format!(
        r#"    {{"name":"{name}","amountIn":"{amount}","minAmountOut":"{minimum}","deadlineMs":"{deadline}","steps":[{steps}],"hex":"{wire}"}}"#,
    )
}

fn result(name: &str, amount_in: u64, amount_out: u64) -> String {
    // src/result.rs::RouteResultV1::pack, including its full u64 framing domain.
    let mut data = [0; 17];
    data[0] = 1;
    data[1..9].copy_from_slice(&amount_in.to_le_bytes());
    data[9..17].copy_from_slice(&amount_out.to_le_bytes());
    let wire = hex(&data);
    format!(
        r#"    {{"name":"{name}","amountIn":"{amount_in}","amountOut":"{amount_out}","hex":"{wire}"}}"#,
    )
}

fn main() {
    let mut instructions = Vec::new();
    // All 24 combinations in idl_decodes_one_two_and_three_hop_wire_fixtures.
    for a_to_b in [false, true] {
        for limit in [0, (1u128 << 96) + 123] {
            let clamm = Step::Clamm(a_to_b, limit, 3);
            for (name, steps) in [
                ("mint", vec![Step::Mint]),
                ("redeem", vec![Step::Redeem]),
                ("clamm", vec![clamm.clone()]),
                ("clamm-mint", vec![clamm.clone(), Step::Mint]),
                ("redeem-clamm", vec![Step::Redeem, clamm.clone()]),
                ("redeem-clamm-mint", vec![Step::Redeem, clamm, Step::Mint]),
            ] {
                instructions.push(instruction(
                    &format!("idl-{name}-direction-{a_to_b}-limit-{limit}"),
                    10_000_000, 1, u64::MAX, steps,
                ));
            }
        }
    }
    // Supported cases from instruction_dispatch.rs (reserved PropAMM excluded).
    for (name, steps) in [
        ("mint", vec![Step::Mint]),
        ("redeem", vec![Step::Redeem]),
        ("clamm", vec![Step::Clamm(true, 123, 3)]),
        ("redeem-mint", vec![Step::Redeem, Step::Mint]),
    ] {
        instructions.push(instruction(&format!("dispatch-{name}"), 100, 90, 1_000, steps));
    }
    // Additional cases over the current Rust parser's accepted framing domain.
    instructions.push(instruction("zero-deadline", 1, 1, 0, vec![Step::Mint]));
    instructions.push(instruction(
        "millisecond-deadline", 0x0102_0304_0506_0708, 0x1112_1314_1516_1718,
        1_800_000_000_123, vec![Step::Redeem],
    ));
    instructions.push(instruction(
        "full-width-three-clamm", u64::MAX, u64::MAX, u64::MAX,
        vec![Step::Clamm(false, u128::MAX, 0), Step::Clamm(true, 1, 1), Step::Clamm(false, (1u128 << 96) + 123, 2)],
    ));

    let mut results = vec![
        result("idl-result", u64::MAX, 123),
        result("little-endian", 0x0102_0304_0506_0708, 0x1112_1314_1516_1718),
        result("length-and-version-tests", 100, 95),
    ];
    for amount_in in [0, 1, u64::MAX] {
        for amount_out in [0, 1, u64::MAX] {
            results.push(result(&format!("bounds-{amount_in}-{amount_out}"), amount_in, amount_out));
        }
    }
    let output = format!(
        "{{\n  \"sourceRevision\": \"40dd9c6a5fa2dbbf7dc332dcb3d0500b7a0c8958\",\n  \"instructions\": [\n{}\n  ],\n  \"results\": [\n{}\n  ]\n}}\n",
        instructions.join(",\n"), results.join(",\n"),
    );
    if let Some(path) = std::env::args().nth(1) {
        std::fs::write(path, output).unwrap();
    } else {
        print!("{output}");
    }
}
