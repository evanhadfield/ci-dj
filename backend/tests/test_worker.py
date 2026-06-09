"""Worker loop tests: the deck must survive engine failures.

The worker runs in a thread with a fake engine (run_deck_worker only needs
the queue interface, so plain queue.Queue works in place of mp.Queue).
"""

import queue
import threading
import time

import pytest

from magenta_dj.worker import run_deck_worker

FAKE_PCM = b"\x00" * 64


class FakeEngine:
    def __init__(self):
        self.prompt = None
        self.fail_set_prompt = False
        self.fail_generate = False

    def set_prompt(self, prompt):
        if self.fail_set_prompt:
            raise RuntimeError("embed blew up")
        self.prompt = prompt

    def generate_chunk(self):
        if self.fail_generate:
            raise RuntimeError("inference blew up")
        return FAKE_PCM


class DeckHarness:
    def __init__(self):
        self.engine = FakeEngine()
        self.cmd_queue = queue.Queue()
        self.out_queue = queue.Queue()
        self.thread = threading.Thread(
            target=run_deck_worker,
            args=("test", "fake", self.cmd_queue, self.out_queue),
            kwargs={"engine_factory": lambda model: self.engine},
            daemon=True,
        )

    def send(self, **command):
        self.cmd_queue.put(command)

    def next_event(self, wanted_kind, timeout=3.0):
        """Return the next ('audio' | status-event-name) payload, skipping others."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                kind, payload = self.out_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            if kind == "audio" and wanted_kind == "audio":
                return payload
            if kind == "status" and payload.get("event") == wanted_kind:
                return payload
        raise AssertionError(f"no {wanted_kind!r} event within {timeout}s")


@pytest.fixture
def deck():
    harness = DeckHarness()
    harness.thread.start()
    harness.next_event("ready")
    yield harness
    harness.send(type="shutdown")
    harness.thread.join(timeout=2)
    assert not harness.thread.is_alive()


def test_play_emits_audio(deck):
    deck.send(type="play")
    assert deck.next_event("audio") == FAKE_PCM
    assert deck.next_event("chunk")["index"] == 0


def test_set_prompt_applies_at_chunk_boundary(deck):
    deck.send(type="set_prompt", prompt="warm disco funk")
    applied = deck.next_event("prompt_applied")
    assert applied["prompt"] == "warm disco funk"
    assert deck.engine.prompt == "warm disco funk"


def test_set_prompt_failure_keeps_worker_alive(deck):
    deck.engine.fail_set_prompt = True
    deck.send(type="set_prompt", prompt="boom")
    assert "set_prompt failed" in deck.next_event("error")["error"]

    # The deck must still take commands and play afterwards.
    deck.engine.fail_set_prompt = False
    deck.send(type="set_prompt", prompt="recovered")
    assert deck.next_event("prompt_applied")["prompt"] == "recovered"
    deck.send(type="play")
    assert deck.next_event("audio") == FAKE_PCM


def test_generation_failure_stops_deck_but_worker_survives(deck):
    deck.engine.fail_generate = True
    deck.send(type="play")
    assert "generation failed" in deck.next_event("error")["error"]

    # The failure auto-stopped the deck; play must work again once the
    # engine recovers.
    deck.engine.fail_generate = False
    deck.send(type="play")
    assert deck.next_event("audio") == FAKE_PCM
