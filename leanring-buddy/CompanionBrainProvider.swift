//
//  CompanionBrainProvider.swift
//  leanring-buddy
//
//  Adapter layer between the voice flow and the Clicky brain sidecar.
//

import Foundation

enum BrainStatus {
    case thinking
    case usingTool(name: String, detail: String)
}

struct CompanionBrainResponse {
    let traceId: String
    let turnId: String
    let text: String
}

protocol CompanionBrainProvider {
    func respond(
        transcript: String,
        images: [(data: Data, label: String)],
        backend: String,
        model: String,
        effort: String,
        onStatus: @MainActor @Sendable @escaping (BrainStatus) -> Void
    ) async throws -> CompanionBrainResponse

    func oneShot(
        prompt: String,
        images: [(data: Data, label: String)],
        backend: String,
        systemPrompt: String
    ) async throws -> String
}

enum CompanionBrainProviderError: Error, LocalizedError {
    case inactivityTimeout
    case totalTimeout

    var errorDescription: String? {
        switch self {
        case .inactivityTimeout:
            return "The brain sidecar did not send progress for 3 minutes"
        case .totalTimeout:
            return "The brain sidecar turn exceeded 10 minutes"
        }
    }
}

@MainActor
final class SidecarBrainProvider: CompanionBrainProvider {
    private let sidecarManager: SidecarProcessManager

    init(sidecarManager: SidecarProcessManager) {
        self.sidecarManager = sidecarManager
    }

    func respond(
        transcript: String,
        images: [(data: Data, label: String)],
        backend: String,
        model: String,
        effort: String,
        onStatus: @MainActor @Sendable @escaping (BrainStatus) -> Void
    ) async throws -> CompanionBrainResponse {
        let writtenCaptures = try await Task.detached(priority: .utility) {
            try ScreenshotFileStore.writeCaptures(images)
        }.value
        defer {
            Task.detached(priority: .utility) {
                ScreenshotFileStore.cleanUp(directoryURL: writtenCaptures.directoryURL)
            }
        }

        let requestId = UUID().uuidString
        let turnStartedAt = Date()
        var lastEventAt = Date()

        return try await withTaskCancellationHandler {
            try await withThrowingTaskGroup(of: CompanionBrainResponse.self) { taskGroup in
                taskGroup.addTask { @MainActor in
                    try await self.sidecarManager.sendChat(
                        requestId: requestId,
                        backend: backend,
                        model: model,
                        effort: effort,
                        text: transcript,
                        images: writtenCaptures.images,
                        onStatus: { event in
                            lastEventAt = Date()
                            if event.phase == "tool" {
                                onStatus(.usingTool(name: event.tool ?? "tool", detail: event.detail ?? ""))
                            } else {
                                onStatus(.thinking)
                            }
                        }
                    )
                }

                taskGroup.addTask { @MainActor in
                    while true {
                        try await Task.sleep(nanoseconds: 1_000_000_000)

                        if Date().timeIntervalSince(turnStartedAt) > 600 {
                            self.sidecarManager.cancelRequest(targetId: requestId)
                            throw CompanionBrainProviderError.totalTimeout
                        }

                        if Date().timeIntervalSince(lastEventAt) > 180 {
                            self.sidecarManager.cancelRequest(targetId: requestId)
                            throw CompanionBrainProviderError.inactivityTimeout
                        }
                    }
                }

                guard let firstCompletedResult = try await taskGroup.next() else {
                    throw CompanionBrainProviderError.totalTimeout
                }
                taskGroup.cancelAll()
                return firstCompletedResult
            }
        } onCancel: {
            Task { @MainActor [sidecarManager] in
                sidecarManager.cancelRequest(targetId: requestId)
            }
        }
    }

    func oneShot(
        prompt: String,
        images: [(data: Data, label: String)],
        backend: String,
        systemPrompt: String
    ) async throws -> String {
        let writtenCaptures = try await Task.detached(priority: .utility) {
            try ScreenshotFileStore.writeCaptures(images)
        }.value
        defer {
            Task.detached(priority: .utility) {
                ScreenshotFileStore.cleanUp(directoryURL: writtenCaptures.directoryURL)
            }
        }

        return try await sidecarManager.sendOneShot(
            backend: backend,
            text: prompt,
            images: writtenCaptures.images,
            systemPrompt: systemPrompt
        )
    }
}
