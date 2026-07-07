//
//  AppleTTSClient.swift
//  leanring-buddy
//
//  System speech fallback that matches the companion TTS interface.
//

import AVFoundation

@MainActor
protocol CompanionTTSClient: AnyObject {
    func speakText(_ text: String) async throws
    var isPlaying: Bool { get }
    func stopPlayback()
}

@MainActor
final class AppleTTSClient: NSObject, CompanionTTSClient {
    private let synthesizer = AVSpeechSynthesizer()
    private var speechStartDelegate: AppleSpeechStartDelegate?

    override init() {
        super.init()
    }

    func speakText(_ text: String) async throws {
        stopPlayback()

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.preferredEnglishVoice()
        utterance.rate = 0.53

        try await withCheckedThrowingContinuation { continuation in
            let delegate = AppleSpeechStartDelegate { result in
                continuation.resume(with: result)
            }
            speechStartDelegate = delegate
            synthesizer.delegate = delegate

            synthesizer.speak(utterance)
        }
    }

    var isPlaying: Bool {
        synthesizer.isSpeaking
    }

    func stopPlayback() {
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        // If a speakText call is still awaiting its didStart callback, resume
        // it now — otherwise clearing the delegate below would strand that
        // continuation forever and leak the awaiting task.
        speechStartDelegate?.forceCancel()
        speechStartDelegate = nil
        synthesizer.delegate = nil
    }

    private static func preferredEnglishVoice() -> AVSpeechSynthesisVoice? {
        let englishVoices = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language == "en-US" }

        return englishVoices.sorted { firstVoice, secondVoice in
            qualityRank(for: firstVoice.quality) > qualityRank(for: secondVoice.quality)
        }.first ?? AVSpeechSynthesisVoice(language: "en-US")
    }

    private static func qualityRank(for quality: AVSpeechSynthesisVoiceQuality) -> Int {
        switch quality {
        case .premium:
            return 3
        case .enhanced:
            return 2
        default:
            return 1
        }
    }
}

private final class AppleSpeechStartDelegate: NSObject, AVSpeechSynthesizerDelegate {
    private var didResumeContinuation = false
    private let completion: (Result<Void, Error>) -> Void

    init(completion: @escaping (Result<Void, Error>) -> Void) {
        self.completion = completion
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        resumeOnce(with: .success(()))
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        resumeOnce(with: .failure(CancellationError()))
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        // Degenerate utterances (for example an empty string) can finish
        // without ever reporting didStart — resume as success so the caller
        // is never stranded.
        resumeOnce(with: .success(()))
    }

    func forceCancel() {
        resumeOnce(with: .failure(CancellationError()))
    }

    private func resumeOnce(with result: Result<Void, Error>) {
        guard !didResumeContinuation else { return }
        didResumeContinuation = true
        completion(result)
    }
}

extension ElevenLabsTTSClient: CompanionTTSClient {}
