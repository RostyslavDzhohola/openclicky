//
//  BuddyDictationManager.swift
//  leanring-buddy
//
//  Shared push-to-talk dictation manager for the help chat and brainstorm buddy.
//  Captures microphone audio with AVAudioEngine, routes it into the active
//  transcription provider, and hands the final draft back to the active input bar.
//

import AppKit
import AVFoundation
import Combine
import CoreAudio
import Foundation
import Speech

enum BuddyPushToTalkShortcut {
    enum ShortcutOption {
        case shiftFunction
        case controlOption
        case shiftControl
        case controlOptionSpace
        case shiftControlSpace

        var displayText: String {
            switch self {
            case .shiftFunction:
                return "shift + fn"
            case .controlOption:
                return "ctrl + option"
            case .shiftControl:
                return "shift + control"
            case .controlOptionSpace:
                return "ctrl + option + space"
            case .shiftControlSpace:
                return "shift + control + space"
            }
        }

        var keyCapsuleLabels: [String] {
            switch self {
            case .shiftFunction:
                return ["shift", "fn"]
            case .controlOption:
                return ["ctrl", "option"]
            case .shiftControl:
                return ["shift", "control"]
            case .controlOptionSpace:
                return ["ctrl", "option", "space"]
            case .shiftControlSpace:
                return ["shift", "control", "space"]
            }
        }

        fileprivate var modifierOnlyFlags: NSEvent.ModifierFlags? {
            switch self {
            case .shiftFunction:
                return [.shift, .function]
            case .controlOption:
                return [.control, .option]
            case .shiftControl:
                return [.shift, .control]
            case .controlOptionSpace, .shiftControlSpace:
                return nil
            }
        }

        fileprivate var spaceShortcutModifierFlags: NSEvent.ModifierFlags? {
            switch self {
            case .shiftFunction:
                return nil
            case .controlOption:
                return nil
            case .shiftControl:
                return nil
            case .controlOptionSpace:
                return [.control, .option]
            case .shiftControlSpace:
                return [.shift, .control]
            }
        }
    }

    enum ShortcutTransition {
        case none
        case pressed
        case released
    }

    private enum ShortcutEventType {
        case flagsChanged
        case keyDown
        case keyUp
    }

    static let currentShortcutOption: ShortcutOption = .controlOption
    static let pushToTalkKeyCode: UInt16 = 49 // Space
    static let pushToTalkDisplayText = currentShortcutOption.displayText
    static let pushToTalkTooltipText = "push to talk (\(pushToTalkDisplayText))"

    static func shortcutTransition(
        for event: NSEvent,
        wasShortcutPreviouslyPressed: Bool
    ) -> ShortcutTransition {
        guard let shortcutEventType = shortcutEventType(for: event.type) else { return .none }

        return shortcutTransition(
            for: shortcutEventType,
            keyCode: event.keyCode,
            modifierFlags: event.modifierFlags.intersection(.deviceIndependentFlagsMask),
            wasShortcutPreviouslyPressed: wasShortcutPreviouslyPressed
        )
    }

    static func shortcutTransition(
        for eventType: CGEventType,
        keyCode: UInt16,
        modifierFlagsRawValue: UInt64,
        wasShortcutPreviouslyPressed: Bool
    ) -> ShortcutTransition {
        guard let shortcutEventType = shortcutEventType(for: eventType) else { return .none }

        return shortcutTransition(
            for: shortcutEventType,
            keyCode: keyCode,
            modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(modifierFlagsRawValue))
                .intersection(.deviceIndependentFlagsMask),
            wasShortcutPreviouslyPressed: wasShortcutPreviouslyPressed
        )
    }

    private static func shortcutEventType(for eventType: NSEvent.EventType) -> ShortcutEventType? {
        switch eventType {
        case .flagsChanged:
            return .flagsChanged
        case .keyDown:
            return .keyDown
        case .keyUp:
            return .keyUp
        default:
            return nil
        }
    }

    private static func shortcutEventType(for eventType: CGEventType) -> ShortcutEventType? {
        switch eventType {
        case .flagsChanged:
            return .flagsChanged
        case .keyDown:
            return .keyDown
        case .keyUp:
            return .keyUp
        default:
            return nil
        }
    }

    private static func shortcutTransition(
        for shortcutEventType: ShortcutEventType,
        keyCode: UInt16,
        modifierFlags: NSEvent.ModifierFlags,
        wasShortcutPreviouslyPressed: Bool
    ) -> ShortcutTransition {
        if let modifierOnlyFlags = currentShortcutOption.modifierOnlyFlags {
            guard shortcutEventType == .flagsChanged else { return .none }

            let isShortcutCurrentlyPressed = modifierFlags.contains(modifierOnlyFlags)

            if isShortcutCurrentlyPressed && !wasShortcutPreviouslyPressed {
                return .pressed
            }

            if !isShortcutCurrentlyPressed && wasShortcutPreviouslyPressed {
                return .released
            }

            return .none
        }

        guard let pushToTalkModifierFlags = currentShortcutOption.spaceShortcutModifierFlags else {
            return .none
        }

        let matchesModifierFlags = modifierFlags.isSuperset(of: pushToTalkModifierFlags)

        if shortcutEventType == .keyDown
            && keyCode == pushToTalkKeyCode
            && matchesModifierFlags
            && !wasShortcutPreviouslyPressed {
            return .pressed
        }

        if shortcutEventType == .keyUp
            && keyCode == pushToTalkKeyCode
            && wasShortcutPreviouslyPressed {
            return .released
        }

        return .none
    }
}

enum BuddyDictationPermissionProblem {
    case microphoneAccessDenied
    case speechRecognitionDenied
}

/// A microphone the user can pin for push-to-talk capture. The `id` is the
/// CoreAudio device UID (identical to `AVCaptureDevice.uniqueID`), which is what
/// we persist and later translate back into a live `AudioDeviceID` when a
/// recording session starts.
struct CaptureMicrophone: Identifiable, Equatable {
    let id: String       // AVCaptureDevice.uniqueID == CoreAudio device UID
    let displayName: String
}

private enum BuddyDictationStartSource {
    case microphoneButton
    case keyboardShortcut
}

private struct BuddyDictationDraftCallbacks {
    let updateDraftText: (String) -> Void
    let submitDraftText: (String) -> Void
}

/// Allows the provider-creation task to cross its async boundary without
/// claiming that every transcription-session implementation is independently
/// thread-safe. The session is consumed on the main actor and then owned by
/// EarlyAudioBufferRelay, which serializes all audio access with its lock.
private final class StreamingTranscriptionSessionTaskResult: @unchecked Sendable {
    let transcriptionSession: any BuddyStreamingTranscriptionSession

    init(transcriptionSession: any BuddyStreamingTranscriptionSession) {
        self.transcriptionSession = transcriptionSession
    }
}

/// Bridges the audio-engine tap to a transcription session that may still be
/// starting. The tap and provider setup run on different executors, so every
/// transition is serialized by the lock: attach flushes the queued buffers
/// while holding that lock, which prevents a newly arriving live buffer from
/// overtaking the startup audio.
private final class EarlyAudioBufferRelay: @unchecked Sendable {
    private struct QueuedAudioBuffer {
        let audioBuffer: AVAudioPCMBuffer
        let durationSeconds: TimeInterval
    }

    private static let maximumQueuedAudioDurationSeconds: TimeInterval = 15

    private let stateLock = NSLock()
    private var queuedAudioBuffers: [QueuedAudioBuffer] = []
    private var queuedAudioDurationSeconds: TimeInterval = 0
    private var attachedTranscriptionSession: (any BuddyStreamingTranscriptionSession)?
    private var hasDetectedFirstNonEmptyAudioBuffer = false
    private var hasPrintedQueueCapacityWarning = false
    private var isDiscarded = false

    func appendOrForward(_ audioBuffer: AVAudioPCMBuffer) {
        guard audioBuffer.frameLength > 0 else { return }

        stateLock.lock()
        defer { stateLock.unlock() }

        guard !isDiscarded else { return }

        if let attachedTranscriptionSession {
            attachedTranscriptionSession.appendAudioBuffer(audioBuffer)
            return
        }

        // AVAudioEngine owns and may reuse the tap's buffer after the callback
        // returns. Queue an independent copy so provider startup can safely
        // outlive that callback without retaining mutable HAL-owned memory.
        guard let copiedAudioBuffer = Self.copyAudioBuffer(audioBuffer) else { return }

        let audioBufferDurationSeconds = TimeInterval(audioBuffer.frameLength) / audioBuffer.format.sampleRate
        queuedAudioBuffers.append(
            QueuedAudioBuffer(
                audioBuffer: copiedAudioBuffer,
                durationSeconds: audioBufferDurationSeconds
            )
        )
        queuedAudioDurationSeconds += audioBufferDurationSeconds

        while queuedAudioDurationSeconds > Self.maximumQueuedAudioDurationSeconds,
              !queuedAudioBuffers.isEmpty {
            let discardedOldestAudioBuffer = queuedAudioBuffers.removeFirst()
            queuedAudioDurationSeconds -= discardedOldestAudioBuffer.durationSeconds

            if !hasPrintedQueueCapacityWarning {
                hasPrintedQueueCapacityWarning = true
                print("⚠️ BuddyDictationManager: transcription provider startup exceeded the 15-second early-audio buffer; dropping oldest audio")
            }
        }
    }

    func markFirstNonEmptyAudioBufferDetectedIfNeeded() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }

        guard !isDiscarded, !hasDetectedFirstNonEmptyAudioBuffer else { return false }
        hasDetectedFirstNonEmptyAudioBuffer = true
        return true
    }

    func attach(_ transcriptionSession: any BuddyStreamingTranscriptionSession) {
        stateLock.lock()
        defer { stateLock.unlock() }

        guard !isDiscarded else { return }

        attachedTranscriptionSession = transcriptionSession

        // Flush under the same lock used by appendOrForward so live tap audio
        // cannot reach the provider before the queued startup audio.
        for queuedAudioBuffer in queuedAudioBuffers {
            transcriptionSession.appendAudioBuffer(queuedAudioBuffer.audioBuffer)
        }

        queuedAudioBuffers.removeAll(keepingCapacity: false)
        queuedAudioDurationSeconds = 0
    }

    func discard() {
        stateLock.lock()
        defer { stateLock.unlock() }

        isDiscarded = true
        queuedAudioBuffers.removeAll(keepingCapacity: false)
        queuedAudioDurationSeconds = 0
        attachedTranscriptionSession = nil
    }

    private static func copyAudioBuffer(_ audioBuffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copiedAudioBuffer = AVAudioPCMBuffer(
            pcmFormat: audioBuffer.format,
            frameCapacity: audioBuffer.frameLength
        ) else {
            return nil
        }

        copiedAudioBuffer.frameLength = audioBuffer.frameLength

        let sourceAudioBuffers = UnsafeMutableAudioBufferListPointer(audioBuffer.mutableAudioBufferList)
        let destinationAudioBuffers = UnsafeMutableAudioBufferListPointer(copiedAudioBuffer.mutableAudioBufferList)

        for audioBufferIndex in 0..<min(sourceAudioBuffers.count, destinationAudioBuffers.count) {
            let sourceAudioBuffer = sourceAudioBuffers[audioBufferIndex]
            var destinationAudioBuffer = destinationAudioBuffers[audioBufferIndex]
            let bytesToCopy = min(
                Int(sourceAudioBuffer.mDataByteSize),
                Int(destinationAudioBuffer.mDataByteSize)
            )

            guard bytesToCopy > 0,
                  let sourceAudioData = sourceAudioBuffer.mData,
                  let destinationAudioData = destinationAudioBuffer.mData else {
                continue
            }

            destinationAudioData.copyMemory(from: sourceAudioData, byteCount: bytesToCopy)
            destinationAudioBuffer.mDataByteSize = UInt32(bytesToCopy)
            destinationAudioBuffers[audioBufferIndex] = destinationAudioBuffer
        }

        return copiedAudioBuffer
    }
}

@MainActor
final class BuddyDictationManager: NSObject, ObservableObject {
    private static let defaultFinalTranscriptFallbackDelaySeconds: TimeInterval = 2.4
    private static let maximumTranscriptionProviderStartupWaitSeconds: TimeInterval = 15
    /// UserDefaults key holding the CoreAudio UID of the microphone the user has
    /// pinned for push-to-talk. Absent / `nil` means "use the system default
    /// input" (which is what macOS auto-routes to AirPods, the case this picker
    /// exists to override).
    private static let preferredMicrophoneUIDDefaultsKey = "clickyPreferredMicrophoneUID"
    /// UserDefaults key holding the pre-session default input device UID while
    /// a pinned microphone is active, so a crash or force-quit can restore the
    /// user's system-wide default on the next launch.
    private static let defaultInputDeviceUIDToRestoreAfterCrashDefaultsKey = "clickyDefaultInputDeviceUIDToRestoreAfterCrash"
    /// Peak session power (on the same 0–1 scale as `currentAudioPowerLevel`,
    /// i.e. RMS boosted by 10.2 and clamped) below which a session is considered
    /// to have captured no audible speech. Normal speech peaks well above 0.1;
    /// a dead or non-engaging capture device (e.g. a Bluetooth HFP mic that
    /// never switched on) hovers near 0.
    private static let noAudibleSpeechPeakAudioPowerThreshold: CGFloat = 0.05
    private static let recordedAudioPowerHistoryLength = 44
    private static let recordedAudioPowerHistoryBaselineLevel: CGFloat = 0.02
    private static let recordedAudioPowerHistorySampleIntervalSeconds: TimeInterval = 0.07
    private static let microphoneReadySound: NSSound? = {
        let microphoneReadySound = NSSound(named: NSSound.Name("Tink"))
        microphoneReadySound?.volume = 0.25
        return microphoneReadySound
    }()

    @Published private(set) var isRecordingFromMicrophoneButton = false
    @Published private(set) var isRecordingFromKeyboardShortcut = false
    @Published private(set) var isKeyboardShortcutSessionActiveOrFinalizing = false
    @Published private(set) var isFinalizingTranscript = false
    @Published private(set) var isPreparingToRecord = false
    @Published private(set) var currentAudioPowerLevel: CGFloat = 0
    @Published private(set) var recordedAudioPowerHistory = Array(
        repeating: BuddyDictationManager.recordedAudioPowerHistoryBaselineLevel,
        count: BuddyDictationManager.recordedAudioPowerHistoryLength
    )
    @Published private(set) var microphoneButtonRecordingStartedAt: Date?
    @Published private(set) var transcriptionProviderDisplayName = ""
    @Published var lastErrorMessage: String?
    @Published private(set) var currentPermissionProblem: BuddyDictationPermissionProblem?

    /// Invoked when a dictation session ends having captured essentially no
    /// audio (empty transcript AND peak power below
    /// `noAudibleSpeechPeakAudioPowerThreshold`), or when the capture pipeline
    /// fails to start at all. The owner speaks a hint so silent-capture
    /// failures (e.g. a Bluetooth HFP mic that never engaged) are never
    /// swallowed without user-visible feedback.
    var onDictationProducedNoAudibleSpeech: (() -> Void)?

    var isDictationInProgress: Bool {
        isPreparingToRecord || isRecordingFromMicrophoneButton || isRecordingFromKeyboardShortcut || isFinalizingTranscript
    }

    var isActivelyRecordingAudio: Bool {
        isRecordingFromMicrophoneButton || isRecordingFromKeyboardShortcut
    }

    var isMicrophoneButtonActivelyRecordingAudio: Bool {
        isRecordingFromMicrophoneButton
    }

    var isMicrophoneButtonSessionBusy: Bool {
        activeStartSource == .microphoneButton
            && (isPreparingToRecord || isRecordingFromMicrophoneButton || isFinalizingTranscript)
    }

    var needsInitialPermissionPrompt: Bool {
        if transcriptionProvider.requiresSpeechRecognitionPermission {
            return AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined
                || SFSpeechRecognizer.authorizationStatus() == .notDetermined
        }

        return AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined
    }

    private let transcriptionProvider: any BuddyTranscriptionProvider
    /// Replaced with a fresh instance at every session start (see
    /// `startRecognitionSession`): AVAudioEngine binds its input to the system
    /// default device when it starts, and a built engine caches that device's
    /// format — only a fresh engine reliably picks up the session's capture
    /// device (which we may have just made the default) and its real format.
    private var audioEngine = AVAudioEngine()
    private var activeTranscriptionSession: (any BuddyStreamingTranscriptionSession)?
    private var activeTranscriptionSessionCreationTask: Task<StreamingTranscriptionSessionTaskResult, Error>?
    private var activeEarlyAudioBufferRelay: EarlyAudioBufferRelay?
    private var transcriptionProviderStartupBeganAt: Date?
    private var activeStartSource: BuddyDictationStartSource?
    private var draftCallbacks: BuddyDictationDraftCallbacks?
    private var draftTextBeforeCurrentDictation = ""
    private var latestRecognizedText = ""
    private var shouldAutomaticallySubmitFinalDraft = false
    private var hasFinishedCurrentDictationSession = false
    private var finalizeFallbackWorkItem: DispatchWorkItem?
    /// Rotated on every arm/re-arm of the final-transcript fallback so a
    /// fallback whose work item already fired — but whose MainActor hop has
    /// not run yet — can detect it was superseded (e.g. by provider
    /// attachment re-arming the timer) instead of finishing the session.
    private var currentFinalTranscriptFallbackRequestIdentifier = UUID()
    private var pendingStartRequestIdentifier = UUID()
    private var contextualKeyterms: [String] = []
    private var lastRecordedAudioPowerSampleDate = Date.distantPast
    private var activePermissionRequestTask: Task<Bool, Never>?
    /// Timestamp of the last completed permission request, used to debounce
    /// rapid follow-up requests that arrive before macOS updates its cache.
    private var lastPermissionRequestCompletedAt: Date?
    /// The system default input device that was active before this session
    /// switched it to the pinned microphone. Restored (best-effort) when the
    /// session tears down, so the pin is session-scoped and the rest of the OS
    /// gets its previous default back. `nil` when no switch happened.
    private var defaultInputDeviceIDToRestoreAfterSession: AudioDeviceID?
    /// Loudest audio power seen this session (same 0–1 scale as
    /// `currentAudioPowerLevel`); used to distinguish "user said nothing that
    /// transcribed" from "the capture device produced silence".
    private var currentSessionPeakAudioPowerLevel: CGFloat = 0
    /// Human-readable description of where this session is capturing from
    /// ("system default" or the pinned mic's name), for the per-session
    /// diagnostics line.
    private var currentSessionCaptureDeviceDescription = "system default"

    override init() {
        let transcriptionProvider = BuddyTranscriptionProviderFactory.makeDefaultProvider()
        self.transcriptionProvider = transcriptionProvider
        self.transcriptionProviderDisplayName = transcriptionProvider.displayName
        super.init()
        restoreDefaultInputDeviceAfterUnexpectedTerminationIfNeeded()
    }

    func updateContextualKeyterms(_ contextualKeyterms: [String]) {
        self.contextualKeyterms = contextualKeyterms
    }

    // MARK: - Microphone Selection

    /// Enumerates the microphones the user can pin for push-to-talk capture.
    /// Uses the macOS 14 device types (`.microphone` for built-in / USB inputs,
    /// `.external` for other external audio devices). The returned `id` is the
    /// device UID, which round-trips through UserDefaults and CoreAudio's
    /// UID→AudioDeviceID translation when a recording session starts.
    static func availableCaptureMicrophones() -> [CaptureMicrophone] {
        let discoverySession = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        )

        return discoverySession.devices.map { captureDevice in
            CaptureMicrophone(
                id: captureDevice.uniqueID,
                displayName: captureDevice.localizedName
            )
        }
    }

    /// The microphone UID the user has pinned, or `nil` when they want the
    /// system default input.
    func preferredMicrophoneUID() -> String? {
        UserDefaults.standard.string(forKey: Self.preferredMicrophoneUIDDefaultsKey)
    }

    /// Pins a specific microphone by UID (or clears the pin with `nil` to fall
    /// back to the system default input). The change takes effect on the next
    /// push-to-talk session — no restart needed — because the pin is applied
    /// (as a session-scoped default-input switch) at every session start.
    func setPreferredMicrophoneUID(_ preferredMicrophoneUID: String?) {
        if let preferredMicrophoneUID, !preferredMicrophoneUID.isEmpty {
            UserDefaults.standard.set(preferredMicrophoneUID, forKey: Self.preferredMicrophoneUIDDefaultsKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.preferredMicrophoneUIDDefaultsKey)
        }
    }

    /// Translates a CoreAudio device UID into a live `AudioDeviceID`, or returns
    /// `nil` when no connected device matches (e.g. the pinned microphone was
    /// unplugged). Callers treat `nil` as "fall back to the system default".
    private func audioDeviceID(forUID microphoneUID: String) -> AudioDeviceID? {
        var translationAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var resolvedDeviceID = AudioDeviceID(kAudioObjectUnknown)
        var resolvedDeviceIDSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        var microphoneUIDString = microphoneUID as CFString
        let translationStatus = withUnsafeMutablePointer(to: &microphoneUIDString) { microphoneUIDPointer in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject),
                &translationAddress,
                UInt32(MemoryLayout<CFString>.size),
                microphoneUIDPointer,
                &resolvedDeviceIDSize,
                &resolvedDeviceID
            )
        }
        guard translationStatus == noErr, resolvedDeviceID != kAudioObjectUnknown else { return nil }
        return resolvedDeviceID
    }

    /// Reads a device's persistent CoreAudio UID so a default-input restore can
    /// survive launches, where the numeric `AudioDeviceID` is not stable.
    private func audioDeviceUID(for inputDeviceID: AudioDeviceID) -> String? {
        var deviceUIDAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceUID: CFString = "" as CFString
        var deviceUIDSize = UInt32(MemoryLayout<CFString>.size)
        let readStatus = AudioObjectGetPropertyData(
            inputDeviceID,
            &deviceUIDAddress,
            0,
            nil,
            &deviceUIDSize,
            &deviceUID
        )
        guard readStatus == noErr else { return nil }
        return deviceUID as String
    }

    /// Records the original default before changing it so an interrupted
    /// session can be repaired next launch. An existing value is older and
    /// therefore belongs to the user's true pre-session default.
    private func persistDefaultInputDeviceForCrashRecoveryIfNeeded(
        _ previousDefaultInputDeviceID: AudioDeviceID?
    ) {
        guard UserDefaults.standard.string(forKey: Self.defaultInputDeviceUIDToRestoreAfterCrashDefaultsKey) == nil else {
            return
        }
        guard let previousDefaultInputDeviceID else {
            print("⚠️ BuddyDictationManager: could not persist the previous default input because CoreAudio did not return a device")
            return
        }
        guard let previousDefaultInputDeviceUID = audioDeviceUID(for: previousDefaultInputDeviceID) else {
            print("⚠️ BuddyDictationManager: could not persist the previous default input because its device UID could not be read")
            return
        }
        UserDefaults.standard.set(
            previousDefaultInputDeviceUID,
            forKey: Self.defaultInputDeviceUIDToRestoreAfterCrashDefaultsKey
        )
    }

    /// Repairs the system default after a prior session was interrupted before
    /// its normal teardown could restore it. The saved intent is one-shot so a
    /// disconnected device cannot cause repeated restoration attempts.
    private func restoreDefaultInputDeviceAfterUnexpectedTerminationIfNeeded() {
        guard let defaultInputDeviceUIDToRestore = UserDefaults.standard.string(
            forKey: Self.defaultInputDeviceUIDToRestoreAfterCrashDefaultsKey
        ) else {
            return
        }
        defer {
            UserDefaults.standard.removeObject(
                forKey: Self.defaultInputDeviceUIDToRestoreAfterCrashDefaultsKey
            )
        }

        guard let defaultInputDeviceIDToRestore = audioDeviceID(forUID: defaultInputDeviceUIDToRestore) else {
            print("⚠️ BuddyDictationManager: failed to restore the previous default input because device UID \(defaultInputDeviceUIDToRestore) is unavailable")
            return
        }
        if !setSystemDefaultInputDevice(defaultInputDeviceIDToRestore) {
            print("⚠️ BuddyDictationManager: failed to restore the previous default input after an interrupted dictation session")
        }
    }

    /// Reads the system's current default input device from CoreAudio, or `nil`
    /// on failure.
    private func systemDefaultInputDeviceID() -> AudioDeviceID? {
        var defaultInputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var defaultInputDeviceID = AudioDeviceID(kAudioObjectUnknown)
        var defaultInputDeviceIDSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        let readStatus = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &defaultInputAddress,
            0,
            nil,
            &defaultInputDeviceIDSize,
            &defaultInputDeviceID
        )
        guard readStatus == noErr, defaultInputDeviceID != kAudioObjectUnknown else { return nil }
        return defaultInputDeviceID
    }

    /// Makes a device the system default input. Returns whether the property
    /// write succeeded.
    private func setSystemDefaultInputDevice(_ inputDeviceID: AudioDeviceID) -> Bool {
        var defaultInputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var mutableInputDeviceID = inputDeviceID
        let setStatus = AudioObjectSetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &defaultInputAddress,
            0,
            nil,
            UInt32(MemoryLayout<AudioDeviceID>.size),
            &mutableInputDeviceID
        )
        return setStatus == noErr
    }

    /// Session-scoped microphone pin: if the user pinned a mic and it resolves,
    /// make it the SYSTEM DEFAULT input for the duration of the session
    /// (remembering the previous default for restore at teardown).
    ///
    /// Why switch the system default instead of setting
    /// kAudioOutputUnitProperty_CurrentDevice on the input node's AUHAL: field
    /// diagnostics (Bose + DJI silence bug, round 2) showed that modern macOS
    /// AVAudioEngine re-binds its input to the system default device at start
    /// and discards the per-AU device override — the AUHAL pin was cosmetic.
    /// Capture only ever came from the default input, and with Bluetooth
    /// headphones connected the default flips to their HFP mic, which often
    /// fails to engage while A2DP is playing → captured silence, no error.
    /// Switching the default is the only binding macOS reliably honors.
    ///
    /// An unresolvable pin (unplugged mic) logs a warning and proceeds on the
    /// current default; no preference means no switch at all.
    private func switchSystemDefaultInputToPinnedMicrophoneIfNeeded() {
        currentSessionCaptureDeviceDescription = "system default"

        guard let preferredMicrophoneUID = preferredMicrophoneUID(), !preferredMicrophoneUID.isEmpty else {
            return
        }

        guard let preferredDeviceID = audioDeviceID(forUID: preferredMicrophoneUID) else {
            print("⚠️ BuddyDictationManager: preferred microphone \(preferredMicrophoneUID) is unavailable; using system default input")
            return
        }

        let pinnedMicrophoneDisplayName = Self.availableCaptureMicrophones()
            .first { $0.id == preferredMicrophoneUID }?
            .displayName ?? preferredMicrophoneUID

        let previousDefaultInputDeviceID = systemDefaultInputDeviceID()
        if previousDefaultInputDeviceID == preferredDeviceID {
            // Already the default — nothing to switch or restore.
            currentSessionCaptureDeviceDescription = "\(pinnedMicrophoneDisplayName) (already system default)"
            return
        }

        if setSystemDefaultInputDevice(preferredDeviceID) {
            defaultInputDeviceIDToRestoreAfterSession = previousDefaultInputDeviceID
            persistDefaultInputDeviceForCrashRecoveryIfNeeded(previousDefaultInputDeviceID)
            currentSessionCaptureDeviceDescription = "\(pinnedMicrophoneDisplayName) (pinned via default-input switch)"
        } else {
            print("⚠️ BuddyDictationManager: failed to make \(pinnedMicrophoneDisplayName) the default input; using system default input")
        }
    }

    /// Puts the pre-session default input back (best-effort) if this session
    /// switched it. Called from the common session-teardown path so every
    /// stop/cancel/error/finish flow restores the user's previous default.
    private func restorePreviousDefaultInputIfNeeded() {
        guard let previousDefaultInputDeviceID = defaultInputDeviceIDToRestoreAfterSession else { return }
        defaultInputDeviceIDToRestoreAfterSession = nil

        if !setSystemDefaultInputDevice(previousDefaultInputDeviceID) {
            print("⚠️ BuddyDictationManager: failed to restore the previous default input (device \(previousDefaultInputDeviceID))")
        }
        UserDefaults.standard.removeObject(
            forKey: Self.defaultInputDeviceUIDToRestoreAfterCrashDefaultsKey
        )
    }

    func startPersistentDictationFromMicrophoneButton(
        currentDraftText: String,
        updateDraftText: @escaping (String) -> Void,
        submitDraftText: @escaping (String) -> Void
    ) async {
        await startPushToTalk(
            startSource: .microphoneButton,
            currentDraftText: currentDraftText,
            updateDraftText: updateDraftText,
            submitDraftText: submitDraftText,
            shouldAutomaticallySubmitFinalDraftOnStop: false
        )
    }

    func startPushToTalkFromKeyboardShortcut(
        currentDraftText: String,
        updateDraftText: @escaping (String) -> Void,
        submitDraftText: @escaping (String) -> Void
    ) async {
        await startPushToTalk(
            startSource: .keyboardShortcut,
            currentDraftText: currentDraftText,
            updateDraftText: updateDraftText,
            submitDraftText: submitDraftText,
            shouldAutomaticallySubmitFinalDraftOnStop: currentDraftText
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .isEmpty
        )
    }

    func stopPersistentDictationFromMicrophoneButton() {
        stopPushToTalk(expectedStartSource: .microphoneButton)
    }

    func stopPushToTalkFromKeyboardShortcut() {
        stopPushToTalk(expectedStartSource: .keyboardShortcut)
    }

    func cancelCurrentDictation(preserveDraftText: Bool = true) {
        pendingStartRequestIdentifier = UUID()

        guard isDictationInProgress else { return }

        finalizeFallbackWorkItem?.cancel()
        finalizeFallbackWorkItem = nil

        if preserveDraftText {
            let currentDraftText = composeDraftText(withTranscribedText: latestRecognizedText)
            draftCallbacks?.updateDraftText(currentDraftText)
        }

        tearDownActiveRecognitionResources()

        resetSessionState()
    }

    func requestInitialPushToTalkPermissionsIfNeeded() async {
        guard needsInitialPermissionPrompt else { return }
        guard !isDictationInProgress else { return }

        lastErrorMessage = nil
        currentPermissionProblem = nil
        isPreparingToRecord = true

        NSApplication.shared.activate(ignoringOtherApps: true)

        do {
            try await Task.sleep(for: .milliseconds(200))
        } catch {
            // If the task is cancelled while we are waiting for macOS to bring
            // the app forward, we can safely continue into the permission check.
        }

        let hasPermissions = await requestMicrophoneAndSpeechPermissionsWithoutDuplicatePrompts()
        isPreparingToRecord = false

        if hasPermissions {
            lastErrorMessage = nil
        }
    }

    private func startPushToTalk(
        startSource: BuddyDictationStartSource,
        currentDraftText: String,
        updateDraftText: @escaping (String) -> Void,
        submitDraftText: @escaping (String) -> Void,
        shouldAutomaticallySubmitFinalDraftOnStop: Bool
    ) async {
        guard !isDictationInProgress else { return }

        print("🎙️ BuddyDictationManager: start requested (\(startSource))")

        if needsInitialPermissionPrompt {
            print("🎙️ BuddyDictationManager: requesting initial permissions")
            NSApplication.shared.activate(ignoringOtherApps: true)

            do {
                try await Task.sleep(for: .milliseconds(200))
            } catch {
                // If the task is cancelled while the app is being activated,
                // we can safely continue into the permission request.
            }
        }

        let startRequestIdentifier = UUID()
        pendingStartRequestIdentifier = startRequestIdentifier

        lastErrorMessage = nil
        currentPermissionProblem = nil
        isPreparingToRecord = true

        guard await requestMicrophoneAndSpeechPermissionsWithoutDuplicatePrompts() else {
            print("🎙️ BuddyDictationManager: permissions missing or denied")
            isPreparingToRecord = false
            return
        }
        guard !Task.isCancelled else {
            print("🎙️ BuddyDictationManager: start cancelled (shortcut released during permission check)")
            isPreparingToRecord = false
            return
        }
        guard pendingStartRequestIdentifier == startRequestIdentifier else {
            print("🎙️ BuddyDictationManager: start request superseded")
            isPreparingToRecord = false
            return
        }

        draftTextBeforeCurrentDictation = currentDraftText
        latestRecognizedText = ""
        draftCallbacks = BuddyDictationDraftCallbacks(
            updateDraftText: updateDraftText,
            submitDraftText: submitDraftText
        )
        activeStartSource = startSource
        shouldAutomaticallySubmitFinalDraft = shouldAutomaticallySubmitFinalDraftOnStop
        hasFinishedCurrentDictationSession = false
        isFinalizingTranscript = false
        isRecordingFromMicrophoneButton = false
        isRecordingFromKeyboardShortcut = false
        isKeyboardShortcutSessionActiveOrFinalizing = startSource == .keyboardShortcut
        currentAudioPowerLevel = 0
        recordedAudioPowerHistory = Array(
            repeating: Self.recordedAudioPowerHistoryBaselineLevel,
            count: Self.recordedAudioPowerHistoryLength
        )
        microphoneButtonRecordingStartedAt = nil
        lastRecordedAudioPowerSampleDate = .distantPast
        currentSessionPeakAudioPowerLevel = 0

        guard !Task.isCancelled else {
            print("🎙️ BuddyDictationManager: start cancelled (shortcut released before recording began)")
            resetSessionState()
            return
        }

        do {
            try await startRecognitionSession(startRequestIdentifier: startRequestIdentifier)
            guard pendingStartRequestIdentifier == startRequestIdentifier || isFinalizingTranscript else {
                print("🎙️ BuddyDictationManager: start request superseded during session start")
                tearDownActiveRecognitionResources()
                resetSessionState()
                return
            }
            guard !Task.isCancelled || isFinalizingTranscript else {
                print("🎙️ BuddyDictationManager: start cancelled (shortcut released during session start)")
                tearDownActiveRecognitionResources()
                resetSessionState()
                return
            }
            print("🎙️ BuddyDictationManager: recognition session started")
        } catch {
            guard activeStartSource == startSource,
                  pendingStartRequestIdentifier == startRequestIdentifier || isFinalizingTranscript else {
                return
            }

            // Provider creation now happens after the engine is live, so every
            // failure must also tear down the tap and its startup-audio relay.
            tearDownActiveRecognitionResources()

            isPreparingToRecord = false
            lastErrorMessage = userFacingErrorMessage(
                from: error,
                fallback: "couldn't start voice input. try again."
            )
            print("❌ BuddyDictationManager: failed to start recognition session (\(transcriptionProvider.displayName)): \(error)")
            resetSessionState()
            // Nothing observes lastErrorMessage today, so a failed engine or
            // provider start would otherwise be a silent no-op from the user's
            // point of view — speak up through the same channel as a silent
            // capture so the failure is never swallowed.
            onDictationProducedNoAudibleSpeech?()
        }
    }

    private func stopPushToTalk(expectedStartSource: BuddyDictationStartSource) {
        pendingStartRequestIdentifier = UUID()

        guard activeStartSource == expectedStartSource else {
            isPreparingToRecord = false
            return
        }
        guard !isFinalizingTranscript else { return }

        print("🎙️ BuddyDictationManager: stop requested (\(expectedStartSource))")

        isRecordingFromMicrophoneButton = false
        isRecordingFromKeyboardShortcut = false
        isFinalizingTranscript = true

        let finalTranscriptFallbackDelaySeconds = activeTranscriptionSession?.finalTranscriptFallbackDelaySeconds
            ?? Self.defaultFinalTranscriptFallbackDelaySeconds

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        activeTranscriptionSession?.requestFinalTranscript()

        scheduleFinalTranscriptFallback(after: finalTranscriptFallbackDelaySeconds)
    }

    private func startRecognitionSession(startRequestIdentifier: UUID) async throws {
        tearDownActiveRecognitionResources()

        // Apply the microphone pin BEFORE creating the fresh engine: the pin is
        // a session-scoped system-default-input switch (see the method's comment
        // for why the per-AU AUHAL override does not work), and the engine binds
        // to whatever the default input is when it is built and started.
        switchSystemDefaultInputToPinnedMicrophoneIfNeeded()

        // Rebuild the engine from scratch for every dictation session. An
        // already-built engine stays bound to the device (and cached format) it
        // was constructed around; only a fresh engine reliably binds to the
        // current system default input — which we may have just switched to the
        // pinned mic — and reports that device's real format for the tap.
        // Push-to-talk cadence is human-scale; engine construction is cheap.
        audioEngine = AVAudioEngine()

        let earlyAudioBufferRelay = EarlyAudioBufferRelay()
        activeEarlyAudioBufferRelay = earlyAudioBufferRelay

        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        // One-line capture-path diagnostic so field debugging never has to guess
        // which device and format a session actually recorded from.
        print("🎙️ BuddyDictationManager: capturing from \(currentSessionCaptureDeviceDescription) at \(Int(inputFormat.sampleRate))Hz/\(inputFormat.channelCount)ch")

        // The tap fires on AVFoundation's internal queue while the main actor
        // may concurrently create or tear down the provider session. Capture
        // the relay strongly rather than reading manager properties here: its
        // lock makes startup buffering safe, its attached session stays alive
        // for the tap's lifetime, and a stale tap can never feed a newer
        // session. This preserves the use-after-free protection added after a
        // field crash when headphones changed during recording.
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self, earlyAudioBufferRelay] buffer, _ in
            earlyAudioBufferRelay.appendOrForward(buffer)

            if buffer.frameLength > 0,
               earlyAudioBufferRelay.markFirstNonEmptyAudioBufferDetectedIfNeeded() {
                Task { @MainActor [weak self, earlyAudioBufferRelay] in
                    self?.markMicrophoneLiveIfCurrentSession(
                        startRequestIdentifier: startRequestIdentifier,
                        earlyAudioBufferRelay: earlyAudioBufferRelay
                    )
                }
            }

            self?.updateAudioPowerLevel(from: buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()

        print("🎙️ BuddyDictationManager: audio engine started, opening transcription provider \(transcriptionProvider.displayName)")

        // This unstructured task deliberately survives cancellation of the
        // shortcut-start task. A key release during provider setup must still
        // produce a session so the already-buffered short utterance can be
        // flushed and finalized.
        transcriptionProviderStartupBeganAt = Date()
        let transcriptionSessionCreationTask = Task<StreamingTranscriptionSessionTaskResult, Error> {
            let transcriptionSession = try await transcriptionProvider.startStreamingSession(
                keyterms: buildTranscriptionKeyterms(),
                onTranscriptUpdate: { [weak self] transcriptText in
                    Task { @MainActor in
                        guard let self,
                              self.activeEarlyAudioBufferRelay === earlyAudioBufferRelay else {
                            return
                        }

                        self.latestRecognizedText = transcriptText
                    }
                },
                onFinalTranscriptReady: { [weak self] transcriptText in
                    Task { @MainActor in
                        guard let self,
                              self.activeEarlyAudioBufferRelay === earlyAudioBufferRelay else {
                            return
                        }

                        self.latestRecognizedText = transcriptText

                        if self.isFinalizingTranscript {
                            self.finishCurrentDictationSessionIfNeeded(
                                shouldSubmitFinalDraft: self.shouldAutomaticallySubmitFinalDraft
                            )
                        }
                    }
                },
                onError: { [weak self] error in
                    Task { @MainActor in
                        guard let self,
                              self.activeEarlyAudioBufferRelay === earlyAudioBufferRelay else {
                            return
                        }

                        self.handleRecognitionError(error)
                    }
                }
            )

            return StreamingTranscriptionSessionTaskResult(
                transcriptionSession: transcriptionSession
            )
        }
        activeTranscriptionSessionCreationTask = transcriptionSessionCreationTask
        let transcriptionSessionTaskResult = try await transcriptionSessionCreationTask.value
        let newlyCreatedTranscriptionSession = transcriptionSessionTaskResult.transcriptionSession

        guard activeEarlyAudioBufferRelay === earlyAudioBufferRelay else {
            newlyCreatedTranscriptionSession.cancel()
            earlyAudioBufferRelay.discard()
            throw CancellationError()
        }

        activeTranscriptionSessionCreationTask = nil
        transcriptionProviderStartupBeganAt = nil
        activeTranscriptionSession = newlyCreatedTranscriptionSession
        earlyAudioBufferRelay.attach(newlyCreatedTranscriptionSession)

        // A quick press-and-release can reach finalization before provider
        // setup completes. Flush first, then close the provider input so that
        // the buffered utterance is included in its final transcript.
        if isFinalizingTranscript {
            newlyCreatedTranscriptionSession.requestFinalTranscript()
            scheduleFinalTranscriptFallback(
                after: newlyCreatedTranscriptionSession.finalTranscriptFallbackDelaySeconds
            )
        }

        print("🎙️ BuddyDictationManager: transcription provider ready")
    }

    private func markMicrophoneLiveIfCurrentSession(
        startRequestIdentifier: UUID,
        earlyAudioBufferRelay: EarlyAudioBufferRelay
    ) {
        guard pendingStartRequestIdentifier == startRequestIdentifier,
              activeEarlyAudioBufferRelay === earlyAudioBufferRelay,
              let activeStartSource,
              !isFinalizingTranscript else {
            return
        }

        isRecordingFromMicrophoneButton = activeStartSource == .microphoneButton
        isRecordingFromKeyboardShortcut = activeStartSource == .keyboardShortcut
        isPreparingToRecord = false

        if activeStartSource == .microphoneButton {
            microphoneButtonRecordingStartedAt = Date()
        }

        Self.microphoneReadySound?.play()
        print("🎙️ BuddyDictationManager: microphone is live")
    }

    private func scheduleFinalTranscriptFallback(after fallbackDelaySeconds: TimeInterval) {
        finalizeFallbackWorkItem?.cancel()

        // The work item fires on the main queue but does its real work in a
        // separate MainActor Task hop. Provider attachment can re-arm this
        // fallback inside that gap; without an identity check the stale,
        // already-fired fallback would then see the freshly attached session,
        // skip its re-arm branch, and finish the session before the final
        // transcript arrives. Rotating this token on every (re-)arm lets the
        // stale hop recognize it was superseded and bail out.
        let fallbackRequestIdentifier = UUID()
        currentFinalTranscriptFallbackRequestIdentifier = fallbackRequestIdentifier

        let shouldSubmitFinalDraftWhenFallbackTriggers = shouldAutomaticallySubmitFinalDraft
        let fallbackWorkItem = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                guard self.currentFinalTranscriptFallbackRequestIdentifier == fallbackRequestIdentifier else {
                    return
                }

                // A key release can precede provider attachment. Keep the
                // existing default fallback as a watchdog, but do not let it
                // discard captured startup audio while provider creation is
                // still legitimately in flight. Attachment re-arms this timer
                // with the provider's own final-transcript delay.
                if self.activeTranscriptionSession == nil,
                   self.activeEarlyAudioBufferRelay != nil,
                   self.isFinalizingTranscript {
                    if let transcriptionProviderStartupBeganAt = self.transcriptionProviderStartupBeganAt {
                        let providerStartupElapsedSeconds = Date().timeIntervalSince(
                            transcriptionProviderStartupBeganAt
                        )
                        let providerStartupRemainingSeconds = Self.maximumTranscriptionProviderStartupWaitSeconds
                            - providerStartupElapsedSeconds

                        if providerStartupRemainingSeconds > 0 {
                            self.scheduleFinalTranscriptFallback(
                                after: min(
                                    Self.defaultFinalTranscriptFallbackDelaySeconds,
                                    providerStartupRemainingSeconds
                                )
                            )
                            return
                        }
                    }

                    print("⚠️ BuddyDictationManager: transcription provider did not become ready within 15 seconds after audio capture started")
                }

                self.finishCurrentDictationSessionIfNeeded(
                    shouldSubmitFinalDraft: shouldSubmitFinalDraftWhenFallbackTriggers
                )
            }
        }
        finalizeFallbackWorkItem = fallbackWorkItem
        DispatchQueue.main.asyncAfter(
            deadline: .now() + fallbackDelaySeconds,
            execute: fallbackWorkItem
        )
    }

    private func handleRecognitionError(_ error: Error) {
        if hasFinishedCurrentDictationSession {
            return
        }

        if isFinalizingTranscript && !latestRecognizedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            finishCurrentDictationSessionIfNeeded(
                shouldSubmitFinalDraft: shouldAutomaticallySubmitFinalDraft
            )
        } else {
            print("❌ Buddy dictation error (\(transcriptionProvider.displayName)): \(error)")
            lastErrorMessage = userFacingErrorMessage(
                from: error,
                fallback: "couldn't transcribe that. try again."
            )
            cancelCurrentDictation(preserveDraftText: false)
        }
    }

    private func finishCurrentDictationSessionIfNeeded(shouldSubmitFinalDraft: Bool) {
        guard !hasFinishedCurrentDictationSession else { return }
        hasFinishedCurrentDictationSession = true

        finalizeFallbackWorkItem?.cancel()
        finalizeFallbackWorkItem = nil

        let finalDraftText = composeDraftText(withTranscribedText: latestRecognizedText)
        let finalTranscriptText = latestRecognizedText.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentDraftCallbacks = draftCallbacks
        // Snapshot the peak before resetSessionState() clears it.
        let sessionPeakAudioPowerLevel = currentSessionPeakAudioPowerLevel

        if !shouldSubmitFinalDraft && !finalDraftText.isEmpty {
            currentDraftCallbacks?.updateDraftText(finalDraftText)
        }

        tearDownActiveRecognitionResources()

        resetSessionState()

        // An empty transcript with a near-zero peak means the capture device
        // produced silence (not just unintelligible speech) — tell the user
        // instead of silently doing nothing.
        if finalTranscriptText.isEmpty
            && sessionPeakAudioPowerLevel < Self.noAudibleSpeechPeakAudioPowerThreshold {
            print("⚠️ BuddyDictationManager: session ended with no transcript and peak power \(sessionPeakAudioPowerLevel) — capture was effectively silent")
            onDictationProducedNoAudibleSpeech?()
        }

        guard shouldSubmitFinalDraft else { return }
        guard !finalTranscriptText.isEmpty else { return }

        currentDraftCallbacks?.submitDraftText(finalDraftText)
    }

    private func tearDownActiveRecognitionResources() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        activeTranscriptionSessionCreationTask?.cancel()
        activeTranscriptionSessionCreationTask = nil
        transcriptionProviderStartupBeganAt = nil
        activeEarlyAudioBufferRelay?.discard()
        activeEarlyAudioBufferRelay = nil
        activeTranscriptionSession?.cancel()
        activeTranscriptionSession = nil
    }

    private func composeDraftText(withTranscribedText transcribedText: String) -> String {
        let trimmedTranscriptText = transcribedText.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedTranscriptText.isEmpty else {
            return draftTextBeforeCurrentDictation
        }

        let trimmedExistingDraftText = draftTextBeforeCurrentDictation
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedExistingDraftText.isEmpty else {
            return trimmedTranscriptText
        }

        if draftTextBeforeCurrentDictation.hasSuffix(" ") || draftTextBeforeCurrentDictation.hasSuffix("\n") {
            return draftTextBeforeCurrentDictation + trimmedTranscriptText
        }

        return draftTextBeforeCurrentDictation + " " + trimmedTranscriptText
    }

    private func resetSessionState() {
        pendingStartRequestIdentifier = UUID()
        finalizeFallbackWorkItem?.cancel()
        finalizeFallbackWorkItem = nil
        // Also invalidate any fallback whose work item fired but whose
        // MainActor hop has not run yet — it must not finish a session that
        // starts after this reset.
        currentFinalTranscriptFallbackRequestIdentifier = UUID()
        activeEarlyAudioBufferRelay?.discard()
        activeEarlyAudioBufferRelay = nil
        activeTranscriptionSession = nil
        draftCallbacks = nil
        activeStartSource = nil
        draftTextBeforeCurrentDictation = ""
        latestRecognizedText = ""
        shouldAutomaticallySubmitFinalDraft = false
        hasFinishedCurrentDictationSession = false
        isPreparingToRecord = false
        isRecordingFromMicrophoneButton = false
        isRecordingFromKeyboardShortcut = false
        isKeyboardShortcutSessionActiveOrFinalizing = false
        isFinalizingTranscript = false
        currentAudioPowerLevel = 0
        recordedAudioPowerHistory = Array(
            repeating: Self.recordedAudioPowerHistoryBaselineLevel,
            count: Self.recordedAudioPowerHistoryLength
        )
        microphoneButtonRecordingStartedAt = nil
        lastRecordedAudioPowerSampleDate = .distantPast
        currentSessionPeakAudioPowerLevel = 0
        currentSessionCaptureDeviceDescription = "system default"
        // Every stop/cancel/error/finish flow converges here, so this is the one
        // place that reliably gives the user their previous default input back
        // after a session-scoped microphone switch.
        restorePreviousDefaultInputIfNeeded()
    }

    private func buildTranscriptionKeyterms() -> [String] {
        let baseKeyterms = [
            "makesomething",
            "Learning Buddy",
            "Codex",
            "Claude",
            "Anthropic",
            "OpenAI",
            "SwiftUI",
            "Xcode",
            "Vercel",
            "Next.js",
            "localhost",
            "JavaScript",
            "TypeScript",
            "CSS",
            "flexbox",
            "teach me",
            "lesson",
            "Clicky"
        ]

        let combinedKeyterms = baseKeyterms + contextualKeyterms
        var uniqueNormalizedKeyterms = Set<String>()
        var orderedKeyterms: [String] = []

        for keyterm in combinedKeyterms {
            let trimmedKeyterm = keyterm.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedKeyterm.isEmpty else { continue }

            let normalizedKeyterm = trimmedKeyterm.lowercased()
            if uniqueNormalizedKeyterms.contains(normalizedKeyterm) {
                continue
            }

            uniqueNormalizedKeyterms.insert(normalizedKeyterm)
            orderedKeyterms.append(trimmedKeyterm)
        }

        return orderedKeyterms
    }

    private func updateAudioPowerLevel(from audioBuffer: AVAudioPCMBuffer) {
        guard let channelData = audioBuffer.floatChannelData else { return }

        let channelSamples = channelData[0]
        let frameCount = Int(audioBuffer.frameLength)
        guard frameCount > 0 else { return }

        var summedSquares: Float = 0
        for sampleIndex in 0..<frameCount {
            let sample = channelSamples[sampleIndex]
            summedSquares += sample * sample
        }

        let rootMeanSquare = sqrt(summedSquares / Float(frameCount))
        let boostedLevel = min(max(rootMeanSquare * 10.2, 0), 1)

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }

            let smoothedAudioPowerLevel = max(
                CGFloat(boostedLevel),
                self.currentAudioPowerLevel * 0.72
            )
            self.currentAudioPowerLevel = smoothedAudioPowerLevel
            self.currentSessionPeakAudioPowerLevel = max(
                self.currentSessionPeakAudioPowerLevel,
                CGFloat(boostedLevel)
            )

            let now = Date()
            if now.timeIntervalSince(self.lastRecordedAudioPowerSampleDate)
                >= Self.recordedAudioPowerHistorySampleIntervalSeconds {
                self.lastRecordedAudioPowerSampleDate = now
                self.appendRecordedAudioPowerSample(
                    max(CGFloat(boostedLevel), Self.recordedAudioPowerHistoryBaselineLevel)
                )
            }
        }
    }

    private func appendRecordedAudioPowerSample(_ audioPowerSample: CGFloat) {
        var updatedRecordedAudioPowerHistory = recordedAudioPowerHistory
        updatedRecordedAudioPowerHistory.append(audioPowerSample)

        if updatedRecordedAudioPowerHistory.count > Self.recordedAudioPowerHistoryLength {
            updatedRecordedAudioPowerHistory.removeFirst(
                updatedRecordedAudioPowerHistory.count - Self.recordedAudioPowerHistoryLength
            )
        }

        recordedAudioPowerHistory = updatedRecordedAudioPowerHistory
    }

    private func requestMicrophoneAndSpeechPermissionsIfNeeded() async -> Bool {
        let hasMicrophonePermission = await requestMicrophonePermissionIfNeeded()
        guard hasMicrophonePermission else {
            lastErrorMessage = "microphone permission is required for push to talk."
            return false
        }

        guard transcriptionProvider.requiresSpeechRecognitionPermission else {
            return true
        }

        let hasSpeechRecognitionPermission = await requestSpeechRecognitionPermissionIfNeeded()
        guard hasSpeechRecognitionPermission else {
            lastErrorMessage = "speech recognition permission is required for push to talk."
            return false
        }

        return true
    }

    /// macOS can show the microphone/speech sheet again if we accidentally fan out
    /// multiple permission requests before the first one finishes. We keep exactly
    /// one in-flight request task so rapid repeat presses all await the same result.
    ///
    /// After the task completes, we skip re-requesting for a short cooldown period
    /// so macOS has time to update its authorization cache. This prevents the
    /// permission dialog from popping up again on rapid follow-up presses.
    private func requestMicrophoneAndSpeechPermissionsWithoutDuplicatePrompts() async -> Bool {
        // If a permission request is already in-flight, reuse it.
        if let activePermissionRequestTask {
            return await activePermissionRequestTask.value
        }

        // If we just finished a permission request very recently, skip re-requesting.
        // macOS can briefly report .notDetermined even after the user tapped Allow,
        // so we trust the cached result for a short window.
        if let lastPermissionRequestCompletedAt,
           Date().timeIntervalSince(lastPermissionRequestCompletedAt) < 1.0 {
            return AVCaptureDevice.authorizationStatus(for: .audio) != .denied
                && AVCaptureDevice.authorizationStatus(for: .audio) != .restricted
        }

        let permissionRequestTask = Task { @MainActor in
            await self.requestMicrophoneAndSpeechPermissionsIfNeeded()
        }

        activePermissionRequestTask = permissionRequestTask

        let hasPermissions = await permissionRequestTask.value
        activePermissionRequestTask = nil
        lastPermissionRequestCompletedAt = Date()
        return hasPermissions
    }

    private func requestMicrophonePermissionIfNeeded() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            currentPermissionProblem = nil
            return true
        case .notDetermined:
            let isGranted = await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { isGranted in
                    continuation.resume(returning: isGranted)
                }
            }
            currentPermissionProblem = isGranted ? nil : .microphoneAccessDenied
            return isGranted
        case .denied, .restricted:
            currentPermissionProblem = .microphoneAccessDenied
            return false
        @unknown default:
            currentPermissionProblem = .microphoneAccessDenied
            return false
        }
    }

    private func requestSpeechRecognitionPermissionIfNeeded() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            currentPermissionProblem = nil
            return true
        case .notDetermined:
            let isGranted = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { authorizationStatus in
                    continuation.resume(returning: authorizationStatus == .authorized)
                }
            }
            currentPermissionProblem = isGranted ? nil : .speechRecognitionDenied
            return isGranted
        case .denied, .restricted:
            currentPermissionProblem = .speechRecognitionDenied
            return false
        @unknown default:
            currentPermissionProblem = .speechRecognitionDenied
            return false
        }
    }

    func openRelevantPrivacySettings() {
        let settingsURLString: String

        switch currentPermissionProblem {
        case .microphoneAccessDenied:
            settingsURLString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        case .speechRecognitionDenied:
            settingsURLString = "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"
        case nil:
            settingsURLString = "x-apple.systempreferences:com.apple.preference.security"
        }

        guard let settingsURL = URL(string: settingsURLString) else { return }
        NSWorkspace.shared.open(settingsURL)
    }

    private func userFacingErrorMessage(from error: Error, fallback: String) -> String {
        if let localizedError = error as? LocalizedError,
           let errorDescription = localizedError.errorDescription?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !errorDescription.isEmpty {
            return errorDescription
        }

        let errorDescription = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        if !errorDescription.isEmpty,
           errorDescription != "The operation couldn’t be completed." {
            return errorDescription
        }

        return fallback
    }
}
