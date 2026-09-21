# Phase 1 contract fixtures

The JSON files in this directory are executable contract fixtures. Unit and
contract tests load them at runtime to verify schema parity, example validity,
and frozen D4 classification behavior.

They are repository assets, not disposable planning notes:

- `d2-handoff.schema.json` is the published D2 structural contract.
- `d2-handoff.example.json` is the valid illustrative D2 envelope.
- `d4-task-corpus.json` is the frozen D4 v1 classification corpus.

Changes to these files require corresponding contract-test updates and a clear
versioning decision. Do not delete them during documentation cleanup.
