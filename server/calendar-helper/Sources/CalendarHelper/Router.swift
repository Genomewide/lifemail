import Foundation

class Router {
    private let service = EventKitService.shared

    func handle(_ request: HttpRequest) async -> HttpResponse {
        // Health endpoint is always tokenless
        if request.path == "/health" && request.method == "GET" {
            return handleHealth()
        }

        // All other endpoints require auth if token is configured
        if let authError = Auth.check(request) {
            return authError
        }

        // Check authorization for non-health endpoints
        if request.path != "/health" && !service.isAuthorized {
            return HttpResponse.error(
                code: "NOT_AUTHORIZED",
                message: "Calendar access not granted. Run calendar-helper --request-access.",
                statusCode: 403
            )
        }

        switch (request.method, request.path) {
        case ("POST", "/request-access"):
            return await handleRequestAccess()
        case ("GET", "/calendars"):
            return handleCalendars(request)
        case ("GET", "/events"):
            return handleEvents(request)
        case ("GET", "/search"):
            return handleSearch(request)
        case ("GET", "/event"):
            return handleGetEvent(request)
        default:
            return HttpResponse.error(code: "NOT_FOUND", message: "Unknown endpoint: \(request.method) \(request.path)", statusCode: 404)
        }
    }

    // MARK: - Handlers

    private func handleHealth() -> HttpResponse {
        let data: [String: Any] = [
            "name": "calendar-helper",
            "version": "0.1.0",
            "authorized": service.isAuthorized,
            "port": AppConfig.shared.port,
            "pid": ProcessInfo.processInfo.processIdentifier
        ]
        return HttpResponse.ok(data)
    }

    private func handleRequestAccess() async -> HttpResponse {
        let result = await service.requestAccess()
        return HttpResponse.ok([
            "authorized": result.authorized,
            "status": result.status
        ] as [String: Any])
    }

    private func handleCalendars(_ request: HttpRequest) -> HttpResponse {
        let includeHidden = request.queryParams["includeHidden"] == "true"
        let calendars = service.getCalendars(includeHidden: includeHidden)
        let encoded = calendars.map { cal -> [String: Any] in
            [
                "calendarId": cal.calendarId,
                "title": cal.title,
                "sourceTitle": cal.sourceTitle,
                "type": cal.type,
                "allowsModifications": cal.allowsModifications,
                "isHidden": cal.isHidden
            ]
        }
        return HttpResponse.ok(["calendars": encoded])
    }

    private func handleEvents(_ request: HttpRequest) -> HttpResponse {
        guard let startStr = request.queryParams["startUtc"], let startUtc = Int(startStr),
              let endStr = request.queryParams["endUtc"], let endUtc = Int(endStr) else {
            return HttpResponse.error(code: "INVALID_REQUEST", message: "startUtc and endUtc are required")
        }

        let calendarIds = request.queryParams["calendarIds"]?.split(separator: ",").map(String.init)
        let includeNotes = request.queryParams["includeNotes"] != "false"
        let notesMaxChars = min(Int(request.queryParams["notesMaxChars"] ?? "20000") ?? 20000, 200000)
        let limit = min(Int(request.queryParams["limit"] ?? "500") ?? 500, 5000)
        let offset = decodeCursor(request.queryParams["cursor"])

        let result = service.getEvents(
            startUtc: startUtc, endUtc: endUtc,
            calendarIds: calendarIds,
            includeNotes: includeNotes, notesMaxChars: notesMaxChars,
            limit: limit, offset: offset
        )

        let eventsArr = result.events.map { encodeEvent($0) }
        let nextCursor: Any = result.hasMore ? encodeCursor(offset + limit) : NSNull()

        return HttpResponse.ok([
            "events": eventsArr,
            "nextCursor": nextCursor
        ] as [String: Any])
    }

    private func handleSearch(_ request: HttpRequest) -> HttpResponse {
        guard let query = request.queryParams["query"], !query.isEmpty else {
            return HttpResponse.error(code: "INVALID_REQUEST", message: "query parameter is required")
        }

        let now = Int(Date().timeIntervalSince1970)
        let startUtc = Int(request.queryParams["startUtc"] ?? "") ?? (now - 365 * 86400)
        let endUtc = Int(request.queryParams["endUtc"] ?? "") ?? (now + 365 * 86400)
        let calendarIds = request.queryParams["calendarIds"]?.split(separator: ",").map(String.init)
        let includeNotes = request.queryParams["includeNotes"] != "false"
        let notesMaxChars = min(Int(request.queryParams["notesMaxChars"] ?? "2000") ?? 2000, 20000)
        let limit = min(Int(request.queryParams["limit"] ?? "50") ?? 50, 200)
        let offset = decodeCursor(request.queryParams["cursor"])

        let result = service.searchEvents(
            query: query, startUtc: startUtc, endUtc: endUtc,
            calendarIds: calendarIds,
            includeNotes: includeNotes, notesMaxChars: notesMaxChars,
            limit: limit, offset: offset
        )

        let eventsArr = result.events.map { encodeEvent($0) }
        let nextCursor: Any = result.hasMore ? encodeCursor(offset + limit) : NSNull()

        return HttpResponse.ok([
            "events": eventsArr,
            "nextCursor": nextCursor
        ] as [String: Any])
    }

    private func handleGetEvent(_ request: HttpRequest) -> HttpResponse {
        guard let identifier = request.queryParams["eventIdentifier"], !identifier.isEmpty else {
            return HttpResponse.error(code: "INVALID_REQUEST", message: "eventIdentifier parameter is required")
        }

        let includeNotes = request.queryParams["includeNotes"] != "false"
        let notesMaxChars = min(Int(request.queryParams["notesMaxChars"] ?? "20000") ?? 20000, 200000)

        guard let event = service.getEvent(identifier: identifier, includeNotes: includeNotes, notesMaxChars: notesMaxChars) else {
            return HttpResponse.error(code: "NOT_FOUND", message: "Event not found: \(identifier)", statusCode: 404)
        }

        return HttpResponse.ok(["event": encodeEvent(event)])
    }

    // MARK: - Cursor helpers

    private func encodeCursor(_ offset: Int) -> String {
        let json = "{\"offset\":\(offset)}"
        return Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func decodeCursor(_ cursor: String?) -> Int {
        guard let cursor = cursor, !cursor.isEmpty else { return 0 }
        let base64 = cursor
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: padded),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let offset = json["offset"] as? Int else {
            return 0
        }
        return offset
    }

    // MARK: - Encoding

    private func encodeEvent(_ ev: EventInfo) -> [String: Any] {
        var dict: [String: Any] = [
            "eventIdentifier": ev.eventIdentifier,
            "calendarId": ev.calendarId,
            "calendarName": ev.calendarName,
            "title": ev.title,
            "startUtc": ev.startUtc,
            "endUtc": ev.endUtc,
            "allDay": ev.allDay,
        ]
        dict["location"] = ev.location as Any? ?? NSNull()
        dict["url"] = ev.url as Any? ?? NSNull()
        dict["notes"] = ev.notes as Any? ?? NSNull()
        dict["lastModifiedUtc"] = ev.lastModifiedUtc as Any? ?? NSNull()
        return dict
    }
}
