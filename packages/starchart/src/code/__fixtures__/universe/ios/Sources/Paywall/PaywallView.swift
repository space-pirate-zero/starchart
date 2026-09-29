import SwiftUI
import RevenueCat

/// The paywall. Braces in comments { and strings "}" must not confuse the scanner.
struct PaywallView: View {
    @State private var isPurchasing = false

    var body: some View {
        VStack(spacing: 16) {
            Text("paywall.title")
            Text("\(Pricing.proUSD) per month")
            Text(verbatim: "not a key")
            if PostHogSDK.shared.isFeatureEnabled("new-paywall") {
                Text("New!")
            }
            Button("Subscribe") {
                purchase(ProductID.proMonthly)
            }
        }
    }

    private func purchase(_ id: String) {
        isPurchasing = true
        Purchases.shared.getProducts([id]) { _ in }
    }
}

#Preview {
    PaywallView()
}
