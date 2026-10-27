import sys, uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import io
src, text, wdth, wght, track = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
f = TTFont(src); f.flavor=None
inst = instantiateVariableFont(f, {"wdth": wdth, "wght": wght})
buf = io.BytesIO(); inst.save(buf); data = buf.getvalue()
upem = inst['head'].unitsPerEm
face = hb.Face(data); font = hb.Font(face)
b = hb.Buffer(); b.add_str(text); b.guess_segment_properties(); hb.shape(font, b, {"kern": True})
gs = inst.getGlyphSet(); order = inst.getGlyphOrder()
x = 0; d = []
for info, pos in zip(b.glyph_infos, b.glyph_positions):
    name = order[info.codepoint]
    pen = SVGPathPen(gs)
    gs[name].draw(TransformPen(pen, (1,0,0,-1, x + pos.x_offset, 0)))
    d.append(pen.getCommands())
    x += pos.x_advance + track*upem
x -= track*upem
asc = inst['OS/2'].sCapHeight; xh = inst['OS/2'].sxHeight
print(f'{{"upem":{upem},"width":{x},"cap":{asc},"xh":{xh},"d":"{" ".join(d)}"}}')
