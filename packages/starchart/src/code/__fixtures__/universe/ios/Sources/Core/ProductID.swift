import Foundation

enum ProductID {
    // @starchart anchors addon:pro.productId
    static let proMonthly = "pro_monthly"
    static let proYearly = "pro_yearly"
}

enum Plan: String {
    case monthly, yearly = "annual"
    case lifetime
}
