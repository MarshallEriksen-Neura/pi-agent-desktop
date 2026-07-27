#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a Tauri updater latest.json manifest from local release assets.",
    )
    parser.add_argument("--assets-dir", required=True, help="Directory containing release assets")
    parser.add_argument("--repo", required=True, help="GitHub repo slug, e.g. owner/name")
    parser.add_argument("--release-tag", required=True, help="Release tag, e.g. v1.2.3")
    parser.add_argument("--version", help="Manifest version. Defaults to release tag without leading v")
    parser.add_argument(
        "--metadata-json",
        help="Optional JSON file with GitHub release metadata (body, publishedAt).",
    )
    parser.add_argument("--notes", default="", help="Release notes/body")
    parser.add_argument(
        "--pub-date",
        help="RFC3339 publication date. Defaults to current UTC time if omitted.",
    )
    parser.add_argument("--output", required=True, help="Path to write latest.json")
    return parser.parse_args()


def asset_url(repo: str, release_tag: str, filename: str) -> str:
    return f"https://github.com/{repo}/releases/download/{release_tag}/{filename}"


def read_signature(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def normalize_pub_date(pub_date: str | None) -> str:
    if pub_date:
        return pub_date
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def collect_assets(assets_dir: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    for path in sorted(assets_dir.rglob("*")):
        if not path.is_file():
            continue
        existing = files.get(path.name)
        if existing is not None:
            raise SystemExit(
                f"duplicate asset basename found: {path.name} at {existing} and {path}"
            )
        files[path.name] = path
    return files


def require_asset(assets: dict[str, Path], predicate, label: str) -> Path | None:
    matches = [path for path in assets.values() if predicate(path.name.lower())]
    if not matches:
        return None
    if len(matches) > 1:
        names = ", ".join(sorted(path.name for path in matches))
        raise SystemExit(f"multiple assets matched {label}: {names}")
    return matches[0]


def build_entry(repo: str, release_tag: str, asset_path: Path, sig_path: Path) -> dict[str, str]:
    return {
        "signature": read_signature(sig_path),
        "url": asset_url(repo, release_tag, asset_path.name),
    }


def main() -> None:
    args = parse_args()
    assets_dir = Path(args.assets_dir)
    output_path = Path(args.output)
    assets = collect_assets(assets_dir)

    repo = args.repo
    release_tag = args.release_tag
    version = (args.version or release_tag).removeprefix("v")
    notes = args.notes
    pub_date = args.pub_date
    if args.metadata_json:
        metadata = json.loads(Path(args.metadata_json).read_text(encoding="utf-8"))
        notes = metadata.get("body", notes)
        pub_date = metadata.get("publishedAt", pub_date)
    pub_date = normalize_pub_date(pub_date)

    platforms: dict[str, dict[str, str]] = {}

    def add_target(target: str, asset_path: Path | None) -> None:
        if asset_path is None:
            return
        sig_path = assets.get(f"{asset_path.name}.sig")
        if sig_path is None:
            raise SystemExit(f"missing signature asset for {asset_path.name}")
        platforms[target] = build_entry(repo, release_tag, asset_path, sig_path)

    windows_nsis = require_asset(
        assets,
        lambda name: name.endswith("_x64-setup.exe"),
        "windows nsis bundle",
    )
    windows_msi = require_asset(
        assets,
        lambda name: name.endswith(".msi") and not name.endswith(".msi.sig"),
        "windows msi bundle",
    )
    macos_arm = require_asset(
        assets,
        lambda name: name.endswith("_aarch64.app.tar.gz"),
        "macOS arm updater bundle",
    )
    macos_x64 = require_asset(
        assets,
        lambda name: name.endswith("_x86_64.app.tar.gz"),
        "macOS x64 updater bundle",
    )
    linux_appimage = require_asset(
        assets,
        lambda name: name.endswith(".appimage"),
        "linux appimage bundle",
    )
    linux_deb = require_asset(
        assets,
        lambda name: name.endswith(".deb"),
        "linux deb bundle",
    )
    linux_rpm = require_asset(
        assets,
        lambda name: name.endswith(".rpm"),
        "linux rpm bundle",
    )

    add_target("windows-x86_64-nsis", windows_nsis)
    add_target("windows-x86_64-msi", windows_msi)
    add_target("windows-x86_64", windows_nsis or windows_msi)

    add_target("darwin-aarch64-app", macos_arm)
    add_target("darwin-aarch64", macos_arm)
    add_target("darwin-x86_64-app", macos_x64)
    add_target("darwin-x86_64", macos_x64)

    add_target("linux-x86_64-appimage", linux_appimage)
    add_target("linux-x86_64-deb", linux_deb)
    add_target("linux-x86_64-rpm", linux_rpm)
    add_target("linux-x86_64", linux_appimage or linux_deb or linux_rpm)

    if not platforms:
        raise SystemExit(f"no updater-capable assets found under {assets_dir}")

    manifest = {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": platforms,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
