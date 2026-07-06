import Foundation

struct AppConfig {
    static var shared = AppConfig()

    var port: UInt16 = 17831
    var bindAddress: String = "127.0.0.1"
    var mode: Mode = .serve

    enum Mode {
        case serve
        case requestAccess
        case printAuthStatus
    }

    static func parse(_ args: [String]) -> AppConfig {
        var config = AppConfig()
        var i = 1 // skip program name

        while i < args.count {
            switch args[i] {
            case "--serve":
                config.mode = .serve
            case "--request-access":
                config.mode = .requestAccess
            case "--print-auth-status":
                config.mode = .printAuthStatus
            case "--port":
                i += 1
                if i < args.count, let p = UInt16(args[i]) {
                    config.port = p
                }
            case "--bind":
                i += 1
                if i < args.count {
                    config.bindAddress = args[i]
                }
            default:
                Log.warn("Unknown argument: \(args[i])")
            }
            i += 1
        }

        return config
    }
}
