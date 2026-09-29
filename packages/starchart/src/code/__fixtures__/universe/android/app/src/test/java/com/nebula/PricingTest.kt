package com.nebula

import org.junit.Test

class PricingTest {
    @Test
    fun `pro costs 4_99`() {
        assert(Pricing.PRO_USD == 4.99)
        assert(Tier.PRO.isPaid())
    }
}
