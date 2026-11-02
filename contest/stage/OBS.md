# OBS setup for the Final broadcast (brief for Codex, computer use)

Goal: one OBS scene collection on the owner's Mac (M4 Pro, built-in display 3024×1964) that streams the Final on Sat 31 Oct 2026, 15:00 Astana, and is tried at the dress rehearsal Thu 29 Oct 15:00 as an unlisted YouTube stream. Spec: `docs/spec.md` §7.7 («Пульт», «Preshow с живыми ведущими»).

You work in OBS.app through computer use. Do not touch the Stage code, the running servers or other apps. Do not enter or reveal the YouTube stream key: the owner pastes it in (step 6).

## What runs

- Stage server: `http://127.0.0.1:8780/show.html` (started by the orchestrator session). With `?cams=1` the Stage leaves the two top corners free for the webcams.
- Two human hosts sit together at this Mac. Cameras now: the built-in «Камера MacBook Pro»; a second camera may come later (iPhone via Continuity Camera or USB). Until then the second circle is a placeholder.

## Steps

1. **Scene collection** «OpenEgiz Final», canvas and output **1920×1080**, **30 fps**. Keep the existing collection «Безымянный» untouched.
2. **Scene «Эфир»**, sources bottom to top:
   - **Browser source «Сцена»**: URL `http://127.0.0.1:8780/show.html?cams=1&air=1` (no `segment=`: a refresh or a crash of the source comes back where the show was, not to the title; `air=1` keeps the operator's indicator off air; to start the broadcast over, Interact with the source and press Shift+R twice), 1920×1080, «Control audio via OBS» on, «Shutdown source when not visible» off, «Refresh browser when scene becomes active» off. This carries the robots' voices.
   - **Video Capture Device «Камера 1»**: «Камера MacBook Pro», cropped to a square, scaled to **300×300**, placed at **x=40, y=40** (top-left), circular mask: generate a 300×300 PNG with a white filled circle on transparent background (Python/Pillow or ImageMagick), add it as an «Image Mask/Blend» filter (Alpha Mask). Thin 3–4 px light border optional, no glow.
   - **«Камера 2»**: same size and mask at **x=1580, y=40** (top-right). Until a second camera exists: a color/image placeholder with the same mask, and the source hidden by default.
   - **Mic «Микрофон ведущих»**: the built-in mic (or the one the owner names). Noise suppression filter, a limiter at −3 dB.
3. **Scene «Технический перерыв»**: a still of the control room (`contest/stage/out/frame-t24.47.png` scaled to 1920×1080) with the caption «Технический перерыв» (Russian, clean sans-serif, no neon), the two camera circles in the same places, mic **muted** in this scene.
4. **Hotkeys**: mute/unmute «Микрофон ведущих» — `⌃⌥M`; switch to «Эфир» — `⌃⌥1`, to «Технический перерыв» — `⌃⌥2`. Hosts mute the mic at the launch of the engine and unmute at the envelopes (spec §7.7).
5. **Audio**: Сцена around −14 LUFS-ish peaks under −6 dB, mic peaks under −6 dB; monitor off on the mic (no echo). Show both meters in the mixer.
6. **Output / stream**: Service YouTube (RTMPS), encoder Apple VT H.264 hardware, **CBR 6000 kbps**, keyframe interval 2 s, audio AAC 160 kbps 48 kHz. Leave the stream key field for the owner. **Recording**: MKV (remux to MP4 after), same encoder, to `~/Movies/openegiz-final/`.
7. **Check** (objective): start a local recording for 60 s while the Stage plays; then confirm with `ffprobe` the file is 1920×1080, 30 fps, has one audio stream; take a screenshot of the OBS preview and verify both circles sit in the top corners and nothing of the Stage's text is under them. Report OBS CPU and dropped/lagged frames from «Stats» during the 60 s.

Report in English: what you set up, the hotkeys, the ffprobe output, the Stats numbers, a screenshot path, and anything you could not do.
