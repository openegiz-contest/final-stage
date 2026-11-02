# Third-party notices

| What | Where | Licence |
|---|---|---|
| three.js r181 (core build, the examples used by the Stage) | `contest/site/assets/3d/three/` | MIT, Copyright 2010-2025 three.js authors; text in `contest/site/assets/3d/three/LICENSE` |
| GLTFLoader, BufferGeometryUtils (three.js examples) | `contest/stage/vendor/three-addons/` | MIT, same authors; text in `contest/stage/vendor/three-addons/LICENSE` |
| Inter (variable) | `contest/stage/assets/fonts/Inter-wght.woff2` | SIL Open Font License 1.1, The Inter Project Authors; text in `contest/stage/assets/fonts/OFL-Inter.txt` |
| Geologica (variable) | `contest/stage/assets/fonts/Geologica-wght.woff2` | SIL Open Font License 1.1, The Geologica Project Authors; text in `contest/stage/assets/fonts/OFL-Geologica.txt` |
| IBM Plex Mono (Regular, Medium, SemiBold) | `contest/stage/assets/fonts/IBMPlexMono-*.woff2` | SIL Open Font License 1.1, IBM Corp.; text in `contest/stage/assets/fonts/OFL-IBMPlexMono.txt` |

Everything else is original to this project: the robot models (`contest/stage/assets/robots/*.glb`, made with
Blender by `contest/stage/tools/blender/robots.py`, no imported assets, no textures), the procedural mine
(`contest/site/assets/3d/mine.js`), the test patterns under `contest/stage/test/program/fixture/assets/`
(generated with ffmpeg's `testsrc` sources) and the mine poster (`contest/stage/assets/mock/mine-poster.jpg`, a
render of the procedural mine).

The speech service can call ElevenLabs and Yandex SpeechKit with the user's own keys; their terms apply to that
use. The voice ids in `contest/stage/tts/voices.json` are public voice-library ids, not credentials.
