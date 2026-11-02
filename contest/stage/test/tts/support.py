"""Shared test helpers: import path, the word-contract checker, a mock HTTP server."""

import base64
import json
import struct
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
TTS = HERE.parent.parent / "tts"
sys.path.insert(0, str(TTS))

FIXTURES = HERE / "fixtures"
SHORT = "Коллеги, команда «Север-7» набрала 86 баллов из 100: диспетчер не терял самосвалы, но карта простоя осталась без единого пояснения."


def check_words(tc, text, words, duration, tol=0.3):
    """The word contract of providers/common.py, checked on a result."""
    tc.assertTrue(words, "no words")
    tokens = len(text.split())
    tc.assertEqual(len(words), tokens, "one word per whitespace-delimited token")
    tc.assertEqual(words[0]["start_char"], 0)
    tc.assertEqual(words[-1]["end_char"], len(text))
    for a, b in zip(words, words[1:]):
        tc.assertEqual(a["end_char"], b["start_char"], "characters are partitioned")
        tc.assertLessEqual(a["start_s"], b["start_s"], "starts are monotonic")
        tc.assertLessEqual(a["end_s"], b["start_s"] + 1e-6 + (a["end_s"] - a["start_s"]), "")
    for w in words:
        tc.assertLess(w["start_char"], w["end_char"])
        tc.assertLessEqual(w["start_s"], w["end_s"])
        tc.assertGreaterEqual(w["start_s"], 0)
        tc.assertLessEqual(w["end_s"], duration + 1e-6)
    tc.assertLessEqual(abs(words[-1]["end_s"] - duration), tol, "last end is close to the duration")
    # the verbatim text is recoverable from the offsets
    tc.assertEqual("".join(text[w["start_char"]:w["end_char"]] for w in words), text)


def wav_bytes(seconds=0.2, sr=8000):
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack("<h", 0) * int(sr * seconds))
    return buf.getvalue()


class Mock:
    """A local HTTP server answering every POST with `handler(path, headers, body) -> (status, bytes)`."""

    def __init__(self, handler):
        self.calls = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.calls.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": json.loads(body)})
                status, data = handler(self.path, self.headers, json.loads(body))
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()
