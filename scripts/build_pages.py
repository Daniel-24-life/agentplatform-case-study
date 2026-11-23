from pathlib import Path
import re
from shutil import copyfile
import sys

repository = Path(__file__).resolve().parents[1]
out = Path(sys.argv[1])
files = {
    "index.html": "case-study/index.html",
    "styles.css": "case-study/styles.css",
    "docs/assets/product-metrics-refined-synthetic.png": "docs/assets/product-metrics-refined-synthetic.png",
    "docs/assets/product-metrics-synthetic-fixture.png": "docs/assets/product-metrics-synthetic-fixture.png"
}

for output_path, input_path in files.items():
    target = out / output_path
    target.parent.mkdir(parents=True, exist_ok=True)
    copyfile(repository / input_path, target)

source = out / "index.html"
sheet = source.read_text(encoding="utf-8").replace('"../docs/assets/', '"docs/assets/')
sheet = re.sub(r'href="\.\./([^"]+)"', r'href="https://github.com/Daniel-24-life/agentplatform-case-study/blob/main/\1"', sheet)
source.write_text(sheet, encoding="utf-8")
