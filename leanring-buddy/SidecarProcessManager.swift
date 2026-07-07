//
//  SidecarProcessManager.swift
//  leanring-buddy
//
//  Supervises the Clicky brain sidecar and speaks its NDJSON protocol.
//

import CryptoKit
import Combine
import Foundation

enum SidecarStatus: Equatable {
    case stopped
    case discoveringNode
    case installing
    case starting
    case ready
    case failed(String)
}

struct SidecarRequestError: Error, LocalizedError {
    let code: String
    let message: String
    let backend: String?

    var errorDescription: String? {
        if let backend {
            return "\(backend): \(message)"
        }
        return message
    }
}

struct SidecarWorkspace: Identifiable {
    let id: String
    let name: String
    let path: String
    let lessonCount: Int
}

struct SidecarAuthStatus {
    let claudeLoggedIn: Bool
    let claudeMethod: String
    let codexLoggedIn: Bool
    let teachSkillInstalled: Bool
}

struct SidecarEvent {
    let rawPayload: [String: Any]

    var id: String? { rawPayload["id"] as? String }
    var type: String { rawPayload["type"] as? String ?? "" }
    var version: String? { rawPayload["version"] as? String }
    var node: String? { rawPayload["node"] as? String }
    var sidecarPath: String? { rawPayload["sidecarPath"] as? String }
    var phase: String? { rawPayload["phase"] as? String }
    var tool: String? { rawPayload["tool"] as? String }
    var detail: String? { rawPayload["detail"] as? String }
    var text: String? { rawPayload["text"] as? String }
    var reset: Bool? { rawPayload["reset"] as? Bool }
    var code: String? { rawPayload["code"] as? String }
    var message: String? { rawPayload["message"] as? String }
    var backend: String? { rawPayload["backend"] as? String }
    var workspaceId: String? { rawPayload["workspaceId"] as? String }
    var path: String? { rawPayload["path"] as? String }
    var openedByAgent: Bool? { rawPayload["openedByAgent"] as? Bool }
    var level: String? { rawPayload["level"] as? String }

    var workspace: SidecarWorkspace? {
        guard let workspacePayload = rawPayload["workspace"] as? [String: Any] else { return nil }
        return Self.parseWorkspace(from: workspacePayload)
    }

    var workspaces: [SidecarWorkspace]? {
        guard let workspacePayloads = rawPayload["workspaces"] as? [[String: Any]] else { return nil }
        return workspacePayloads.compactMap(Self.parseWorkspace)
    }

    var authStatus: SidecarAuthStatus {
        let claudePayload = rawPayload["claude"] as? [String: Any] ?? [:]
        let codexPayload = rawPayload["codex"] as? [String: Any] ?? [:]
        let teachSkillPayload = rawPayload["teachSkill"] as? [String: Any] ?? [:]

        return SidecarAuthStatus(
            claudeLoggedIn: Self.booleanValue(in: claudePayload, keys: ["loggedIn", "isLoggedIn", "authenticated", "available"]),
            claudeMethod: Self.stringValue(in: claudePayload, keys: ["method", "authMethod", "source"]) ?? "",
            codexLoggedIn: Self.booleanValue(in: codexPayload, keys: ["loggedIn", "isLoggedIn", "authenticated", "available"]),
            teachSkillInstalled: Self.booleanValue(in: teachSkillPayload, keys: ["installed", "isInstalled", "available"])
        )
    }

    private static func parseWorkspace(from payload: [String: Any]) -> SidecarWorkspace? {
        guard let id = payload["id"] as? String,
              let name = payload["name"] as? String,
              let path = payload["path"] as? String else {
            return nil
        }

        return SidecarWorkspace(
            id: id,
            name: name,
            path: path,
            lessonCount: payload["lessonCount"] as? Int ?? 0
        )
    }

    private static func booleanValue(in payload: [String: Any], keys: [String]) -> Bool {
        for key in keys {
            if let value = payload[key] as? Bool {
                return value
            }
        }
        return false
    }

    private static func stringValue(in payload: [String: Any], keys: [String]) -> String? {
        for key in keys {
            if let value = payload[key] as? String {
                return value
            }
        }
        return nil
    }
}

@MainActor
final class SidecarProcessManager: ObservableObject {
    @Published var status: SidecarStatus = .stopped

    var onReady: ((SidecarEvent) -> Void)?
    var onLog: ((SidecarEvent) -> Void)?
    var onLessonCreated: (((workspaceId: String, path: String, openedByAgent: Bool)) -> Void)?

    private let userDefaults = UserDefaults.standard
    private let fileManager = FileManager.default
    private let nodePathDefaultsKey = "clickyNodePath"
    private let sidecarDevPathDefaultsKey = "clickySidecarDevPath"
    private let anthropicAPIKeyDefaultsKey = "clickyAnthropicAPIKey"

    private var sidecarProcess: Process?
    private var sidecarInputPipe: Pipe?
    private var sidecarOutputPipe: Pipe?
    private var sidecarErrorPipe: Pipe?
    private var sidecarStdoutDataContinuation: AsyncStream<Data>.Continuation?
    private var sidecarStderrDataContinuation: AsyncStream<Data>.Continuation?
    private var sidecarStdoutConsumerTask: Task<Void, Never>?
    private var sidecarStderrConsumerTask: Task<Void, Never>?
    private var stdoutBuffer = Data()
    private var stderrBuffer = Data()
    private var pendingRequests: [String: CheckedContinuation<SidecarEvent, Error>] = [:]
    private var statusHandlers: [String: @MainActor @Sendable (SidecarEvent) -> Void] = [:]
    /// Request ids whose task was cancelled before the continuation was
    /// registered — consumed by sendRequest to resume immediately.
    private var cancelledRequestIds: Set<String> = []
    private var readyContinuation: CheckedContinuation<Void, Error>?
    private var readyTimeoutWorkItem: DispatchWorkItem?
    private var intentionallyStopped = false
    private var restartBackoffSeconds: TimeInterval = 2
    private var processStartedAt: Date?
    private var restartTask: Task<Void, Never>?
    private var startTask: Task<Void, Error>?

    func start() async throws {
        if case .ready = status {
            return
        }

        if let startTask {
            try await startTask.value
            return
        }

        let newStartTask = Task { @MainActor in
            try await self.performStart()
        }
        startTask = newStartTask

        do {
            try await newStartTask.value
            startTask = nil
        } catch {
            startTask = nil
            throw error
        }
    }

    private func performStart() async throws {
        intentionallyStopped = false
        restartTask?.cancel()
        restartTask = nil

        status = .discoveringNode
        let discoveredNodePath = try await resolveNodePath()

        do {
            let sidecarDirectoryURL = try await prepareSidecarDirectory(nodePath: discoveredNodePath)
            try spawnSidecar(nodePath: discoveredNodePath, sidecarDirectoryURL: sidecarDirectoryURL)
        } catch {
            userDefaults.removeObject(forKey: nodePathDefaultsKey)
            let reprobedNodePath = try await resolveNodePath(shouldIgnoreCache: true)
            let sidecarDirectoryURL = try await prepareSidecarDirectory(nodePath: reprobedNodePath)
            try spawnSidecar(nodePath: reprobedNodePath, sidecarDirectoryURL: sidecarDirectoryURL)
        }

        try await waitForReadyEvent()
    }

    func sendChat(
        requestId: String = UUID().uuidString,
        backend: String,
        workspaceId: String,
        model: String,
        effort: String,
        text: String,
        images: [(path: String, label: String)],
        teachIntent: Bool,
        onStatus: (@MainActor @Sendable (SidecarEvent) -> Void)?
    ) async throws -> String {
        let event = try await sendRequest(
            id: requestId,
            payload: [
                "id": requestId,
                "type": "chat",
                "backend": backend,
                "workspaceId": workspaceId,
                "model": model,
                "effort": effort,
                "text": text,
                "images": images.map { ["path": $0.path, "label": $0.label] },
                "teachIntent": teachIntent
            ],
            onStatus: onStatus
        )

        guard let text = event.text else {
            throw SidecarRequestError(code: "internal", message: "Chat result did not include text", backend: backend)
        }
        return text
    }

    func sendOneShot(
        backend: String,
        text: String,
        images: [(path: String, label: String)],
        systemPrompt: String
    ) async throws -> String {
        let requestId = UUID().uuidString
        let event = try await sendRequest(
            id: requestId,
            payload: [
                "id": requestId,
                "type": "oneShot",
                "backend": backend,
                "text": text,
                "images": images.map { ["path": $0.path, "label": $0.label] },
                "systemPrompt": systemPrompt
            ],
            onStatus: nil
        )

        guard let text = event.text else {
            throw SidecarRequestError(code: "internal", message: "One-shot result did not include text", backend: backend)
        }
        return text
    }

    func createWorkspace(name: String) async throws -> SidecarWorkspace {
        let requestId = UUID().uuidString
        let event = try await sendRequest(
            id: requestId,
            payload: ["id": requestId, "type": "createWorkspace", "name": name],
            onStatus: nil
        )

        guard let workspace = event.workspace else {
            throw SidecarRequestError(code: "internal", message: "Workspace creation result did not include a workspace", backend: nil)
        }
        return workspace
    }

    func listWorkspaces() async throws -> [SidecarWorkspace] {
        let requestId = UUID().uuidString
        let event = try await sendRequest(
            id: requestId,
            payload: ["id": requestId, "type": "listWorkspaces"],
            onStatus: nil
        )

        guard let workspaces = event.workspaces else {
            throw SidecarRequestError(code: "internal", message: "Workspace list result did not include workspaces", backend: nil)
        }
        return workspaces
    }

    func checkAuthStatus() async throws -> SidecarAuthStatus {
        let requestId = UUID().uuidString
        let event = try await sendRequest(
            id: requestId,
            payload: ["id": requestId, "type": "authStatus"],
            onStatus: nil
        )
        return event.authStatus
    }

    func resetSession(backend: String, workspaceId: String) async throws -> Bool {
        let requestId = UUID().uuidString
        let event = try await sendRequest(
            id: requestId,
            payload: [
                "id": requestId,
                "type": "resetSession",
                "backend": backend,
                "workspaceId": workspaceId
            ],
            onStatus: nil
        )
        return event.reset ?? false
    }

    func cancelRequest(targetId: String) {
        guard sidecarProcess?.isRunning == true else { return }

        let requestId = UUID().uuidString
        writeFireAndForgetRequest([
            "id": requestId,
            "type": "cancel",
            "targetId": targetId
        ])
    }

    func stop() {
        intentionallyStopped = true
        restartTask?.cancel()
        restartTask = nil
        readyTimeoutWorkItem?.cancel()
        readyTimeoutWorkItem = nil

        if sidecarProcess?.isRunning == true {
            writeFireAndForgetRequest(["id": UUID().uuidString, "type": "shutdown"])
        }

        sidecarInputPipe?.fileHandleForWriting.closeFile()

        let processToTerminate = sidecarProcess
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            if processToTerminate?.isRunning == true {
                processToTerminate?.terminate()
            }
        }

        closePipesAndClearProcessReferences()
        failAllPendingRequests(with: SidecarRequestError(code: "cancelled", message: "Sidecar stopped", backend: nil))
        status = .stopped
    }

    private func resolveNodePath(shouldIgnoreCache: Bool = false) async throws -> String {
        if !shouldIgnoreCache,
           let cachedNodePath = userDefaults.string(forKey: nodePathDefaultsKey),
           await Self.nodePathIsUsable(cachedNodePath) {
            return cachedNodePath
        }

        var candidateNodePaths: [String] = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node"
        ]
        candidateNodePaths.append(contentsOf: newestNVMNodePaths())
        candidateNodePaths.append(contentsOf: [
            "\(NSHomeDirectory())/.volta/bin/node",
            "/usr/bin/node"
        ])

        for candidateNodePath in candidateNodePaths {
            if await Self.nodePathIsUsable(candidateNodePath) {
                userDefaults.set(candidateNodePath, forKey: nodePathDefaultsKey)
                return candidateNodePath
            }
        }

        if let shellResolvedNodePath = try await Self.resolveNodePathFromLoginShell(),
           await Self.nodePathIsUsable(shellResolvedNodePath) {
            userDefaults.set(shellResolvedNodePath, forKey: nodePathDefaultsKey)
            return shellResolvedNodePath
        }

        throw SidecarRequestError(code: "internal", message: "Could not find Node.js 18 or newer", backend: nil)
    }

    private func newestNVMNodePaths() -> [String] {
        let nvmVersionsURL = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".nvm")
            .appendingPathComponent("versions")
            .appendingPathComponent("node")

        guard let versionDirectoryURLs = try? fileManager.contentsOfDirectory(
            at: nvmVersionsURL,
            includingPropertiesForKeys: nil
        ) else {
            return []
        }

        return versionDirectoryURLs
            .sorted {
                Self.nodeVersionSortKey(
                    from: $0.lastPathComponent
                ).isGreaterThan(Self.nodeVersionSortKey(from: $1.lastPathComponent))
            }
            .map { $0.appendingPathComponent("bin").appendingPathComponent("node").path }
    }

    private func prepareSidecarDirectory(nodePath: String) async throws -> URL {
        if let devPath = userDefaults.string(forKey: sidecarDevPathDefaultsKey), !devPath.isEmpty {
            return URL(fileURLWithPath: devPath)
        }

        guard let bundledSidecarURL = Bundle.main.resourceURL?.appendingPathComponent("sidecar") else {
            throw SidecarRequestError(code: "internal", message: "Bundled sidecar was not found", backend: nil)
        }

        let expectedHash = try await Task.detached(priority: .utility) {
            try Self.computeBundledSidecarHash(bundledSidecarURL: bundledSidecarURL)
        }.value
        let sidecarInstallDirectoryURL = try applicationSupportDirectoryURL().appendingPathComponent("sidecar")
        let installedHashURL = sidecarInstallDirectoryURL.appendingPathComponent(".hash")
        let installedHash = try? String(contentsOf: installedHashURL, encoding: .utf8)

        guard installedHash?.trimmingCharacters(in: .whitespacesAndNewlines) != expectedHash else {
            return sidecarInstallDirectoryURL
        }

        status = .installing
        try await Task.detached(priority: .utility) {
            let fileManager = FileManager.default
            try? fileManager.removeItem(at: sidecarInstallDirectoryURL)
            try fileManager.createDirectory(
                at: sidecarInstallDirectoryURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try Self.copyDirectoryExcludingNodeModules(from: bundledSidecarURL, to: sidecarInstallDirectoryURL)
        }.value

        let npmPath = URL(fileURLWithPath: nodePath).deletingLastPathComponent().appendingPathComponent("npm").path
        print("🧠 sidecar: installing dependencies with npm ci --omit=dev")
        _ = try await Self.runProcessAndCollectOutput(
            executablePath: npmPath,
            arguments: ["ci", "--omit=dev"],
            currentDirectoryURL: sidecarInstallDirectoryURL,
            environment: installEnvironment(nodePath: nodePath),
            timeoutSeconds: 300
        )

        // Only record the hash once dependencies are actually in place — a
        // failed npm install must NOT satisfy the hash guard on the next
        // launch, or the app would spawn a sidecar with no node_modules and
        // crash-loop until the install directory is deleted by hand.
        try await Task.detached(priority: .utility) {
            try expectedHash.write(to: installedHashURL, atomically: true, encoding: .utf8)
        }.value

        return sidecarInstallDirectoryURL
    }

    private func spawnSidecar(nodePath: String, sidecarDirectoryURL: URL) throws {
        status = .starting
        closePipesAndClearProcessReferences()

        let process = Process()
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        let stdoutDataStream = Self.makePipeDataStream()
        let stderrDataStream = Self.makePipeDataStream()

        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = ["index.mjs"]
        process.currentDirectoryURL = sidecarDirectoryURL
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        process.environment = sidecarEnvironment(nodePath: nodePath)

        outputPipe.fileHandleForReading.readabilityHandler = { [weak self, stdoutDataStream] fileHandle in
            guard self != nil else { return }
            let availableData = fileHandle.availableData
            guard !availableData.isEmpty else { return }
            stdoutDataStream.continuation.yield(availableData)
        }

        errorPipe.fileHandleForReading.readabilityHandler = { [weak self, stderrDataStream] fileHandle in
            guard self != nil else { return }
            let availableData = fileHandle.availableData
            guard !availableData.isEmpty else { return }
            stderrDataStream.continuation.yield(availableData)
        }

        sidecarStdoutDataContinuation = stdoutDataStream.continuation
        sidecarStderrDataContinuation = stderrDataStream.continuation
        sidecarStdoutConsumerTask = Task { @MainActor [weak self] in
            for await dataChunk in stdoutDataStream.stream {
                self?.handleSidecarStdoutData(dataChunk)
            }
        }
        sidecarStderrConsumerTask = Task { @MainActor [weak self] in
            for await dataChunk in stderrDataStream.stream {
                self?.handleSidecarStderrData(dataChunk)
            }
        }

        process.terminationHandler = { [weak self] terminatedProcess in
            Task { @MainActor [weak self] in
                self?.handleSidecarTermination(terminationStatus: terminatedProcess.terminationStatus)
            }
        }

        sidecarProcess = process
        sidecarInputPipe = inputPipe
        sidecarOutputPipe = outputPipe
        sidecarErrorPipe = errorPipe
        stdoutBuffer = Data()
        stderrBuffer = Data()

        try process.run()
        processStartedAt = Date()
    }

    private func waitForReadyEvent() async throws {
        if case .ready = status {
            return
        }

        try await withCheckedThrowingContinuation { continuation in
            readyContinuation = continuation
            let timeoutWorkItem = DispatchWorkItem { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self, let readyContinuation = self.readyContinuation else { return }
                    self.readyContinuation = nil

                    // Kill the unresponsive process before reporting failure —
                    // clearing references without terminating would orphan a
                    // hung Node process on every ready timeout. Detach the
                    // termination handler first so the kill doesn't trigger
                    // the crash-restart path on top of this failure.
                    let unresponsiveProcess = self.sidecarProcess
                    self.closePipesAndClearProcessReferences()
                    if unresponsiveProcess?.isRunning == true {
                        unresponsiveProcess?.terminate()
                    }

                    readyContinuation.resume(throwing: SidecarRequestError(
                        code: "internal",
                        message: "Sidecar did not become ready within 30 seconds",
                        backend: nil
                    ))
                }
            }
            readyTimeoutWorkItem = timeoutWorkItem
            DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeoutWorkItem)
        }
    }

    private func sendRequest(
        id: String,
        payload: [String: Any],
        onStatus: (@MainActor @Sendable (SidecarEvent) -> Void)?
    ) async throws -> SidecarEvent {
        if status != .ready {
            try await start()
        }
        try Task.checkCancellation()

        // The continuation must resume even when the sidecar never answers
        // (hung turn, cancelled caller, watchdog timeout) — otherwise the
        // awaiting task leaks and anything joining on it hangs forever. The
        // cancellation handler resumes it explicitly; the cancelledRequestIds
        // set closes the race where cancellation lands before the
        // continuation is registered below.
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if cancelledRequestIds.remove(id) != nil {
                    continuation.resume(throwing: CancellationError())
                    return
                }

                pendingRequests[id] = continuation
                if let onStatus {
                    statusHandlers[id] = onStatus
                }

                do {
                    try writeRequest(payload)
                } catch {
                    pendingRequests.removeValue(forKey: id)
                    statusHandlers.removeValue(forKey: id)
                    continuation.resume(throwing: error)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.failPendingRequestForCancellation(id: id)
            }
        }
    }

    /// Resumes (with CancellationError) and forgets the pending continuation
    /// for a cancelled request. If the continuation isn't registered yet, the
    /// id is remembered so registration in sendRequest resumes immediately.
    private func failPendingRequestForCancellation(id: String) {
        if let continuation = pendingRequests.removeValue(forKey: id) {
            statusHandlers.removeValue(forKey: id)
            continuation.resume(throwing: CancellationError())
        } else {
            cancelledRequestIds.insert(id)
        }
    }

    private func writeFireAndForgetRequest(_ payload: [String: Any]) {
        do {
            try writeRequest(payload)
        } catch {
            print("🧠 sidecar: failed to write fire-and-forget request: \(error)")
        }
    }

    private func writeRequest(_ payload: [String: Any]) throws {
        guard let inputFileHandle = sidecarInputPipe?.fileHandleForWriting else {
            throw SidecarRequestError(code: "internal", message: "Sidecar stdin is unavailable", backend: nil)
        }

        let jsonData = try JSONSerialization.data(withJSONObject: payload, options: [])
        var lineData = jsonData
        lineData.append(0x0A)
        try inputFileHandle.write(contentsOf: lineData)
    }

    private func handleSidecarStdoutData(_ data: Data) {
        stdoutBuffer.append(data)
        while let newlineIndex = stdoutBuffer.firstIndex(of: 0x0A) {
            let lineData = Data(stdoutBuffer[..<newlineIndex])
            stdoutBuffer.removeSubrange(...newlineIndex)
            handleSidecarStdoutLineData(lineData)
        }
    }

    private func handleSidecarStdoutLineData(_ lineData: Data) {
        guard !lineData.isEmpty else { return }

        do {
            guard let rawPayload = try JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
                return
            }
            handleSidecarEvent(SidecarEvent(rawPayload: rawPayload))
        } catch {
            let line = String(data: lineData, encoding: .utf8) ?? "<unreadable>"
            print("🧠 sidecar: failed to decode stdout line: \(line)")
        }
    }

    private func handleSidecarEvent(_ event: SidecarEvent) {
        switch event.type {
        case "ready":
            readyTimeoutWorkItem?.cancel()
            readyTimeoutWorkItem = nil
            status = .ready
            onReady?(event)
            if let readyContinuation {
                self.readyContinuation = nil
                readyContinuation.resume()
            }

        case "status":
            guard let id = event.id else { return }
            statusHandlers[id]?(event)

        case "result":
            guard let id = event.id, let continuation = pendingRequests.removeValue(forKey: id) else { return }
            statusHandlers.removeValue(forKey: id)
            continuation.resume(returning: event)

        case "error":
            guard let id = event.id, let continuation = pendingRequests.removeValue(forKey: id) else { return }
            statusHandlers.removeValue(forKey: id)
            continuation.resume(throwing: SidecarRequestError(
                code: event.code ?? "internal",
                message: event.message ?? "Sidecar request failed",
                backend: event.backend
            ))

        case "lessonCreated":
            if let workspaceId = event.workspaceId, let path = event.path {
                onLessonCreated?((
                    workspaceId: workspaceId,
                    path: path,
                    openedByAgent: event.openedByAgent ?? false
                ))
            }

        case "log":
            onLog?(event)

        default:
            break
        }
    }

    private func handleSidecarStderrData(_ data: Data) {
        stderrBuffer.append(data)
        while let newlineIndex = stderrBuffer.firstIndex(of: 0x0A) {
            let lineData = Data(stderrBuffer[..<newlineIndex])
            stderrBuffer.removeSubrange(...newlineIndex)
            if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                print("🧠 sidecar: \(line)")
            }
        }
    }

    private func handleSidecarTermination(terminationStatus: Int32) {
        // Capture uptime BEFORE clearing process state — the cleanup below
        // nils out processStartedAt, which would make uptime always zero and
        // prevent the restart backoff from ever resetting.
        let uptime = processStartedAt.map { Date().timeIntervalSince($0) } ?? 0

        closePipesAndClearProcessReferences()

        if intentionallyStopped {
            status = .stopped
            return
        }

        if uptime >= 60 {
            restartBackoffSeconds = 2
        }

        let crashError = SidecarRequestError(
            code: "node_backend_crash",
            message: "Sidecar exited with status \(terminationStatus)",
            backend: nil
        )
        failAllPendingRequests(with: crashError)
        status = .failed(crashError.message)

        let restartDelay = restartBackoffSeconds
        restartBackoffSeconds = min(restartBackoffSeconds * 2, 30)
        restartTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(restartDelay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            try? await self?.start()
        }
    }

    private func failAllPendingRequests(with error: Error) {
        for continuation in pendingRequests.values {
            continuation.resume(throwing: error)
        }
        pendingRequests.removeAll()
        statusHandlers.removeAll()
        cancelledRequestIds.removeAll()

        if let readyContinuation {
            self.readyContinuation = nil
            readyContinuation.resume(throwing: error)
        }
    }

    private func closePipesAndClearProcessReferences() {
        sidecarOutputPipe?.fileHandleForReading.readabilityHandler = nil
        sidecarErrorPipe?.fileHandleForReading.readabilityHandler = nil
        sidecarStdoutDataContinuation?.finish()
        sidecarStderrDataContinuation?.finish()
        sidecarStdoutConsumerTask?.cancel()
        sidecarStderrConsumerTask?.cancel()
        sidecarProcess?.terminationHandler = nil
        sidecarProcess = nil
        sidecarInputPipe = nil
        sidecarOutputPipe = nil
        sidecarErrorPipe = nil
        sidecarStdoutDataContinuation = nil
        sidecarStderrDataContinuation = nil
        sidecarStdoutConsumerTask = nil
        sidecarStderrConsumerTask = nil
        processStartedAt = nil
    }

    private nonisolated static func makePipeDataStream() -> (
        stream: AsyncStream<Data>,
        continuation: AsyncStream<Data>.Continuation
    ) {
        var capturedContinuation: AsyncStream<Data>.Continuation?
        let stream = AsyncStream<Data> { continuation in
            capturedContinuation = continuation
        }

        guard let capturedContinuation else {
            preconditionFailure("AsyncStream continuation was not created synchronously")
        }

        return (stream, capturedContinuation)
    }

    private nonisolated static func computeBundledSidecarHash(bundledSidecarURL: URL) throws -> String {
        var combinedData = Data()
        let fileManager = FileManager.default
        let fixedRelativePaths = ["index.mjs", "package.json", "package-lock.json"]

        for relativePath in fixedRelativePaths {
            combinedData.append(try Data(contentsOf: bundledSidecarURL.appendingPathComponent(relativePath)))
        }

        let sourceDirectoryURL = bundledSidecarURL.appendingPathComponent("src")
        let sourceFileURLs = try fileManager.contentsOfDirectory(
            at: sourceDirectoryURL,
            includingPropertiesForKeys: [.isRegularFileKey]
        )
        .filter { url in
            (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        }
        .sorted { $0.lastPathComponent < $1.lastPathComponent }

        for sourceFileURL in sourceFileURLs {
            combinedData.append(try Data(contentsOf: sourceFileURL))
        }

        let hash = SHA256.hash(data: combinedData)
        return hash.map { String(format: "%02x", $0) }.joined()
    }

    private nonisolated static func copyDirectoryExcludingNodeModules(from sourceURL: URL, to destinationURL: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: destinationURL, withIntermediateDirectories: true)
        let childURLs = try fileManager.contentsOfDirectory(
            at: sourceURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: []
        )

        for childURL in childURLs {
            guard childURL.lastPathComponent != "node_modules" else { continue }

            let destinationChildURL = destinationURL.appendingPathComponent(childURL.lastPathComponent)
            let isDirectory = (try? childURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            if isDirectory {
                try Self.copyDirectoryExcludingNodeModules(from: childURL, to: destinationChildURL)
            } else {
                try fileManager.copyItem(at: childURL, to: destinationChildURL)
            }
        }
    }

    private func applicationSupportDirectoryURL() throws -> URL {
        let applicationSupportURL = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let clickyDirectoryURL = applicationSupportURL.appendingPathComponent("OpenClicky")
        try fileManager.createDirectory(at: clickyDirectoryURL, withIntermediateDirectories: true)
        return clickyDirectoryURL
    }

    private func sidecarEnvironment(nodePath: String) -> [String: String] {
        var environment = installEnvironment(nodePath: nodePath)
        if let anthropicAPIKey = userDefaults.string(forKey: anthropicAPIKeyDefaultsKey), !anthropicAPIKey.isEmpty {
            environment["CLICKY_ANTHROPIC_API_KEY"] = anthropicAPIKey
        }
        return environment
    }

    private func installEnvironment(nodePath: String) -> [String: String] {
        let nodeDirectoryPath = URL(fileURLWithPath: nodePath).deletingLastPathComponent().path
        return [
            "PATH": "\(nodeDirectoryPath):/usr/bin:/bin",
            "HOME": NSHomeDirectory(),
            "USER": NSUserName(),
            "TMPDIR": NSTemporaryDirectory()
        ]
    }

    private static func nodePathIsUsable(_ nodePath: String) async -> Bool {
        guard FileManager.default.isExecutableFile(atPath: nodePath) else { return false }

        do {
            let output = try await runProcessAndCollectOutput(
                executablePath: nodePath,
                arguments: ["--version"],
                currentDirectoryURL: nil,
                environment: nil,
                timeoutSeconds: 10
            )
            let versionString = output.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            return nodeMajorVersion(from: versionString) >= 18
        } catch {
            return false
        }
    }

    private static func resolveNodePathFromLoginShell() async throws -> String? {
        let output = try await runProcessAndCollectOutput(
            executablePath: "/bin/zsh",
            arguments: ["-lic", "command -v node"],
            currentDirectoryURL: nil,
            environment: nil,
            timeoutSeconds: 10
        )
        let nodePath = output.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return nodePath.isEmpty ? nil : nodePath
    }

    private static func nodeMajorVersion(from versionString: String) -> Int {
        let trimmedVersion = versionString.trimmingCharacters(in: CharacterSet(charactersIn: "v \n\t"))
        return Int(trimmedVersion.split(separator: ".").first ?? "") ?? 0
    }

    private static func nodeVersionSortKey(from versionDirectoryName: String) -> [Int] {
        let trimmedVersion = versionDirectoryName.trimmingCharacters(in: CharacterSet(charactersIn: "v"))
        let parts = trimmedVersion.split(separator: ".").map { Int($0) ?? 0 }
        return parts + Array(repeating: 0, count: max(0, 3 - parts.count))
    }

    private static func runProcessAndCollectOutput(
        executablePath: String,
        arguments: [String],
        currentDirectoryURL: URL?,
        environment: [String: String]?,
        timeoutSeconds: TimeInterval
    ) async throws -> (stdout: String, stderr: String) {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()

        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = arguments
        process.currentDirectoryURL = currentDirectoryURL
        process.environment = environment
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        // Drain both pipes incrementally while the process runs. Reading only
        // after termination would deadlock any child (npm especially) that
        // writes more than the 64KB pipe buffer before exiting.
        let stdoutAccumulator = SidecarPipeOutputAccumulator()
        let stderrAccumulator = SidecarPipeOutputAccumulator()
        stdoutPipe.fileHandleForReading.readabilityHandler = { fileHandle in
            stdoutAccumulator.append(fileHandle.availableData)
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { fileHandle in
            stderrAccumulator.append(fileHandle.availableData)
        }

        return try await withCheckedThrowingContinuation { continuation in
            let completionState = SidecarProcessCompletionState()
            let timeoutWorkItem = DispatchWorkItem {
                guard completionState.markCompletedIfNeeded() else { return }
                stdoutPipe.fileHandleForReading.readabilityHandler = nil
                stderrPipe.fileHandleForReading.readabilityHandler = nil
                if process.isRunning {
                    process.terminate()
                }
                continuation.resume(throwing: SidecarRequestError(
                    code: "internal",
                    message: "\(executablePath) timed out",
                    backend: nil
                ))
            }

            process.terminationHandler = { terminatedProcess in
                DispatchQueue.global().async {
                    guard completionState.markCompletedIfNeeded() else { return }

                    // Release the handlers BEFORE draining the remainder —
                    // FileHandle reads must not overlap, and a late
                    // readability callback could race readDataToEndOfFile.
                    stdoutPipe.fileHandleForReading.readabilityHandler = nil
                    stderrPipe.fileHandleForReading.readabilityHandler = nil
                    stdoutAccumulator.append(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
                    stderrAccumulator.append(stderrPipe.fileHandleForReading.readDataToEndOfFile())

                    let stdout = stdoutAccumulator.collectedString()
                    let stderr = stderrAccumulator.collectedString()

                    guard terminatedProcess.terminationStatus == 0 else {
                        continuation.resume(throwing: SidecarRequestError(
                            code: "internal",
                            message: "\(executablePath) failed: \(stderr)",
                            backend: nil
                        ))
                        return
                    }

                    continuation.resume(returning: (stdout, stderr))
                }
            }

            do {
                try process.run()
                DispatchQueue.global().asyncAfter(deadline: .now() + timeoutSeconds, execute: timeoutWorkItem)
            } catch {
                timeoutWorkItem.cancel()
                continuation.resume(throwing: error)
            }
        }
    }
}

private extension Array where Element == Int {
    func isGreaterThan(_ other: [Int]) -> Bool {
        for index in 0..<Swift.max(count, other.count) {
            let leftValue = index < count ? self[index] : 0
            let rightValue = index < other.count ? other[index] : 0
            if leftValue != rightValue {
                return leftValue > rightValue
            }
        }
        return false
    }
}

private final class SidecarProcessCompletionState: @unchecked Sendable {
    private let lock = NSLock()
    private var hasCompleted = false

    func markCompletedIfNeeded() -> Bool {
        lock.lock()
        defer { lock.unlock() }

        guard !hasCompleted else { return false }
        hasCompleted = true
        return true
    }
}

/// Thread-safe byte accumulator for draining a child process pipe from its
/// readability callback, which fires on a background queue.
private final class SidecarPipeOutputAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var collectedData = Data()

    func append(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.lock()
        collectedData.append(data)
        lock.unlock()
    }

    func collectedString() -> String {
        lock.lock()
        defer { lock.unlock() }
        return String(data: collectedData, encoding: .utf8) ?? ""
    }
}
