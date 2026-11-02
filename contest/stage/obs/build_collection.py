#!/usr/bin/env python3
"""Build the OBS setup for the OpenEgiz Final broadcast (stdlib only, macOS).

Writes, with OBS closed:
  - scene collection  ~/Library/Application Support/obs-studio/basic/scenes/OpenEgiz Final.json
  - profile           ~/Library/Application Support/obs-studio/basic/profiles/OpenEgiz Final/
  - obs-websocket     ~/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json
                      (only the server keys; the password lives in ~/.config/openegiz/obs-ws.txt)
  - mask PNGs         next to this script (circle 300x300, rounded rectangle 1120x630)
  - ~/Movies/openegiz-final/ (recording folder)

Nothing else under obs-studio/ is touched. Re-running overwrites only these files;
the websocket password is kept if the password file already exists.

Usage: python3 build_collection.py [--force] [--mask-ref-dir DIR]
"""
import argparse
import json
import secrets
import string
import struct
import subprocess
import sys
import uuid
import zlib
from pathlib import Path
from urllib.parse import quote

NAME = "OpenEgiz Final"
HOME = Path.home()
OBS_DIR = HOME / "Library/Application Support/obs-studio"
SCENE_FILE = OBS_DIR / "basic/scenes" / f"{NAME}.json"
PROFILE_DIR = OBS_DIR / "basic/profiles" / NAME
WS_CONFIG = OBS_DIR / "plugin_config/obs-websocket/config.json"
WS_PASSWORD_FILE = HOME / ".config/openegiz/obs-ws.txt"
REC_DIR = HOME / "Movies/openegiz-final"

HERE = Path(__file__).resolve().parent
# The collection references the masks by the absolute path of the main checkout.
DEFAULT_MASK_REF_DIR = str(HERE)
MASK_CIRCLE = "mask-circle-300.png"
MASK_RRECT = "mask-rrect-1120x630.png"

STAGE = "http://127.0.0.1:8780/"
W, H = 1920, 1080
OBS_VER = 536936450  # 32.1.2, as stored by the installed OBS
MAIN_CANVAS = "6c69626f-6273-4c00-9d88-c5136d61696e"
CAMERA_DEVICE = "6C707041-05AC-0010-0008-000000000001"  # «Камера MacBook Pro»
CAMERA_NAME = "Камера MacBook Pro"
MIC_DEVICE = "BuiltInMicrophoneDevice"
STAND_BROWSER_BUNDLE = "com.google.Chrome"  # stands-live.sh opens each Stand in its own Google Chrome window
STAND_DISPLAY = "58A14087-3E23-470B-9400-8FB3E5941FA4"  # main display (Dell AW2724DM, 2560x1440): stands_panel.py opens Stands there

MONITOR_AND_OUTPUT = 2


# ----------------------------------------------------------------- masks (PNG)

def _png_rgba(width, height, alpha_rows):
    raw = bytearray()
    for row in alpha_rows:
        raw.append(0)  # filter: none
        for a in row:
            raw += bytes((255, 255, 255, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def _coverage(inside, x, y, n=4):
    hit = 0
    for j in range(n):
        for i in range(n):
            if inside(x + (i + 0.5) / n, y + (j + 0.5) / n):
                hit += 1
    return round(255 * hit / (n * n))


def write_masks(directory):
    directory.mkdir(parents=True, exist_ok=True)
    r = 150.0
    circle = lambda px, py: (px - r) ** 2 + (py - r) ** 2 <= r * r
    rows = [[_coverage(circle, x, y) for x in range(300)] for y in range(300)]
    (directory / MASK_CIRCLE).write_bytes(_png_rgba(300, 300, rows))

    w, h, rad = 1120, 630, 24.0

    def rrect(px, py):
        cx = min(max(px, rad), w - rad)
        cy = min(max(py, rad), h - rad)
        return (px - cx) ** 2 + (py - cy) ** 2 <= rad * rad

    rows = []
    for y in range(h):
        row = []
        for x in range(w):
            if rad <= x < w - rad or rad <= y < h - rad:
                row.append(255)  # fast path away from the corners
            else:
                row.append(_coverage(rrect, x, y))
        rows.append(row)
    (directory / MASK_RRECT).write_bytes(_png_rgba(w, h, rows))


# --------------------------------------------------------- collection builders

def uid(key):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"openegiz-final/{key}"))


def source(name, sid, versioned=None, settings=None, **extra):
    s = {
        "prev_ver": OBS_VER,
        "name": name,
        "uuid": uid(name),
        "id": sid,
        "versioned_id": versioned or sid,
        "settings": settings or {},
        "mixers": 0,
        "sync": 0,
        "flags": 0,
        "volume": 1.0,
        "balance": 0.5,
        "enabled": True,
        "muted": False,
        "push-to-mute": False,
        "push-to-mute-delay": 0,
        "push-to-talk": False,
        "push-to-talk-delay": 0,
        "hotkeys": {
            "libobs.mute": [],
            "libobs.unmute": [],
            "libobs.push-to-mute": [],
            "libobs.push-to-talk": [],
        },
        "deinterlace_mode": 0,
        "deinterlace_field_order": 0,
        "monitoring_type": 0,
        "private_settings": {},
    }
    s.update(extra)
    return s


def filt(name, fid, versioned, settings):
    f = source(f"{name}", fid, versioned, settings)
    f["uuid"] = uid(f"filter/{name}/{fid}")
    f["hotkeys"] = {}
    return f


def browser(name, url, audio=False):
    settings = {"url": url, "width": W, "height": H}
    extra = {}
    if audio:
        # Stage carries the robots' voices: OBS controls the audio, host hears it, never shut down
        settings.update({"reroute_audio": True, "shutdown": False, "restart_when_active": False})
        extra = {"mixers": 255, "monitoring_type": MONITOR_AND_OUTPUT}
    else:
        # one WebGL page may run at a time: shut down when hidden, reload when shown
        settings.update({"shutdown": True, "restart_when_active": True})
    return source(name, "browser_source", settings=settings, **extra)


def item(item_id, src, x=0.0, y=0.0, *, bounds=None, bounds_type=0, bounds_crop=False,
         crop=(0, 0, 0, 0), scale=1.0, locked=False, ref=(W, H)):
    bx, by = bounds if bounds else (0.0, 0.0)
    rw, rh = ref  # size of the scene the item sits in: OBS rescales the item if it differs on load
    return {
        "name": src["name"],
        "source_uuid": src["uuid"],
        "visible": True,
        "locked": locked,
        "rot": 0.0,
        "scale_ref": {"x": float(rw), "y": float(rh)},
        "align": 5,
        "bounds_type": bounds_type,
        "bounds_align": 0,
        "bounds_crop": bounds_crop,
        "crop_left": crop[0],
        "crop_top": crop[1],
        "crop_right": crop[2],
        "crop_bottom": crop[3],
        "id": item_id,
        "group_item_backup": False,
        "pos": {"x": float(x), "y": float(y)},
        "pos_rel": {"x": (x - rw / 2) / (rh / 2), "y": (y - rh / 2) / (rh / 2)},
        "scale": {"x": scale, "y": scale},
        "scale_rel": {"x": scale, "y": scale},
        "bounds": {"x": float(bx), "y": float(by)},
        "bounds_rel": {"x": bx / (rh / 2), "y": by / (rh / 2)},
        "scale_filter": "disable",
        "blend_method": "default",
        "blend_type": "normal",
        "show_transition": {"duration": 0},
        "hide_transition": {"duration": 0},
        "private_settings": {},
    }


def scene(name, items, hotkey=None, filters=None, size=None):
    hk = {"OBSBasic.SelectScene": [hotkey] if hotkey else []}
    for it in items:
        hk[f"libobs.show_scene_item.{it['id']}"] = []
        hk[f"libobs.hide_scene_item.{it['id']}"] = []
    s = source(name, "scene", settings={
        "id_counter": max(i["id"] for i in items),
        "custom_size": bool(size),
        "items": items,
    })
    if size:
        s["settings"].update({"cx": size[0], "cy": size[1]})
    s["hotkeys"] = hk
    s["canvas_uuid"] = MAIN_CANVAS
    if filters:
        s["filters"] = filters
    return s


def key(obs_key):
    return {"key": obs_key, "control": True, "alt": True}


def build_collection(mask_ref_dir):
    # --- shared devices: one camera, one mic
    camera = source("Камера", "macos-avcapture", settings={
        "device": CAMERA_DEVICE,
        "device_name": CAMERA_NAME,
        "use_preset": True,
        "preset": "AVCaptureSessionPreset1280x720",
    })
    mic = source("Микрофон", "coreaudio_input_capture", settings={"device_id": MIC_DEVICE},
                 mixers=255)
    mic["hotkeys"]["libobs.mute"] = [key("OBS_KEY_M")]
    mic["hotkeys"]["libobs.unmute"] = [key("OBS_KEY_M")]  # pair bound to one key = toggle
    mic["filters"] = [
        filt("Шумоподавление", "noise_suppress_filter", "noise_suppress_filter_v2",
             {"method": "rnnoise"}),
        filt("Лимитер", "limiter_filter", "limiter_filter", {"threshold": -3.0, "release_time": 60}),
    ]

    # --- camera shapes. A source has one filter chain, so the camera is nested through two helper
    # scenes. Each has the custom size of its shape (the mask is stretched over the whole source,
    # so the source must be the mask's size), fits the camera into it (scale to outer bounds,
    # cropped) and masks it; the visible scenes place the nested scene as it is.
    circle_scene = scene("_Камера: круг", [
        item(1, camera, 0, 0, bounds=(300, 300), bounds_type=3, bounds_crop=True, ref=(300, 300)),
    ], size=(300, 300), filters=[filt("Маска круг", "mask_filter", "mask_filter_v2", {
        "type": "mask_alpha_filter.effect",
        "image_path": f"{mask_ref_dir}/{MASK_CIRCLE}",
        "stretch": True,
    })])
    rect_scene = scene("_Камера: рамка", [
        item(1, camera, 0, 0, bounds=(1120, 630), bounds_type=3, bounds_crop=True,
             ref=(1120, 630)),
    ], size=(1120, 630), filters=[filt("Маска рамка", "mask_filter", "mask_filter_v2", {
        "type": "mask_alpha_filter.effect",
        "image_path": f"{mask_ref_dir}/{MASK_RRECT}",
        "stretch": True,
    })])

    def circle_item(item_id):  # 300x300 at (40, 40)
        return item(item_id, circle_scene, 40, 40)

    # --- backgrounds
    soon = browser("Фон: скоро", STAGE + "idle.html?mode=soon&at=2026-10-31T15:00:00%2B05:00")
    host_q = "mode=host&name={}&role={}".format(
        quote("Алихан Амирханов"), quote("Соведущий"))
    host_bg = browser("Фон: ведущий", STAGE + "idle.html?" + host_q)
    stage = browser("Сцена", STAGE + "show.html?cams=1&air=1&hold=0", audio=True)
    brk = browser("Фон: перерыв", STAGE + "idle.html?mode=break")
    end = browser("Фон: финиш", STAGE + "idle.html?mode=end")
    stand = source("Экран: Стенд (Chrome)", "screen_capture", settings={
        # 0 display, 1 window, 2 application. Display: every Stand is its own Chrome process (own
        # proxy), and application capture shows only one Chrome process, not the front Stand
        "type": 0,
        "application": STAND_BROWSER_BUNDLE,
        "display_uuid": STAND_DISPLAY,
        "show_cursor": True,
    })

    def full(src, item_id=1):
        return item(item_id, src, 0, 0)

    scenes = [
        scene("1 Скоро начнём", [full(soon)], key("OBS_KEY_1")),
        scene("2 Ведущий", [
            full(host_bg),
            item(2, rect_scene, 100, 170),
            item(3, mic),
        ], key("OBS_KEY_2")),
        scene("3 Эфир", [full(stage), circle_item(2), item(3, mic)], key("OBS_KEY_3")),
        scene("4 Стенд", [
            # scale inner: OBS stores the computed scale and does not recompute it on load, so it
            # is given for the main display (2560x1440); Ctrl+F in OBS refits another display
            item(1, stand, 0, 0, bounds=(W, H), bounds_type=2, scale=H / 1440),
            circle_item(2),
            item(3, mic),
        ], key("OBS_KEY_4")),
        scene("5 Технический перерыв", [full(brk)], key("OBS_KEY_5")),
        scene("6 Финиш", [full(end), circle_item(2), item(3, mic)], key("OBS_KEY_6")),
    ]
    first = scenes[0]["name"]
    return {
        "name": NAME,
        # no AuxAudioDevice1 / DesktopAudioDevice1: only «Микрофон» and the Stage browser are heard
        "sources": [camera, mic, soon, host_bg, stage, brk, end, stand,
                    circle_scene, rect_scene] + scenes,
        "groups": [],
        "scene_order": [{"name": s["name"]} for s in scenes]
                       + [{"name": circle_scene["name"]}, {"name": rect_scene["name"]}],
        "current_scene": first,
        "current_program_scene": first,
        "canvases": [],
        "current_transition": "Затухание",  # built-in Fade, Russian UI name
        "transition_duration": 400,
        "transitions": [],
        "quick_transitions": [
            {"name": "Обрезка", "duration": 300, "hotkeys": [], "id": 1, "fade_to_black": False},
            {"name": "Затухание", "duration": 400, "hotkeys": [], "id": 2, "fade_to_black": False},
        ],
        "saved_projectors": [],
        "preview_locked": False,
        "scaling_enabled": False,
        "scaling_level": -8,
        "scaling_off_x": 0.0,
        "scaling_off_y": 0.0,
        "virtual-camera": {"type2": 3},
        "modules": {"scripts-tool": []},
        "resolution": {"x": W, "y": H},
        "version": 2,
    }


# --------------------------------------------------------------------- profile

BASIC_INI = f"""[General]
Name={NAME}

[Output]
Mode=Advanced
FilenameFormatting=%CCYY-%MM-%DD %hh-%mm-%ss
DelayEnable=false
Reconnect=true
RetryDelay=2
MaxRetries=25
BindIP=default
IPFamily=IPv4+IPv6
NewSocketLoopEnable=false
LowLatencyEnable=false

[Stream1]
IgnoreRecommended=true
EnableMultitrackVideo=false

[SimpleOutput]
FilePath={REC_DIR}
RecFormat2=mkv
VBitrate=6000
ABitrate=160
UseAdvanced=false
StreamEncoder=apple_h264
RecEncoder=apple_h264
StreamAudioEncoder=aac
RecAudioEncoder=aac
RecTracks=1

[AdvOut]
ApplyServiceSettings=false
UseRescale=false
TrackIndex=1
VodTrackIndex=2
Encoder=com.apple.videotoolbox.videoencoder.ave.avc
RecType=Standard
RecFilePath={REC_DIR}
RecFormat2=mkv
RecUseRescale=false
RecTracks=1
RecEncoder=none
RecSplitFileTime=15
RecSplitFileSize=2048
RecSplitFileType=Time
RecRB=false
FLVTrack=1
StreamMultiTrackAudioMixes=1
AudioEncoder=CoreAudio_AAC
RecAudioEncoder=CoreAudio_AAC
Track1Bitrate=160
Track2Bitrate=160
Track3Bitrate=160
Track4Bitrate=160
Track5Bitrate=160
Track6Bitrate=160

[Video]
BaseCX={W}
BaseCY={H}
OutputCX={W}
OutputCY={H}
FPSType=0
FPSCommon=30
FPSInt=30
FPSNum=30
FPSDen=1
ScaleType=bicubic
ColorFormat=NV12
ColorSpace=709
ColorRange=Partial
SdrWhiteLevel=300
HdrNominalPeakLevel=1000
AutoRemux=true

[Audio]
MonitoringDeviceId=default
MonitoringDeviceName=Default
SampleRate=48000
ChannelSetup=Stereo
MeterDecayRate=23.53
PeakMeterType=0
DesktopDevice1=disabled
DesktopDevice2=disabled
AuxDevice1=disabled
AuxDevice2=disabled
AuxDevice3=disabled
AuxDevice4=disabled
"""

# YouTube - RTMPS, no key: the owner pastes it into Settings > Stream
SERVICE = {
    "type": "rtmp_common",
    "settings": {
        "service": "YouTube - RTMPS",
        "protocol": "RTMPS",
        "server": "rtmps://a.rtmps.youtube.com:443/live2",
        "bwtest": False,
        "key": "",
    },
}

# Apple VideoToolbox H.264 (hardware), CBR 6000 kbps, keyframe every 2 s
ENCODER = {
    "bitrate": 6000,
    "rate_control": "CBR",
    "keyint_sec": 2,
    "profile": "high",
}


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")


def write_profile():
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    (PROFILE_DIR / "basic.ini").write_text(BASIC_INI, encoding="utf-8")
    write_json(PROFILE_DIR / "service.json", SERVICE)
    write_json(PROFILE_DIR / "streamEncoder.json", ENCODER)
    write_json(PROFILE_DIR / "recordEncoder.json", ENCODER)


def write_websocket():
    if WS_PASSWORD_FILE.exists() and WS_PASSWORD_FILE.read_text().strip():
        password = WS_PASSWORD_FILE.read_text().strip()
    else:
        alphabet = string.ascii_letters + string.digits
        password = "".join(secrets.choice(alphabet) for _ in range(24))
        WS_PASSWORD_FILE.parent.mkdir(parents=True, exist_ok=True)
        WS_PASSWORD_FILE.write_text(password + "\n")
    WS_PASSWORD_FILE.chmod(0o600)

    config = {}
    if WS_CONFIG.exists():
        config = json.loads(WS_CONFIG.read_text(encoding="utf-8"))
    config.update({
        "alerts_enabled": False,
        "auth_required": True,
        "first_load": False,
        "server_enabled": True,
        "server_port": 4455,
        "server_password": password,
    })
    write_json(WS_CONFIG, config)
    WS_CONFIG.chmod(0o600)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--force", action="store_true", help="write even if OBS is running")
    ap.add_argument("--mask-ref-dir", default=DEFAULT_MASK_REF_DIR,
                    help="directory the collection points the masks at (default: main checkout)")
    args = ap.parse_args()

    running = subprocess.run(["pgrep", "-x", "OBS"], capture_output=True).returncode == 0
    if running and not args.force:
        sys.exit("OBS is running: quit it first (it would overwrite these files on exit).")

    write_masks(HERE)
    REC_DIR.mkdir(parents=True, exist_ok=True)
    write_json(SCENE_FILE, build_collection(args.mask_ref_dir.rstrip("/")))
    write_profile()
    write_websocket()
    print(f"collection: {SCENE_FILE}")
    print(f"profile:    {PROFILE_DIR}")
    print(f"masks:      {HERE / MASK_CIRCLE}, {HERE / MASK_RRECT} (referenced at {args.mask_ref_dir})")
    print(f"websocket:  port 4455, password in {WS_PASSWORD_FILE}")
    print(f"recordings: {REC_DIR}")


if __name__ == "__main__":
    main()
