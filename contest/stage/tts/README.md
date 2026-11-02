# Stage TTS

Voices for the six robots of the Final Stage (five Judges and the Host), spec §7.7. A local service turns `speaker + text` into audio plus word timings, so the Stage types the verbatim text under the voice.

Engines, in the fallback order of every speaker: ElevenLabs (primary), Yandex SpeechKit v3 (cloud fallback), macOS AVSpeechSynthesizer (offline). Without keys everything runs on macOS.

| Path | What |
|---|---|
| `serve.py` | the service (stdlib, `127.0.0.1:8790`) |
| `prerender.py` | fills the cache from a script, writes a manifest |
| `sample.py` | voice sample for the owner: 6 voices per engine plus `index.html` |
| `voices.json` | speakers, fallback chains, voice settings, sample candidates |
| `engine.py` | chain, cache, timeouts, concurrency (shared by the three scripts) |
| `providers/` | `macos.py`, `elevenlabs.py`, `yandex.py`, `common.py` (word assembly, keys) |
| `swift/macos_tts.swift` | source of the macOS tool; built to `bin/macos_tts` (gitignored) on first use, or `swiftc -O swift/macos_tts.swift -o bin/macos_tts` |
| `../test/tts/` | tests: `python3 -m unittest discover contest/stage/test/tts` (about 15 s) |

## Setup

Python 3.10+, stdlib only. macOS needs `swiftc` (Xcode command line tools); the tool is compiled on the first macOS synthesis.

Keys come from the environment, then from `~/.config/openegiz-stage/keys.env` (`OPENEGIZ_STAGE_KEYS` points elsewhere):

```
# ~/.config/openegiz-stage/keys.env   (chmod 600)
ELEVENLABS_API_KEY=sk_...
YANDEX_API_KEY=AQVN...
YANDEX_FOLDER_ID=b1g...
# optional: YANDEX_BASE_URL (default https://tts.api.ml.yandexcloud.kz, the Kazakhstan endpoint;
# global: https://tts.api.cloud.yandex.net), ELEVENLABS_BASE_URL
```

A missing key makes that engine "unavailable": the chain skips it at once, with no timeout and no cooldown.

## Service

```bash
python3 contest/stage/tts/serve.py [--port 8790] [--voices voices.json] [--cache DIR] [--cors http://127.0.0.1:8780]
```

CORS allows `http://127.0.0.1:8780` (the Stage). Cache: `~/Library/Caches/openegiz-stage/tts/` (override `--cache` or `OPENEGIZ_STAGE_TTS_CACHE`); the key is sha256(engine, voice, settings, text), so a repeated or prefetched request is instant, and a settings change in `voices.json` is a new entry (the `say` dictionary counts only with the entries the text uses: a new pronunciation does not re-synthesise every line).

`GET /synth?speaker=<id>&text=<urlencoded>[&tags=auto|none|<JSON [{at, tag}]>]`:

Audio tags (eleven_v4): with `settings.auto_tags` on, `tags=auto` (the default) asks `tagger.py` (Claude Haiku through the local `claude` CLI, ~5–7 s, cached in `~/.cache/openegiz-stage/tags/`) where to put tags such as `[thoughtful]` or `[sighs]`. The tagger returns only a sentence and a tag from a whitelist, never text. The ElevenLabs provider inserts `[tag] ` and the `say` pronunciations (`engines.elevenlabs.say`, e.g. README → ридми) only into the text it sends, and maps the timings back, so `words` are over the exact text you sent. The response carries `tags`. A tagged line takes ~10 s to prepare on a cache miss: prefetch.

```json
{"audio": "/audio/<sha256>.wav", "duration_s": 35.23, "engine": "macos", "voice": "Milena",
 "format": "wav", "cached": false,
 "fallback_from": [{"engine": "elevenlabs", "error": "ELEVENLABS_API_KEY is not set"}],
 "words": [{"start_char": 0, "end_char": 9, "start_s": 0.005, "end_s": 0.772}, ...]}
```

- `engine`/`voice` name what actually spoke; `fallback_from` (only if non-empty) lists the engines skipped or failed and why.
- `words`: one entry per whitespace-delimited token (`«Север-7»` and `100:` are single words). Characters are partitioned: `words[0].start_char == 0`, `words[i].end_char == words[i+1].start_char`, `words[-1].end_char == len(text)`, offsets are code points of the exact text sent. Type `text[:end_char]` when the voice reaches `end_s` (or `text[:start_char]` at `start_s`). Times never decrease and stay within `duration_s`.
- Errors: 400 (unknown speaker, empty text, over 6000 characters), 502 (every engine failed; body has `tried`), 404.
- `GET /audio/<sha256>.<ext>`: the cached file, `Range` supported (wav, mp3).
- `GET /speakers`: speakers and chains. `GET /health`: which keys are present.

Behaviour: at most 2 synthesis jobs at once; identical requests in flight share one job; a provider that fails or times out (default 8 s, macOS 45 s) falls through to the next engine and is skipped for 30 s (`cooldown_s`), except as the last resort, so a dead network costs one timeout, not one per message. Prefetch the next Judge message by calling `/synth` for it while the previous one plays.

## voices.json

```json
{"settings": {"timeout_s": 8, "cooldown_s": 30, "concurrency": 2},
 "engines":  {"elevenlabs": {"model_id": "eleven_multilingual_v2", "output_format": "mp3_44100_128"}, ...},
 "speakers": {"opus-5.5": {"label": "...", "chain": [
     {"engine": "elevenlabs", "voice": "<voice_id>", "stability": 0.65, "speed": 0.95},
     {"engine": "yandex", "voice": "filipp", "role": "good", "speed": 0.95},
     {"engine": "macos", "voice": "Milena", "rate": 0.42, "pitch": 0.7}]}, ...},
 "sample": {"text": "...", "candidates": {"macos": [...6], "elevenlabs": [...6], "yandex": [...6]}}}
```

Speakers: `opus-5.5`, `sonnet-5.5`, `fable-5.1`, `gpt-6.1-sol`, `gpt-6-astra`, `host`. In a chain entry, `engine`, `voice` and `timeout_s` are routing; every other key is an engine setting (merged over `engines.<name>`, part of the cache key).

- ElevenLabs: `voice` is a voice_id; `model_id` (default `eleven_multilingual_v2`; whether v3/v4 accept `with-timestamps` is untested), `stability`, `similarity_boost`, `style`, `speed`, `use_speaker_boost`, `language_code`, `output_format`, `base_url`.
- Yandex: `voice` (filipp, ermil, alena, dasha, julia, lera, ...), `role`, `speed`, `pitch_shift`, `volume`, `unsafe_mode` (default true: text over 250 characters is split by the service and billed per piece), `base_url`.
- macOS: `voice` (installed name; only Milena for Russian), `rate` (0 to 1, default 0.5; steps are coarse), `pitch` (0.5 to 2).

The voices in the file are provisional. The ElevenLabs ids are premade voices written from memory and not checked against an account; `python3 contest/stage/tts/sample.py --engine elevenlabs --list-voices` prints the account's real ids.

## Pre-render

```bash
python3 contest/stage/tts/prerender.py script.json [--manifest out.json] [--cache DIR] [--jobs 2]
```

`script.json` is `[{"id": "intro-1", "speaker": "host", "text": "..."}, ...]` (`id` optional). It fills the cache through the same chain and writes the manifest (`script.manifest.json` by default): per item `id, speaker, text, audio, file, duration_s, engine, voice, format, words`. The running service serves the same files from the same cache.

## Voice sample for the owner

```bash
python3 contest/stage/tts/sample.py --engine macos        # works now
python3 contest/stage/tts/sample.py --engine elevenlabs   # needs ELEVENLABS_API_KEY
python3 contest/stage/tts/sample.py --engine yandex       # needs YANDEX_API_KEY (+ YANDEX_FOLDER_ID)
```

One phrase (`sample.text`: 19 words, a team name and two numbers), six voices, into `contest/stage/out/voice-sample/<engine>/NN-<voice>.<ext>` plus `index.html` (open it in a browser; each file has a label and a player). A voice that fails is listed on the page with the error. macOS has one Russian voice, Milena: its six files are rate/pitch variants of one timbre. To audition a voice that is not in the list, edit `sample.candidates` in `voices.json`, or design one in the ElevenLabs dashboard (Voice Design), add it to the library and put its voice_id into the file.

## What waits for the owner

- ElevenLabs: an account, an API key, a plan with enough credits (about 58k characters is an hour of speech), then the sample, the pick by ear, and a check that the chosen model returns alignment (`eleven_multilingual_v2` is the documented one).
- Yandex: a Cloud account in the Kazakhstan region with billing, a folder id, an API key (role `ai.speechkit-tts.user`), then the sample. The v3 REST response format used here follows the docs; the first live call confirms it (including that digits are reported as words the aligner can match).
- macOS: Katya (298.6 MB) and Yuri (146.4 MB) ru-RU voices are downloadable in System Settings, Accessibility, Spoken Content, System voice, Manage Voices. A download is an install and needs the owner's yes. Without them every robot's offline voice is Milena with a different rate and pitch.

## Known limits

- macOS word times come from `willSpeakRangeOfSpeechString` at the frame count of the written buffers. Measured on a 35 s message: pauses in the audio sit within 0.15 s of the reported word starts at most punctuation boundaries, the worst case 0.4 s (around an opening quote). The last callback arrives after the audio ends, so the last word's start is estimated from the speaking rate (`fix_last_word`).
- Pitch works in `write()` (measured F0 follows it); rate is quantised (0.46 and 0.50 give the same speed).
