import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class UpdaterManifestTests(unittest.TestCase):
    def test_macos_architectures_keep_their_signed_update_entries(self):
        for intel_suffix in ("x64", "x86_64"):
            with self.subTest(intel_suffix=intel_suffix), tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                assets = root / "assets"
                assets.mkdir()
                bundles = {
                    "darwin-aarch64": "Pi_aarch64.app.tar.gz",
                    "darwin-x86_64": f"Pi_{intel_suffix}.app.tar.gz",
                }
                for target, filename in bundles.items():
                    (assets / filename).write_bytes(b"bundle")
                    (assets / f"{filename}.sig").write_text(f"signature-{target}", encoding="utf-8")
                output = root / "latest.json"
                subprocess.run(
                    [
                        sys.executable,
                        str(Path(__file__).with_name("generate_updater_manifest.py")),
                        "--assets-dir", str(assets),
                        "--repo", "owner/repo",
                        "--release-tag", "v0.18.1",
                        "--output", str(output),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                manifest = json.loads(output.read_text(encoding="utf-8"))
                self.assertEqual(manifest["version"], "0.18.1")
                self.assertEqual(len(manifest["platforms"]), 4)
                for target, filename in bundles.items():
                    expected = {
                        "signature": f"signature-{target}",
                        "url": f"https://github.com/owner/repo/releases/download/v0.18.1/{filename}",
                    }
                    self.assertEqual(manifest["platforms"][target], expected)
                    self.assertEqual(manifest["platforms"][f"{target}-app"], expected)


if __name__ == "__main__":
    unittest.main()
