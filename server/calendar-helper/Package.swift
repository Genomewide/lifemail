// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CalendarHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "calendar-helper",
            path: "Sources/CalendarHelper"
        )
    ]
)
