// macOS TTS tool for the Stage: AVSpeechSynthesizer.write() -> WAV file + per-word start times.
//
//   macos_tts --text-file in.txt --out out.wav [--voice Milena] [--rate 0.5] [--pitch 1.0] [--list-voices]
//
// stdout: one JSON object
//   {"voice":..., "sample_rate":..., "duration_s":..., "synth_s":..., "first_audio_s":...,
//    "words":[{"loc":<UTF-16 offset>,"len":<UTF-16 length>,"start_s":...}]}
// Offsets are UTF-16 (NSRange); the Python side converts them to code points.
import AVFoundation
import Foundation

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(1)
}

final class Delegate: NSObject, AVSpeechSynthesizerDelegate {
    var words: [(Int, Int, Double)] = []
    var frames: Int64 = 0
    var sampleRate: Double = 22050
    func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString r: NSRange, utterance u: AVSpeechUtterance) {
        words.append((r.location, r.length, Double(frames) / sampleRate))
    }
}

var args = Array(CommandLine.arguments.dropFirst())
func opt(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

if args.contains("--list-voices") {
    for v in AVSpeechSynthesisVoice.speechVoices() where v.language.hasPrefix("ru") {
        print("\(v.name)\t\(v.language)\t\(v.quality.rawValue)")
    }
    exit(0)
}

guard let textFile = opt("--text-file"), let outPath = opt("--out") else {
    fail("usage: macos_tts --text-file in.txt --out out.wav [--voice Milena] [--rate 0.5] [--pitch 1.0]")
}
guard let text = try? String(contentsOfFile: textFile, encoding: .utf8) else { fail("cannot read \(textFile)") }
let voiceName = opt("--voice") ?? "Milena"
let rate = Float(opt("--rate") ?? "") ?? AVSpeechUtteranceDefaultSpeechRate
let pitch = Float(opt("--pitch") ?? "") ?? 1.0

let voices = AVSpeechSynthesisVoice.speechVoices()
guard let voice = voices.first(where: { $0.name == voiceName || $0.identifier == voiceName }) else {
    fail("voice not installed: \(voiceName)")
}

let started = Date()
let synth = AVSpeechSynthesizer()
let delegate = Delegate()
synth.delegate = delegate
let utt = AVSpeechUtterance(string: text)
utt.voice = voice
utt.rate = min(max(rate, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
utt.pitchMultiplier = min(max(pitch, 0.5), 2.0)

var file: AVAudioFile?
var finished = false
var firstAudio: Double? = nil
var failure: String? = nil

synth.write(utt) { buffer in
    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
    if pcm.frameLength == 0 { finished = true; return }
    if firstAudio == nil { firstAudio = Date().timeIntervalSince(started) }
    delegate.sampleRate = pcm.format.sampleRate
    do {
        if file == nil {
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: pcm.format.sampleRate,
                AVNumberOfChannelsKey: pcm.format.channelCount,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
            ]
            file = try AVAudioFile(forWriting: URL(fileURLWithPath: outPath), settings: settings,
                                   commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved)
        }
        try file!.write(from: pcm)
        delegate.frames += Int64(pcm.frameLength)
    } catch {
        failure = "\(error)"
        finished = true
    }
}

let deadline = Date(timeIntervalSinceNow: 120)
while !finished && Date() < deadline {
    RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
}
file = nil  // close the file
if let f = failure { fail("write failed: \(f)") }
if !finished { fail("timeout") }
if delegate.frames == 0 { fail("no audio produced") }

let synthS = Date().timeIntervalSince(started)
let dur = Double(delegate.frames) / delegate.sampleRate
var out = "{\"voice\":\"\(voice.name)\",\"sample_rate\":\(Int(delegate.sampleRate)),"
out += String(format: "\"duration_s\":%.4f,\"synth_s\":%.4f,\"first_audio_s\":%.4f,\"words\":[", dur, synthS, firstAudio ?? 0)
out += delegate.words.map { String(format: "{\"loc\":%d,\"len\":%d,\"start_s\":%.4f}", $0.0, $0.1, $0.2) }.joined(separator: ",")
out += "]}"
print(out)
