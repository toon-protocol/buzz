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
//!
//! ## buzz#22: the parity port
//!
//! Still one version (`1`, still deny-unknown), widened in three ways. See
//! `docs/workflow-agent-parity.md` for the full upstream-vs-here checklist;
//! this is the shape those three additions take on the wire:
//!
//! - **`trigger.all` / `trigger.any`** — a list of `{contains}` / `{matches}`
//!   conditions, ANDed or ORed, alongside the existing single `contains` /
//!   `matches`. Exactly one of the four may be set. Not recursive — an item
//!   inside `all`/`any` cannot itself be an `all`/`any` — because upstream's
//!   analogue is a flat `evalexpr` boolean expression, not a composable tree,
//!   and a flat list already covers what a boolean expression buys without
//!   pulling in an expression language (see the "why not `buzz-workflow`"
//!   section above — that reasoning still holds for v1's condition language).
//! - **`trigger.schedule`** — a cron expression (5, 6, or 7 fields; the
//!   `cron` crate's own field count, seconds included, or the shorter forms
//!   normalized up to it — mirrors `buzz_workflow::schema::normalize_cron`
//!   exactly, so a string means the same schedule in both engines). Mutually
//!   exclusive with `contains` / `matches` / `all` / `any`: a schedule fires
//!   on the clock, not on a message, so there is nothing to evaluate a
//!   content condition against. A schedule trigger also does not set
//!   `trigger.channel` — there is no triggering channel to scope to — so the
//!   destination is `action.channel` instead (see next point), which a
//!   schedule workflow is required to set.
//! - **`action.channel`** — an explicit destination channel, validated as a
//!   UUID like `trigger.channel`. For a message trigger this is an *override*
//!   of the default (reply into whichever channel the trigger fired in); for
//!   a schedule trigger it is the only place a destination can come from, so
//!   it is required. Either way, whether the runner actually holds a key for
//!   that channel is a runtime check ([`crate::workflow_agent::act`]), not a
//!   parse-time one — the whole point of "fail loud, not fail open" here is
//!   that a workflow naming a channel this identity was never admitted to
//!   must be refused loudly per firing, not silently downgraded to plaintext
//!   or silently skipped.

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
    #[serde(default)]
    all: Option<Vec<ConditionFile>>,
    #[serde(default)]
    any: Option<Vec<ConditionFile>>,
    /// A cron expression — see the module doc's "buzz#22" section. Mutually
    /// exclusive with everything else above.
    #[serde(default)]
    schedule: Option<String>,
}

/// One entry of a `trigger.all` / `trigger.any` list — the same two
/// conditions the top-level trigger supports, deliberately not itself
/// recursive (see the module doc).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConditionFile {
    #[serde(default)]
    contains: Option<String>,
    #[serde(default)]
    matches: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionFile {
    #[serde(default)]
    reply: Option<String>,
    /// Post a NIP-25 kind:7 reaction onto the triggering message instead of
    /// replying (buzz#52). Mutually exclusive with `reply`.
    #[serde(default)]
    add_reaction: Option<AddReactionFile>,
    /// Cross-channel override / schedule destination (buzz#22) — see the
    /// module doc's "buzz#22" section. Not valid alongside `add_reaction`:
    /// a reaction always targets the triggering message's own event, which
    /// is only ever addressable in the channel it was posted in.
    #[serde(default)]
    channel: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AddReactionFile {
    emoji: String,
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
    /// Every sub-condition must match (`trigger.all`).
    All(Vec<Condition>),
    /// At least one sub-condition must match (`trigger.any`).
    Any(Vec<Condition>),
}

impl Condition {
    /// Does `text` fire this trigger?
    pub fn evaluate(&self, text: &str) -> bool {
        match self {
            Condition::Contains(needle) => text.to_lowercase().contains(&needle.to_lowercase()),
            Condition::Matches { regex, .. } => regex.is_match(text),
            Condition::All(conditions) => conditions.iter().all(|c| c.evaluate(text)),
            Condition::Any(conditions) => conditions.iter().any(|c| c.evaluate(text)),
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
            (Condition::All(a), Condition::All(b)) => a == b,
            (Condition::Any(a), Condition::Any(b)) => a == b,
            _ => false,
        }
    }
}

/// The upper bound NIP-25 puts on a reaction's `content` — mirrors
/// `buzz_sdk::builders::build_reaction`'s `EmojiTooLong` check, so a
/// too-long emoji fails at workflow-load time rather than at publish time.
const MAX_EMOJI_CHARS: usize = 64;

/// What a fired workflow does (buzz#52 widens this from "always a reply" to
/// "a reply, or a reaction on the triggering message").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionKind {
    /// Post `text` as a channel message — v1's (and still the default)
    /// action.
    Reply(String),
    /// Post a NIP-25 kind:7 reaction (`emoji`) onto the triggering message —
    /// see the module doc's "buzz#52" section.
    AddReaction { emoji: String },
}

/// A compiled `trigger.schedule` — the cron expression plus its display
/// source, since [`cron::Schedule`] round-trips through [`Display`] but not
/// every caller wants to reformat it just to log what was configured.
///
/// [`Display`]: std::fmt::Display
#[derive(Debug, Clone)]
pub struct Schedule {
    /// The expression exactly as authored (before normalization), for logs
    /// and error messages.
    pub source: String,
    pub compiled: std::sync::Arc<cron::Schedule>,
}

impl PartialEq for Schedule {
    fn eq(&self, other: &Self) -> bool {
        self.source == other.source
    }
}

/// What kind of thing starts a workflow (buzz#22 widens this from "always a
/// message condition" to "a message condition, or a wall-clock schedule").
#[derive(Debug, Clone, PartialEq)]
pub enum TriggerKind {
    /// A channel message matching `condition` — v1's (and still the default)
    /// shape.
    Message(Condition),
    /// A cron schedule — see the module doc's "buzz#22" section.
    Schedule(Schedule),
}

/// Normalize a cron expression to the 7-field (`sec min hour dom month dow
/// year`) form the `cron` crate requires. Mirrors
/// `buzz_workflow::schema::normalize_cron` field-for-field, so the same
/// string means the same schedule in both engines.
fn normalize_cron(expr: &str) -> String {
    match expr.split_whitespace().count() {
        5 => format!("0 {expr} *"),
        6 => format!("{expr} *"),
        _ => expr.to_string(),
    }
}

/// Parse and validate one `all`/`any` item, or the top-level `contains` /
/// `matches` pair — shared so both call sites reject "both set" / "neither
/// set" identically.
fn parse_condition(
    contains: Option<String>,
    matches: Option<String>,
    source: &Path,
    context: &str,
) -> Result<Condition, CliError> {
    match (contains, matches) {
        (Some(_), Some(_)) => Err(CliError::Usage(format!(
            "{}: {context} must set exactly one of 'contains' or 'matches', not both",
            source.display()
        ))),
        (None, None) => Err(CliError::Usage(format!(
            "{}: {context} must set one of 'contains' or 'matches'",
            source.display()
        ))),
        (Some(needle), None) if needle.is_empty() => Err(CliError::Usage(format!(
            "{}: {context}.contains must not be empty",
            source.display()
        ))),
        (Some(needle), None) => Ok(Condition::Contains(needle)),
        (None, Some(pattern)) => {
            let regex = Regex::new(&pattern).map_err(|e| {
                CliError::Usage(format!(
                    "{}: {context}.matches is not a valid regex: {e}",
                    source.display()
                ))
            })?;
            Ok(Condition::Matches {
                pattern,
                regex: std::sync::Arc::new(regex),
            })
        }
    }
}

/// One loaded, validated workflow: one trigger, one action — widened by
/// buzz#22 from "trigger is always a message condition" to "trigger is a
/// message condition or a schedule" (see [`TriggerKind`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Workflow {
    /// Display name — the `name:` field, or the file's stem when omitted.
    pub name: String,
    /// Where this workflow was loaded from, for logs and error messages.
    pub source: PathBuf,
    /// Restrict evaluation to one channel, or `None` for every channel the
    /// runner holds a key for. Always `None` for a [`TriggerKind::Schedule`]
    /// workflow (validated in [`parse_workflow`]) — a schedule has no
    /// triggering channel to scope to.
    pub channel: Option<String>,
    pub trigger: TriggerKind,
    /// What firing does — a reply (posted into the triggering channel, or
    /// `action_channel` for a schedule trigger) or a reaction on the
    /// triggering message (buzz#52; never valid for a schedule trigger,
    /// which has no triggering message — see [`parse_workflow`]).
    pub action: ActionKind,
    /// `action.channel`: a cross-channel override for a message trigger's
    /// reply, or the required destination for a schedule trigger. See the
    /// module doc's "buzz#22" section. Always `None` for an `add_reaction`
    /// action (validated in [`parse_workflow`]) — a reaction targets the
    /// triggering message's own channel, not an overridable one.
    pub action_channel: Option<String>,
}

impl Workflow {
    /// Whether this workflow is even in scope for `channel_id` — checked
    /// before the (more expensive) condition, and before the caller spends a
    /// decrypt on a message this workflow was never going to look at. Always
    /// `false` for a schedule workflow: it is never reached by the message
    /// walk (see `crate::workflow_agent::plan_trigger`), only by the
    /// scheduler pass.
    pub fn applies_to_channel(&self, channel_id: &str) -> bool {
        matches!(self.trigger, TriggerKind::Message(_))
            && self
                .channel
                .as_deref()
                .is_none_or(|only| only == channel_id)
    }

    /// The condition to evaluate, for a message-triggered workflow.
    pub fn condition(&self) -> Option<&Condition> {
        match &self.trigger {
            TriggerKind::Message(condition) => Some(condition),
            TriggerKind::Schedule(_) => None,
        }
    }

    /// The compiled schedule, for a schedule-triggered workflow.
    pub fn schedule(&self) -> Option<&Schedule> {
        match &self.trigger {
            TriggerKind::Message(_) => None,
            TriggerKind::Schedule(schedule) => Some(schedule),
        }
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

    let validate_channel = |field: &str, channel: String| -> Result<String, CliError> {
        crate::validate::validate_uuid(&channel).map_err(|_| {
            CliError::Usage(format!(
                "{}: {field} {channel:?} is not a valid channel UUID",
                source.display()
            ))
        })?;
        Ok(channel)
    };

    let has_message_fields = file.trigger.contains.is_some()
        || file.trigger.matches.is_some()
        || file.trigger.all.is_some()
        || file.trigger.any.is_some();

    let trigger = match file.trigger.schedule {
        Some(expr) => {
            if has_message_fields {
                return Err(CliError::Usage(format!(
                    "{}: a schedule trigger cannot also set 'contains', 'matches', 'all', or 'any'",
                    source.display()
                )));
            }
            if file.trigger.channel.is_some() {
                return Err(CliError::Usage(format!(
                    "{}: a schedule trigger has no triggering channel to scope to — set \
'action.channel' for the destination instead of 'trigger.channel'",
                    source.display()
                )));
            }
            let normalized = normalize_cron(&expr);
            let compiled = normalized.parse::<cron::Schedule>().map_err(|e| {
                CliError::Usage(format!(
                    "{}: trigger.schedule {expr:?} is not a valid cron expression: {e}",
                    source.display()
                ))
            })?;
            TriggerKind::Schedule(Schedule {
                source: expr,
                compiled: std::sync::Arc::new(compiled),
            })
        }
        None => {
            let condition = match (
                file.trigger.contains,
                file.trigger.matches,
                file.trigger.all,
                file.trigger.any,
            ) {
                (Some(needle), None, None, None) if !needle.is_empty() => {
                    Condition::Contains(needle)
                }
                (Some(_), None, None, None) => {
                    return Err(CliError::Usage(format!(
                        "{}: trigger.contains must not be empty",
                        source.display()
                    )))
                }
                (None, Some(pattern), None, None) => {
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
                (None, None, Some(items), None) => {
                    Condition::All(parse_condition_list(items, source, "trigger.all")?)
                }
                (None, None, None, Some(items)) => {
                    Condition::Any(parse_condition_list(items, source, "trigger.any")?)
                }
                (None, None, None, None) => {
                    return Err(CliError::Usage(format!(
                        "{}: trigger must set one of 'contains', 'matches', 'all', 'any', or 'schedule'",
                        source.display()
                    )))
                }
                _ => {
                    return Err(CliError::Usage(format!(
                        "{}: trigger must set exactly one of 'contains', 'matches', 'all', or 'any'",
                        source.display()
                    )))
                }
            };
            TriggerKind::Message(condition)
        }
    };

    let channel = file
        .trigger
        .channel
        .map(|channel| validate_channel("trigger.channel", channel))
        .transpose()?;

    let action_channel = file
        .action
        .channel
        .map(|channel| validate_channel("action.channel", channel))
        .transpose()?;

    if matches!(trigger, TriggerKind::Schedule(_)) && action_channel.is_none() {
        return Err(CliError::Usage(format!(
            "{}: a schedule trigger has no triggering channel to reply into, so 'action.channel' \
is required",
            source.display()
        )));
    }

    let action = match (file.action.reply, file.action.add_reaction) {
        (Some(_), Some(_)) => {
            return Err(CliError::Usage(format!(
                "{}: action must set exactly one of 'reply' or 'add_reaction', not both",
                source.display()
            )))
        }
        (None, None) => {
            return Err(CliError::Usage(format!(
                "{}: action must set one of 'reply' or 'add_reaction'",
                source.display()
            )))
        }
        (Some(reply), None) => {
            if reply.trim().is_empty() {
                return Err(CliError::Usage(format!(
                    "{}: action.reply must not be empty",
                    source.display()
                )));
            }
            ActionKind::Reply(reply)
        }
        (None, Some(AddReactionFile { emoji })) => {
            if matches!(trigger, TriggerKind::Schedule(_)) {
                return Err(CliError::Usage(format!(
                    "{}: a schedule trigger has no triggering message — 'action.add_reaction' \
needs one to react to",
                    source.display()
                )));
            }
            if action_channel.is_some() {
                return Err(CliError::Usage(format!(
                    "{}: 'action.add_reaction' cannot also set 'action.channel' — a reaction \
always targets the triggering message's own channel",
                    source.display()
                )));
            }
            let emoji = emoji.trim().to_string();
            if emoji.is_empty() {
                return Err(CliError::Usage(format!(
                    "{}: action.add_reaction.emoji must not be empty",
                    source.display()
                )));
            }
            if emoji.chars().count() > MAX_EMOJI_CHARS {
                return Err(CliError::Usage(format!(
                    "{}: action.add_reaction.emoji must be at most {MAX_EMOJI_CHARS} characters",
                    source.display()
                )));
            }
            ActionKind::AddReaction { emoji }
        }
    };

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
        trigger,
        action,
        action_channel,
    })
}

/// Parse and validate every item of a `trigger.all` / `trigger.any` list.
/// Rejects an empty list — `all: []` is vacuously true and `any: []` is
/// vacuously false, and either is far more likely a typo than an intended
/// always/never trigger.
fn parse_condition_list(
    items: Vec<ConditionFile>,
    source: &Path,
    context: &str,
) -> Result<Vec<Condition>, CliError> {
    if items.is_empty() {
        return Err(CliError::Usage(format!(
            "{}: {context} must not be empty",
            source.display()
        )));
    }
    items
        .into_iter()
        .map(|item| parse_condition(item.contains, item.matches, source, context))
        .collect()
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
        assert_eq!(
            wf.condition().cloned(),
            Some(Condition::Contains("hello".to_string()))
        );
        assert_eq!(wf.action, ActionKind::Reply("hi there".to_string()));
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
        assert!(wf.condition().unwrap().evaluate("deploy service to prod"));
        assert!(!wf
            .condition()
            .unwrap()
            .evaluate("deploy service to staging"));
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

    // ─── buzz#22: all / any composition ─────────────────────────────────────

    #[test]
    fn an_all_condition_requires_every_sub_condition() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  all:\n",
            "    - contains: P1\n    - contains: prod\n",
            "action:\n  reply: escalate\n",
        );
        let wf = parse_workflow(yaml, &path("all.yaml")).unwrap();
        let cond = wf.condition().unwrap();
        assert!(cond.evaluate("P1 incident in prod"));
        assert!(!cond.evaluate("P1 incident in staging"));
        assert!(!cond.evaluate("prod is fine"));
    }

    #[test]
    fn an_any_condition_requires_one_sub_condition() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  any:\n",
            "    - contains: P1\n    - contains: SEV1\n",
            "action:\n  reply: escalate\n",
        );
        let wf = parse_workflow(yaml, &path("any.yaml")).unwrap();
        let cond = wf.condition().unwrap();
        assert!(cond.evaluate("a P1 incident"));
        assert!(cond.evaluate("a SEV1 incident"));
        assert!(!cond.evaluate("a routine deploy"));
    }

    #[test]
    fn all_and_any_are_mutually_exclusive_with_contains() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  contains: hi\n  all:\n    - contains: bye\n",
            "action:\n  reply: yo\n",
        );
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("exactly one")));
    }

    #[test]
    fn an_empty_all_list_is_rejected() {
        let yaml = "version: 1\ntrigger:\n  all: []\naction:\n  reply: yo\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("trigger.all")));
    }

    #[test]
    fn an_empty_any_list_is_rejected() {
        let yaml = "version: 1\ntrigger:\n  any: []\naction:\n  reply: yo\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("trigger.any")));
    }

    #[test]
    fn an_all_item_with_neither_contains_nor_matches_is_rejected() {
        let yaml = "version: 1\ntrigger:\n  all:\n    - {}\naction:\n  reply: yo\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn an_all_item_may_use_matches_instead_of_contains() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  all:\n",
            "    - matches: '^deploy'\n    - contains: prod\n",
            "action:\n  reply: ack\n",
        );
        let wf = parse_workflow(yaml, &path("all-matches.yaml")).unwrap();
        assert!(wf.condition().unwrap().evaluate("deploy to prod"));
        assert!(!wf.condition().unwrap().evaluate("redeploy to prod"));
    }

    // ─── buzz#22: schedule trigger ──────────────────────────────────────────

    #[test]
    fn a_schedule_trigger_parses_with_a_5_field_cron_and_a_destination() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  schedule: '0 9 * * 1-5'\n",
            "action:\n  reply: standup time\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
        );
        let wf = parse_workflow(yaml, &path("standup.yaml")).unwrap();
        assert_eq!(wf.schedule().unwrap().source, "0 9 * * 1-5");
        assert!(wf.condition().is_none());
        assert_eq!(
            wf.action_channel.as_deref(),
            Some("6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b")
        );
    }

    #[test]
    fn a_schedule_trigger_accepts_7_field_cron_with_seconds() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  schedule: '*/2 * * * * * *'\n",
            "action:\n  reply: tick\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
        );
        assert!(parse_workflow(yaml, &path("tick.yaml")).is_ok());
    }

    #[test]
    fn a_schedule_trigger_without_a_destination_channel_is_rejected() {
        let yaml = "version: 1\ntrigger:\n  schedule: '0 9 * * 1-5'\naction:\n  reply: hi\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("action.channel")));
    }

    #[test]
    fn a_schedule_trigger_cannot_also_set_contains() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  schedule: '0 9 * * 1-5'\n  contains: hi\n",
            "action:\n  reply: hi\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
        );
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn a_schedule_trigger_cannot_also_set_trigger_channel() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  schedule: '0 9 * * 1-5'\n",
            "  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
            "action:\n  reply: hi\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
        );
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn an_invalid_cron_expression_is_rejected() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  schedule: 'not-a-cron'\n",
            "action:\n  reply: hi\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
        );
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn an_invalid_action_channel_uuid_is_rejected() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  contains: hi\n",
            "action:\n  reply: hi\n  channel: not-a-uuid\n",
        );
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    // ─── buzz#22: action.channel override (message triggers) ───────────────

    #[test]
    fn a_message_trigger_may_set_an_action_channel_override() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  contains: hi\n",
            "action:\n  reply: hi\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
        );
        let wf = parse_workflow(yaml, &path("cross.yaml")).unwrap();
        assert_eq!(
            wf.action_channel.as_deref(),
            Some("6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b")
        );
    }

    #[test]
    fn a_message_trigger_action_channel_is_optional() {
        let yaml = "version: 1\ntrigger:\n  contains: hi\naction:\n  reply: hi\n";
        let wf = parse_workflow(yaml, &path("noop.yaml")).unwrap();
        assert_eq!(wf.action_channel, None);
    }

    // ─── buzz#22: a schedule workflow never matches the message walk ────────

    #[test]
    fn a_schedule_workflow_never_applies_to_any_walked_channel() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  schedule: '0 9 * * 1-5'\n",
            "action:\n  reply: hi\n  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
        );
        let wf = parse_workflow(yaml, &path("standup.yaml")).unwrap();
        assert!(!wf.applies_to_channel("6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b"));
        assert!(!wf.applies_to_channel("anything"));
    }

    // ─── buzz#52: action.add_reaction ────────────────────────────────────────

    #[test]
    fn a_message_trigger_may_use_add_reaction_instead_of_reply() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  contains: todo\n",
            "action:\n  add_reaction:\n    emoji: eyes\n",
        );
        let wf = parse_workflow(yaml, &path("triage.yaml")).unwrap();
        assert_eq!(
            wf.action,
            ActionKind::AddReaction {
                emoji: "eyes".to_string()
            }
        );
    }

    #[test]
    fn add_reaction_and_reply_are_mutually_exclusive() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  contains: todo\n",
            "action:\n  reply: hi\n  add_reaction:\n    emoji: eyes\n",
        );
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("exactly one")));
    }

    #[test]
    fn an_action_with_neither_reply_nor_add_reaction_is_rejected() {
        let yaml = "version: 1\ntrigger:\n  contains: todo\naction: {}\n";
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn an_empty_add_reaction_emoji_is_rejected() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  contains: todo\n",
            "action:\n  add_reaction:\n    emoji: '   '\n",
        );
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("emoji")));
    }

    #[test]
    fn an_overlong_add_reaction_emoji_is_rejected() {
        let long = "x".repeat(65);
        let yaml = format!(
            "version: 1\ntrigger:\n  contains: todo\naction:\n  add_reaction:\n    emoji: {long}\n"
        );
        let err = parse_workflow(&yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("64")));
    }

    #[test]
    fn add_reaction_cannot_set_an_action_channel_override() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  contains: todo\n",
            "action:\n  add_reaction:\n    emoji: eyes\n",
            "  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
        );
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(_)));
    }

    #[test]
    fn a_schedule_trigger_cannot_use_add_reaction() {
        let yaml = concat!(
            "version: 1\ntrigger:\n  schedule: '0 9 * * 1-5'\n",
            "action:\n  add_reaction:\n    emoji: eyes\n",
            "  channel: 6f1c9d02-1c2a-4a55-9f2b-8f4c0d1e2a3b\n",
        );
        let err = parse_workflow(yaml, &path("bad.yaml")).unwrap_err();
        assert!(matches!(err, CliError::Usage(msg) if msg.contains("add_reaction")));
    }
}
