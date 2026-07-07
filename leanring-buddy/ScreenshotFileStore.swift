//
//  ScreenshotFileStore.swift
//  leanring-buddy
//
//  Writes per-turn captures to disk so the brain sidecar can read them.
//

import Foundation

enum ScreenshotFileStore {
    static func writeCaptures(_ captures: [(data: Data, label: String)]) throws -> (directoryURL: URL, images: [(path: String, label: String)]) {
        let directoryURL = try capturesRootDirectoryURL().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)

        let images = try captures.enumerated().map { captureIndex, capture in
            let imageURL = directoryURL.appendingPathComponent("screen\(captureIndex + 1).jpeg")
            try capture.data.write(to: imageURL, options: [.atomic])
            return (path: imageURL.path, label: capture.label)
        }

        return (directoryURL: directoryURL, images: images)
    }

    static func cleanUp(directoryURL: URL) {
        try? FileManager.default.removeItem(at: directoryURL)
    }

    static func sweepStaleCaptures() {
        guard let captureDirectoryURLs = try? FileManager.default.contentsOfDirectory(
            at: try capturesRootDirectoryURL(),
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return
        }

        let oneDayAgo = Date().addingTimeInterval(-86_400)
        for captureDirectoryURL in captureDirectoryURLs {
            let modificationDate = try? captureDirectoryURL.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
            if modificationDate ?? .distantPast < oneDayAgo {
                try? FileManager.default.removeItem(at: captureDirectoryURL)
            }
        }
    }

    private static func capturesRootDirectoryURL() throws -> URL {
        let applicationSupportURL = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let capturesURL = applicationSupportURL
            .appendingPathComponent("OpenClicky")
            .appendingPathComponent("captures")
        try FileManager.default.createDirectory(at: capturesURL, withIntermediateDirectories: true)
        return capturesURL
    }
}
