// Voices into a clip: lays the voiced lines on the clip's timeline and writes a copy of the clip with an audio track.
//   node contest/stage/tools/mux.mjs <clip.mp4> <track.json> [--out file.mp4] [--from 0] [--dir tmp]
// <track.json> is voice.exportTrack() of the page: [{ "audioUrl": "http://127.0.0.1:8790/audio/<sha>.wav", "at": 12.4 }, ...]
// (or { "track": [...] }). audioUrl is an http(s) URL (downloaded first, so the service must still be up or the files
// cached) or a file path; `at` is the show time the line starts. --from is the show time of the clip's first frame
// (clip.mjs --from): a line starts at at − from on the clip; the part of a line before the clip is cut.
// The video is copied as is; the audio is AAC 192k stereo 48 kHz, as long as the video. Output: contest/stage/out/<clip name>-audio.mp4.
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STAGE = dirname(dirname(fileURLToPath(import.meta.url)));
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE || FFMPEG.replace(/ffmpeg$/, "ffprobe");

const argv = process.argv.slice(2);
const opt = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []))[0];
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const [clip, trackFile] = positional;
if (!clip || !trackFile) {
  console.error("usage: mux.mjs <clip.mp4> <track.json> [--out file.mp4] [--from s]");
  process.exit(2);
}
const from = Number(opt("from") || 0);
const out = resolve(opt("out") || join(STAGE, "out", `${basename(clip, extname(clip))}-audio.mp4`));

const parsed = JSON.parse(await readFile(trackFile, "utf8"));
const lines = (Array.isArray(parsed) ? parsed : parsed.track).map((l) => ({ src: l.audioUrl ?? l.file, at: Number(l.at) - from }));
if (!lines.length || lines.some((l) => !l.src || !Number.isFinite(l.at))) {
  console.error(`mux: ${trackFile} has no voiced line, or a line without audioUrl/at`);
  process.exit(2);
}

const videoS = Number(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip], { encoding: "utf8" }));
const work = await mkdtemp(opt("dir") ? join(resolve(opt("dir")), "mux-") : join(tmpdir(), "stage-mux-"));
try {
  const files = [];
  for (const [i, l] of lines.entries()) {
    if (!/^https?:/.test(l.src)) {
      files.push(resolve(l.src.replace(/^file:\/\//, "")));
      continue;
    }
    const r = await fetch(l.src);
    if (!r.ok) throw new Error(`${l.src}: HTTP ${r.status}`);
    const f = join(work, `line${i}${extname(new URL(l.src).pathname) || ".wav"}`);
    await writeFile(f, Buffer.from(await r.arrayBuffer()));
    files.push(f);
  }

  // input 0 the clip, input 1 silence as long as the video (amix follows it), then one input per line
  const chains = lines.map((l, i) => {
    const ms = Math.max(0, Math.round(l.at * 1000));
    const cut = l.at < 0 ? `atrim=start=${-l.at},asetpts=PTS-STARTPTS,` : "";
    return `[${i + 2}:a]${cut}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[a${i}]`;
  });
  const mix = `[1:a]${lines.map((_, i) => `[a${i}]`).join("")}amix=inputs=${lines.length + 1}:duration=first:normalize=0:dropout_transition=0[aout]`;
  await mkdir(dirname(out), { recursive: true });
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", clip, "-f", "lavfi", "-t", String(videoS), "-i", "anullsrc=r=48000:cl=stereo",
    ...files.flatMap((f) => ["-i", f]), "-filter_complex", [...chains, mix].join(";"),
    "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", String(videoS), "-movflags", "+faststart", out], { stdio: "inherit" });
  console.log(`wrote ${out} (${lines.length} lines, ${videoS.toFixed(1)} s)`);
} finally {
  await rm(work, { recursive: true, force: true });
}
