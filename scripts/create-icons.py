"""Generate the extension's small code-native Flow monogram."""
from pathlib import Path
from PIL import Image, ImageDraw

output = Path(__file__).resolve().parent.parent / "icons"
output.mkdir(exist_ok=True)
scale = 4
image = Image.new("RGBA", (128 * scale, 128 * scale))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((2 * scale, 2 * scale, 126 * scale, 126 * scale), radius=34 * scale, fill="#191b21", outline="#4a4d56", width=2 * scale)
for line in [((35, 88), (35, 39), (69, 39)), ((35, 62), (75, 62)), ((79, 39), (79, 88), (101, 88))]:
    draw.line([(x * scale, y * scale) for x, y in line], fill="#f9fafc", width=7 * scale, joint="curve")
draw.ellipse((98 * scale, 21 * scale, 110 * scale, 33 * scale), fill="#397cff")
for size in (16, 32, 48, 128):
    image.resize((size, size), Image.Resampling.LANCZOS).save(output / f"icon{size}.png")
print(output)
