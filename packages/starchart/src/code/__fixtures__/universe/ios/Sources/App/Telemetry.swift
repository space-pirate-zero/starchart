import Foundation
import Sentry

enum Telemetry {
    static func start() {
        let dsn = ProcessInfo.processInfo.environment["SENTRY_DSN"]
        SentrySDK.start { options in options.dsn = dsn }
        Analytics.track("app_opened")
    }
}
