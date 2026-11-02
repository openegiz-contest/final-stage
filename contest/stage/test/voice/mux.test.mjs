import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE || FFMPEG.replace(/ffmpeg$/, "ffprobe");
const MUX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "mux.mjs");

test("tools/mux.mjs: a 10 s clip with two voiced lines gets an audio stream, video copied", { skip: !existsSync(FFMPEG) && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "mux-test-"));
  try {
    const ff = (...a) => execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...a]);
    ff("-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=10", "-pix_fmt", "yuv420p", join(dir, "clip.mp4"));
    ff("-f", "lavfi", "-i", "sine=frequency=440:duration=3", join(dir, "a.wav"));
    ff("-f", "lavfi", "-i", "sine=frequency=330:duration=2.5", join(dir, "b.wav"));
    writeFileSync(join(dir, "track.json"), JSON.stringify([{ audioUrl: join(dir, "a.wav"), at: 1.5 }, { audioUrl: join(dir, "b.wav"), at: 6 }]));
    const out = join(dir, "clip-audio.mp4");
    const r = spawnSync("node", [MUX, join(dir, "clip.mp4"), join(dir, "track.json"), "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const probe = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,duration", "-of", "json", out], { encoding: "utf8" }));
    assert.deepEqual(probe.streams.map((s) => s.codec_type).sort(), ["audio", "video"]);
    assert.equal(probe.streams.find((s) => s.codec_type === "video").codec_name, "h264");
    assert.ok(Math.abs(Number(probe.streams.find((s) => s.codec_type === "audio").duration) - 10) < 0.2);
    // the audio is where the lines are: loud at 2.5 s, silent at 5 s
    const vol = (ss, file = out) => /mean_volume: (-?[\d.]+|-inf)/.exec(spawnSync(FFMPEG, ["-ss", String(ss), "-t", "0.5", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr)[1];
    assert.ok(Number(vol(2.5)) > -30, `2.5 s: ${vol(2.5)} dB`);
    assert.ok(vol(5) === "-inf" || Number(vol(5)) < -60, `5 s: ${vol(5)} dB`);
    assert.ok(Number(vol(7)) > -30, `7 s: ${vol(7)} dB`);
    // --from 5: the second line starts 1 s into the clip, the first is gone
    const out2 = join(dir, "from.mp4");
    const r2 = spawnSync("node", [MUX, join(dir, "clip.mp4"), join(dir, "track.json"), "--out", out2, "--from", "5"], { encoding: "utf8" });
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(vol(0.2, out2) === "-inf" || Number(vol(0.2, out2)) < -60, "the first line is cut away");
    assert.ok(Number(vol(1.5, out2)) > -30, "the second line starts 1 s into the clip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools/mux.mjs: no voiced line is an error, not a silent file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mux-test-"));
  try {
    writeFileSync(join(dir, "track.json"), "[]");
    const r = spawnSync("node", [MUX, join(dir, "nope.mp4"), join(dir, "track.json")], { encoding: "utf8" });
    assert.equal(r.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
