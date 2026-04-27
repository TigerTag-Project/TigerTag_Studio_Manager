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

import os
import requests

# List of URLs and corresponding filenames to download
json_files = [
    ("https://api.tigertag.io/api:tigertag/version/get/all", "id_version.json"),
    ("https://api.tigertag.io/api:tigertag/material/get/all", "id_material.json"),
    ("https://api.tigertag.io/api:tigertag/aspect/get/all", "id_aspect.json"),
    ("https://api.tigertag.io/api:tigertag/type/get/all", "id_type.json"),
    ("https://api.tigertag.io/api:tigertag/diameter/filament/get/all", "id_diameter.json"),
    ("https://api.tigertag.io/api:tigertag/brand/get/all", "id_brand.json"),
    ("https://api.tigertag.io/api:tigertag/measure_unit/get/all", "id_measure_unit.json")
]

# Target folder
target_folder = os.path.dirname(os.path.abspath(__file__))

def download_json_files():
    for url, filename in json_files:
        file_path = os.path.join(target_folder, filename)
        try:
            print(f"Downloading {url}...")
            response = requests.get(url)
            response.raise_for_status()
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(response.text)
            print(f"Saved: {file_path}")
        except Exception as e:
            print(f"Failed to download {url}: {e}")

if __name__ == "__main__":
    download_json_files()