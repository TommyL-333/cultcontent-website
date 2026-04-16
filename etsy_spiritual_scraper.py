"""
Etsy Spiritual Brand Scraper for Cult Content
Pulls shop data across spiritual/metaphysical/wellness categories
Output: CSV ready for GHL import

Usage:
    pip install requests pandas tqdm
    python etsy_spiritual_scraper.py --api-key YOUR_KEY_HERE

Optional flags:
    --limit 2000          Total unique shops to collect (default: 3000)
    --output brands.csv   Output filename (default: etsy_spiritual_brands.csv)
    --delay 0.5           Seconds between requests (default: 0.3)
"""

import requests
import pandas as pd
import time
import argparse
from tqdm import tqdm
from datetime import datetime

# ── Search keywords covering the niche ──────────────────────────────────────
SEARCH_QUERIES = [
    # Core spiritual
    "scrying mirror",
    "crystal healing shop",
    "ritual candles",
    "tarot cards handmade",
    "oracle deck",
    "singing bowl",
    "selenite crystal",
    "altar supplies",
    "witchcraft supplies",
    "spell candles",
    "moon ritual",
    "smudge bundle sage",
    "pendulum divination",
    "spiritual jewelry",
    "rune set",
    # Sound healing
    "sound healing bowl",
    "tuning fork healing",
    "crystal singing bowl",
    # Supplements / wellness
    "mushroom supplement spiritual",
    "herbal tincture wellness",
    "adaptogen blend",
    "cacao ceremony",
    "spiritual supplements",
    "reishi mushroom blend",
    # Conscious beauty
    "ritual skincare",
    "crystal infused beauty",
    "moon water skincare",
    "intention setting beauty",
    "chakra skincare",
    # Home / lifestyle
    "sacred geometry art",
    "crystal grid",
    "metaphysical home decor",
    "astrology gifts",
    "manifestation journal",
    "energy clearing",
]

BASE_URL = "https://openapi.etsy.com/v3/application"


def get_listings(api_key, query, limit=100, offset=0, delay=0.3):
    """Fetch active listings for a search query with exponential backoff on 429."""
    url = f"{BASE_URL}/listings/active"
    params = {
        "keywords": query,
        "limit": min(limit, 100),  # Etsy max per page is 100
        "offset": offset,
        "includes": "shop",
        "sort_on": "score",
        "sort_order": "desc",
    }
    headers = {"x-api-key": api_key}

    backoff = 10
    for attempt in range(5):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=15)
            if r.status_code == 200:
                return r.json()
            elif r.status_code == 429:
                tqdm.write(f"\n  Rate limited — sleeping {backoff}s (attempt {attempt + 1}/5)...")
                time.sleep(backoff)
                backoff = min(backoff * 2, 120)
                continue
            elif r.status_code == 403:
                tqdm.write("\n  Invalid API key or key lacks required scopes.")
                return None
            elif r.status_code == 400:
                tqdm.write(f"\n  Bad request for query '{query}': {r.text[:200]}")
                return None
            else:
                tqdm.write(f"\n  HTTP {r.status_code} for query '{query}' — skipping")
                return None
        except requests.exceptions.RequestException as e:
            tqdm.write(f"\n  Request error: {e}")
            if attempt < 4:
                time.sleep(backoff)
                backoff = min(backoff * 2, 120)
            else:
                return None
    return None


def extract_shop_data(listing, source_query):
    """Extract relevant fields from a listing's embedded shop data."""
    shop = listing.get("shop") or {}

    shop_name = shop.get("shop_name", "")
    shop_id = str(listing.get("shop_id") or shop.get("shop_id", ""))
    shop_url = f"https://www.etsy.com/shop/{shop_name}" if shop_name else ""
    title = shop.get("title", "")
    sales_count = shop.get("transaction_sold_count", 0) or 0

    # Price handling
    price_info = listing.get("price") or {}
    divisor = max(price_info.get("divisor", 100) or 100, 1)
    amount = price_info.get("amount", 0) or 0

    return {
        "shop_name": shop_name,
        "shop_id": shop_id,
        "shop_url": shop_url,
        "shop_title": title,
        "sales_count": sales_count,
        "listing_title": listing.get("title", ""),
        "tags": ", ".join(listing.get("tags", [])),
        "source_query": source_query,
        "scraped_at": datetime.now().strftime("%Y-%m-%d"),
    }


def size_tier(sales):
    if sales >= 10000:
        return "Large (10k+ sales)"
    elif sales >= 1000:
        return "Medium (1k-10k sales)"
    elif sales >= 100:
        return "Small (100-1k sales)"
    else:
        return "Micro (<100 sales)"


def scrape_etsy(api_key, total_limit=3000, delay=0.3, output_file="etsy_spiritual_brands.csv"):
    """Main scraper loop — deduplicates by shop_id across all queries."""

    print(f"\n  Cult Content — Etsy Spiritual Brand Scraper")
    print(f"  Target : {total_limit} unique shops")
    print(f"  Queries: {len(SEARCH_QUERIES)}")
    print(f"  Output : {output_file}\n")

    all_shops = {}  # shop_id -> data
    per_query_target = max(100, (total_limit // len(SEARCH_QUERIES)) + 50)  # slight overshoot per query

    query_bar = tqdm(SEARCH_QUERIES, desc="Queries", unit="query")

    for query in query_bar:
        query_bar.set_postfix({"shops": len(all_shops), "query": query[:30]})
        offset = 0
        fetched_this_query = 0

        while fetched_this_query < per_query_target:
            batch_size = min(100, per_query_target - fetched_this_query)
            data = get_listings(api_key, query, limit=batch_size, offset=offset, delay=delay)

            if not data or not data.get("results"):
                break

            results = data["results"]
            count = data.get("count", len(results))

            for listing in results:
                shop_id = str(listing.get("shop_id", ""))
                if shop_id and shop_id not in all_shops:
                    shop_data = extract_shop_data(listing, query)
                    if shop_data["shop_name"]:  # skip listings with no shop data
                        all_shops[shop_id] = shop_data

            offset += len(results)
            fetched_this_query += len(results)

            # No more pages for this query
            if len(results) < batch_size or offset >= count:
                break

            # Hit global target
            if len(all_shops) >= total_limit:
                break

            time.sleep(delay)

        if len(all_shops) >= total_limit:
            tqdm.write(f"  Hit target of {total_limit} unique shops — stopping early")
            break

    # ── Build DataFrame ────────────────────────────────────────────────────
    print(f"\n  Building CSV from {len(all_shops)} unique shops...")

    df = pd.DataFrame(list(all_shops.values()))

    if df.empty:
        print("  No data collected. Check your API key and try again.")
        return df

    df = df.sort_values("sales_count", ascending=False)
    df["size_tier"] = df["sales_count"].apply(size_tier)

    # Rename to GHL-friendly column names
    df = df.rename(columns={
        "shop_name":    "First Name",
        "shop_url":     "Website",
        "shop_title":   "Company",
        "sales_count":  "Etsy Sales Count",
        "size_tier":    "Size Tier",
        "source_query": "Discovery Keyword",
        "tags":         "Product Tags",
        "shop_id":      "Etsy Shop ID",
        "listing_title":"Sample Listing",
        "scraped_at":   "Scraped Date",
    })

    # Blank fields GHL expects at import
    df["Email"] = ""
    df["Phone"] = ""
    df["Tags"] = "etsy-spiritual-prospect"

    col_order = [
        "First Name", "Company", "Website", "Email", "Phone",
        "Tags", "Size Tier", "Etsy Sales Count", "Discovery Keyword",
        "Product Tags", "Sample Listing", "Etsy Shop ID", "Scraped Date",
    ]
    df = df[[c for c in col_order if c in df.columns]]

    df.to_csv(output_file, index=False)

    # ── Summary ────────────────────────────────────────────────────────────
    print(f"\n{'=' * 52}")
    print(f"  Done! {len(df)} unique brands saved to {output_file}")
    print(f"\n  Size breakdown:")
    for tier, n in df["Size Tier"].value_counts().items():
        print(f"    {tier:<28} {n:>5}")
    print(f"\n  Top 10 brands by Etsy sales:")
    top10 = df[["First Name", "Etsy Sales Count", "Discovery Keyword"]].head(10)
    for _, row in top10.iterrows():
        print(f"    {row['First Name']:<30} {row['Etsy Sales Count']:>7,}  [{row['Discovery Keyword']}]")
    print(f"{'=' * 52}\n")

    return df


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Etsy Spiritual Brand Scraper — Cult Content")
    parser.add_argument("--api-key",  required=True,                           help="Etsy v3 API key (developers.etsy.com)")
    parser.add_argument("--limit",    type=int,   default=3000,                help="Target unique shops (default: 3000)")
    parser.add_argument("--output",               default="etsy_spiritual_brands.csv", help="Output CSV filename")
    parser.add_argument("--delay",    type=float, default=0.3,                 help="Seconds between requests (default: 0.3)")
    args = parser.parse_args()

    scrape_etsy(
        api_key=args.api_key,
        total_limit=args.limit,
        delay=args.delay,
        output_file=args.output,
    )
