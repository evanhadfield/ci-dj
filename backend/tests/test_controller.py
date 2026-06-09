"""Controller WebSocket tests: input validation at the trust boundary and
session cleanup. A fake deck stands in for the worker process; the lifespan
(which spawns real model workers) is deliberately not entered.
"""

import queue
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from magenta_dj import controller
from magenta_dj.controller import validate_command


class FakeDeck:
    def __init__(self):
        self.deck_id = "a"
        self.model = "fake"
        self.cmd_queue = queue.Queue()
        self.out_queue = queue.Queue()
        self.connected = False
        self.stopped = False

    def send(self, command):
        self.cmd_queue.put(command)

    def drain(self):
        while not self.out_queue.empty():
            self.out_queue.get_nowait()

    def stop_and_drain(self):
        self.stopped = True
        self.drain()


@pytest.fixture
def deck(monkeypatch):
    fake = FakeDeck()
    monkeypatch.setitem(controller.decks, "a", fake)
    return fake


@pytest.fixture
def client():
    return TestClient(controller.app)


def connect(client):
    return client.websocket_connect("/ws/deck/a")


def test_hello_on_connect(client, deck):
    with connect(client) as ws:
        hello = ws.receive_json()
    assert hello["event"] == "hello"
    assert hello["sample_rate"] == 48_000
    assert hello["channels"] == 2


def test_valid_commands_are_forwarded_sanitized(client, deck):
    with connect(client) as ws:
        ws.receive_json()
        ws.send_json({"type": "set_prompt", "prompt": "warm disco funk", "extra": 1})
        ws.send_json({"type": "play"})
    assert deck.cmd_queue.get(timeout=1) == {
        "type": "set_prompt",
        "prompt": "warm disco funk",
    }
    assert deck.cmd_queue.get(timeout=1) == {"type": "play"}


@pytest.mark.parametrize(
    "frame",
    [
        "{not json",
        '"just a string"',
        "[1, 2]",
        '{"type": "shutdown"}',
        '{"type": "set_prompt"}',
        '{"type": "set_prompt", "prompt": 7}',
        '{"type": "set_prompt", "prompt": "  "}',
    ],
)
def test_bad_frames_get_error_and_are_not_forwarded(client, deck, frame):
    with connect(client) as ws:
        ws.receive_json()
        ws.send_text(frame)
        assert ws.receive_json()["event"] == "error"
        # The connection survives and still accepts valid commands.
        ws.send_json({"type": "play"})
    assert deck.cmd_queue.get(timeout=1) == {"type": "play"}
    assert deck.cmd_queue.empty()


def test_binary_frame_gets_error(client, deck):
    with connect(client) as ws:
        ws.receive_json()
        ws.send_bytes(b"\x00\x01")
        assert ws.receive_json()["event"] == "error"


def test_second_connection_is_rejected(client, deck):
    with connect(client) as ws:
        ws.receive_json()
        with pytest.raises(WebSocketDisconnect) as excinfo:
            with connect(client):
                pass
        assert excinfo.value.code == 4409


def test_unknown_deck_is_rejected(client, deck):
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/ws/deck/nope"):
            pass
    assert excinfo.value.code == 4404


def test_disconnect_releases_deck_and_stops_worker(client, deck):
    with connect(client) as ws:
        ws.receive_json()
        assert deck.connected
    assert deck.stopped
    assert not deck.connected
    # A new session must be accepted after the previous one ends.
    with connect(client) as ws:
        assert ws.receive_json()["event"] == "hello"


def test_pump_failure_still_releases_deck(client, deck):
    # Regression: a pump task that dies with a real exception (not
    # CancelledError) must not skip session cleanup, or the deck stays
    # locked and rejects every reconnect until the server restarts.
    with connect(client) as ws:
        ws.receive_json()
        # An unserializable status payload makes the pump's json.dumps raise,
        # killing the pump task while the session is still open.
        deck.out_queue.put(("status", object()))
        deadline = time.monotonic() + 2
        while not deck.out_queue.empty() and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.05)  # let the pump consume it and die
    assert deck.stopped
    assert not deck.connected
    # The deck must accept a fresh session afterwards.
    with connect(client) as ws:
        assert ws.receive_json()["event"] == "hello"


def test_stale_audio_is_drained_on_connect(client, deck):
    deck.out_queue.put(("audio", b"stale"))
    with connect(client) as ws:
        hello = ws.receive_json()
        assert hello["event"] == "hello"
        # Nothing from before the session may reach the client; the first
        # message after hello must be the post-connect one we enqueue now.
        deck.out_queue.put(("status", {"event": "fresh"}))
        assert ws.receive_json()["event"] == "fresh"


@pytest.mark.parametrize(
    ("parsed", "ok"),
    [
        ({"type": "play"}, True),
        ({"type": "stop"}, True),
        ({"type": "set_prompt", "prompt": "x"}, True),
        ({"type": "set_prompt", "prompt": ""}, False),
        ({"type": "set_prompt", "prompt": None}, False),
        ({"type": "shutdown"}, False),
        ({}, False),
        ("play", False),
        (None, False),
    ],
)
def test_validate_command(parsed, ok):
    command, error = validate_command(parsed)
    assert (command is not None) == ok
    assert (error is None) == ok
