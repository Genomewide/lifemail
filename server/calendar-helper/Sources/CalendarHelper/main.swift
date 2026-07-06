import Foundation
import EventKit

let config = AppConfig.parse(CommandLine.arguments)
AppConfig.shared = config

switch config.mode {
case .requestAccess:
    Log.info("Requesting calendar access...")
    let semaphore = DispatchSemaphore(value: 0)
    var exitCode: Int32 = 0

    Task {
        let result = await EventKitService.shared.requestAccess()
        if result.authorized {
            Log.info("Calendar access granted (status: \(result.status))")
            print("Calendar access: \(result.status)")
            exitCode = 0
        } else {
            Log.error("Calendar access denied (status: \(result.status))")
            print("Calendar access: \(result.status)")
            exitCode = 2
        }
        semaphore.signal()
    }
    semaphore.wait()
    exit(exitCode)

case .printAuthStatus:
    let status = EventKitService.shared.authorizationStatus
    print("Calendar authorization status: \(status)")
    exit(status == "authorized" ? 0 : 2)

case .serve:
    Log.info("Starting calendar-helper server on \(config.bindAddress):\(config.port)")

    if !EventKitService.shared.isAuthorized {
        Log.warn("Calendar access not authorized. Non-health endpoints will return NOT_AUTHORIZED.")
        Log.warn("Run: calendar-helper --request-access")
    }

    let server = HttpServer(port: config.port, bindAddress: config.bindAddress)
    do {
        try server.start() // blocks forever
    } catch {
        Log.error("Server failed to start: \(error)")
        exit(10)
    }
}
