import Foundation
import EventKit

class EventKitService {
    static let shared = EventKitService()
    private let store = EKEventStore()

    // MARK: - Authorization

    var authorizationStatus: String {
        let status = EKEventStore.authorizationStatus(for: .event)
        switch status {
        case .authorized, .fullAccess:
            return "authorized"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        case .notDetermined:
            return "notDetermined"
        case .writeOnly:
            return "writeOnly"
        @unknown default:
            return "unknown"
        }
    }

    var isAuthorized: Bool {
        let status = EKEventStore.authorizationStatus(for: .event)
        if #available(macOS 14.0, *) {
            return status == .fullAccess || status == .authorized
        }
        return status == .authorized
    }

    func requestAccess() async -> (authorized: Bool, status: String) {
        do {
            if #available(macOS 14.0, *) {
                let granted = try await store.requestFullAccessToEvents()
                return (granted, granted ? "authorized" : "denied")
            } else {
                let granted = try await store.requestAccess(to: .event)
                return (granted, granted ? "authorized" : "denied")
            }
        } catch {
            Log.error("requestAccess failed: \(error)")
            return (false, "denied")
        }
    }

    // MARK: - Calendars

    func getCalendars(includeHidden: Bool) -> [CalendarInfo] {
        let calendars = store.calendars(for: .event)
        return calendars
            .filter { includeHidden || !$0.isSubscribed }
            .map { cal in
                CalendarInfo(
                    calendarId: cal.calendarIdentifier,
                    title: cal.title,
                    sourceTitle: cal.source?.title ?? "",
                    type: calendarTypeString(cal.type),
                    allowsModifications: cal.allowsContentModifications,
                    isHidden: cal.isSubscribed
                )
            }
    }

    // MARK: - Events

    func getEvents(startUtc: Int, endUtc: Int, calendarIds: [String]?, includeNotes: Bool, notesMaxChars: Int, limit: Int, offset: Int) -> (events: [EventInfo], hasMore: Bool) {
        let startDate = Date(timeIntervalSince1970: TimeInterval(startUtc))
        let endDate = Date(timeIntervalSince1970: TimeInterval(endUtc))

        var calendars: [EKCalendar]? = nil
        if let ids = calendarIds, !ids.isEmpty {
            calendars = ids.compactMap { store.calendar(withIdentifier: $0) }
        }

        let predicate = store.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
        let allEvents = store.events(matching: predicate)
            .sorted { ($0.startDate ?? Date.distantPast) < ($1.startDate ?? Date.distantPast) }

        let paged = Array(allEvents.dropFirst(offset).prefix(limit + 1))
        let hasMore = paged.count > limit
        let results = Array(paged.prefix(limit))

        return (results.map { mapEvent($0, includeNotes: includeNotes, notesMaxChars: notesMaxChars) }, hasMore)
    }

    func searchEvents(query: String, startUtc: Int, endUtc: Int, calendarIds: [String]?, includeNotes: Bool, notesMaxChars: Int, limit: Int, offset: Int) -> (events: [EventInfo], hasMore: Bool) {
        let startDate = Date(timeIntervalSince1970: TimeInterval(startUtc))
        let endDate = Date(timeIntervalSince1970: TimeInterval(endUtc))

        var calendars: [EKCalendar]? = nil
        if let ids = calendarIds, !ids.isEmpty {
            calendars = ids.compactMap { store.calendar(withIdentifier: $0) }
        }

        let predicate = store.predicateForEvents(withStart: startDate, end: endDate, calendars: calendars)
        let lowerQuery = query.lowercased()

        let matched = store.events(matching: predicate)
            .filter { ev in
                let title = ev.title?.lowercased() ?? ""
                let location = ev.location?.lowercased() ?? ""
                let notes = ev.notes?.lowercased() ?? ""
                let url = ev.url?.absoluteString.lowercased() ?? ""
                return title.contains(lowerQuery) || location.contains(lowerQuery) ||
                       notes.contains(lowerQuery) || url.contains(lowerQuery)
            }
            .sorted { a, b in
                // Title matches first, then by startDate
                let aTitle = (a.title?.lowercased() ?? "").contains(lowerQuery)
                let bTitle = (b.title?.lowercased() ?? "").contains(lowerQuery)
                if aTitle != bTitle { return aTitle }
                return (a.startDate ?? Date.distantPast) < (b.startDate ?? Date.distantPast)
            }

        let paged = Array(matched.dropFirst(offset).prefix(limit + 1))
        let hasMore = paged.count > limit
        let results = Array(paged.prefix(limit))

        return (results.map { mapEvent($0, includeNotes: includeNotes, notesMaxChars: notesMaxChars) }, hasMore)
    }

    func getEvent(identifier: String, includeNotes: Bool, notesMaxChars: Int) -> EventInfo? {
        guard let event = store.event(withIdentifier: identifier) else { return nil }
        return mapEvent(event, includeNotes: includeNotes, notesMaxChars: notesMaxChars)
    }

    // MARK: - Helpers

    private func mapEvent(_ event: EKEvent, includeNotes: Bool, notesMaxChars: Int) -> EventInfo {
        var notes: String? = nil
        if includeNotes, let n = event.notes {
            if n.count > notesMaxChars {
                notes = String(n.prefix(notesMaxChars)) + "…"
            } else {
                notes = n
            }
        }

        return EventInfo(
            eventIdentifier: event.eventIdentifier,
            calendarId: event.calendar?.calendarIdentifier ?? "",
            calendarName: event.calendar?.title ?? "",
            title: event.title ?? "",
            location: event.location,
            url: event.url?.absoluteString,
            notes: notes,
            startUtc: Int(event.startDate.timeIntervalSince1970),
            endUtc: Int(event.endDate.timeIntervalSince1970),
            allDay: event.isAllDay,
            lastModifiedUtc: event.lastModifiedDate.map { Int($0.timeIntervalSince1970) }
        )
    }

    private func calendarTypeString(_ type: EKCalendarType) -> String {
        switch type {
        case .local: return "local"
        case .calDAV: return "calDAV"
        case .exchange: return "exchange"
        case .subscription: return "subscription"
        case .birthday: return "birthday"
        @unknown default: return "unknown"
        }
    }
}
