"""Shared sector taxonomy for holdings, sector performance and sector news."""

SECTORS = [
    {"id": "communication_services", "name": "Communication Services", "us": "XLC", "global": "IXP"},
    {"id": "consumer_discretionary", "name": "Consumer Discretionary", "us": "XLY", "global": "RXI"},
    {"id": "consumer_staples", "name": "Consumer Staples", "us": "XLP", "global": "KXI"},
    {"id": "energy", "name": "Energy", "us": "XLE", "global": "IXC"},
    {"id": "financials", "name": "Financials", "us": "XLF", "global": "IXG"},
    {"id": "health_care", "name": "Health Care", "us": "XLV", "global": "IXJ"},
    {"id": "industrials", "name": "Industrials", "us": "XLI", "global": "EXI"},
    {"id": "information_technology", "name": "Information Technology", "us": "XLK", "global": "IXN"},
    {"id": "materials", "name": "Materials", "us": "XLB", "global": "MXI"},
    {"id": "real_estate", "name": "Real Estate", "us": "XLRE", "global": "REET"},
    {"id": "utilities", "name": "Utilities", "us": "XLU", "global": "JXI"},
]

SECTOR_NAMES = {sector["name"] for sector in SECTORS}
SECTOR_BY_NAME = {sector["name"]: sector for sector in SECTORS}

# Provider (Yahoo Finance) sector labels mapped onto the GICS-style names above.
_PROVIDER_LABELS = {
    "technology": "Information Technology",
    "information technology": "Information Technology",
    "financial services": "Financials",
    "financial": "Financials",
    "financials": "Financials",
    "healthcare": "Health Care",
    "health care": "Health Care",
    "consumer cyclical": "Consumer Discretionary",
    "consumer discretionary": "Consumer Discretionary",
    "consumer defensive": "Consumer Staples",
    "consumer staples": "Consumer Staples",
    "basic materials": "Materials",
    "materials": "Materials",
    "communication services": "Communication Services",
    "energy": "Energy",
    "industrials": "Industrials",
    "real estate": "Real Estate",
    "utilities": "Utilities",
}


def normalize_sector(value):
    """Return the shared sector name for a provider label, or None when unknown."""
    if not isinstance(value, str):
        return None
    return _PROVIDER_LABELS.get(" ".join(value.split()).casefold())
