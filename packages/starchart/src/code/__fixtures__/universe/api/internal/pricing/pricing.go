package pricing

// ProMonthly is the store product id.
const ProMonthly = "pro_monthly"

const (
	ProUSD   = 4.99
	Currency = "usd"
)

var Features = []string{"themes", "sync"}

type Plan struct {
	ID    string
	Price float64
}

func (p *Plan) Total() float64 {
	return p.Price + ProUSD
}
