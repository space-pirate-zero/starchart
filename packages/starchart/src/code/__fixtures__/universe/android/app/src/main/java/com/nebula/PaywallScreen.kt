package com.nebula

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.revenuecat.purchases.Purchases
import com.posthog.PostHog

@Composable
fun PaywallScreen(modifier: Modifier = Modifier) {
    val title = stringResource(R.string.paywall_title)
    val price = Pricing.PRO_USD
    val apiUrl = System.getenv("API_URL")
    if (PostHog.isFeatureEnabled("new-paywall")) {
        PostHog.capture("paywall_shown")
    }
    Purchases.sharedInstance.getOfferings()
}
