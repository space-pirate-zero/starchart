package main

import (
	"fmt"
	"os"

	"example.com/nebula/api/internal/pricing"
	stripe "github.com/stripe/stripe-go/v76"
)

func main() {
	stripe.Key = os.Getenv("STRIPE_KEY")
	fmt.Println(pricing.ProUSD, pricing.Features)
}
