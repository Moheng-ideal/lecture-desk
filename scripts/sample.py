"""Create the original two-page sample lesson and the browser shortcut icons."""

import sys
from io import BytesIO
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont as SourceFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas


ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
FONT_NAME = "LectureNoto"
INK = HexColor("#282d24")
MUTED = HexColor("#5f6659")
GREEN = HexColor("#415e47")
BRICK = HexColor("#a34836")
LINE = HexColor("#dedfd4")

SAMPLE = (
    "示例课本   /   代数",
    "函数与图像",
    "第一节  什么是函数",
    "函数描述两个变量之间的对应关系。给定一个输入值 x，",
    "如果它恰好对应一个输出值 y，就可以写作 y = f(x)。",
    "输入值的取值范围叫作定义域。图像上的每个点 (x, y)",
    "都表示一组满足这一对应关系的输入与输出。",
    "例题  求函数值",
    "设 f(x) = x²。当 x = −2、0、2 时，",
    "三个对应的函数值分别是 4、0、4。",
    "观察  图像关于 y 轴对称。输入 2 与 −2 的符号相反，",
    "输出却相同。这个现象来自平方这一运算。",
    "课堂提问  图像上还有哪些点的函数值是 4？",
    "读懂函数图像",
    "第二节  用图像判断函数性质",
    "从左向右读曲线时，纵坐标随横坐标的改变而变化。",
    "在 x < 0 的一侧，f(x) = x² 随 x 增大而减小。",
    "在 x > 0 的一侧，f(x) = x² 随 x 增大而增大。",
    "最低点与对称轴",
    "图像最低点是 (0, 0)，对称轴是 y 轴。",
    "对于任意允许的 x，都有 f(−x) = f(x)。",
    "尝试  将图像整体向上移动 1 个单位，再读出最低点。",
    "函数的式子如何变化？图像的对称轴有没有变化？",
    "讲课台示例  /  原创内容",
    "x y 0 1 2 3 4 5 6 7 8 9 − 讲",
)


def load_font(path):
    font = SourceFont(path, recalcTimestamp=False)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": 400}, inplace=True)
    selection = subset.Subsetter()
    selection.populate(text="".join(SAMPLE))
    selection.subset(font)
    output = BytesIO()
    font.save(output)
    return output.getvalue()


def text(canvas, value, x, y, size=13, color=INK):
    canvas.setFillColor(color)
    canvas.setFont(FONT_NAME, size)
    canvas.drawString(x, y, value)


def page_header(canvas, title, subtitle):
    canvas.setFillColor(HexColor("#fdfcf7"))
    canvas.rect(0, 0, 596, 842, fill=1, stroke=0)
    text(canvas, SAMPLE[0], 48, 789, 12, GREEN)
    canvas.setStrokeColor(LINE)
    canvas.line(48, 769, 548, 769)
    text(canvas, title, 48, 708, 39)
    text(canvas, subtitle, 49, 667, 17, BRICK)


def page_footer(canvas, number):
    canvas.setStrokeColor(LINE)
    canvas.line(48, 53, 548, 53)
    text(canvas, SAMPLE[23], 48, 32, 10, MUTED)
    text(canvas, str(number), 537, 32, 10, MUTED)
    canvas.showPage()


def graph(canvas, bottom=235):
    width, height, left = 420, 192, 88
    canvas.setFillColor(HexColor("#edf1e8"))
    canvas.roundRect(left, bottom, width, height, 10, fill=1, stroke=0)
    middle, floor, step = left + width / 2, bottom + 24, 28
    canvas.setLineWidth(.5)
    canvas.setStrokeColor(HexColor("#d2dbcc"))
    for offset in range(-3, 4):
        canvas.line(middle + 53 * offset, floor, middle + 53 * offset, floor + 140)
    for offset in range(6):
        canvas.line(left + 35, floor + step * offset, left + width - 35, floor + step * offset)
    canvas.setStrokeColor(GREEN)
    canvas.line(left + 28, floor, left + width - 25, floor)
    canvas.line(middle, floor - 8, middle, floor + 150)
    text(canvas, "x", left + width - 20, floor - 7, 11, GREEN)
    text(canvas, "y", middle + 8, floor + 146, 11, GREEN)
    text(canvas, "0", middle + 6, floor - 16, 10, GREEN)
    canvas.setStrokeColor(BRICK)
    canvas.setLineWidth(2.3)
    path = canvas.beginPath()
    for index in range(97):
        x = -2.18 + index * 4.36 / 96
        px, py = middle + x * 53, floor + x * x * step
        (path.moveTo if index == 0 else path.lineTo)(px, py)
    canvas.drawPath(path)
    canvas.setFillColor(BRICK)
    for x in [-2, 0, 2]:
        canvas.circle(middle + x * 53, floor + x * x * step, 3.2, fill=1, stroke=0)


def create_pdf():
    canvas = Canvas(str(PUBLIC / "sample.pdf"), pagesize=(596, 842), invariant=1)
    canvas.setTitle(SAMPLE[1])
    canvas.setAuthor("讲课台")
    page_header(canvas, SAMPLE[1], SAMPLE[2])
    for index, value in enumerate(SAMPLE[3:7]):
        text(canvas, value, 49, 618 - index * 26)
    canvas.setFillColor(HexColor("#f2e9df"))
    canvas.roundRect(48, 450, 500, 75, 9, fill=1, stroke=0)
    text(canvas, SAMPLE[7], 62, 501, 13, BRICK)
    text(canvas, SAMPLE[8], 62, 481, 12)
    text(canvas, SAMPLE[9], 62, 462, 12)
    graph(canvas)
    for index, value in enumerate(SAMPLE[10:13]):
        text(canvas, value, 49, 203 - index * 26)
    page_footer(canvas, 1)

    page_header(canvas, SAMPLE[13], SAMPLE[14])
    for index, value in enumerate(SAMPLE[15:18]):
        text(canvas, value, 49, 618 - index * 26)
    graph(canvas, 334)
    text(canvas, SAMPLE[18], 49, 295, 17, BRICK)
    for index, value in enumerate(SAMPLE[19:23]):
        text(canvas, value, 49, 263 - index * 26)
    page_footer(canvas, 2)
    canvas.save()


def create_icons(font_data):
    for size in (192, 512):
        image = Image.new("RGB", (size, size), "#f9f7f2")
        draw = ImageDraw.Draw(image)
        margin = round(size * .1)
        draw.rounded_rectangle((margin, margin, size - margin, size - margin), radius=round(size * .17), fill="#39463b")
        font = ImageFont.truetype(BytesIO(font_data), round(size * .42))
        draw.text((size / 2, size / 2), "讲", font=font, fill="#fffefa", anchor="mm")
        image.save(PUBLIC / f"icon-{size}.png", optimize=True)


if __name__ == "__main__":
    data = load_font(sys.argv[1])
    pdfmetrics.registerFont(TTFont(FONT_NAME, BytesIO(data)))
    PUBLIC.mkdir(exist_ok=True)
    create_pdf()
    create_icons(data)
