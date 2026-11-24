// Include in server/tests/native_routing/api.rs in a temporary PropAMM archive.
// Uses the real native quote endpoint and loopback node/pricing fixtures only.
#[tokio::test]
async fn export_native_swap_api_sdk_fixtures() {
    async fn capture(http: &Http, name: &str, request: Value) -> Value {
        let (status, quote) = http.post(request.clone()).await;
        assert_eq!(status, StatusCode::OK, "{name}: {quote}");
        let issued = if name == "display-only" {
            let issued = http.state.native_quote_store.get(quote["quote_id"].as_str().unwrap()).unwrap();
            issued.transaction().sanitize().unwrap();
            assert_eq!(quote["required_signers"][0]["pubkey"], request["user_pubkey"]);
            issued
        } else {
            http.assert_issued(&quote)
        };
        json!({
            "name": name, "request": request, "quote": quote,
            "message_hex": hex::encode(issued.message().serialize()),
            "transaction_hex": hex::encode(issued.transaction().serialize()),
        })
    }

    let mut cases = Vec::new();
    let http = Http::new(|_| {}).await;
    cases.push(capture(&http, "treasury", body(3, 1, "9007199254740993")).await);
    cases.push(capture(&http, "two-treasury", body(3, 2, "100000000")).await);

    let mut preview = body(3, 1, "100000000");
    preview["user_pubkey"] = json!(Pubkey::default().to_string());
    cases.push(capture(&http, "display-only", preview).await);

    let mut chain = pricing_tests::fixture(None).await;
    enable(&mut chain);
    chain.config.markets[0].max_sell_input = Some(999);
    let mut state = pricing_tests::state(&chain).await;
    pricing_tests::install_pool(&chain, &mut state, &pool_tests::test_pool(true));
    let http = Http::start(chain, state).await;
    cases.push(capture(&http, "clamm", body(1, 2, "1000")).await);

    for (a_to_b, path, name) in [
        (true, [3, 1, 2, 4], "mixed-three-hop"),
        (false, [4, 2, 1, 3], "mixed-three-hop-reverse"),
    ] {
        let mut chain = pricing_tests::fixture(None).await;
        enable(&mut chain);
        let mut fourth = chain.config.tokens[1].clone();
        fourth.symbol = "tALT".into();
        fourth.mint_pubkey = mint(4);
        chain.config.tokens.push(fourth);
        {
            let mut mints = chain.rpc.control.mint_responses.lock().unwrap();
            let six_decimal_mint = mints[&Pubkey::new_from_array([2; 32])].clone();
            mints.insert(Pubkey::new_from_array([4; 32]), six_decimal_mint);
        }
        let mut last_market = chain.config.markets[0].clone();
        last_market.base_symbol = "tALT".into();
        last_market.price_asset_key = "alt".into();
        last_market.coinbase_product_id = "ALT-USD".into();
        chain.config.markets = vec![chain.config.markets[1].clone(), last_market];
        let mut state = pricing_tests::state(&chain).await;
        state.price_feed.set_test_price(
            ("alt".into(), "usd".into()), "1", std::time::Duration::from_secs(60),
        );
        pricing_tests::install_pool(&chain, &mut state, &pool_tests::test_pool(a_to_b));
        let http = Http::start(chain, state).await;
        let mut request = body(path[0], path[3], "100000000");
        request["slippage_bps"] = json!(50);
        cases.push(capture(&http, name, request).await);
    }

    let output = std::env::var("NATIVE_SWAP_FIXTURES_OUT").unwrap();
    std::fs::write(
        output,
        serde_json::to_string_pretty(&json!({
            "propamm_revision": "6fb6483",
            "cases": cases,
        })).unwrap() + "\n",
    ).unwrap();
}
