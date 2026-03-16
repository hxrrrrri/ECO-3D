from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer


def convert_markdown_like_to_pdf(input_path: Path, output_path: Path) -> None:
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "TitleCustom",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=18,
        leading=22,
        spaceAfter=10,
    )
    h2_style = ParagraphStyle(
        "H2Custom",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=13,
        leading=17,
        spaceBefore=8,
        spaceAfter=4,
    )
    body_style = ParagraphStyle(
        "BodyCustom",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        spaceAfter=3,
    )

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=A4,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        topMargin=1.8 * cm,
        bottomMargin=1.8 * cm,
        title="ECO-3D Project Overview",
        author="ECO-3D Team",
    )

    story = []
    lines = input_path.read_text(encoding="utf-8").splitlines()

    for raw in lines:
        line = raw.strip()
        if not line:
            story.append(Spacer(1, 6))
            continue

        escaped = (
            line.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )

        if escaped.startswith("# "):
            story.append(Paragraph(escaped[2:].strip(), title_style))
        elif escaped.startswith("## "):
            story.append(Paragraph(escaped[3:].strip(), h2_style))
        else:
            if escaped.startswith("- "):
                escaped = "• " + escaped[2:].strip()
            story.append(Paragraph(escaped, body_style))

    doc.build(story)


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    src = root / "PROJECT_OVERVIEW.md"
    dst = root / "PROJECT_OVERVIEW.pdf"
    convert_markdown_like_to_pdf(src, dst)
    print(f"PDF generated: {dst}")
