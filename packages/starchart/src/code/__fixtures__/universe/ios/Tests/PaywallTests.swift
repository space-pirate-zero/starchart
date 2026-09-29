import XCTest
@testable import Nebula

final class PaywallTests: XCTestCase {
    func testPaywallShowsPrice() {
        let view = PaywallView()
        XCTAssertNotNil(view.body)
        XCTAssertEqual(Pricing.proUSD, 4.99)
    }
}
