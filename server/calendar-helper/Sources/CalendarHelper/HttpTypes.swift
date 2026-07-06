import Foundation

struct HttpRequest {
    let method: String
    let path: String
    let queryParams: [String: String]
    let headers: [String: String]
    let body: Data?
}

struct HttpResponse {
    let statusCode: Int
    let body: Data

    static func json(_ statusCode: Int, _ value: Any) -> HttpResponse {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        return HttpResponse(statusCode: statusCode, body: data)
    }

    static func ok(_ data: Any) -> HttpResponse {
        return json(200, ["ok": true, "data": data])
    }

    static func error(code: String, message: String, statusCode: Int = 400, details: [String: Any] = [:]) -> HttpResponse {
        return json(statusCode, [
            "ok": false,
            "error": [
                "code": code,
                "message": message,
                "details": details
            ] as [String: Any]
        ])
    }

    func serialize() -> Data {
        let header = """
        HTTP/1.1 \(statusCode) \(statusText)\r
        Content-Type: application/json\r
        Content-Length: \(body.count)\r
        Connection: close\r
        \r

        """
        var result = header.data(using: .utf8)!
        result.append(body)
        return result
    }

    private var statusText: String {
        switch statusCode {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 500: return "Internal Server Error"
        default: return "Unknown"
        }
    }
}
