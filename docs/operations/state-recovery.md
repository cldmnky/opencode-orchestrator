# Operator state recovery

State recovery is an operator-only CLI surface. It never appears as a model
tool and never touches repository files, Git, or GitHub.

```sh
# Bounded metadata only; no objectives, prompts, transcripts, evidence text, or raw records.
opencode-v2-agent-orchestrator state export --session ses_123

# Strict schema validation with family, version, and exact parse issue paths.
opencode-v2-agent-orchestrator state validate --session ses_123

# Archive every discoverable record for one session, then remove the originals.
opencode-v2-agent-orchestrator state archive --session ses_123

# Archive and remove one family only. The explicit confirmation is required.
opencode-v2-agent-orchestrator state reset --session ses_123 --family review-v1 --yes
```

The CLI uses `opencode api` and therefore the host's service discovery and
authentication. A location can be supplied with `--directory`; every request
uses the V2 deep-object `location[directory]` parameter.

Recovery is fail-closed when the server storage backend cannot scan, when the
bounded scan cap is reached, or when a scan fails. Archive writes complete
before the first live key is removed. A reset always names exactly one session
and one family; there is no recursive or project-wide delete operation.

Archives are stored in the plugin-owned
`orchestrator-state-archive/v1/<timestamp>/` namespace and contain the original
versioned value for operator recovery. A timestamp collision receives a
numeric suffix. Export and validation expose metadata only. If removal fails
after archiving, the recovery path attempts to restore every live record from
the completed archive before reporting the failure.
