import Foundation

struct Auth {
    static let token: String? = ProcessInfo.processInfo.environment["CAL_HELPER_TOKEN"]

    static func check(_ request: HttpRequest) -> HttpResponse? {
        guard let requiredToken = token, !requiredToken.isEmpty else {
            return nil // No token required
        }

        guard let authHeader = request.headers["authorization"] ?? request.headers["Authorization"] else {
            return HttpResponse.error(code: "TOKEN_REQUIRED", message: "Authorization header required", statusCode: 401)
        }

        let prefix = "Bearer "
        guard authHeader.hasPrefix(prefix) else {
            return HttpResponse.error(code: "TOKEN_INVALID", message: "Invalid authorization format, expected: Bearer <token>", statusCode: 401)
        }

        let provided = String(authHeader.dropFirst(prefix.count))
        guard provided == requiredToken else {
            return HttpResponse.error(code: "TOKEN_INVALID", message: "Invalid bearer token", statusCode: 403)
        }

        return nil // Auth OK
    }
}
