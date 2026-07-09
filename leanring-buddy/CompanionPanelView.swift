//
//  CompanionPanelView.swift
//  leanring-buddy
//
//  The SwiftUI content hosted inside the menu bar panel. Shows the companion
//  voice status, push-to-talk shortcut, and quick settings. Designed to feel
//  like Loom's recording panel — dark, rounded, minimal, and special.
//

import AVFoundation
import SwiftUI

struct CompanionPanelView: View {
    @ObservedObject var companionManager: CompanionManager

    /// Backends for which the user just tapped "Sign in" (which opens Terminal).
    /// Used to show the "finish in Terminal, then Re-check" hint only after the
    /// user has actually started a sign-in, rather than permanently.
    @State private var backendsAwaitingTerminalSignIn: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            panelHeader
            Divider()
                .background(DS.Colors.borderSubtle)
                .padding(.horizontal, 16)

            permissionsCopySection
                .padding(.top, 16)
                .padding(.horizontal, 16)

            if companionManager.hasCompletedOnboarding && companionManager.allPermissionsGranted {
                Spacer()
                    .frame(height: 12)

                brainSection
                    .padding(.horizontal, 16)
            }

            if !companionManager.allPermissionsGranted {
                Spacer()
                    .frame(height: 16)

                settingsSection
                    .padding(.horizontal, 16)
            }

            // Show Clicky toggle — hidden for now
            // if companionManager.hasCompletedOnboarding && companionManager.allPermissionsGranted {
            //     Spacer()
            //         .frame(height: 16)
            //
            //     showClickyCursorToggleRow
            //         .padding(.horizontal, 16)
            // }

            if companionManager.hasCompletedOnboarding && companionManager.allPermissionsGranted {
                Spacer()
                    .frame(height: 16)

                dmFarzaButton
                    .padding(.horizontal, 16)
            }

            Spacer()
                .frame(height: 12)

            Divider()
                .background(DS.Colors.borderSubtle)
                .padding(.horizontal, 16)

            footerSection
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
        }
        .frame(width: 320)
        .background(panelBackground)
        .onAppear {
            // Pull the latest brain sign-in state each time the panel opens so its
            // rows reflect reality without a manual refresh.
            companionManager.refreshBrainAuthStatus()
            // Re-read topics and lessons from disk so the lessons picker reflects
            // any lessons created while the panel was closed.
            companionManager.refreshLessonTopicListings()
            // Re-read connected microphones so the mic picker reflects devices
            // plugged in or removed while the panel was closed.
            companionManager.refreshAvailableMicrophones()
        }
    }

    // MARK: - Brain Section

    /// Groups the brain status and picker rows shown once the user is onboarded
    /// and fully permissioned. Order: status concerns first (sidecar health,
    /// account sign-in), then the pickers (backend, model, thinking), then the
    /// lessons section.
    private var brainSection: some View {
        VStack(spacing: 4) {
            sidecarStatusRow
            healthWarningsSection
            brainAuthSection
            backendPickerRow
            modelPickerRow
            thinkingPickerRow
            microphonePickerRow
            lessonsSection
        }
    }

    // MARK: - Header

    private var panelHeader: some View {
        HStack {
            HStack(spacing: 8) {
                // Animated status dot
                Circle()
                    .fill(statusDotColor)
                    .frame(width: 8, height: 8)
                    .shadow(color: statusDotColor.opacity(0.6), radius: 4)

                Text("OpenClicky")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(DS.Colors.textPrimary)
            }

            Spacer()

            Text(statusText)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textTertiary)

            Button(action: {
                NotificationCenter.default.post(name: .clickyDismissPanel, object: nil)
            }) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 20, height: 20)
                    .background(
                        Circle()
                            .fill(Color.white.opacity(0.08))
                    )
            }
            .buttonStyle(.plain)
            .pointerCursor()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    // MARK: - Permissions Copy

    @ViewBuilder
    private var permissionsCopySection: some View {
        if companionManager.hasCompletedOnboarding && companionManager.allPermissionsGranted {
            Text("Hold Control+Option to talk.")
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if companionManager.hasCompletedOnboarding {
            // Permissions were revoked after onboarding — tell user to re-grant
            VStack(alignment: .leading, spacing: 6) {
                Text("Permissions needed")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(DS.Colors.textSecondary)

                Text("Some permissions were revoked. Grant all four below to keep using Clicky.")
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("Hi, I'm Farza. This is Clicky.")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(DS.Colors.textSecondary)

                Text("A side project I made for fun to help me learn stuff as I use my computer.")
                    .font(.system(size: 11))
                    .foregroundColor(DS.Colors.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)

                Text("Nothing runs in the background. Clicky will only take a screenshot when you press the hot key. So, you can give that permission in peace. If you are still sus, eh, I can't do much there champ.")
                    .font(.system(size: 11))
                    .foregroundColor(Color(red: 0.9, green: 0.4, blue: 0.4))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Permissions

    private var settingsSection: some View {
        VStack(spacing: 2) {
            Text("PERMISSIONS")
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundColor(DS.Colors.textTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 6)

            microphonePermissionRow

            accessibilityPermissionRow

            screenRecordingPermissionRow

            if companionManager.hasScreenRecordingPermission {
                screenContentPermissionRow
            }

        }
    }

    private var accessibilityPermissionRow: some View {
        let isGranted = companionManager.hasAccessibilityPermission
        return HStack {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                Text("Accessibility")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            if isGranted {
                HStack(spacing: 4) {
                    Circle()
                        .fill(DS.Colors.success)
                        .frame(width: 6, height: 6)
                    Text("Granted")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.success)
                }
            } else {
                HStack(spacing: 6) {
                    Button(action: {
                        // Triggers the system accessibility prompt (AXIsProcessTrustedWithOptions)
                        // on first attempt, then opens System Settings on subsequent attempts.
                        WindowPositionManager.requestAccessibilityPermission()
                    }) {
                        Text("Grant")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(DS.Colors.textOnAccent)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(
                                Capsule()
                                    .fill(DS.Colors.accent)
                            )
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()

                    Button(action: {
                        // Reveals the app in Finder so the user can drag it into
                        // the Accessibility list if it doesn't appear automatically
                        // (common with unsigned dev builds).
                        WindowPositionManager.revealAppInFinder()
                        WindowPositionManager.openAccessibilitySettings()
                    }) {
                        Text("Find App")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(DS.Colors.textSecondary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(
                                Capsule()
                                    .stroke(DS.Colors.borderSubtle, lineWidth: 0.8)
                            )
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                }
            }
        }
        .padding(.vertical, 6)
    }

    private var screenRecordingPermissionRow: some View {
        let isGranted = companionManager.hasScreenRecordingPermission
        return HStack {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.dashed.badge.record")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                VStack(alignment: .leading, spacing: 1) {
                    Text("Screen Recording")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(DS.Colors.textSecondary)

                    Text(isGranted
                         ? "Only takes a screenshot when you use the hotkey"
                         : "Quit and reopen after granting")
                        .font(.system(size: 10))
                        .foregroundColor(DS.Colors.textTertiary)
                }
            }

            Spacer()

            if isGranted {
                HStack(spacing: 4) {
                    Circle()
                        .fill(DS.Colors.success)
                        .frame(width: 6, height: 6)
                    Text("Granted")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.success)
                }
            } else {
                Button(action: {
                    // Triggers the native macOS screen recording prompt on first
                    // attempt (auto-adds app to the list), then opens System Settings
                    // on subsequent attempts.
                    WindowPositionManager.requestScreenRecordingPermission()
                }) {
                    Text("Grant")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(DS.Colors.accent)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
        .padding(.vertical, 6)
    }

    private var screenContentPermissionRow: some View {
        let isGranted = companionManager.hasScreenContentPermission
        return HStack {
            HStack(spacing: 8) {
                Image(systemName: "eye")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                Text("Screen Content")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            if isGranted {
                HStack(spacing: 4) {
                    Circle()
                        .fill(DS.Colors.success)
                        .frame(width: 6, height: 6)
                    Text("Granted")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.success)
                }
            } else {
                Button(action: {
                    companionManager.requestScreenContentPermission()
                }) {
                    Text("Grant")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(DS.Colors.accent)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
        .padding(.vertical, 6)
    }

    private var microphonePermissionRow: some View {
        let isGranted = companionManager.hasMicrophonePermission
        return HStack {
            HStack(spacing: 8) {
                Image(systemName: "mic")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                Text("Microphone")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            if isGranted {
                HStack(spacing: 4) {
                    Circle()
                        .fill(DS.Colors.success)
                        .frame(width: 6, height: 6)
                    Text("Granted")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.success)
                }
            } else {
                Button(action: {
                    // Triggers the native macOS microphone permission dialog on
                    // first attempt. If already denied, opens System Settings.
                    let status = AVCaptureDevice.authorizationStatus(for: .audio)
                    if status == .notDetermined {
                        AVCaptureDevice.requestAccess(for: .audio) { _ in }
                    } else {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                }) {
                    Text("Grant")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(DS.Colors.accent)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
        .padding(.vertical, 6)
    }

    private func permissionRow(
        label: String,
        iconName: String,
        isGranted: Bool,
        settingsURL: String
    ) -> some View {
        HStack {
            HStack(spacing: 8) {
                Image(systemName: iconName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isGranted ? DS.Colors.textTertiary : DS.Colors.warning)
                    .frame(width: 16)

                Text(label)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            if isGranted {
                HStack(spacing: 4) {
                    Circle()
                        .fill(DS.Colors.success)
                        .frame(width: 6, height: 6)
                    Text("Granted")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.success)
                }
            } else {
                Button(action: {
                    if let url = URL(string: settingsURL) {
                        NSWorkspace.shared.open(url)
                    }
                }) {
                    Text("Grant")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(DS.Colors.textOnAccent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule()
                                .fill(DS.Colors.accent)
                        )
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }
        }
        .padding(.vertical, 6)
    }



    // MARK: - Show Clicky Cursor Toggle

    private var showClickyCursorToggleRow: some View {
        HStack {
            HStack(spacing: 8) {
                Image(systemName: "cursorarrow")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 16)

                Text("Show Clicky")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            Toggle("", isOn: Binding(
                get: { companionManager.isClickyCursorEnabled },
                set: { companionManager.setClickyCursorEnabled($0) }
            ))
            .toggleStyle(.switch)
            .labelsHidden()
            .tint(DS.Colors.accent)
            .scaleEffect(0.8)
        }
        .padding(.vertical, 4)
    }

    private var speechToTextProviderRow: some View {
        HStack {
            HStack(spacing: 8) {
                Image(systemName: "mic.badge.waveform")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .frame(width: 16)

                Text("Speech to Text")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)
            }

            Spacer()

            Text(companionManager.buddyDictationManager.transcriptionProviderDisplayName)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(DS.Colors.textTertiary)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Model & Thinking Pickers

    /// The "Model" row. Both backends render an identical-geometry segmented row;
    /// only the option set and the bound selection differ per backend.
    @ViewBuilder
    private var modelPickerRow: some View {
        if companionManager.selectedBackend == "codex" {
            segmentedPickerRow(
                label: "Model",
                options: [
                    (displayName: "Default", value: "default"),
                    (displayName: "GPT-5.5", value: "gpt-5.5"),
                    (displayName: "Codex", value: "gpt-5.5-codex")
                ],
                selectedValue: companionManager.selectedCodexModel,
                onSelect: { companionManager.setSelectedCodexModel($0) }
            )
        } else {
            segmentedPickerRow(
                label: "Model",
                options: [
                    (displayName: "Sonnet", value: "claude-sonnet-4-6"),
                    (displayName: "Opus", value: "claude-opus-4-6")
                ],
                selectedValue: companionManager.selectedModel,
                onSelect: { companionManager.setSelectedModel($0) }
            )
        }
    }

    /// The "Thinking" (reasoning-effort) row. Claude tops out at "Max", Codex at
    /// "XHigh"; both render four options in the same segmented geometry.
    @ViewBuilder
    private var thinkingPickerRow: some View {
        if companionManager.selectedBackend == "codex" {
            segmentedPickerRow(
                label: "Thinking",
                options: [
                    (displayName: "Low", value: "low"),
                    (displayName: "Med", value: "medium"),
                    (displayName: "High", value: "high"),
                    (displayName: "XHigh", value: "xhigh")
                ],
                selectedValue: companionManager.selectedCodexEffort,
                onSelect: { companionManager.setSelectedCodexEffort($0) }
            )
        } else {
            segmentedPickerRow(
                label: "Thinking",
                options: [
                    (displayName: "Low", value: "low"),
                    (displayName: "Med", value: "medium"),
                    (displayName: "High", value: "high"),
                    (displayName: "Max", value: "max")
                ],
                selectedValue: companionManager.selectedClaudeEffort,
                onSelect: { companionManager.setSelectedClaudeEffort($0) }
            )
        }
    }

    /// A generic segmented-control row: a label on the left and a pill of
    /// mutually exclusive options on the right. Shared by the model and thinking
    /// rows on both backends so every row has identical geometry.
    private func segmentedPickerRow(
        label: String,
        options: [(displayName: String, value: String)],
        selectedValue: String,
        onSelect: @escaping (String) -> Void
    ) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)

            Spacer()

            HStack(spacing: 0) {
                ForEach(options, id: \.value) { option in
                    segmentedOptionButton(
                        displayName: option.displayName,
                        value: option.value,
                        selectedValue: selectedValue,
                        optionCount: options.count,
                        onSelect: onSelect
                    )
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.white.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(DS.Colors.borderSubtle, lineWidth: 0.5)
            )
        }
        .padding(.vertical, 4)
    }

    private func segmentedOptionButton(
        displayName: String,
        value: String,
        selectedValue: String,
        optionCount: Int,
        onSelect: @escaping (String) -> Void
    ) -> some View {
        let isSelected = selectedValue == value
        // Four options must share one row, so tighten the horizontal padding when
        // the control is crowded while keeping two/three-option rows roomy like
        // the other segmented pickers in the panel.
        let horizontalPadding: CGFloat = optionCount >= 4 ? 7 : 10
        return Button(action: {
            onSelect(value)
        }) {
            Text(displayName)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(isSelected ? DS.Colors.textPrimary : DS.Colors.textTertiary)
                .padding(.horizontal, horizontalPadding)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(isSelected ? Color.white.opacity(0.1) : Color.clear)
                )
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }

    // MARK: - Microphone Picker

    /// The "Microphone" row. Lets the user pin a specific input device so macOS
    /// can't silently route push-to-talk capture through AirPods (which forces
    /// the awful-sounding Bluetooth HFP codec). "System default" keeps the OS
    /// behaviour. Styled to match the Model / Thinking rows: a 13pt label on the
    /// left and a borderless menu control on the right.
    private var microphonePickerRow: some View {
        HStack {
            Text("Microphone")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)

            Spacer()

            microphoneMenu
        }
        .padding(.vertical, 4)
    }

    /// The display name shown on the menu's label: the pinned microphone's name
    /// when one is selected and still connected, "System default" when nothing is
    /// pinned, and an explicit unavailable notice when the pinned microphone is
    /// currently disconnected (the pin stays persisted).
    private var selectedMicrophoneDisplayName: String {
        guard let selectedMicrophoneUID = companionManager.selectedMicrophoneUID else {
            return "System default"
        }
        let matchingMicrophone = companionManager.availableMicrophones
            .first { $0.id == selectedMicrophoneUID }
        // A pin exists but its device is not connected right now: be honest that
        // capture is falling back while the pin itself is still persisted — a
        // plain "System default" would misrepresent the pin as cleared.
        return matchingMicrophone?.displayName ?? "Unavailable — using system default"
    }

    /// Borderless menu mirroring the lessons menu's styling. Lists "System
    /// default" first (checkmark when nothing is pinned) then every connected
    /// microphone (checkmark on the pinned one).
    private var microphoneMenu: some View {
        Menu {
            Button {
                companionManager.setSelectedMicrophoneUID(nil)
            } label: {
                if companionManager.selectedMicrophoneUID == nil {
                    Label("System default", systemImage: "checkmark")
                } else {
                    Text("System default")
                }
            }

            ForEach(companionManager.availableMicrophones) { microphone in
                Button {
                    companionManager.setSelectedMicrophoneUID(microphone.id)
                } label: {
                    if companionManager.selectedMicrophoneUID == microphone.id {
                        Label(microphone.displayName, systemImage: "checkmark")
                    } else {
                        Text(microphone.displayName)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(selectedMicrophoneDisplayName)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(DS.Colors.textPrimary)
                    .lineLimit(1)

                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(DS.Colors.textTertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.white.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(DS.Colors.borderSubtle, lineWidth: 0.5)
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .pointerCursor()
    }

    // MARK: - Backend Picker

    private var backendPickerRow: some View {
        HStack {
            Text("Brain")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(DS.Colors.textSecondary)

            Spacer()

            HStack(spacing: 0) {
                backendOptionButton(label: "Claude", backendID: "claude")
                backendOptionButton(label: "Codex", backendID: "codex")
            }
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.white.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(DS.Colors.borderSubtle, lineWidth: 0.5)
            )
        }
        .padding(.vertical, 4)
    }

    private func backendOptionButton(label: String, backendID: String) -> some View {
        let isSelected = companionManager.selectedBackend == backendID
        return Button(action: {
            companionManager.setSelectedBackend(backendID)
        }) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(isSelected ? DS.Colors.textPrimary : DS.Colors.textTertiary)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(isSelected ? Color.white.opacity(0.1) : Color.clear)
                )
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }

    // MARK: - Health Warnings

    /// Up to two single-line warning rows, each shown only when its condition is
    /// active. These surface silent failures the pickers can't fix — the
    /// push-to-talk tap failing to install, or speech recognition being denied.
    @ViewBuilder
    private var healthWarningsSection: some View {
        if !companionManager.isPushToTalkHealthy {
            healthWarningRow(
                message: "push-to-talk inactive — relaunch OpenClicky after granting Accessibility"
            )
        }
        // Only warn about speech recognition once the microphone is granted, so
        // this doesn't add noise during the initial onboarding permission flow.
        if companionManager.hasMicrophonePermission && !companionManager.hasSpeechRecognitionPermission {
            healthWarningRow(
                message: "speech recognition not granted — voice input may fail"
            )
        }
    }

    private func healthWarningRow(message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(DS.Colors.warning)

            Text(message)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(DS.Colors.warningText)
                .fixedSize(horizontal: false, vertical: true)

            Spacer()
        }
        .padding(.vertical, 4)
    }

    // MARK: - Brain Auth Status

    /// Sign-in state for both brain backends, always visible so the user can see
    /// at a glance which logins are ready. A single subtle "Re-check" affordance
    /// in the header re-runs the sidecar's auth probe for both rows at once.
    private var brainAuthSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Accounts")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundColor(DS.Colors.textTertiary)

                Spacer()

                Button(action: {
                    backendsAwaitingTerminalSignIn.removeAll()
                    companionManager.refreshBrainAuthStatus()
                }) {
                    Text("Re-check")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(DS.Colors.textTertiary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
            }

            brainAuthBackendRow(
                label: "Claude",
                backendID: "claude",
                isSignedIn: companionManager.brainAuthStatus?.claudeLoggedIn,
                usesApiKey: companionManager.brainAuthStatus?.claudeMethod == "api_key"
            )

            brainAuthBackendRow(
                label: "Codex",
                backendID: "codex",
                isSignedIn: companionManager.brainAuthStatus?.codexLoggedIn,
                usesApiKey: false
            )
        }
        .padding(.vertical, 4)
    }

    /// One labeled sign-in row: a colored dot (green signed-in / orange
    /// signed-out / neutral gray while the first probe is pending), the backend
    /// name, its status text, and — when signed out — a "Sign in" button that
    /// opens Terminal plus a follow-up hint to re-check afterward.
    private func brainAuthBackendRow(
        label: String,
        backendID: String,
        isSignedIn: Bool?,
        usesApiKey: Bool
    ) -> some View {
        // A turn that actually failed with "auth_required" is ground truth the
        // optimistic file-based check can't see, so treat that backend as signed
        // out regardless of what the file probe reported.
        let hasProvenAuthFailure = companionManager.authRequiredPanelMessage?.backend == backendID

        let dotColor: Color
        let statusText: String
        if hasProvenAuthFailure {
            dotColor = DS.Colors.warning
            statusText = "Not signed in"
        } else if let isSignedIn {
            dotColor = isSignedIn ? DS.Colors.success : DS.Colors.warning
            if isSignedIn {
                statusText = usesApiKey ? "Using API key" : "Signed in"
            } else {
                statusText = "Not signed in"
            }
        } else {
            dotColor = DS.Colors.textTertiary
            statusText = "Checking…"
        }

        let isSignedOut = hasProvenAuthFailure || isSignedIn == false

        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 6, height: 6)

                Text(label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)

                Text(statusText)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(DS.Colors.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer()

                if isSignedOut {
                    Button(action: {
                        companionManager.openTerminalToSignIn(backend: backendID)
                        backendsAwaitingTerminalSignIn.insert(backendID)
                    }) {
                        Text("Sign in")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(DS.Colors.textOnAccent)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(
                                Capsule()
                                    .fill(DS.Colors.accent)
                            )
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                }
            }

            if isSignedOut && backendsAwaitingTerminalSignIn.contains(backendID) {
                Text("finish in Terminal, then Re-check")
                    .font(.system(size: 10))
                    .foregroundColor(DS.Colors.textTertiary)
                    .padding(.leading, 12)
            }
        }
    }

    // MARK: - Sidecar Status

    /// Only rendered while the sidecar is not fully ready — a healthy sidecar
    /// shows nothing so the panel stays uncluttered. Lives in its own subview so
    /// it can observe the sidecar manager's published status directly.
    private var sidecarStatusRow: some View {
        SidecarStatusRow(sidecarManager: companionManager.sidecarManager)
    }

    // MARK: - Lessons

    /// A picker that lists every learning topic and its lessons; picking a lesson
    /// opens that lesson's HTML directly, and a final item still opens the full
    /// static dashboard. Topics are managed entirely by voice ("teach me …");
    /// lessons are found by navigation, not conversation.
    private var lessonsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Lessons")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(DS.Colors.textSecondary)

                Spacer()

                lessonsMenu
            }

            Text("say \"teach me …\" to start a topic")
                .font(.system(size: 10))
                .foregroundColor(DS.Colors.textTertiary)
        }
        .padding(.vertical, 4)
    }

    /// Borderless menu that mirrors the old topic picker's styling. Each topic is
    /// a nested submenu of its lessons; a divider then an "All lessons" item keeps
    /// the full dashboard reachable.
    private var lessonsMenu: some View {
        Menu {
            if companionManager.lessonTopicListings.isEmpty {
                Text("no lessons yet")
            } else {
                ForEach(companionManager.lessonTopicListings) { topic in
                    Menu(topic.displayName) {
                        ForEach(topic.lessons) { lesson in
                            Button(lesson.displayTitle) {
                                companionManager.openLesson(lesson)
                            }
                        }
                    }
                }
            }

            Divider()

            Button("All lessons (dashboard)") {
                companionManager.openLessonsDashboard()
            }
        } label: {
            HStack(spacing: 4) {
                Text("Open lessons")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(DS.Colors.textPrimary)
                    .lineLimit(1)

                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(DS.Colors.textTertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.white.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(DS.Colors.borderSubtle, lineWidth: 0.5)
            )
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .pointerCursor()
    }

    // MARK: - DM Farza Button

    private var dmFarzaButton: some View {
        Button(action: {
            if let url = URL(string: "https://x.com/dzhohola") {
                NSWorkspace.shared.open(url)
            }
        }) {
            HStack(spacing: 8) {
                Image(systemName: "bubble.left.fill")
                    .font(.system(size: 12, weight: .medium))

                VStack(alignment: .leading, spacing: 2) {
                    Text("Got feedback? DM me")
                        .font(.system(size: 12, weight: .semibold))
                    Text("Bugs, ideas, anything — I read every message.")
                        .font(.system(size: 10))
                        .foregroundColor(DS.Colors.textTertiary)
                }
            }
            .foregroundColor(DS.Colors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: DS.CornerRadius.medium, style: .continuous)
                    .fill(Color.white.opacity(0.06))
            )
            .overlay(
                RoundedRectangle(cornerRadius: DS.CornerRadius.medium, style: .continuous)
                    .stroke(DS.Colors.borderSubtle, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }

    // MARK: - Footer

    private var footerSection: some View {
        HStack {
            Button(action: {
                NSApp.terminate(nil)
            }) {
                HStack(spacing: 6) {
                    Image(systemName: "power")
                        .font(.system(size: 11, weight: .medium))
                    Text("Quit Clicky")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundColor(DS.Colors.textTertiary)
            }
            .buttonStyle(.plain)
            .pointerCursor()

        }
    }

    // MARK: - Visual Helpers

    private var panelBackground: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(DS.Colors.background)
            .shadow(color: Color.black.opacity(0.5), radius: 20, x: 0, y: 10)
            .shadow(color: Color.black.opacity(0.3), radius: 4, x: 0, y: 2)
    }

    private var statusDotColor: Color {
        if !companionManager.isOverlayVisible {
            return DS.Colors.textTertiary
        }
        switch companionManager.voiceState {
        case .idle:
            return DS.Colors.success
        case .listening:
            return DS.Colors.blue400
        case .processing, .responding:
            return DS.Colors.blue400
        }
    }

    private var statusText: String {
        if !companionManager.hasCompletedOnboarding || !companionManager.allPermissionsGranted {
            return "Setup"
        }
        if !companionManager.isOverlayVisible {
            return "Ready"
        }
        switch companionManager.voiceState {
        case .idle:
            return "Active"
        case .listening:
            return "Listening"
        case .processing:
            return "Processing"
        case .responding:
            return "Responding"
        }
    }

}

// MARK: - Sidecar Status Row

/// A one-line health indicator for the brain sidecar. Rendered only while the
/// sidecar is not fully ready, so a healthy sidecar takes up no panel space.
/// It observes the sidecar manager directly so its status text updates live as
/// the process discovers Node, installs dependencies, starts, or fails.
private struct SidecarStatusRow: View {
    @ObservedObject var sidecarManager: SidecarProcessManager

    var body: some View {
        if let sidecarStatusText {
            HStack(spacing: 6) {
                Circle()
                    .fill(isFailure ? DS.Colors.warning : DS.Colors.textTertiary)
                    .frame(width: 6, height: 6)

                Text(sidecarStatusText)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(isFailure ? DS.Colors.warningText : DS.Colors.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer()
            }
            .padding(.vertical, 4)
        }
    }

    /// The status line to show, or nil when the sidecar is ready (row hidden).
    private var sidecarStatusText: String? {
        switch sidecarManager.status {
        case .ready:
            return nil
        case .installing:
            return "Installing brain dependencies…"
        case .starting, .discoveringNode:
            return "Starting…"
        case .stopped:
            return "Stopped"
        case .failed(let message):
            return message
        }
    }

    private var isFailure: Bool {
        if case .failed = sidecarManager.status { return true }
        return false
    }
}
