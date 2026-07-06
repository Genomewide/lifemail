import Foundation

class HttpServer {
    let port: UInt16
    let bindAddress: String
    let router: Router
    private var serverSocket: Int32 = -1

    init(port: UInt16, bindAddress: String = "127.0.0.1") {
        self.port = port
        self.bindAddress = bindAddress
        self.router = Router()
    }

    func start() throws {
        serverSocket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard serverSocket >= 0 else {
            throw ServerError.socketCreationFailed
        }

        var opt: Int32 = 1
        setsockopt(serverSocket, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        inet_pton(AF_INET, bindAddress, &addr.sin_addr)

        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(serverSocket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            throw ServerError.bindFailed(errno: errno)
        }

        guard Darwin.listen(serverSocket, 128) == 0 else {
            throw ServerError.listenFailed(errno: errno)
        }

        Log.info("Listening on \(bindAddress):\(port)")

        // Accept loop
        while true {
            let clientSocket = Darwin.accept(serverSocket, nil, nil)
            if clientSocket < 0 { continue }

            Task {
                await handleConnection(clientSocket)
            }
        }
    }

    private func handleConnection(_ socket: Int32) async {
        defer { Darwin.close(socket) }

        // Read request data (up to 64KB should be plenty for our use case)
        var buffer = [UInt8](repeating: 0, count: 65536)
        let bytesRead = Darwin.read(socket, &buffer, buffer.count)
        guard bytesRead > 0 else { return }

        let requestData = Data(buffer[..<bytesRead])
        guard let request = parseRequest(requestData) else {
            let resp = HttpResponse.error(code: "INVALID_REQUEST", message: "Could not parse HTTP request")
            sendResponse(socket, resp)
            return
        }

        let response = await router.handle(request)
        sendResponse(socket, response)
    }

    private func parseRequest(_ data: Data) -> HttpRequest? {
        guard let str = String(data: data, encoding: .utf8) else { return nil }

        // Split headers and body
        let parts = str.components(separatedBy: "\r\n\r\n")
        let headerSection = parts[0]
        let body = parts.count > 1 ? parts[1].data(using: .utf8) : nil

        let lines = headerSection.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }

        let requestParts = requestLine.split(separator: " ", maxSplits: 2)
        guard requestParts.count >= 2 else { return nil }

        let method = String(requestParts[0])
        let fullPath = String(requestParts[1])

        // Parse path and query string
        var path = fullPath
        var queryParams: [String: String] = [:]

        if let qIndex = fullPath.firstIndex(of: "?") {
            path = String(fullPath[fullPath.startIndex..<qIndex])
            let queryString = String(fullPath[fullPath.index(after: qIndex)...])
            for pair in queryString.split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1)
                if kv.count == 2 {
                    let key = String(kv[0]).removingPercentEncoding ?? String(kv[0])
                    let val = String(kv[1]).removingPercentEncoding ?? String(kv[1])
                    queryParams[key] = val
                } else if kv.count == 1 {
                    queryParams[String(kv[0])] = ""
                }
            }
        }

        // Parse headers
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if let colonIndex = line.firstIndex(of: ":") {
                let key = String(line[line.startIndex..<colonIndex]).trimmingCharacters(in: .whitespaces)
                let value = String(line[line.index(after: colonIndex)...]).trimmingCharacters(in: .whitespaces)
                headers[key.lowercased()] = value
            }
        }

        return HttpRequest(method: method, path: path, queryParams: queryParams, headers: headers, body: body)
    }

    private func sendResponse(_ socket: Int32, _ response: HttpResponse) {
        let data = response.serialize()
        data.withUnsafeBytes { ptr in
            if let base = ptr.baseAddress {
                _ = Darwin.write(socket, base, data.count)
            }
        }
    }
}

enum ServerError: Error, CustomStringConvertible {
    case socketCreationFailed
    case bindFailed(errno: Int32)
    case listenFailed(errno: Int32)

    var description: String {
        switch self {
        case .socketCreationFailed:
            return "Failed to create socket"
        case .bindFailed(let e):
            return "Failed to bind: errno \(e) (\(String(cString: strerror(e))))"
        case .listenFailed(let e):
            return "Failed to listen: errno \(e) (\(String(cString: strerror(e))))"
        }
    }
}
