//! LLM 精炼 / 翻译调用与连接解析。
//!
//! 权威的精炼 system prompt 已迁至 `refine_prompt.rs`（最小修改护栏 + 口水词
//! 规则 + 用户词表，全部折叠进单次调用）；本模块只负责把它接进一次
//! chat completion。旧常量 `REFINE_SYSTEM_PROMPT` 已删除，勿在此重建。

use crate::config::{LLMRefineConfig, STORED_SECRET_PLACEHOLDER};
use crate::filler::FillerCleanupMode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const TRANSLATE_SYSTEM_PROMPT: &str = "You are a precise translator. Translate the user's text into the target language. Preserve meaning, tone, and formatting. Return only the translation.";
const POLISH_SYSTEM_PROMPT: &str = "You are a careful editor. Rewrite the user's text to improve clarity and fluency while preserving its meaning, tone, register, and the language it is written in. Fix grammar and wording issues and keep the original formatting. Return only the rewritten text.";
const EXPLAIN_SYSTEM_PROMPT: &str = "You are a patient teacher. Explain the user's selected text clearly and concisely in the same language as the selection. If it is an error message or code, explain the likely cause and how to fix it; if it is terminology or a passage, explain the meaning. Use plain language. Return only the explanation.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineConnectionResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Option<Vec<ChatChoice>>,
    error: Option<ChatError>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: Option<ChatMessage>,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ChatError {
    message: Option<String>,
}

fn resolve_connection(config: &LLMRefineConfig) -> (String, String, String) {
    let provider = config.provider.as_str();
    let (endpoint, model, key) = match provider {
        "openai" => (
            if config.endpoint.trim().is_empty() {
                "https://api.openai.com/v1".into()
            } else {
                config.endpoint.clone()
            },
            if config.openai.model.is_empty() {
                config.model.clone()
            } else {
                config.openai.model.clone()
            },
            pick_key(&config.openai.api_key, &config.api_key),
        ),
        "deepseek" => (
            if config.endpoint.trim().is_empty() {
                "https://api.deepseek.com".into()
            } else {
                config.endpoint.clone()
            },
            if config.deepseek.model.is_empty() {
                config.model.clone()
            } else {
                config.deepseek.model.clone()
            },
            pick_key(&config.deepseek.api_key, &config.api_key),
        ),
        "openrouter" => (
            if config.endpoint.trim().is_empty() {
                "https://openrouter.ai/api/v1".into()
            } else {
                config.endpoint.clone()
            },
            if config.openrouter.model.is_empty() {
                config.model.clone()
            } else {
                config.openrouter.model.clone()
            },
            pick_key(&config.openrouter.api_key, &config.api_key),
        ),
        "tokendance" => (
            if config.endpoint.trim().is_empty() {
                "https://tokendance.space/gateway/v1".into()
            } else {
                config.endpoint.clone()
            },
            if config.tokendance.model.is_empty() {
                config.model.clone()
            } else {
                config.tokendance.model.clone()
            },
            pick_key(&config.tokendance.api_key, &config.api_key),
        ),
        "mimo" => (
            if config.mimo.endpoint.trim().is_empty() {
                "https://api.xiaomimimo.com/v1".into()
            } else {
                config.mimo.endpoint.clone()
            },
            if config.mimo.model.trim().is_empty() {
                "mimo-v2.5".into()
            } else {
                config.mimo.model.clone()
            },
            pick_key(&config.mimo.api_key, &config.api_key),
        ),
        _ => {
            // custom-compatible and any future provider: prefer dedicated custom fields.
            let endpoint = if !config.custom.endpoint.trim().is_empty() {
                config.custom.endpoint.clone()
            } else {
                config.endpoint.clone()
            };
            let model = if !config.custom.model.trim().is_empty() {
                config.custom.model.clone()
            } else {
                config.model.clone()
            };
            let key = pick_key(&config.custom.api_key, &config.api_key);
            (endpoint, model, key)
        }
    };

    let base = endpoint.trim().trim_end_matches('/').to_string();
    let base = base
        .strip_suffix("/chat/completions")
        .unwrap_or(&base)
        .trim_end_matches('/')
        .to_string();
    let url = format!("{base}/chat/completions");
    (url, model, key)
}

fn pick_key(provider_key: &str, fallback: &str) -> String {
    let value = if provider_key.trim().is_empty() {
        fallback
    } else {
        provider_key
    };
    if value == STORED_SECRET_PLACEHOLDER {
        String::new()
    } else {
        value.to_string()
    }
}

pub(crate) fn require_https_or_localhost(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid endpoint: {e}"))?;
    let host = parsed.host_str().unwrap_or("");
    let is_local = host == "localhost" || host == "127.0.0.1" || host == "::1";
    if parsed.scheme() == "https" || (parsed.scheme() == "http" && is_local) {
        Ok(())
    } else {
        Err("Custom endpoint must use https (http allowed only for localhost)".into())
    }
}

async fn chat_completion(
    system: &str,
    user: &str,
    config: &LLMRefineConfig,
) -> Result<String, String> {
    let (url, model, api_key) = resolve_connection(config);
    if url.is_empty() || model.is_empty() || api_key.is_empty() {
        return Err("LLM connection is incomplete".into());
    }
    require_https_or_localhost(&url)?;

    let payload = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.2,
        // Bound completion length adaptively. A rewritten / translated copy of
        // the input needs roughly one token per input char (CJK) and fewer for
        // Latin scripts, so `input + margin` never truncates normal output;
        // the floor leaves short push-to-talk utterances room for reasoning,
        // and the ceiling stops a thinking model from wandering.
        "max_tokens": (user.chars().count() + 256).clamp(512, 8192),
    });

    let response = crate::state::shared_http_client()
        .post(&url)
        .timeout(std::time::Duration::from_secs(60))
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {e}"))?;

    let status = response.status();
    let body: ChatResponse = response.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let message = body
            .error
            .and_then(|e| e.message)
            .unwrap_or_else(|| format!("LLM returned HTTP {status}"));
        return Err(message);
    }

    let content = body
        .choices
        .and_then(|c| c.into_iter().next())
        .and_then(|c| c.message)
        .and_then(|m| m.content)
        .map(|c| match c {
            Value::String(s) => s,
            other => other.to_string(),
        })
        .unwrap_or_default()
        .trim()
        .to_string();

    Ok(strip_think(&content))
}

fn strip_think(content: &str) -> String {
    let trimmed = content.trim();
    if let Some(rest) = trimmed.strip_prefix("<think>") {
        return match rest.find("</think>") {
            Some(end) => rest[end + "</think>".len()..].trim().to_string(),
            // Unterminated think block (e.g. max_tokens cut the output short):
            // there is no usable answer, and callers keep the raw text on an
            // empty result instead of injecting think garbage.
            None => String::new(),
        };
    }
    trimmed.to_string()
}

/// 一次精炼调用的 system prompt：基础护栏 + 本次的用户词表 + 口水词规则 +
/// 热词纠正 + 风格预设（段落顺序见 [`crate::refine_prompt::build_refine_system_prompt`]）。
/// 永远只有一次 LLM 调用——口水词清理折叠进本 prompt，不做第二次请求。
/// `hotwords` 来自 `asr.hotwords`（热词表与 ASR 配置同侧），与词表独立。
pub fn system_prompt_for(config: &LLMRefineConfig, hotwords: &[String]) -> String {
    crate::refine_prompt::build_refine_system_prompt(
        &config.user_glossary,
        FillerCleanupMode::parse(&config.filler_cleanup) == FillerCleanupMode::Llm,
        &config.refine_style,
        &config.refine_style_custom,
        hotwords,
    )
}

pub async fn refine_text(
    text: &str,
    config: &LLMRefineConfig,
    hotwords: &[String],
) -> Result<String, String> {
    let system = system_prompt_for(config, hotwords);
    chat_completion(&system, text, config).await
}

pub async fn translate_text(
    text: &str,
    target_language: &str,
    config: &LLMRefineConfig,
) -> Result<String, String> {
    let user = format!("Target language: {target_language}\n\n{text}");
    chat_completion(TRANSLATE_SYSTEM_PROMPT, &user, config).await
}

/// 选区动作「润色改写」的 system prompt：`POLISH_SYSTEM_PROMPT` + 风格段。
/// 热词段不进本 prompt（热词只服务转写纠错）。
fn polish_system_prompt(config: &LLMRefineConfig) -> String {
    let style = crate::refine_prompt::build_style_section(
        &config.refine_style,
        &config.refine_style_custom,
    );
    if style.is_empty() {
        POLISH_SYSTEM_PROMPT.to_string()
    } else {
        format!("{POLISH_SYSTEM_PROMPT}\n\n{style}")
    }
}

/// 选区动作「润色改写」：原文语言内改写，不换语种。风格预设（3.1）同样
/// 作用于本动作：只改表达方式，不推翻本 prompt 的语言/含义约束。
pub async fn polish_text(text: &str, config: &LLMRefineConfig) -> Result<String, String> {
    chat_completion(&polish_system_prompt(config), text, config).await
}

/// 选区动作「解释说明」：返回解释文本（不写回文档）。
pub async fn explain_text(text: &str, config: &LLMRefineConfig) -> Result<String, String> {
    chat_completion(EXPLAIN_SYSTEM_PROMPT, text, config).await
}

/// Whether the LLM connection resolves to a complete endpoint / model / API
/// key. Clipboard-touching flows (selection translation) check this *before*
/// any side effects so an unconfigured connection fails fast with a visible
/// hint — the role of the Electron blueprint's `resolveConfig` pre-check.
pub fn connection_ready(config: &LLMRefineConfig) -> bool {
    let (url, model, api_key) = resolve_connection(config);
    !url.is_empty() && !model.is_empty() && !api_key.is_empty()
}

pub async fn test_connection(config: &LLMRefineConfig) -> RefineConnectionResult {
    match chat_completion("Reply with the single word: ok", "ping", config).await {
        Ok(_) => RefineConnectionResult {
            ok: true,
            message: "Connection succeeded".into(),
        },
        Err(message) => RefineConnectionResult { ok: false, message },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_injects_glossary_and_filler_flag() {
        let mut config = LLMRefineConfig::default();
        config.user_glossary = vec!["张伟".to_string()];
        config.filler_cleanup = "llm".into();

        let prompt = system_prompt_for(&config, &[]);
        assert!(prompt.contains("- 张伟"));
        assert!(prompt.contains("Filler-word cleanup"));

        config.filler_cleanup = "rules".into();
        let prompt = system_prompt_for(&config, &[]);
        assert!(prompt.contains("- 张伟"));
        assert!(!prompt.contains("Filler-word cleanup"));
    }

    #[test]
    fn system_prompt_defaults_are_safe() {
        let prompt = system_prompt_for(&LLMRefineConfig::default(), &[]);
        assert!(prompt.contains("Minimal edit rules"));
        assert!(!prompt.contains("Preferred glossary terms:"));
        assert!(!prompt.contains("Target writing style"));
    }

    #[test]
    fn system_prompt_passes_style_and_hotwords() {
        let mut config = LLMRefineConfig::default();
        config.refine_style = "email".into();
        let prompt = system_prompt_for(&config, &["芷若".to_string()]);
        assert!(prompt.contains("Target writing style for this run:"));
        assert!(prompt.contains("professional email"));
        assert!(prompt.contains("Hotword corrections"));
        assert!(prompt.contains("- 芷若"));
    }

    #[test]
    fn polish_system_carries_style_but_not_hotwords() {
        let mut config = LLMRefineConfig::default();
        assert_eq!(polish_system_prompt(&config), POLISH_SYSTEM_PROMPT);

        config.refine_style = "weekly".into();
        let system = polish_system_prompt(&config);
        assert!(system.starts_with(POLISH_SYSTEM_PROMPT));
        assert!(system.contains("Target writing style for this run:"));
        assert!(system.contains("weekly work report"));
        // polish 走 POLISH_SYSTEM_PROMPT + 风格段，不带热词段（热词只服务转写纠错）。
        assert!(!system.contains("Hotword corrections"));
    }
}
