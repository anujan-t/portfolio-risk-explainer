# Portfolio Risk Explainer

Upload a brokerage CSV, get your portfolio's risk in plain English.

Most retail investors can see what they own but not what they are exposed to.
This reads a holdings export, computes the standard risk measures, and runs an
LLM narration layer over the results so the output is a paragraph rather than a
wall of ratios.

**Stack:** Python · pandas · NumPy · LLM API (narration layer)

## Status

In progress. The metrics layer runs; narration layer next.

- [x] Holdings ingest and weight calculation
- [x] Concentration: HHI, effective positions, top-N and sector exposure
- [x] Annualised volatility and beta against a benchmark
- [ ] LLM narration layer
- [ ] Web upload interface
- [ ] Position-level drill-downs, broker sync, multi-account

## Try it

```bash
pip install -r requirements.txt
python risk.py data/sample_holdings.csv --prices data/sample_prices.csv
```

Sample output:

```
Concentration
  positions                6
  hhi                      0.1810
  effective_positions      5.5242
  largest_position         AAPL
  largest_weight           0.2459
  top_3_weight             0.6361
  largest_sector           Technology
  largest_sector_weight    0.5615

Market Risk
  annual_volatility        0.1769
  beta                     1.0865
```

Six positions, but an HHI of 0.18 means it behaves like roughly 5.5 equally
weighted ones, and 56% of it is a single sector. That is the kind of thing the
narration layer will say out loud.

## Input format

`holdings.csv` needs `ticker`, `shares`, `price`. A `sector` column is optional
and unlocks sector concentration.

```csv
ticker,shares,price,sector
AAPL,40,232.50,Technology
```

`prices.csv` is optional, one row per date, one column per ticker plus the
benchmark.

## Notes

Sample data is synthetic. Real brokerage exports are gitignored.
