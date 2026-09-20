"""
generate_asi_reference_sites.py

Queries Wikidata for every item carrying the "heritage designation:
Monument of National Importance (India)" property (Q1568593) — the
standard tag Wikidata uses for centrally ASI-protected monuments — and
writes a CSV formatted for import into the `reference_sites` table (see
supabase-schema.sql).

WHY THIS IS A SEPARATE SCRIPT, NOT SOMETHING THE APP DOES ITSELF:
This needs to reach query.wikidata.org, which is a bulk, one-time data
import, not something that belongs in a user-facing web app. Run it once,
on your own machine, whenever you want to (re)build the reference dataset.

Usage:
    pip install requests
    python generate_asi_reference_sites.py > reference_sites_seed.csv

Then in Supabase: Table Editor -> reference_sites -> Insert -> Import data
from CSV, and pick the file you just generated. (The "category" column is
left blank by this script — Wikidata's monument-type data doesn't map
cleanly onto this app's five categories, so it's left for manual tagging,
or you can extend the SPARQL query below with wdt:P31 to attempt it.)
"""
import csv
import sys

import requests

SPARQL_ENDPOINT = "https://query.wikidata.org/sparql"

QUERY = """
SELECT ?siteLabel ?stateLabel ?coord ?image WHERE {
  ?site wdt:P1435 wd:Q1568593.   # heritage designation: Monument of National Importance (India)
  OPTIONAL { ?site wdt:P625 ?coord. }
  OPTIONAL { ?site wdt:P131 ?state. }
  OPTIONAL { ?site wdt:P18 ?image. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""


def main():
    resp = requests.get(
        SPARQL_ENDPOINT,
        params={"query": QUERY, "format": "json"},
        headers={"User-Agent": "heritage-mapping-reference-import/1.0 (student mini-project)"},
        timeout=120,
    )
    resp.raise_for_status()
    rows = resp.json()["results"]["bindings"]

    writer = csv.writer(sys.stdout)
    writer.writerow(["name", "state", "lat", "lng", "image_url", "image_attribution", "source"])

    seen = set()
    for row in rows:
        name = row.get("siteLabel", {}).get("value", "").strip()
        if not name or name in seen:
            continue
        seen.add(name)

        state = row.get("stateLabel", {}).get("value", "")
        coord = row.get("coord", {}).get("value", "")  # WKT "Point(lng lat)"
        image = row.get("image", {}).get("value", "")

        lat = lng = ""
        if coord.startswith("Point(") and coord.endswith(")"):
            lng_str, lat_str = coord[6:-1].split(" ")
            lat, lng = lat_str, lng_str

        if not lat or not lng:
            continue  # skip entries with no known coordinate — not usable for distance checks

        writer.writerow([
            name,
            state,
            lat,
            lng,
            image,
            "Image via Wikimedia Commons — open the file page for the photographer and licence" if image else "",
            "Wikidata (Monument of National Importance, India)",
        ])

    print(f"Wrote {len(seen)} sites.", file=sys.stderr)


if __name__ == "__main__":
    main()
