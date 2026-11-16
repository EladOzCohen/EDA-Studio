"""Generate sample_data/sales_sample.csv (synthetic, with real structure to explore)."""
from pathlib import Path

import numpy as np
import pandas as pd

rng = np.random.default_rng(7)
n = 6000
dates = pd.to_datetime("2023-01-01") + pd.to_timedelta(rng.integers(0, 730, n), unit="D")
region = rng.choice(["North", "South", "East", "West"], n, p=[.3, .2, .3, .2])
category = rng.choice(["Electronics", "Clothing", "Home", "Sports", "Books"], n, p=[.25, .25, .2, .2, .1])
channel = rng.choice(["Online", "Store"], n, p=[.6, .4])
age = np.clip(rng.normal(40, 12, n).round(), 18, 80)
price = np.round(rng.lognormal(3.5, .6, n) * (1 + .3 * (category == "Electronics")), 2)
discount = np.round(rng.choice([0, 0, 0, .05, .1, .2], n) + .02 * (channel == "Online"), 2)
units = rng.poisson(2.2 + 0.8 * (channel == "Online"), n) + 1
season = 1 + .15 * np.sin((dates.month - 3) / 12 * 2 * np.pi)
revenue = np.round(price * units * (1 - discount) * season, 2)
satisfaction = np.clip(np.round(3.2 + .01 * (age - 40) - 1.5 * discount + .25 * (channel == "Store") + rng.normal(0, .8, n), 1), 1, 5)
df = pd.DataFrame(dict(order_date=dates.date, region=region, category=category, channel=channel, customer_age=age.astype(int),
                       unit_price=price, units=units, discount=discount, revenue=revenue, satisfaction=satisfaction))
df.loc[rng.random(n) < .03, "satisfaction"] = np.nan
out = Path(__file__).parent.parent / "sample_data"
out.mkdir(exist_ok=True)
df.to_csv(out / "sales_sample.csv", index=False)
df.head(500).to_json(out / "sales_sample.ndjson", orient="records", lines=True, date_format="iso")
print("wrote", len(df), "rows")
