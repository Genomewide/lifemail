import Foundation

enum Log {
    static let level: String = ProcessInfo.processInfo.environment["CAL_HELPER_LOG_LEVEL"]?.lowercased() ?? "info"

    private static func shouldLog(_ msgLevel: String) -> Bool {
        let levels = ["debug": 0, "info": 1, "warn": 2, "error": 3]
        return (levels[msgLevel] ?? 0) >= (levels[level] ?? 1)
    }

    private static func emit(_ lvl: String, _ msg: String) {
        guard shouldLog(lvl) else { return }
        let ts = ISO8601DateFormatter().string(from: Date())
        FileHandle.standardError.write("[\(ts)] \(lvl.uppercased()) \(msg)\n".data(using: .utf8)!)
    }

    static func debug(_ msg: String) { emit("debug", msg) }
    static func info(_ msg: String) { emit("info", msg) }
    static func warn(_ msg: String) { emit("warn", msg) }
    static func error(_ msg: String) { emit("error", msg) }
}
