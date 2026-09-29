import Sentry

enum Telemetry {
    static func start() {
        SentrySDK.start { options in
            options.dsn = ProcessInfo.processInfo.environment["SENTRY_DSN"]
        }
    }
}
