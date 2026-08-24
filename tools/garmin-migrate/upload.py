#!/usr/bin/env python3
"""Bulk-upload garmin-migrate output to Garmin Connect.

Usage:
    python3 -m pip install garminconnect
    python3 upload.py ./garmin-out

Uploads every TCX in <outdir>/tcx/ as an activity and every row of
<outdir>/weight.csv as a body-composition entry. Credentials are prompted
(MFA supported); a session token is cached in ~/.garmin-migrate-tokens so
re-runs don't re-prompt. Garmin rejects exact-duplicate activity uploads,
so re-running after a partial failure is safe.
"""

import csv
import getpass
import sys
import time
from pathlib import Path

try:
    from garminconnect import Garmin
except ImportError:
    sys.exit("Missing dependency: python3 -m pip install garminconnect")

TOKEN_DIR = Path.home() / ".garmin-migrate-tokens"


def login() -> Garmin:
    api = Garmin()
    try:
        api.login(str(TOKEN_DIR))
        print("Logged in with cached Garmin session.")
        return api
    except Exception:
        pass
    email = input("Garmin email: ")
    password = getpass.getpass("Garmin password: ")
    api = Garmin(email=email, password=password, return_on_mfa=False)
    api.login()
    try:
        api.garth.dump(str(TOKEN_DIR))
    except Exception:
        pass
    return api


def upload_activities(api: Garmin, tcx_dir: Path) -> None:
    files = sorted(tcx_dir.glob("*.tcx"))
    print(f"Uploading {len(files)} activities...")
    ok = dup = failed = 0
    for i, f in enumerate(files, 1):
        try:
            api.upload_activity(str(f))
            ok += 1
        except Exception as e:  # noqa: BLE001
            if "409" in str(e) or "duplicate" in str(e).lower():
                dup += 1
            else:
                failed += 1
                print(f"  FAILED {f.name}: {e}")
        if i % 20 == 0:
            print(f"  {i}/{len(files)}")
            time.sleep(2)  # be gentle with Garmin's rate limits
    print(f"Activities: {ok} uploaded, {dup} already existed, {failed} failed.")


def upload_weight(api: Garmin, csv_path: Path) -> None:
    if not csv_path.exists():
        return
    rows = list(csv.DictReader(csv_path.open()))
    print(f"Uploading {len(rows)} weight entries...")
    ok = failed = 0
    for i, row in enumerate(rows, 1):
        try:
            kwargs = {"timestamp": row["timestamp_iso"]}
            if row.get("weight_kg"):
                kwargs["weight"] = float(row["weight_kg"])
            if row.get("body_fat_pct"):
                kwargs["percent_fat"] = float(row["body_fat_pct"])
            if "weight" not in kwargs and "percent_fat" not in kwargs:
                continue
            api.add_body_composition(**kwargs)
            ok += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAILED {row['timestamp_iso']}: {e}")
        if i % 50 == 0:
            print(f"  {i}/{len(rows)}")
            time.sleep(1)
    print(f"Weight: {ok} uploaded, {failed} failed.")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 upload.py <outdir from the migrate CLI>")
    out = Path(sys.argv[1])
    if not (out / "tcx").is_dir():
        sys.exit(f"{out}/tcx not found — run the migrate CLI first.")
    api = login()
    upload_activities(api, out / "tcx")
    upload_weight(api, out / "weight.csv")
    print("Done. Check https://connect.garmin.com/modern/activities")


if __name__ == "__main__":
    main()
