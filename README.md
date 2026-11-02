# OpenEgiz Final: the Stage

The Stage is the 3D picture of the OpenEgiz Final broadcast ("Digital Mine on OpenEgiz" contest): a control room
at night, five robot Judges and a robot Host, subtitles, voices, the sealed-envelope reveal. The Final was
streamed once, on 31 October 2026, 15:00 Astana time, on the YouTube channel of the summer school.

**This is the code used on air.** It is the `contest/stage/` folder of the private organizers' repository at
commit `ddc2403`, exported without git history (the history was not reviewed for publication) and checked for
secrets, personal data and licences.

## What it does, and what it does not

The Stage only *reads*. It has three sources, all through `contest/stage/server.py` (GET and HEAD only, every
path confined to its root):

1. `/run/state.json`: the Judges engine's state, rewritten by the engine after every event, polled once a second;
2. `/run/turns/<id>/`: the engine's raw turn logs (the Judges' tool calls and answers), scrubbed by the engine's
   own page before they reach the Stage;
3. `/pub/`: the Final Materials (the published Qualifying results and the Finalists' sources).

It invents no event, no text and no activity: a Judge's words are shown verbatim, and the Stage decides nothing.
The shapes of these sources are in [`contest/stage/CONTRACT.md`](contest/stage/CONTRACT.md). The engine itself
(the Judges' pipeline) is a separate repository and is not part of this one.

## Run it on the synthetic replays

Python 3.10+ and a browser with WebGL2 (Chrome, Brave, Edge). No build step, no `npm install`, no keys: the page
loads three.js and the fonts from this repo, and `voice=estimate` plays the lines silently, typed on estimated timing,
without a speech service.

```bash
python3 contest/stage/server.py --run contest/stage/test/replays/synthetic-run --program contest/stage/test/program/fixture
```

then open

- `http://127.0.0.1:8780/live.html?replay=test/replays/synthetic-full.jsonl&voice=estimate`: the debate of the Judges on a
  recorded run (more recordings: `contest/stage/test/replays/synthetic-*.jsonl`: ceiling, last word, no
  majority, an unavailable Judge, ...);
- `http://127.0.0.1:8780/show.html?replay=test/replays/synthetic-full.jsonl&voice=estimate`: the whole programme (title,
  hash check, the Finalists' minutes, debate, envelopes, result) on a synthetic programme. Space pauses,
  the arrow keys move between segments, `?hold=0` plays without holds.

Everything under `test/replays/synthetic-*` and `test/program/fixture/` is made up. The two
`test/replays/real-live-probe-*.jsonl` recordings are two rehearsal runs of 21 October with real Judge models on
the engine's synthetic fixture (ten invented Teams): real model output, no real Participant's work.

## Tests

No GPU or browser needed:

```bash
python3 -m unittest discover contest/stage/test/tts      # speech service, providers (mocked), tagger
python3 -m unittest discover contest/stage/test/build    # programme builder on a synthetic publication
node --test contest/stage/test/director contest/stage/test/voice contest/stage/tools/record_stand.test.mjs
```

The `*-check.mjs` scripts and `tools/render.mjs` drive headless Chrome with a GPU (`playwright-core` is found on
the global `npm root`, or set `PLAYWRIGHT_CORE`).

## Layout

The paths are the same as in the private repository, so the commands in the Stage's own documents
(`contest/stage/README.md`, `director/README.md`, `robots/README.md`, `tts/README.md`, `obs/README.md`) run as
written. `contest/site/assets/3d/` holds only what the Stage borrows from the contest site: the three.js build
and `mine.js`, the procedural mine.

The Stage's own documents are mostly in Russian and refer to `docs/spec.md` and other files of the private
repository (for example "spec §7.7"); those references do not resolve here.

## Not included

Generated output (`out/`), synthesized audio, recordings of the broadcast or of Stands, API keys (the speech
service reads them from the environment or `~/.config/openegiz-stage/keys.env`), the plans for recording the
Teams' Stands, and the operator script for the Judges' logins.

## Licence

MIT, see [LICENSE](LICENSE). Third-party parts (three.js, fonts) keep their own licences:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The robots are characters for the vendors' models; this
project is not affiliated with Anthropic, OpenAI or ElevenLabs, and uses their names only to say which model or
service is meant.
