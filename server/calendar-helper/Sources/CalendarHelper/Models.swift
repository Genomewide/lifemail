import Foundation

struct CalendarInfo: Codable {
    let calendarId: String
    let title: String
    let sourceTitle: String
    let type: String
    let allowsModifications: Bool
    let isHidden: Bool
}

struct EventInfo: Codable {
    let eventIdentifier: String
    let calendarId: String
    let calendarName: String
    let title: String
    let location: String?
    let url: String?
    let notes: String?
    let startUtc: Int
    let endUtc: Int
    let allDay: Bool
    let lastModifiedUtc: Int?
}
