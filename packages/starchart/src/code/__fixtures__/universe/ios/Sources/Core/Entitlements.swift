import Foundation

enum Entitlements {
    static let proFeatures = ["themes", "sync"]

    static let legalCopy = """
        Pro renews monthly. } struct Fake {
        Cancel anytime.
        """

    /* nested /* block */ comment with struct Decoy { */
    static let raw = #"a "quoted" \(value)"#

    static func isPro(_ features: [String]) -> Bool {
        features.contains(proFeatures[0])
    }
}
