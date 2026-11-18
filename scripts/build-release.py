"""Package only runtime assets, with no test harness or third-party dependency."""
from pathlib import Path
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
FILES = ["manifest.json", "background.js", "content.js", "shared.js", "popup.html", "popup.js", "styles.css", "README.md"]
FILES += [f"icons/icon{size}.png" for size in (16, 32, 48, 128)]


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    release = ROOT / "dist" / "itc-flow-edge"
    archive = ROOT / "dist" / f"itc-flow-edge-{manifest['version']}.zip"
    release.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        source = ROOT / name
        if not source.is_file():
            raise FileNotFoundError(source)
        target = release / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in FILES:
            bundle.write(release / name, name)
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None
        assert set(bundle.namelist()) == set(FILES)
    print(f"Unpacked: {release}")
    print(f"ZIP: {archive} ({archive.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
