//! The workflow agent's YAML definition (buzz#21).
//!
//! ## Why not `buzz-workflow`
//!
//! `crates/buzz-workflow` is the server-side engine: multi-step, cron/webhook
//! triggers, approval gates, `evalexpr` conditions, DB-backed run history. The
//! agent-member version here is one trigger and one action — a channel
//! message that a runner can already decrypt, matched against a substring or
//! regex, answered with a sealed reply — so pulling in that crate would mean
//! carrying its whole surface (and its Postgres-shaped assumptions) for a
//! feature this ticket does not use. What *is* kept compatible on purpose:
//!
//! - `trigger` / `action` as the top-level nouns, matching
//!   `buzz-workflow::schema::TriggerDef` / `ActionDef`.
//! - `action: { reply: "…" }`'s field name echoes `SendMessage`'s `text`
//!   closely enough that a human porting a workflow between the two engines
//!   is translating one field, not re-learning a vocabulary. It is spelled
//!   `reply` rather than `text` because v1 has exactly one channel to post
//!   into (the trigger's) — see #22 for the parity port that adds `channel`
//!   overrides and the rest of upstream's action vocabulary.
//!
//! ## Fail loud, not fail open
//!
//! Every struct here is `#[serde(deny_unknown_fields)]` and `version` is
//! required (not defaulted). A typo'd field or a workflow authored against a
//! v2 this build does not understand yet must refuse to load — silently
//! ignoring an unrecognised field would mean a workflow behaves differently
//! than its author wrote, with no error to explain why.

use std::path::{Path, PathBuf};

use regex::Regex;
use serde::Deserialize;

use crate::error::CliError;

/// The only definition version this build understands. Bumping this is a
/// breaking schema change — see the module doc's forward-compat note.
pub const CURRENT_VERSION: u32 = 1;

/// Raw top-level shape, exactly as authored in YAML.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkflowFile {
    version: u32,
    #[serde(default)]
    name: Option<String>,
    trigger: TriggerFile,
    action: ActionFile,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TriggerFile {
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    contains: Option<String>,
    #[serde(default)]
    matches: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionFile {
    reply: String,
}

/// A trigger condition, validated and ready to evaluate.
#[derive(Debug, Clone)]
pub enum Condition {
    /// Case-insensitive substring match.
    Contains(String),
    /// A compiled regex, matched against the raw (case-sensitive) text.
    Matches {
        pattern: String,
        regex: std::sync::Arc<Regex>,
    },
}

impl Condition {
    /// Does `text` fire this trigger?
    pub fn evaluate(&self, text: &str) -> bool {
        match self {
            Condition::Contains(needle) => text.to_lowercase().contains(&needle.to_lowercase()),
            Condition::Matches { regex, .. } => regex.is_match(text),
        }
    }
}

impl PartialEq for Condition {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Condition::Contains(a), Condition::Contains(b)) => a == b,
            (Condition::Matches { pattern: a, .. }, Condition::Matches { pattern: b, .. }) => {
                a == b
            }
            _ => false,
        }
    }
}

/// One loaded, validated workflow: exactly the shape issue #21 asks for — one
/// trigger, one action.
#[derive(Debug, Clone, PartialEq)]
pub struct Workflow {
    /// Display name — the `name:` field, or the file's stem when omitted.
    pub name: String,
    /// Where this workflow was loaded from, for logs and error messages.
    pub source: PathBuf,
    /// Restrict evaluation to one channel, or `None` for every channel the
    /// runner holds a key for.
    pub channel: Option<String>,
    pub condition: Condition,
    /// The reply text posted back into the triggering channel.
    pub reply: String,
}

impl Workflow {
    /// Whether this workflow is even in scope for `channel_id` — checked
    /// before the (more expensive) condition, and before the caller spends a
    /// decrypt on a message this workflow was never going to look at.
    pub fn applies_to_channel(&self, channel_id: &str) -> bool {
        self.channel
            .as_deref()
            .is_none_or(|only| only == channel_id)
    }
}

/// Parse and validate one workflow definition. `source` is used only for
/// error messages and as the default `name`.
pub fn parse_workflow(yaml: &str, source: &Path) -> Result<Workflow, CliError> {
    let file: WorkflowFile = serde_yaml::from_str(yaml).map_err(|e| {
        CliError::Usage(format!("{}: invalid workflow YAML: {e}", source.display()))
    })?;

    if file.version != CURRENT_VERSION {
        return Err(CliError::Usage(format!(
            "{}: unsupported workflow version {} — this build understands version {CURRENT_VERSION}",
            source.display(),
            file.version
        )));
    }

    let channel = match file.trigger.channel {
        Some(channel) => {
            crate::validate::validate_uuid(&channel).map_err(|_| {
                CliError::Usage(format!(
                    "{}: trigger.channel {channel:?} is not a valid channel UUID",
                    source.display()
                ))
            })?;
            Some(channel)
        }
        None => None,
    };

    let condition = match (file.trigger.contains, file.trigger.matches) {
        (Some(_), Some(_)) => {
            return Err(CliError::Usage(format!(
                "{}: trigger must set exactly one of 'contains' or 'matches', not both",
                source.display()
            )))
        }
        (None, None) => {
            return Err(CliError::Usage(format!(
                "{}: trigger must set one of 'contains' or 'matches'",
                source.display()
            )))
        }
        (Some(needle), None) if needle.is_empty() => {
            return Err(CliError::Usage(format!(
                "{}: trigger.contains must not be empty",
                source.display()
            )))
        }
        (Some(needle), None) => Condition::Contains(needle),
        (None, Some(pattern)) => {
            let regex = Regex::new(&pattern).map_err(|e| {
                CliError::Usage(format!(
                    "{}: trigger.matches is not a valid regex: {e}",
                    source.display()
                ))
            })?;
            Condition::Matches {
                pattern,
                regex: std::sync::Arc::new(regex),
            }
        }
    };

    if file.action.reply.trim().is_empty() {
        return Err(CliError::Usage(format!(
            "{}: action.reply must not be empty",
            source.display()
        )));
    }

    let name = file
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            source
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "workflow".to_string())
        });

    Ok(Workflow {
        name,
        source: source.to_path_buf(),
        channel,
        condition,
        reply: file.action.reply,
    })
}

/// Load every workflow named by `path`: the file itself, or every `.yml` /
/// `.yaml` file directly inside it if `path` is a directory (not recursive —
/// a flat drop-in directory is the whole of v1's authoring story).
///
/// Fails loud and whole: one malformed file fails the entire load rather than
/// silently starting with N-1 workflows, because a runner that starts missing
/// a workflow its operator believes is active is worse than a runner that
/// refuses to start at all.
pub fn load_workflows(path: &Path) -> Result<Vec<Workflow>, CliError> {
    let files = if path.is_dir() {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(path)
            .map_err(|e| {
                CliError::Usage(format!(
                    "failed to read workflow dir {}: {e}",
                    path.display()
                ))
            })?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|p| {
                p.is_file()
                    && matches!(
                        p.extension().and_then(std::ffi::OsStr::to_str),
                        Some("yml") | Some("yaml")
                    )
            })
            .collect();
        entries.sort();
        entries
    } else {
        vec![path.to_path_buf()]
    };

    if files.is_empty() {
        return Err(CliError::Usage(format!(
            "no .yml/.yaml workflow files found in {}",
            path.display()
        )));
    }

    let mut workflows = Vec::with_capacity(files.len());
    let mut seen_names = std::collections::HashSet::new();
    for file in files {
        let raw = std::fs::read_to_string(&file).map_err(|e| {
            CliError::Usage(format!(
                "failed to read workflow file {}: {e}",
                file.display()
            ))
        })?;
        let workflow = parse_workflow(&raw, &file)?;
        if !seen_names.insert(workflow.name.clone()) {
            return Err(CliError::Usage(format!(
                "duplicate workflow name '{}' ({}) — names must be unique so cycle reports and \
logs can name which workflow acted",
                workflow.name,
                file.display()
            )));
        }
        workflows.push(workflow);
    }
    Ok(workflows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(name: &str) -> PathBuf {
        PathBuf::from(name)
    }

    #[test]
    fn parses_a_minimal_contains_workflow() {
        let yaml = "version: 1\ntrigger:\n  contains: hello\naction:\n  reply: hi there\n";
        let wf = parse_workflow(yaml, &path("greeter.yaml")).unwrap();
        assert_eq!(wf.name, "greeter");
        assert_eq!(wf.channel, None);
        assert_eq!(wf.condition, Condition::Contains("hello".to_string()));
        assert_eq!(wf.reply, "hi there");
    }

    #[test]
    fn an_explicit_name_overrides_the_file_stem() {
        let yaml = "version: 1\nname: My Greeter\ntrigger:\n  contains: hi\naction:\n  reply: yo\n";
        let wf = parse_workflow(yaml, &path("workflow-1.yaml")).unwrap();
        assert_eq!(wf.name, "My Greeter");
    }

    #[test]
    fn parses_a_channel_scoped_matches_workflow() {
        let yaml = concat!(
            "version: 1\n",
            "trigger:\n",
            "  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
            "  matches: '^deploy .*prod$'\n",
            "action:\n  reply: 'acknowledged'\n",
        );
        let wf = parse_workflow(yaml, &path("deploy.yaml")).unwrap();
        assert_eq!(
            wf.channel.as_deref(),
            Some("6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b")
        );
        assert!(wf.condition.evaluate("deploy service to prod"));
        assert!(!wf.condition.evaluate("deploy service to staging"));
    }

    #[test]
    fn contains_matching_is_case_insensitive() {
        let cond = Condition::Contains("Hello".to_string());
        assert!(cond.evaluate("well HELLO there"));
        assert!(cond.evaluate("hello"));
        assert!(!cond.evaluate("goodbye"));
    }

    #[test]
    fn missing_version_fails_loud() {
        let yaml = "trigger:\n  contains: hi\naction:\n  reply: yo\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn an_unsupported_version_fails_loud() {
        let yaml = "version: 2\ntrigger:\n  contains: hi\naction:\n  reply: yo\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("version")));
    }

    #[test]
    fn an_unknown_top_level_field_fails_loud() {
        let yaml = concat!(
            "version: 1\n",
            "trigger:\n  contains: hi\n",
            "action:\n  reply: yo\n",
            "schedule:\n  cron: '* * * * *'\n",
        );
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn an_unknown_trigger_field_fails_loud() {
        let yaml = "version: 1\ntrigger:\n  contains: hi\n  emoji: wave\naction:\n  reply: yo\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn both_contains_and_matches_is_rejected() {
        let yaml =
            "version: 1\ntrigger:\n  contains: hi\n  matches: 'hi.*'\naction:\n  reply: yo\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("exactly one")));
    }

    #[test]
    fn neither_contains_nor_matches_is_rejected() {
        let yaml = "version: 1\ntrigger: {}\naction:\n  reply: yo\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn an_invalid_regex_is_rejected() {
        let yaml = "version: 1\ntrigger:\n  matches: '(unclosed'\naction:\n  reply: yo\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn an_invalid_channel_uuid_is_rejected() {
        let yaml =
            "version: 1\ntrigger:\n  channel: not-a-uuid\n  contains: hi\naction:\n  reply: yo\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn an_empty_reply_is_rejected() {
        let yaml = "version: 1\ntrigger:\n  contains: hi\naction:\n  reply: '   '\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn malformed_yaml_fails_loud() {
        let yaml = "version: [unclosed\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn applies_to_channel_with_no_scope_matches_anything() {
        let yaml = "version: 1\ntrigger:\n  contains: hi\naction:\n  reply: yo\n";
        let wf = parse_workflow(yaml, &path("any.yaml")).unwrap();
        assert!(wf.applies_to_channel("engineering"));
        assert!(wf.applies_to_channel("random"));
    }

    #[test]
    fn applies_to_channel_with_a_scope_matches_only_that_one() {
        let yaml = "version: 1\ntrigger:\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n  contains: hi\naction:\n  reply: yo\n";
        let wf = parse_workflow(yaml, &path("scoped.yaml")).unwrap();
        assert!(wf.applies_to_channel("6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b"));
        assert!(!wf.applies_to_channel("0c3b7e41-5d2f-4b18-9a06-2e7f5c4d3b1a"));
    }

    #[test]
    fn load_workflows_from_a_directory_is_sorted_and_deduped_by_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.yaml"),
            "version: 1\nname: first\ntrigger:\n  contains: hi\naction:\n  reply: yo\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("b.yaml"),
            "version: 1\nname: second\ntrigger:\n  contains: bye\naction:\n  reply: cya\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("ignore.txt"), "not yaml").unwrap();

        let workflows = load_workflows(dir.path()).unwrap();
        assert_eq!(workflows.len(), 2);
        assert_eq!(workflows[0].name, "first");
        assert_eq!(workflows[1].name, "second");
    }

    #[test]
    fn load_workflows_rejects_duplicate_names() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.yaml"),
            "version: 1\nname: dup\ntrigger:\n  contains: hi\naction:\n  reply: yo\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("b.yaml"),
            "version: 1\nname: dup\ntrigger:\n  contains: bye\naction:\n  reply: cya\n",
        )
        .unwrap();
        let err = load_workflows(dir.path()).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("duplicate")));
    }

    #[test]
    fn load_workflows_from_a_single_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("greeter.yaml");
        std::fs::write(
            &file,
            "version: 1\ntrigger:\n  contains: hi\naction:\n  reply: yo\n",
        )
        .unwrap();
        let workflows = load_workflows(&file).unwrap();
        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0].name, "greeter");
    }

    #[test]
    fn load_workflows_an_empty_directory_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = load_workflows(dir.path()).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn load_workflows_one_malformed_file_fails_the_whole_load() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("a.yaml"),
            "version: 1\ntrigger:\n  contains: hi\naction:\n  reply: yo\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("b.yaml"), "version: 2\ntrigger: {}\n").unwrap();
        let err = load_workflows(dir.path()).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }
}
