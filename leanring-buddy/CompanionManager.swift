//
//  CompanionManager.swift
//  leanring-buddy
//
//  Central state manager for the companion voice mode. Owns the push-to-talk
//  pipeline (dictation manager + global shortcut monitor + overlay) and
//  exposes observable voice state for the panel UI.
//

import AVFoundation
import Combine
import Foundation
import ScreenCaptureKit
import Speech
import SwiftUI

enum CompanionVoiceState {
    case idle
    case listening
    case processing
    case responding
}

@MainActor
final class CompanionManager: ObservableObject {
    @Published private(set) var voiceState: CompanionVoiceState = .idle
    @Published private(set) var lastTranscript: String?
    @Published private(set) var currentAudioPowerLevel: CGFloat = 0
    @Published private(set) var hasAccessibilityPermission = false
    @Published private(set) var hasScreenRecordingPermission = false
    @Published private(set) var hasMicrophonePermission = false
    @Published private(set) var hasScreenContentPermission = false
    @Published private(set) var hasSpeechRecognitionPermission = false

    /// Screen location (global AppKit coords) of a detected UI element the
    /// buddy should fly to and point at. Parsed from the brain response;
    /// observed by BlueCursorView to trigger the flight animation.
    @Published var detectedElementScreenLocation: CGPoint?
    /// The display frame (global AppKit coords) of the screen the detected
    /// element is on, so BlueCursorView knows which screen overlay should animate.
    @Published var detectedElementDisplayFrame: CGRect?
    /// Custom speech bubble text for the pointing animation. When set,
    /// BlueCursorView uses this instead of a random pointer phrase.
    @Published var detectedElementBubbleText: String?

    let buddyDictationManager = BuddyDictationManager()
    let globalPushToTalkShortcutMonitor = GlobalPushToTalkShortcutMonitor()
    let overlayWindowManager = OverlayWindowManager()
    let sidecarManager = SidecarProcessManager()
    // Response text is now displayed inline on the cursor overlay via
    // streamingResponseText, so no separate response overlay manager is needed.

    private lazy var brain: CompanionBrainProvider = SidecarBrainProvider(sidecarManager: sidecarManager)
    private lazy var textToSpeechClient: CompanionTTSClient = AppleTTSClient()

    /// The currently running AI response task, if any. Cancelled when the user
    /// speaks again so a new response can begin immediately.
    private var currentResponseTask: Task<Void, Never>?

    /// Task that speaks a one-time reassurance ("this one can take a minute or
    /// two") when a turn runs long. Started on the first tool-use status of a
    /// turn and cancelled when the turn completes or is superseded.
    private var longTurnAcknowledgementTask: Task<Void, Never>?

    /// Per-turn guard so the long-turn reassurance is scheduled at most once,
    /// even though tool-use status events fire repeatedly during a turn.
    private var hasScheduledLongTurnAcknowledgementForCurrentTurn = false

    private var shortcutTransitionCancellable: AnyCancellable?
    private var voiceStateCancellable: AnyCancellable?
    private var audioPowerCancellable: AnyCancellable?
    private var accessibilityCheckTimer: Timer?
    private var pendingKeyboardShortcutStartTask: Task<Void, Never>?
    /// Scheduled hide for transient cursor mode — cancelled if the user
    /// speaks again before the delay elapses.
    private var transientHideTask: Task<Void, Never>?

    /// True when all three required permissions (accessibility, screen recording,
    /// microphone) are granted. Used by the panel to show a single "all good" state.
    var allPermissionsGranted: Bool {
        hasAccessibilityPermission && hasScreenRecordingPermission && hasMicrophonePermission && hasScreenContentPermission
    }

    var isPushToTalkHealthy: Bool {
        !hasAccessibilityPermission || globalPushToTalkShortcutMonitor.isEventTapInstalled
    }

    /// Whether the blue cursor overlay is currently visible on screen.
    /// Used by the panel to show accurate status text ("Active" vs "Ready").
    @Published private(set) var isOverlayVisible: Bool = false

    /// The model used for voice responses. Persisted to UserDefaults.
    @Published var selectedModel: String = UserDefaults.standard.string(forKey: "selectedClaudeModel") ?? "claude-sonnet-4-6"

    func setSelectedModel(_ model: String) {
        selectedModel = model
        UserDefaults.standard.set(model, forKey: "selectedClaudeModel")
    }

    @Published var selectedClaudeEffort: String = UserDefaults.standard.string(forKey: "selectedClaudeEffort") ?? "medium"

    func setSelectedClaudeEffort(_ effort: String) {
        selectedClaudeEffort = effort
        UserDefaults.standard.set(effort, forKey: "selectedClaudeEffort")
    }

    @Published var selectedCodexModel: String = UserDefaults.standard.string(forKey: "selectedCodexModel") ?? "default"

    func setSelectedCodexModel(_ model: String) {
        selectedCodexModel = model
        UserDefaults.standard.set(model, forKey: "selectedCodexModel")
    }

    @Published var selectedCodexEffort: String = UserDefaults.standard.string(forKey: "selectedCodexEffort") ?? "medium"

    func setSelectedCodexEffort(_ effort: String) {
        selectedCodexEffort = effort
        UserDefaults.standard.set(effort, forKey: "selectedCodexEffort")
    }

    @Published var selectedBackend: String = UserDefaults.standard.string(forKey: "selectedBrainBackend") ?? "claude"

    func setSelectedBackend(_ backend: String) {
        selectedBackend = backend
        UserDefaults.standard.set(backend, forKey: "selectedBrainBackend")
    }

    @Published var selectedWorkspaceId: String = UserDefaults.standard.string(forKey: "selectedWorkspaceId") ?? "general"

    func setSelectedWorkspaceId(_ workspaceId: String) {
        selectedWorkspaceId = workspaceId
        UserDefaults.standard.set(workspaceId, forKey: "selectedWorkspaceId")
    }

    /// The learning workspaces (topics) known to the brain sidecar, shown in
    /// the panel's topic picker. Refreshed when the panel appears and whenever
    /// a lesson is created.
    @Published private(set) var workspaces: [SidecarWorkspace] = []

    /// The latest brain authentication status for both backends, shown in the
    /// panel. Nil until the first successful check completes.
    @Published private(set) var brainAuthStatus: SidecarAuthStatus?

    /// A specific backend's authentication that a real brain turn just proved is
    /// broken, paired with the panel copy that explains how to fix it. Nil unless
    /// the most recent turn failed with an "auth_required" error.
    ///
    /// This exists because `brainAuthStatus` comes from an optimistic, file-based
    /// login check (it only verifies credential files exist on disk; it cannot
    /// tell whether the stored token has expired or been revoked). So that check
    /// keeps reporting "Signed in" even right after a turn was rejected for a
    /// missing/expired token. When an actual turn fails with "auth_required" we
    /// have ground truth the optimistic check lacks, so we surface it here to
    /// override the panel's "Signed in" line until the next turn is attempted.
    @Published private(set) var authRequiredPanelMessage: (backend: String, message: String)?

    /// Reloads the topic list from the sidecar. Errors are swallowed into a
    /// printed log — the panel simply keeps showing whatever it had before.
    func refreshWorkspaces() {
        Task {
            do {
                let listedWorkspaces = try await sidecarManager.listWorkspaces()
                workspaces = listedWorkspaces
            } catch {
                print("⚠️ Clicky: failed to refresh workspaces: \(error)")
            }
        }
    }

    /// Reloads the brain authentication status from the sidecar. Errors are
    /// swallowed into a printed log so the panel just shows stale data.
    func refreshBrainAuthStatus() {
        Task {
            do {
                let latestBrainAuthStatus = try await sidecarManager.checkAuthStatus()
                brainAuthStatus = latestBrainAuthStatus
            } catch {
                print("⚠️ Clicky: failed to refresh brain auth status: \(error)")
            }
        }
    }

    func resetCurrentConversation() {
        Task {
            do {
                let didReset = try await sidecarManager.resetSession(
                    backend: selectedBackend,
                    workspaceId: selectedWorkspaceId
                )
                if didReset {
                    print("🧠 Clicky: reset \(selectedBackend) conversation for workspace \(selectedWorkspaceId)")
                }
            } catch {
                print("⚠️ Clicky: failed to reset \(selectedBackend) conversation for workspace \(selectedWorkspaceId): \(error)")
            }
        }
    }

    func openTerminalToSignIn(backend: String) {
        let loginCommand = backend == "codex" ? "codex login" : "claude"
        let appleScriptSource = """
        tell application "Terminal"
            activate
            do script "\(loginCommand)"
        end tell
        """

        var errorInfo: NSDictionary?
        NSAppleScript(source: appleScriptSource)?.executeAndReturnError(&errorInfo)
        if let errorInfo {
            print("⚠️ Clicky: failed to open Terminal sign-in helper: \(errorInfo)")
        }
    }

    /// Asks the brain to author the next lesson for the currently selected
    /// topic, based on the learner's records. Only meaningful in a real topic
    /// workspace, so the general workspace is ignored.
    func requestNextLesson() {
        guard selectedWorkspaceId != "general" else { return }
        sendTranscriptToClaudeWithScreenshot(
            transcript: "create the next lesson for me based on my learning records",
            teachIntent: true
        )
    }

    private var selectedModelAlias: String {
        selectedModel.contains("opus") ? "opus" : "sonnet"
    }

    /// User preference for whether the Clicky cursor should be shown.
    /// When toggled off, the overlay is hidden and push-to-talk is disabled.
    /// Persisted to UserDefaults so the choice survives app restarts.
    @Published var isClickyCursorEnabled: Bool = UserDefaults.standard.object(forKey: "isClickyCursorEnabled") == nil
        ? true
        : UserDefaults.standard.bool(forKey: "isClickyCursorEnabled")

    func setClickyCursorEnabled(_ enabled: Bool) {
        isClickyCursorEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "isClickyCursorEnabled")
        transientHideTask?.cancel()
        transientHideTask = nil

        if enabled {
            overlayWindowManager.hasShownOverlayBefore = true
            overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
            isOverlayVisible = true
        } else {
            overlayWindowManager.hideOverlay()
            isOverlayVisible = false
        }
    }

    /// Whether the user has completed onboarding at least once. Persisted
    /// to UserDefaults so the Start button only appears on first launch.
    var hasCompletedOnboarding: Bool {
        get { UserDefaults.standard.bool(forKey: "hasCompletedOnboarding") }
        set { UserDefaults.standard.set(newValue, forKey: "hasCompletedOnboarding") }
    }

    func start() {
        refreshAllPermissions()
        print("🔑 Clicky start — accessibility: \(hasAccessibilityPermission), screen: \(hasScreenRecordingPermission), mic: \(hasMicrophonePermission), screenContent: \(hasScreenContentPermission), onboarded: \(hasCompletedOnboarding)")
        startPermissionPolling()
        bindVoiceStateObservation()
        bindAudioPowerLevel()
        bindShortcutTransitions()
        ScreenshotFileStore.sweepStaleCaptures()

        // When the brain writes a new lesson, open it in the user's default
        // editor unless the agent already opened it itself, then refresh the
        // topic list so its lesson count updates in the panel.
        sidecarManager.onLessonCreated = { [weak self] lesson in
            guard let self else { return }
            if lesson.openedByAgent == false {
                NSWorkspace.shared.open(URL(fileURLWithPath: lesson.path))
            }
            self.refreshWorkspaces()
        }

        markOnboardingCompleteIfPermissionsReady()

        // If the user has completed setup AND all permissions are still granted,
        // show the cursor overlay immediately. If permissions were revoked (e.g.
        // signing change), don't show the cursor — the panel will show the
        // permissions UI instead.
        if hasCompletedOnboarding && allPermissionsGranted && isClickyCursorEnabled {
            overlayWindowManager.hasShownOverlayBefore = true
            overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
            isOverlayVisible = true
        }
    }

    func clearDetectedElementLocation() {
        detectedElementScreenLocation = nil
        detectedElementDisplayFrame = nil
        detectedElementBubbleText = nil
    }

    func stop() {
        globalPushToTalkShortcutMonitor.stop()
        buddyDictationManager.cancelCurrentDictation()
        overlayWindowManager.hideOverlay()
        transientHideTask?.cancel()

        currentResponseTask?.cancel()
        currentResponseTask = nil
        shortcutTransitionCancellable?.cancel()
        voiceStateCancellable?.cancel()
        audioPowerCancellable?.cancel()
        accessibilityCheckTimer?.invalidate()
        accessibilityCheckTimer = nil
    }

    func refreshAllPermissions() {
        let previouslyHadAccessibility = hasAccessibilityPermission
        let previouslyHadScreenRecording = hasScreenRecordingPermission
        let previouslyHadMicrophone = hasMicrophonePermission
        let previouslyHadSpeechRecognition = hasSpeechRecognitionPermission
        let previouslyHadAll = allPermissionsGranted

        let currentlyHasAccessibility = WindowPositionManager.hasAccessibilityPermission()
        hasAccessibilityPermission = currentlyHasAccessibility

        if currentlyHasAccessibility {
            globalPushToTalkShortcutMonitor.start()
        } else {
            globalPushToTalkShortcutMonitor.stop()
        }

        hasScreenRecordingPermission = WindowPositionManager.hasScreenRecordingPermission()

        let micAuthStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        hasMicrophonePermission = micAuthStatus == .authorized
        hasSpeechRecognitionPermission = SFSpeechRecognizer.authorizationStatus() == .authorized

        // Debug: log permission state on changes
        if previouslyHadAccessibility != hasAccessibilityPermission
            || previouslyHadScreenRecording != hasScreenRecordingPermission
            || previouslyHadMicrophone != hasMicrophonePermission
            || previouslyHadSpeechRecognition != hasSpeechRecognitionPermission {
            print("🔑 Permissions — accessibility: \(hasAccessibilityPermission), screen: \(hasScreenRecordingPermission), mic: \(hasMicrophonePermission), speech: \(hasSpeechRecognitionPermission), screenContent: \(hasScreenContentPermission)")
        }

        // Track individual permission grants as they happen
        if !previouslyHadAccessibility && hasAccessibilityPermission {
            ClickyAnalytics.trackPermissionGranted(permission: "accessibility")
        }
        if !previouslyHadScreenRecording && hasScreenRecordingPermission {
            ClickyAnalytics.trackPermissionGranted(permission: "screen_recording")
        }
        if !previouslyHadMicrophone && hasMicrophonePermission {
            ClickyAnalytics.trackPermissionGranted(permission: "microphone")
        }
        // Screen content permission is persisted — once the user has approved the
        // SCShareableContent picker, we don't need to re-check it.
        if !hasScreenContentPermission {
            hasScreenContentPermission = UserDefaults.standard.bool(forKey: "hasScreenContentPermission")
        }

        if !previouslyHadAll && allPermissionsGranted {
            ClickyAnalytics.trackAllPermissionsGranted()
        }

        markOnboardingCompleteIfPermissionsReady()
    }

    /// Triggers the macOS screen content picker by performing a dummy
    /// screenshot capture. Once the user approves, we persist the grant
    /// so they're never asked again during onboarding.
    @Published private(set) var isRequestingScreenContent = false

    func requestScreenContentPermission() {
        guard !isRequestingScreenContent else { return }
        isRequestingScreenContent = true
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else {
                    await MainActor.run { isRequestingScreenContent = false }
                    return
                }
                let filter = SCContentFilter(display: display, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.width = 320
                config.height = 240
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                // Verify the capture actually returned real content — a 0x0 or
                // fully-empty image means the user denied the prompt.
                let didCapture = image.width > 0 && image.height > 0
                print("🔑 Screen content capture result — width: \(image.width), height: \(image.height), didCapture: \(didCapture)")
                await MainActor.run {
                    isRequestingScreenContent = false
                    guard didCapture else { return }
                    hasScreenContentPermission = true
                    UserDefaults.standard.set(true, forKey: "hasScreenContentPermission")
                    ClickyAnalytics.trackPermissionGranted(permission: "screen_content")

                    markOnboardingCompleteIfPermissionsReady()

                    if hasCompletedOnboarding && allPermissionsGranted && !isOverlayVisible && isClickyCursorEnabled {
                        overlayWindowManager.hasShownOverlayBefore = true
                        overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
                        isOverlayVisible = true
                    }
                }
            } catch {
                print("⚠️ Screen content permission request failed: \(error)")
                await MainActor.run { isRequestingScreenContent = false }
            }
        }
    }

    // MARK: - Private

    /// Triggers the system microphone prompt if the user has never been asked.
    /// Once granted/denied the status sticks and polling picks it up.
    private func promptForMicrophoneIfNotDetermined() {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined else { return }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            Task { @MainActor [weak self] in
                self?.hasMicrophonePermission = granted
            }
        }
    }

    /// Polls all permissions frequently so the UI updates live after the
    /// user grants them in System Settings. Screen Recording is the exception —
    /// macOS requires an app restart for that one to take effect.
    private func startPermissionPolling() {
        accessibilityCheckTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refreshAllPermissions()
            }
        }
    }

    private func markOnboardingCompleteIfPermissionsReady() {
        guard allPermissionsGranted, !hasCompletedOnboarding else { return }
        hasCompletedOnboarding = true
    }

    private func bindAudioPowerLevel() {
        audioPowerCancellable = buddyDictationManager.$currentAudioPowerLevel
            .receive(on: DispatchQueue.main)
            .sink { [weak self] powerLevel in
                self?.currentAudioPowerLevel = powerLevel
            }
    }

    private func bindVoiceStateObservation() {
        voiceStateCancellable = buddyDictationManager.$isRecordingFromKeyboardShortcut
            .combineLatest(
                buddyDictationManager.$isFinalizingTranscript,
                buddyDictationManager.$isPreparingToRecord
            )
            .receive(on: DispatchQueue.main)
            .sink { [weak self] isRecording, isFinalizing, isPreparing in
                guard let self else { return }
                // Don't override .responding — the AI response pipeline
                // manages that state directly until streaming finishes.
                guard self.voiceState != .responding else { return }

                if isFinalizing {
                    self.voiceState = .processing
                } else if isRecording {
                    self.voiceState = .listening
                } else if isPreparing {
                    self.voiceState = .processing
                } else {
                    self.voiceState = .idle
                    // If the user pressed and released the hotkey without
                    // saying anything, no response task runs — schedule the
                    // transient hide here so the overlay doesn't get stuck.
                    // Only do this when no response is in flight, otherwise
                    // the brief idle gap between recording and processing
                    // would prematurely hide the overlay.
                    if self.currentResponseTask == nil {
                        self.scheduleTransientHideIfNeeded()
                    }
                }
            }
    }

    private func bindShortcutTransitions() {
        shortcutTransitionCancellable = globalPushToTalkShortcutMonitor
            .shortcutTransitionPublisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] transition in
                self?.handleShortcutTransition(transition)
            }
    }

    private func handleShortcutTransition(_ transition: BuddyPushToTalkShortcut.ShortcutTransition) {
        switch transition {
        case .pressed:
            guard !buddyDictationManager.isDictationInProgress else { return }

            // Cancel any pending transient hide so the overlay stays visible
            transientHideTask?.cancel()
            transientHideTask = nil

            // If the cursor is hidden, bring it back transiently for this interaction
            if !isClickyCursorEnabled && !isOverlayVisible {
                overlayWindowManager.hasShownOverlayBefore = true
                overlayWindowManager.showOverlay(onScreens: NSScreen.screens, companionManager: self)
                isOverlayVisible = true
            }

            // Dismiss the menu bar panel so it doesn't cover the screen
            NotificationCenter.default.post(name: .clickyDismissPanel, object: nil)

            // Cancel any in-progress response and TTS from a previous utterance
            currentResponseTask?.cancel()
            textToSpeechClient.stopPlayback()
            clearDetectedElementLocation()

            ClickyAnalytics.trackPushToTalkStarted()

            pendingKeyboardShortcutStartTask?.cancel()
            pendingKeyboardShortcutStartTask = Task {
                await buddyDictationManager.startPushToTalkFromKeyboardShortcut(
                    currentDraftText: "",
                    updateDraftText: { _ in
                        // Partial transcripts are hidden (waveform-only UI)
                    },
                    submitDraftText: { [weak self] finalTranscript in
                        self?.lastTranscript = finalTranscript
                        print("🗣️ Companion received transcript: \(finalTranscript)")
                        ClickyAnalytics.trackUserMessageSent(transcript: finalTranscript)
                        self?.sendTranscriptToClaudeWithScreenshot(transcript: finalTranscript)
                    }
                )
            }
        case .released:
            // Cancel the pending start task in case the user released the shortcut
            // before the async startPushToTalk had a chance to begin recording.
            // Without this, a quick press-and-release drops the release event and
            // leaves the waveform overlay stuck on screen indefinitely.
            ClickyAnalytics.trackPushToTalkReleased()
            pendingKeyboardShortcutStartTask?.cancel()
            pendingKeyboardShortcutStartTask = nil
            buddyDictationManager.stopPushToTalkFromKeyboardShortcut()
        case .none:
            break
        }
    }

    // MARK: - AI Response Pipeline

    /// Captures a screenshot, sends it along with the transcript to the brain,
    /// and plays the response aloud via TTS. The cursor stays in
    /// the spinner/processing state until TTS audio begins playing.
    /// The brain response may include a [POINT:x,y:label] tag which triggers
    /// the buddy to fly to that element on screen.
    private func sendTranscriptToClaudeWithScreenshot(transcript: String, teachIntent: Bool = false) {
        currentResponseTask?.cancel()
        textToSpeechClient.stopPlayback()

        // Reset the long-turn reassurance state for the new turn.
        longTurnAcknowledgementTask?.cancel()
        longTurnAcknowledgementTask = nil
        hasScheduledLongTurnAcknowledgementForCurrentTurn = false

        currentResponseTask = Task {
            // Stay in processing (spinner) state — no streaming text displayed
            voiceState = .processing

            // A fresh turn is starting, so clear any auth failure the panel was
            // surfacing from the previous turn — this turn will re-prove auth.
            authRequiredPanelMessage = nil

            do {
                // Capture all connected screens so the AI has full context
                let screenCaptures = try await CompanionScreenCaptureUtility.captureAllScreensAsJPEG()

                guard !Task.isCancelled else { return }

                // Build image labels with the actual screenshot pixel dimensions
                // so the brain coordinate space matches the image it sees. We
                // scale from screenshot pixels to display points ourselves.
                let labeledImages = screenCaptures.map { capture in
                    let dimensionInfo = " (image dimensions: \(capture.screenshotWidthInPixels)x\(capture.screenshotHeightInPixels) pixels)"
                    return (data: capture.imageData, label: capture.label + dimensionInfo)
                }

                let fullResponseText = try await brain.respond(
                    transcript: transcript,
                    images: labeledImages,
                    backend: selectedBackend,
                    model: selectedBackend == "codex" ? selectedCodexModel : selectedModelAlias,
                    effort: selectedBackend == "codex" ? selectedCodexEffort : selectedClaudeEffort,
                    workspaceId: selectedWorkspaceId,
                    teachIntent: teachIntent,
                    onStatus: { [weak self] brainStatus in
                        // On the first tool-use of a turn, arm the long-turn
                        // spoken reassurance so quiet, slow turns don't feel dead.
                        if case .usingTool = brainStatus {
                            self?.scheduleLongTurnAcknowledgementIfNeeded()
                        }
                    }
                )

                // The turn produced its result — stand down the long-turn
                // reassurance so it never speaks over the real response.
                longTurnAcknowledgementTask?.cancel()
                longTurnAcknowledgementTask = nil

                guard !Task.isCancelled else { return }

                // Parse an optional trailing [TEACH:...] tag first, then run the
                // existing [POINT:...] parsing on the tag-stripped text.
                let teachParseResult = Self.parseTeachIntent(from: fullResponseText)
                let parseResult = Self.parsePointingCoordinates(from: teachParseResult.cleanedText)
                let spokenText = parseResult.spokenText

                // Handle element pointing if the brain returned coordinates.
                // Switch to idle BEFORE setting the location so the triangle
                // becomes visible and can fly to the target. Without this, the
                // spinner hides the triangle and the flight animation is invisible.
                let hasPointCoordinate = parseResult.coordinate != nil
                if hasPointCoordinate {
                    voiceState = .idle
                }

                // Pick the screen capture matching the brain's screen number,
                // falling back to the cursor screen if not specified.
                let targetScreenCapture: CompanionScreenCapture? = {
                    if let screenNumber = parseResult.screenNumber,
                       screenNumber >= 1 && screenNumber <= screenCaptures.count {
                        return screenCaptures[screenNumber - 1]
                    }
                    return screenCaptures.first(where: { $0.isCursorScreen })
                }()

                if let pointCoordinate = parseResult.coordinate,
                   let targetScreenCapture {
                    // Brain coordinates are in the screenshot's pixel space
                    // (top-left origin, e.g. 1280x831). Scale to the display's
                    // point space (e.g. 1512x982), then convert to AppKit global coords.
                    let screenshotWidth = CGFloat(targetScreenCapture.screenshotWidthInPixels)
                    let screenshotHeight = CGFloat(targetScreenCapture.screenshotHeightInPixels)
                    let displayWidth = CGFloat(targetScreenCapture.displayWidthInPoints)
                    let displayHeight = CGFloat(targetScreenCapture.displayHeightInPoints)
                    let displayFrame = targetScreenCapture.displayFrame

                    // Clamp to screenshot coordinate space
                    let clampedX = max(0, min(pointCoordinate.x, screenshotWidth))
                    let clampedY = max(0, min(pointCoordinate.y, screenshotHeight))

                    // Scale from screenshot pixels to display points
                    let displayLocalX = clampedX * (displayWidth / screenshotWidth)
                    let displayLocalY = clampedY * (displayHeight / screenshotHeight)

                    // Convert from top-left origin (screenshot) to bottom-left origin (AppKit)
                    let appKitY = displayHeight - displayLocalY

                    // Convert display-local coords to global screen coords
                    let globalLocation = CGPoint(
                        x: displayLocalX + displayFrame.origin.x,
                        y: appKitY + displayFrame.origin.y
                    )

                    detectedElementScreenLocation = globalLocation
                    detectedElementDisplayFrame = displayFrame
                    ClickyAnalytics.trackElementPointed(elementLabel: parseResult.elementLabel)
                    print("🎯 Element pointing: (\(Int(pointCoordinate.x)), \(Int(pointCoordinate.y))) → \"\(parseResult.elementLabel ?? "element")\"")
                } else {
                    print("🎯 Element pointing: \(parseResult.elementLabel ?? "no element")")
                }

                ClickyAnalytics.trackAIResponseReceived(response: spokenText)

                // Play the response via TTS. Keep the spinner (processing state)
                // until the audio actually starts playing, then switch to responding.
                if !spokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    do {
                        try await textToSpeechClient.speakText(spokenText)
                        // speakText returns after player.play() — audio is now playing
                        voiceState = .responding
                    } catch {
                        ClickyAnalytics.trackTTSError(error: error.localizedDescription)
                        print("⚠️ Companion TTS error: \(error)")
                        speakGenericErrorFallback()
                    }
                }

                // If the brain signalled a "teach me this over time" intent,
                // spin up (or reuse) the topic workspace and kick off the first
                // lesson turn now that the acknowledgement is being spoken.
                if let teachTopicName = teachParseResult.topicName {
                    await beginTeachingTopic(teachTopicName)
                }
            } catch is CancellationError {
                // User spoke again — response was interrupted
                longTurnAcknowledgementTask?.cancel()
                longTurnAcknowledgementTask = nil
            } catch {
                longTurnAcknowledgementTask?.cancel()
                longTurnAcknowledgementTask = nil
                ClickyAnalytics.trackResponseError(error: error.localizedDescription)
                print("⚠️ Companion response error: \(error)")
                speakFallbackMessage(forTurnError: error)
            }

            if !Task.isCancelled {
                voiceState = .idle
                scheduleTransientHideIfNeeded()
            }
        }
    }

    /// Arms a one-time spoken reassurance for turns that run long. Called on the
    /// first tool-use status of a turn; guarded so repeated tool events don't
    /// schedule it more than once. Waits 8 seconds and, only if the turn is
    /// still running (task not cancelled), speaks a single reassuring line. This
    /// deliberately does NOT change voiceState — the processing spinner stays.
    private func scheduleLongTurnAcknowledgementIfNeeded() {
        guard !hasScheduledLongTurnAcknowledgementForCurrentTurn else { return }
        hasScheduledLongTurnAcknowledgementForCurrentTurn = true

        longTurnAcknowledgementTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard let self, !Task.isCancelled else { return }
            do {
                try await self.textToSpeechClient.speakText("on it — this one can take a minute or two")
            } catch {
                print("⚠️ Companion long-turn acknowledgement TTS error: \(error)")
            }
        }
    }

    /// Creates (or reuses) the learning workspace for the requested topic, makes
    /// it the active workspace, then kicks off the first lesson turn. The sidecar
    /// dedupes by slug, so an existing topic folder is reused as-is. Any failure
    /// falls back to the generic spoken error.
    private func beginTeachingTopic(_ topicName: String) async {
        do {
            let workspace = try await sidecarManager.createWorkspace(name: topicName)
            setSelectedWorkspaceId(workspace.id)

            // Let the spoken acknowledgement finish before starting the lesson
            // turn — starting a turn stops TTS playback, which would cut the
            // acknowledgement off mid-sentence. Bail out if the user speaks
            // again while we wait (this task gets cancelled).
            while textToSpeechClient.isPlaying {
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard !Task.isCancelled else { return }
            }
            guard !Task.isCancelled else { return }

            // Pass just the topic, exactly like typing `/teach <topic>` in a
            // terminal. The skill itself decides what happens next: with an
            // empty MISSION.md it interviews the user first (spoken aloud,
            // answered by voice in this same session) rather than jumping
            // straight to a lesson.
            sendTranscriptToClaudeWithScreenshot(
                transcript: topicName,
                teachIntent: true
            )
        } catch {
            print("⚠️ Companion teach-start error: \(error)")
            speakFallbackMessage(forTurnError: error)
        }
    }

    /// If the cursor is in transient mode (user toggled "Show Clicky" off),
    /// waits for TTS playback and any pointing animation to finish, then
    /// fades out the overlay after a 1-second pause. Cancelled automatically
    /// if the user starts another push-to-talk interaction.
    private func scheduleTransientHideIfNeeded() {
        guard !isClickyCursorEnabled && isOverlayVisible else { return }

        transientHideTask?.cancel()
        transientHideTask = Task {
            // Wait for TTS audio to finish playing
            while textToSpeechClient.isPlaying {
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard !Task.isCancelled else { return }
            }

            // Wait for pointing animation to finish (location is cleared
            // when the buddy flies back to the cursor)
            while detectedElementScreenLocation != nil {
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard !Task.isCancelled else { return }
            }

            // Pause 1s after everything finishes, then fade out
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }
            overlayWindowManager.fadeOutAndHideOverlay()
            isOverlayVisible = false
        }
    }

    /// Picks the right spoken fallback for a failed brain turn. Auth failures
    /// need actionable guidance rather than the generic "something went wrong"
    /// line — the sidecar signals them with a `SidecarRequestError` whose code
    /// is "auth_required" (subscription login missing or expired), so we detect
    /// that specific case and tell the user exactly how to sign back in. Every
    /// other error falls through to the generic fallback.
    private func speakFallbackMessage(forTurnError error: Error) {
        guard
            let sidecarError = error as? SidecarRequestError,
            sidecarError.code == "auth_required"
        else {
            speakGenericErrorFallback()
            return
        }

        // Prefer the backend the sidecar attributed the failure to; fall back
        // to whichever backend the user currently has selected in the panel.
        let backend = sidecarError.backend ?? selectedBackend
        let utterance: String
        // Written-form panel copy (shown, not spoken) that overrides the
        // optimistic "Signed in" auth row for this backend until the next turn.
        let panelMessage: String
        if backend == "codex" {
            utterance = "your codex sign-in is missing or expired. run codex login in a terminal, then try again."
            panelMessage = "Sign-in expired — run `codex login` in Terminal"
        } else {
            utterance = "your claude sign-in is missing or expired. run claude in a terminal, sign in, then try again."
            panelMessage = "Sign-in expired — run `claude` in Terminal"
        }
        authRequiredPanelMessage = (backend: backend, message: panelMessage)

        let synthesizer = NSSpeechSynthesizer()
        synthesizer.startSpeaking(utterance)
        voiceState = .responding

        // Refresh the panel's per-backend sign-in row so it reflects the
        // missing/expired login the user just heard about.
        refreshBrainAuthStatus()
    }

    /// Speaks a hardcoded error message using macOS system TTS when the
    /// primary response path fails.
    private func speakGenericErrorFallback() {
        let utterance = "sorry, something went wrong. check the clicky panel for details."
        let synthesizer = NSSpeechSynthesizer()
        synthesizer.startSpeaking(utterance)
        voiceState = .responding
    }

    // MARK: - Point Tag Parsing

    /// Result of parsing a [POINT:...] tag from the brain response.
    struct PointingParseResult {
        /// The response text with the [POINT:...] tag removed — this is what gets spoken.
        let spokenText: String
        /// The parsed pixel coordinate, or nil if the brain said "none" or no tag was found.
        let coordinate: CGPoint?
        /// Short label describing the element (e.g. "run button"), or "none".
        let elementLabel: String?
        /// Which screen the coordinate refers to (1-based), or nil to default to cursor screen.
        let screenNumber: Int?
    }

    /// Parses a [POINT:x,y:label:screenN] or [POINT:none] tag from the end of the brain response.
    /// Returns the spoken text (tag removed) and the optional coordinate + label + screen number.
    static func parsePointingCoordinates(from responseText: String) -> PointingParseResult {
        // Match [POINT:none] or [POINT:123,456:label] or [POINT:123,456:label:screen2]
        let pattern = #"\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]\s*$"#

        guard let regex = try? NSRegularExpression(pattern: pattern, options: []),
              let match = regex.firstMatch(in: responseText, range: NSRange(responseText.startIndex..., in: responseText)) else {
            // No tag found at all
            return PointingParseResult(spokenText: responseText, coordinate: nil, elementLabel: nil, screenNumber: nil)
        }

        // Remove the tag from the spoken text
        let tagRange = Range(match.range, in: responseText)!
        let spokenText = String(responseText[..<tagRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)

        // Check if it's [POINT:none]
        guard match.numberOfRanges >= 3,
              let xRange = Range(match.range(at: 1), in: responseText),
              let yRange = Range(match.range(at: 2), in: responseText),
              let x = Double(responseText[xRange]),
              let y = Double(responseText[yRange]) else {
            return PointingParseResult(spokenText: spokenText, coordinate: nil, elementLabel: "none", screenNumber: nil)
        }

        var elementLabel: String? = nil
        if match.numberOfRanges >= 4, let labelRange = Range(match.range(at: 3), in: responseText) {
            elementLabel = String(responseText[labelRange]).trimmingCharacters(in: .whitespaces)
        }

        var screenNumber: Int? = nil
        if match.numberOfRanges >= 5, let screenRange = Range(match.range(at: 4), in: responseText) {
            screenNumber = Int(responseText[screenRange])
        }

        return PointingParseResult(
            spokenText: spokenText,
            coordinate: CGPoint(x: x, y: y),
            elementLabel: elementLabel,
            screenNumber: screenNumber
        )
    }

    // MARK: - Teach Tag Parsing

    /// Parses an optional trailing [TEACH:topic name] tag from the brain
    /// response. The sidecar appends this at the very END of a response (after
    /// any [POINT:...] tag) when the user asks to learn a topic over time.
    /// Returns the response text with the tag stripped plus the extracted topic
    /// name, or nil when no teach tag is present.
    static func parseTeachIntent(from responseText: String) -> (cleanedText: String, topicName: String?) {
        // Match a trailing [TEACH:topic name] tag, tolerant of trailing whitespace.
        let pattern = #"\[TEACH:([^\]]+)\]\s*$"#

        guard let regex = try? NSRegularExpression(pattern: pattern, options: []),
              let match = regex.firstMatch(in: responseText, range: NSRange(responseText.startIndex..., in: responseText)),
              let tagRange = Range(match.range, in: responseText),
              let topicRange = Range(match.range(at: 1), in: responseText) else {
            // No teach tag found
            return (cleanedText: responseText, topicName: nil)
        }

        let cleanedText = String(responseText[..<tagRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        let topicName = String(responseText[topicRange]).trimmingCharacters(in: .whitespacesAndNewlines)

        return (cleanedText: cleanedText, topicName: topicName.isEmpty ? nil : topicName)
    }

}
