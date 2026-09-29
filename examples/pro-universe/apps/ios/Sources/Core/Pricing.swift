import Foundation

enum Pricing {
    // @starchart anchors addon:pro.price.usd
    static let proUSD = 4.99

    static func display(_ amount: Double) -> String {
        String(format: "$%.2f", amount)
    }
}
