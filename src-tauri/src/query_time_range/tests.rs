use super::*;
use serde_json::json;

const ANCHOR: &str = "2026-10-09T12:00:00.123Z";

fn relative() -> QueryTimeRange {
    serde_json::from_value(json!({
        "version": 1,
        "definition": { "field": "@timestamp", "fieldType": "date", "timeZone": "Asia/Shanghai",
            "range": { "kind": "relative", "amount": 15, "unit": "minutes" } },
        "bounds": { "resolvedAt": ANCHOR, "from": "2026-10-09T11:45:00.123000000Z", "to": "2026-10-09T12:00:00.123000000Z" },
        "binding": { "connectionId": "connection", "index": "orders" }, "hadQuery": true
    })).unwrap()
}

fn body(time: &QueryTimeRange) -> String {
    let range = json!({"range":{&time.definition.field:{
        "gte": time.bounds.from, "lt": time.bounds.to, "format": "strict_date_optional_time_nanos"
    }}});
    format!(
        r#"{{"query":{{"bool":{{"must":[{{"term":{{"sequence":9007199254740993}}}}],"filter":[{range}]}}}},"size":25}}"#
    )
}

fn valid(time: &QueryTimeRange) -> bool {
    time.validate(Some("connection"), "orders", &body(time))
        .is_ok()
}

fn absolute(
    from: &str,
    to: &str,
    zone: &str,
    utc_from: &str,
    utc_to: &str,
    field_type: TimeFieldType,
) -> QueryTimeRange {
    let mut time = relative();
    time.definition.time_zone = zone.into();
    time.definition.field_type = field_type;
    time.definition.range = TimeRangeValue::Absolute {
        from: from.into(),
        to: to.into(),
    };
    time.bounds.from = utc_from.into();
    time.bounds.to = utc_to.into();
    time
}

#[test]
fn shared_frontend_fixture_round_trips_with_different_draft_and_execution_anchors() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/query-time-range-v1.json"
    ))
    .unwrap();
    let draft = &fixture["draft"];
    let time: QueryTimeRange = serde_json::from_value(draft["timeRange"].clone()).unwrap();
    time.validate(
        draft["connectionId"].as_str(),
        draft["index"].as_str().unwrap(),
        draft["dsl"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(serde_json::to_value(&time).unwrap(), draft["timeRange"]);
    let snapshot = &fixture["snapshot"];
    let executed: ExecutionTimeRange =
        serde_json::from_value(snapshot["timeRange"].clone()).unwrap();
    executed
        .validate(snapshot["rawDsl"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        serde_json::to_value(&executed).unwrap(),
        snapshot["timeRange"]
    );
    assert_ne!(executed.bounds, time.bounds);
}

#[test]
fn cell_filter_fixture_keeps_the_managed_time_wrapper_and_preserves_new_inner_conditions() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/query-filters-time-v1.json"
    ))
    .unwrap();
    let mut time: QueryTimeRange = serde_json::from_value(fixture["timeRange"].clone()).unwrap();
    let dsl = fixture["appliedDsl"].as_str().unwrap();
    time.validate(Some("connection"), "orders", dsl).unwrap();
    assert!(time.had_query);
    assert!(dsl.contains("9007199254740993"));
    let executed: ExecutionTimeRange =
        serde_json::from_value(fixture["executionTimeRange"].clone()).unwrap();
    executed
        .validate(fixture["frozenDsl"].as_str().unwrap())
        .unwrap();
    assert_ne!(time.bounds, executed.bounds);
    time.had_query = false;
    assert!(time.validate(Some("connection"), "orders", dsl).is_err());
}

#[test]
fn exact_relative_units_use_fixed_days_even_across_dst() {
    assert!(valid(&relative()));
    let mut time = relative();
    time.definition.time_zone = "America/New_York".into();
    time.definition.range = TimeRangeValue::Relative {
        amount: 1,
        unit: TimeUnit::Days,
    };
    time.bounds = TimeRangeBounds {
        resolved_at: "2026-03-08T12:00:00.000Z".into(),
        from: "2026-03-07T12:00:00.000000000Z".into(),
        to: "2026-03-08T12:00:00.000000000Z".into(),
    };
    assert!(valid(&time));
    time.bounds.from = "2026-03-07T13:00:00.000000000Z".into();
    assert!(!valid(&time));
    for amount in [0, MAX_AMOUNT + 1, u32::MAX] {
        let mut time = relative();
        time.definition.range = TimeRangeValue::Relative {
            amount,
            unit: TimeUnit::Minutes,
        };
        assert!(!valid(&time));
    }
    let mut time = relative();
    time.definition.range = TimeRangeValue::Relative {
        amount: 3661,
        unit: TimeUnit::Days,
    };
    assert!(!valid(&time));
}

#[test]
fn local_dates_use_real_zone_offsets_and_preserve_nanoseconds() {
    assert!(valid(&absolute(
        "2024-02-29T08:00:00.123456789",
        "2024-02-29T08:00:00.123456790",
        "+08:00",
        "2024-02-29T00:00:00.123456789Z",
        "2024-02-29T00:00:00.123456790Z",
        TimeFieldType::DateNanos
    )));
    assert!(valid(&absolute(
        "2026-07-01T12:00:00",
        "2026-07-01T13:00:00",
        "America/New_York",
        "2026-07-01T16:00:00.000000000Z",
        "2026-07-01T17:00:00.000000000Z",
        TimeFieldType::Date
    )));
    assert!(valid(&absolute(
        "2026-01-01T12:00:00",
        "2026-01-01T13:00:00",
        "America/New_York",
        "2026-01-01T17:00:00.000000000Z",
        "2026-01-01T18:00:00.000000000Z",
        TimeFieldType::Date
    )));
}

#[test]
fn invalid_dates_and_ambiguous_or_nonexistent_local_times_are_not_normalized() {
    for from in [
        "2025-02-29T00:00:00",
        "2026-01-01T24:00:00",
        "2026-01-01T00:00:60",
        "0000-01-01T00:00:00",
        "2026-01-01",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00.1234567890",
        "2026-01-01T00:00:00[u-ca=hebrew]",
    ] {
        assert!(local_date(from).is_err(), "{from}");
    }
    for from in ["2026-03-08T02:30:00", "2026-11-01T01:30:00"] {
        let time = absolute(
            from,
            "2026-11-02T12:00:00",
            "America/New_York",
            "2026-03-08T07:30:00.000000000Z",
            "2026-11-02T17:00:00.000000000Z",
            TimeFieldType::Date,
        );
        assert!(!valid(&time));
    }
    for zone in [
        "system", "local", "-00:00", "+24:00", "+08:60", "Bad/Zone", " UTC", "utc", "GMT+8", "a//b",
    ] {
        assert!(Zone::parse(zone).is_err(), "{zone}");
    }
    for zone in [
        "UTC",
        "+08:00",
        "-03:30",
        "Asia/Shanghai",
        "America/New_York",
        "Europe/Berlin",
        "Etc/GMT+8",
    ] {
        assert!(Zone::parse(zone).is_ok(), "{zone}");
    }
}

#[test]
fn precision_range_order_and_calendar_bounds_match_the_frontend() {
    assert!(!valid(&absolute(
        "2026-01-01T00:00:00.000000001",
        "2026-01-01T00:00:01",
        "UTC",
        "2026-01-01T00:00:00.000000001Z",
        "2026-01-01T00:00:01.000000000Z",
        TimeFieldType::Date
    )));
    assert!(!valid(&absolute(
        "1969-12-31T23:59:59",
        "1970-01-01T00:00:01",
        "UTC",
        "1969-12-31T23:59:59.000000000Z",
        "1970-01-01T00:00:01.000000000Z",
        TimeFieldType::DateNanos
    )));
    let mut edge = absolute(
        "2262-04-11T23:47:16.854775806",
        "2262-04-11T23:47:16.854775807",
        "UTC",
        "2262-04-11T23:47:16.854775806Z",
        "2262-04-11T23:47:16.854775807Z",
        TimeFieldType::DateNanos,
    );
    assert!(valid(&edge));
    edge.definition.range = TimeRangeValue::Absolute {
        from: "2262-04-11T23:47:16.854775806".into(),
        to: "2262-04-11T23:47:16.854775808".into(),
    };
    edge.bounds.to = "2262-04-11T23:47:16.854775808Z".into();
    assert!(!valid(&edge));
    for year in ["0001", "9999"] {
        assert!(valid(&absolute(
            &format!("{year}-01-01T00:00:00"),
            &format!("{year}-01-02T00:00:00"),
            "UTC",
            &format!("{year}-01-01T00:00:00.000000000Z"),
            &format!("{year}-01-02T00:00:00.000000000Z"),
            TimeFieldType::Date
        )));
    }
    for to in [
        "2026-01-01T00:00:00",
        "2025-01-01T00:00:00",
        "2040-01-01T00:00:00",
    ] {
        assert!(!valid(&absolute(
            "2026-01-01T00:00:00",
            to,
            "UTC",
            "2026-01-01T00:00:00.000000000Z",
            &format!("{to}.000000000Z"),
            TimeFieldType::Date
        )));
    }
}

#[test]
fn definition_shapes_are_closed_and_optional_fields_never_accept_null() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Optional {
        #[serde(default, deserialize_with = "optional_query_time_range")]
        time_range: Option<QueryTimeRange>,
    }
    assert!(serde_json::from_str::<Optional>("{}")
        .unwrap()
        .time_range
        .is_none());
    assert!(serde_json::from_str::<Optional>(r#"{"timeRange":null}"#).is_err());
    let time = relative();
    let raw = serde_json::to_string(&time).unwrap();
    for value in [
        raw.replace("\"version\":1", "\"version\":1,\"version\":1"),
        raw.replace("\"field\":", "\"field\":\"other\",\"\\u0066ield\":"),
        raw.replace("\"amount\":15", "\"amount\":15,\"amount\":15"),
        raw.replace("\"amount\":15", "\"amount\":1.5"),
        raw.replace(
            "\"kind\":\"relative\"",
            "\"kind\":\"relative\",\"kind\":\"relative\"",
        ),
        raw.replace("\"unit\":\"minutes\"", "\"unit\":\"months\""),
        raw.replace("\"fieldType\":\"date\"", "\"fieldType\":\"long\""),
    ] {
        assert!(serde_json::from_str::<QueryTimeRange>(&value).is_err());
    }
    for path in [
        "/definition",
        "/bounds",
        "/binding",
        "/definition/range",
        "",
    ] {
        let mut value = serde_json::to_value(&time).unwrap();
        value
            .pointer_mut(path)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("extra".into(), json!(true));
        assert!(serde_json::from_value::<QueryTimeRange>(value).is_err());
    }
    for field in [
        "", " n", "n ", "$param", "_source", "a*", "a?", "\u{007f}", "\u{0085}",
    ] {
        let mut time = time.clone();
        time.definition.field = field.into();
        assert!(!valid(&time));
    }
    let mut large = time.clone();
    large.definition.field = "x".repeat(1025);
    assert!(!valid(&large));
    large.definition.field = "\u{4e2d}".repeat(342);
    assert!(!valid(&large));
    let debug = format!("{time:?}");
    assert!(
        !debug.contains("@timestamp") && !debug.contains("2026-10-09") && !debug.contains("orders")
    );
}

#[test]
fn binding_and_wrapper_are_verified_without_interpreting_original_query_numbers() {
    let time = relative();
    let dsl = body(&time);
    for raw in [
        dsl.replace("9007199254740993", "1E+400"),
        dsl.replace("9007199254740993", "1.0000000000000000001"),
        dsl.replace("9007199254740993", r#""\u0061""#),
    ] {
        time.validate(Some("connection"), "orders", &raw).unwrap();
    }
    assert!(time.validate(None, "orders", &dsl).is_err());
    assert!(time.validate(Some("other"), "orders", &dsl).is_err());
    assert!(time.validate(Some("connection"), "other", &dsl).is_err());
    for raw in [
        "{}".into(),
        dsl.replace("\"lt\":", "\"lte\":"),
        dsl.replace(
            "2026-10-09T12:00:00.123000000Z",
            "2026-10-09T12:00:00.124000000Z",
        ),
        dsl.replace("\"size\":25", "\"knn\":{}"),
        dsl.replace("\"size\":25", "\"retriever\":{}"),
        dsl.replace("\"size\":25", "\"size\":25,\"\\u0073ize\":25"),
        dsl.replace("9007199254740993", r#"{"$param":"id"}"#),
        " ".repeat(MAX_DSL_BYTES) + &dsl,
        "{\"query\":".repeat(66) + "{}" + &"}".repeat(66),
    ] {
        assert!(time.validate(Some("connection"), "orders", &raw).is_err());
    }
    let mut empty = time;
    empty.had_query = false;
    assert!(!valid(&empty));
    let raw = dsl.replace(
        r#"{"term":{"sequence":9007199254740993}}"#,
        r#"{"match_all":{}}"#,
    );
    assert!(empty.validate(Some("connection"), "orders", &raw).is_ok());
}

#[test]
fn runtime_dates_must_be_present_in_actual_dsl_with_a_matching_type() {
    let mut time = relative();
    let raw = body(&time);
    for field_type in ["date", "long", "date_nanos"] {
        let body = raw.replacen(
            '{',
            &format!(r#"{{"runtime_mappings":{{"@timestamp":{{"type":"{field_type}"}}}},"#),
            1,
        );
        assert_eq!(
            time.validate(Some("connection"), "orders", &body).is_ok(),
            field_type == "date"
        );
        if field_type == "date" {
            time.definition.field_type = TimeFieldType::DateNanos;
            assert!(time.validate(Some("connection"), "orders", &body).is_err());
            time.definition.field_type = TimeFieldType::Date;
        }
    }
}
