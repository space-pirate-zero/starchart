import SwiftUI
import RevenueCat

struct PaywallView: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("paywall.title")
            ForEach(Entitlements.proFeatures, id: \.self) { feature in
                Label(feature, systemImage: "sparkles")
            }
            Text(Pricing.display(Pricing.proUSD))
            Button("Go Pro") {
                Purchases.shared.getProducts([ProductID.proMonthly]) { _ in }
            }
        }
    }
}
