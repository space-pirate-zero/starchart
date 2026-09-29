import XCTest
@testable import Nebula

final class PaywallTests: XCTestCase {
    func testPaywallRenders() {
        let view = PaywallView()
        XCTAssertNotNil(view.body)
    }
}
