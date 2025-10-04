// Scraper logic (V2 canonical)
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, COOKIE};
use scraper::{Html, Selector};
use serde_json::json;
use std::time::Duration;

// Minimal local representation of a parsed field extraction rule (decoupled from legacy V1 types)
#[derive(Clone)]
struct FieldSpec {
    selector: String,
    attr: Option<String>,
    base_url: Option<String>,
    // Stored as legacy transform JSON array for reuse of existing apply_transforms without refactor
    transform_legacy: Option<serde_json::Value>,
}

fn build_headers(custom: &Option<std::collections::HashMap<String, String>>, cookies: &Option<String>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    // Sensible defaults
    headers.insert(
        reqwest::header::USER_AGENT,
        HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36"),
    );
    headers.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
    );
    if let Some(map) = custom {
        for (k, v) in map.iter() {
            let name = HeaderName::from_bytes(k.as_bytes())
                .map_err(|e| format!("bad header name {k}: {e}"))?;
            let val = HeaderValue::from_str(v).map_err(|e| format!("bad header value for {k}: {e}"))?;
            headers.insert(name, val);
        }
    }
    if let Some(cookie) = cookies {
        headers.insert(COOKIE, HeaderValue::from_str(cookie).map_err(|e| format!("bad cookie header: {e}"))?);
    }
    Ok(headers)
}

fn replace_query(template: &str, query: &str) -> String {
    template.replace("{query}", &urlencoding::encode(query))
}

fn replace_page(template: &str, page: u32) -> String {
    template.replace("{page}", &page.to_string())
}

fn replace_query_and_page(template: &str, query: &str, page: u32) -> String {
    let with_query = replace_query(template, query);
    replace_page(&with_query, page)
}

fn selector_parts_with_contains(selector: &str) -> Vec<(String, Option<String>)> {
    // Split by commas for alternatives; support minimal :contains(TEXT)
    selector
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|part| {
            if let Some(idx) = part.find(":contains(") {
                let after = &part[idx + ":contains(".len()..];
                if let Some(end) = after.find(')') {
                    let contains = &after[..end];
                    let base = format!("{}{}", &part[..idx], &after[end + 1..]);
                    (base.trim().to_string(), Some(contains.trim_matches(['"', '\'']).to_string()))
                } else {
                    (part.to_string(), None)
                }
            } else {
                (part.to_string(), None)
            }
        })
        .collect()
}

fn element_text(elem: &scraper::ElementRef) -> String {
    elem.text().collect::<Vec<_>>().join(" ").trim().to_string()
}

fn apply_transforms(mut v: String, tf: &Option<serde_json::Value>) -> serde_json::Value {
    if let Some(t) = tf {
        if let Some(arr) = t.as_array() {
            for item in arr {
                if let Some(obj) = item.as_object() {
                    if obj.get("parseInt").and_then(|v| v.as_bool()).unwrap_or(false) {
                        // Extract first integer in the string
                        let mut num: i64 = 0;
                        let mut started = false;
                        let mut negative = false;
                        let mut acc: i64 = 0;
                        for ch in v.chars() {
                            if !started {
                                if ch == '-' { negative = true; started = true; continue; }
                                if ch.is_ascii_digit() { started = true; acc = (ch as u8 - b'0') as i64; }
                            } else {
                                if ch.is_ascii_digit() {
                                    acc = acc.saturating_mul(10).saturating_add((ch as u8 - b'0') as i64);
                                } else {
                                    break;
                                }
                            }
                        }
                        if started { num = if negative { -acc } else { acc }; }
                        return json!(num);
                    }
                    if obj.get("parseSize").and_then(|v| v.as_bool()).unwrap_or(false) {
                        let lower = v.to_lowercase();
                        let mut val: f64 = 0.0;
                        let mut seen_digit = false;
                        let mut num_str = String::new();
                        for ch in lower.chars() {
                            if ch.is_ascii_digit() || (ch == '.' && !num_str.contains('.')) {
                                seen_digit = true;
                                num_str.push(ch);
                            } else if seen_digit {
                                break;
                            }
                        }
                        if let Ok(parsed) = num_str.parse::<f64>() { val = parsed; }
                        let unit = if lower.contains("tib") || lower.contains("tb") {
                            1024f64 * 1024f64 * 1024f64 * 1024f64
                        } else if lower.contains("gib") || lower.contains("gb") {
                            1024f64 * 1024f64 * 1024f64
                        } else if lower.contains("mib") || lower.contains("mb") {
                            1024f64 * 1024f64
                        } else if lower.contains("kib") || lower.contains("kb") {
                            1024f64
                        } else { 1f64 };
                        let bytes = (val * unit).round() as u64;
                        return json!(bytes);
                    }
                    if obj.get("trim").and_then(|v| v.as_bool()).unwrap_or(false) {
                        v = v.trim().to_string();
                    }
                }
            }
        }
    }
    json!(v)
}

fn resolve_base(base: &Option<String>, value: &str) -> String {
    if let Some(b) = base {
        if let Ok(base_url) = reqwest::Url::parse(b) {
            if let Ok(joined) = base_url.join(value) { return joined.to_string(); }
        }
    }
    value.to_string()
}

fn extract_field(doc: &Html, row: &scraper::ElementRef, field: &FieldSpec) -> Option<serde_json::Value> {
    let selector_str = field.selector.as_str();
    if selector_str.is_empty() {
        return None;
    }
    let parts = selector_parts_with_contains(selector_str);
    for (base_sel, contains) in parts {
        if let Ok(sel) = Selector::parse(&base_sel) {
            // Prefer searching inside the row; fallback to entire doc if not found
            let mut candidates: Vec<scraper::ElementRef> = row.select(&sel).collect();
            if candidates.is_empty() {
                candidates = doc.select(&sel).collect();
            }
            for el in candidates {
                if let Some(filter) = &contains {
                    let txt = element_text(&el);
                    if !txt.contains(filter) { continue; }
                }
                let raw = match field.attr.as_deref().unwrap_or("text") {
                    "text" => element_text(&el),
                    other => el.value().attr(other).unwrap_or("").to_string(),
                };
                let raw = if let Some(base) = &field.base_url { resolve_base(&Some(base.clone()), &raw) } else { raw };
                let v = apply_transforms(raw, &field.transform_legacy);
                return Some(v);
            }
        }
    }
    None
}

pub async fn search_torrent_indexer(spec: &crate::plugins::ManifestV1TorrentSpec, query: &str) -> Result<Vec<serde_json::Value>, String> {
    let headers = build_headers(&spec.network.headers, &None)?;
    let client = reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let mut results: Vec<serde_json::Value> = Vec::new();
    let mut page = spec.network.pagination.as_ref().map(|p| p.start).unwrap_or(1);
    let limit = spec.network.pagination.as_ref().and_then(|p| p.limit).unwrap_or(1);
    let _param = spec.network.pagination.as_ref().and_then(|p| p.param.clone());
    let throttle = spec.network.throttle_ms.unwrap_or(0);

    for i in 0..limit {
        let url = replace_query_and_page(&spec.network.url_template, query, page);

        let resp = client
            .request(spec.network.method.parse().unwrap_or(reqwest::Method::GET), &url)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        if !resp.status().is_success() {
            break;
        }
        let body = resp.text().await.map_err(|e| format!("read body: {e}"))?;
        // Use parse spec directly
        let parse_spec = spec.parse.clone();
        let parsed: Result<Vec<serde_json::Value>, String> = tokio::task::spawn_blocking(move || {
            let doc = Html::parse_document(&body);
            let row_sel_str = parse_spec.row_selector.clone();
            let row_sel = Selector::parse(&row_sel_str).map_err(|_| format!("bad row selector: {row_sel_str}"))?;
            let mut local_results: Vec<serde_json::Value> = Vec::new();
            for row in doc.select(&row_sel) {
                let mut obj = serde_json::Map::new();
                for (k, f) in &parse_spec.fields {
                    // Convert transform vector into legacy JSON object array expected by apply_transforms
                    let legacy_transform = f.transform.as_ref().map(|vec| {
                        serde_json::Value::Array(vec.iter().map(|t| match t.as_str() {
                            "parseInt"|"parse-int" => json!({"parseInt": true}),
                            "parseSize"|"parse-size" => json!({"parseSize": true}),
                            "trim" => json!({"trim": true}),
                            other => json!({other: true})
                        }).collect())
                    });
                    let spec_field = FieldSpec {
                        selector: f.selector.clone(),
                        attr: f.attr.clone(),
                        base_url: f.base_url.clone(),
                        transform_legacy: legacy_transform,
                    };
                    if let Some(val) = extract_field(&doc, &row, &spec_field) { obj.insert(k.clone(), val); }
                }
                if !obj.is_empty() {
                    local_results.push(serde_json::Value::Object(obj));
                }
            }
            Ok(local_results)
        }).await.map_err(|e| format!("join error: {e}"))?;
        results.extend(parsed?);

        // Next page
        page = page.saturating_add(1);
        if throttle > 0 && i + 1 < limit {
            tokio::time::sleep(Duration::from_millis(throttle)).await;
        }
    }

    Ok(results)
}
