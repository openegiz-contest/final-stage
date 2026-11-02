# OBS setup for the Final broadcast

One human host (the owner) on the built-in MacBook camera. The setup is generated, not clicked: `build_collection.py` writes an OBS scene collection and profile, `check.mjs` checks the running OBS. The older brief for two hosts is `../OBS.md`; its encoder and audio numbers still apply.

## Install

1. Quit OBS (it overwrites these files on exit; the script refuses to run while OBS is open, `--force` overrides).
2. `python3 contest/stage/obs/build_collection.py`. Stdlib only. It writes:
   - scene collection `~/Library/Application Support/obs-studio/basic/scenes/OpenEgiz Final.json`;
   - profile `~/Library/Application Support/obs-studio/basic/profiles/OpenEgiz Final/` (`basic.ini`, `service.json`, `streamEncoder.json`, `recordEncoder.json`);
   - the two masks next to the script: `mask-circle-300.png` (300×300) and `mask-rrect-1120x630.png` (r=24);
   - obs-websocket on port 4455 with auth (`plugin_config/obs-websocket/config.json`); the password is in `~/.config/openegiz/obs-ws.txt` (chmod 600), kept on re-runs;
   - the recordings folder `~/Movies/openegiz-final/`.

   Re-running overwrites only these files. Other collections and profiles are not touched.
3. The collection points the masks at this `obs/` folder (its absolute path). Other path: `--mask-ref-dir DIR`.
4. Start OBS with the collection and profile: `open -a OBS --args --collection "OpenEgiz Final" --profile "OpenEgiz Final"`. Or in OBS: menu Profile → «OpenEgiz Final», Scene Collection → «OpenEgiz Final».

## Stream key

The only thing left for the owner: Settings → Stream → service «YouTube - RTMPS» is already chosen; paste the key into «Stream Key» (Use Stream Key, not Connect Account). The key is not stored anywhere in the repo.

## What is in it

Canvas and output 1920×1080, 30 fps. Apple VT H.264 hardware, CBR 6000 kbps, keyframe every 2 s, AAC 160 kbps 48 kHz. Recording: MKV in `~/Movies/openegiz-final/`, auto-remuxed to MP4 (the MKV stays next to it). Transition: Fade 400 ms. OBS's global Mic/Aux and Desktop audio are off; only «Микрофон» (built-in mic, RNNoise + limiter −3 dB) and the Stage browser source are heard.

| Scene | Content |
|---|---|
| 1 Скоро начнём | `idle.html?mode=soon&at=2026-10-31T15:00:00%2B05:00`. Silent |
| 2 Ведущий | `idle.html?mode=host&name=…&role=Соведущий`, the camera in a rounded 1120×630 frame at (100, 170), mic |
| 3 Эфир | `show.html?cams=1&air=1&hold=0` (no holds: spec §7.7, the Stage runs title to end by itself; OBS controls its audio, "Monitor and Output": the host hears the robots in headphones; never shut down, no refresh on activation), the camera circle 300×300 at (40, 40), mic |
| 4 Стенд | macOS Screen Capture of Google Chrome (the Stand window `stands-live.sh open` starts), fitted to 1920×1080, the camera circle, mic |
| 5 Технический перерыв | `idle.html?mode=break`. Silent |
| 6 Финиш | `idle.html?mode=end`, the camera circle, mic |

Every `idle.html` source shuts down when not visible and reloads when its scene becomes active (one WebGL page runs at a time). The server base is `http://127.0.0.1:8780/`: start the Stage server before the scenes are used. OBS starts on scene 1.

The camera and the mic are one source each. A source has one filter chain, so the camera shapes are two helper scenes at the end of the scene list, `_Камера: круг` and `_Камера: рамка`: each has the custom size of its mask, fits the camera into it (crop to fill) and applies the mask. Do not delete them; resize them only together with the mask.

## Hotkeys

| Key | Action |
|---|---|
| Ctrl+Option+1 … 6 | switch to scene 1 … 6 |
| Ctrl+Option+M | mute / unmute «Микрофон» (one key bound to both, a toggle) |

Hotkeys work while another app is in front only with the macOS permission Input Monitoring for OBS (below).

## macOS permissions

System Settings → Privacy & Security, for OBS:

- Camera: the camera sources;
- Microphone: «Микрофон»;
- Screen & System Audio Recording: scene 4 (Screen Capture);
- Input Monitoring: the global hotkeys.

Without a permission the source is black or silent; OBS must be restarted after granting.

## Scene 4: the window

The source captures the whole main display, so whatever window is in front there is on air: keep only the Stand window on it during the Stands (Claude, Terminal, YouTube Studio on the other displays). Application capture (`com.google.Chrome`) does not work: every Stand runs in its own Chrome process (own proxy), and OBS captures only one Chrome process. The display is the main one (Dell AW2724DM, 2560×1440), where `stands_panel.py` opens the Stand windows; the fit to the canvas is stored for it; with another display select the source and press Ctrl+F (Fit to screen) in the preview.

## Check

With OBS running and the Stage server up (`python3 contest/stage/server.py --port 8780`):

```
node contest/stage/obs/check.mjs                # all scenes + 60 s recording
node contest/stage/obs/check.mjs --skip-record  # scenes only
```

Node 22+ (built-in `WebSocket`), `ffprobe` in PATH. For each scene: switch, wait 4 s, screenshot of the program to `/tmp/obs-check/<n>.png`, GetStats (CPU, active fps, skipped frames). Then a 60 s recording on scene 3, and `ffprobe` of the files: 1920×1080, 30 fps, an audio stream. Exit code 1 if the ffprobe check fails. Look at the screenshots: the camera circle at the top-left, nothing of the Stage's text under it.
