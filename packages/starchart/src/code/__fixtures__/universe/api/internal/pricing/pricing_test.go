package pricing

import "testing"

func TestTotal(t *testing.T) {
	p := Plan{ID: ProMonthly}
	if p.Total() < ProUSD {
		t.Fatal("bad total")
	}
}
