package com.nebula

object Pricing {
    const val PRO_USD = 4.99
    val FEATURES = listOf("themes", "sync")
    val LABEL = "Pro ${PRO_USD}"
}

enum class Tier(val productId: String) {
    PRO("pro_monthly"),
    FREE("free");

    fun isPaid(): Boolean = this == PRO
}
