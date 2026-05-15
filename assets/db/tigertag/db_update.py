# TigerTag RFID Guide
# Copyright (C) 2025 TigerTag
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

# Plug-and-play live-API sync for the TigerTag reference JSONs.
#
# What it does on each run:
#   1. Calls the API's all/last_update endpoint
#   2. Compares every per-dataset timestamp to the local last_update.json
#   3. Downloads only the files whose server-side timestamp has changed
#
# First run downloads everything; subsequent runs are no-ops when nothing
# has changed server-side. Drop this script wherever you want the JSON
# files to live and run it — no other setup needed.
#
# If you don't need real-time freshness, prefer Download_all_id_DB_GitHub.py:
# it pulls the same files from the auto-synced GitHub mirror via the GitHub
# CDN, which avoids any load on the TigerTag API.

import json
import os
import sys

import requests

API_BASE = "https://api.tigertag.io/api:tigertag"
HTTP_TIMEOUT = 30

# last_update key  ->  (API endpoint path,           local filename)
DATASETS = {
    "versions":           ("version/get/all",            "id_version.json"),
    "types":              ("type/get/all",               "id_type.json"),
    "brands":             ("brand/get/all",              "id_brand.json"),
    "filament_diameters": ("diameter/filament/get/all",  "id_diameter.json"),
    "filament_materials": ("material/get/all",           "id_material.json"),
    "aspects":            ("aspect/get/all",             "id_aspect.json"),
    "measure_units":      ("measure_unit/get/all",       "id_measure_unit.json"),
}

TARGET_FOLDER = os.path.dirname(os.path.abspath(__file__))
LAST_UPDATE_PATH = os.path.join(TARGET_FOLDER, "last_update.json")


def load_local_last_update():
    if not os.path.exists(LAST_UPDATE_PATH):
        return {}
    try:
        with open(LAST_UPDATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def fetch_remote_last_update():
    response = requests.get(f"{API_BASE}/all/last_update", timeout=HTTP_TIMEOUT)
    response.raise_for_status()
    return response.json(), response.text


def download_dataset(endpoint, filename):
    url = f"{API_BASE}/{endpoint}"
    response = requests.get(url, timeout=HTTP_TIMEOUT)
    response.raise_for_status()
    try:
        data = response.json()
    except ValueError as e:
        raise RuntimeError(f"Invalid JSON received for {filename}: {e}")
    with open(os.path.join(TARGET_FOLDER, filename), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def sync():
    remote_data, remote_text = fetch_remote_last_update()
    local_data = load_local_last_update()

    updated = []
    for key, (endpoint, filename) in DATASETS.items():
        remote_ts = remote_data.get(key)
        local_ts = local_data.get(key)
        local_file = os.path.join(TARGET_FOLDER, filename)

        if remote_ts is None:
            print(f"[skip] {key}: not present in API last_update payload")
            continue

        if remote_ts == local_ts and os.path.exists(local_file):
            print(f"[ok]   {filename}: up to date ({remote_ts})")
            continue

        print(f"[sync] {filename}: {local_ts} -> {remote_ts}")
        download_dataset(endpoint, filename)
        updated.append(filename)

    if updated or local_data != remote_data:
        with open(LAST_UPDATE_PATH, "w", encoding="utf-8") as f:
            f.write(remote_text)
        if "last_update.json" not in updated:
            updated.append("last_update.json")

    return updated


if __name__ == "__main__":
    try:
        changed = sync()
    except requests.RequestException as exc:
        print(f"error: API request failed: {exc}", file=sys.stderr)
        sys.exit(1)

    if changed:
        print(f"\nUpdated {len(changed)} file(s):")
        for name in changed:
            print(f"  {name}")
    else:
        print("\nAll datasets already up to date.")