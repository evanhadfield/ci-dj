"""Collective-intelligence layer feature flag (Phase 0).

Reads `COLLECTIVE_ENABLED` from the environment. Off by default, so SlipMate's
behaviour is unchanged until the operator opts in (docs/collective/PLAN.md §10
hard rule). Re-evaluated on every call so test fixtures can flip it with
`monkeypatch.setenv` and a long-lived process can be toggled without restart.
"""

import os


def is_enabled() -> bool:
    return os.environ.get("COLLECTIVE_ENABLED", "0") == "1"
