# -*- coding: utf-8 -*-
"""Subset the Noto Sans SC variable font to the CJK charset in
tools/font-subset/charset-cjk.txt.

One-shot but replayable pipeline. Run from anywhere (venv with fonttools
lives at tools/font-subset/.venv, gitignored):

    tools/font-subset/.venv/Scripts/python tools/font-subset/subset-fonts.py

Source (full vendor VF, not committed to this repo):
    D:/Desktop/AgentLearn/00_DIYProjects/0720openpencil/FONTS/
        noto-sans-sc/NotoSansSC[wght].ttf   (google/fonts 仓 ofl/notosanssc，
        glyf 可变字体，wght 100-900，无 CFF2——opentype.js 可解析)

Charset (tools/font-subset/charset-cjk.txt, committed) was built from:
    - 通用规范汉字表 8105 字 (level-1/2/3 txt from
      github.com/shengdoushi/common-standard-chinese-characters-table,
      fetched via cdn.jsdelivr.net mirror)
    - ASCII printable range, full GB2312 repertoire (incl. symbol rows),
      fullwidth ASCII/space, and common marketing/typographic symbols
      (￥ € © ® ™ ° ‰ × ÷ ± 「」【】《》〈〉 ...). 9031 unique chars total.

Notes:
    - The name table is preserved verbatim (--name-IDs='*' --name-legacy
      --name-languages='*') because the runtime registers fonts under clean
      family names hard-coded in packages/core/src/text/fonts.ts.
    - The wght axis survives subsetting (fvar/gvar/STAT/avar/HVAR kept by
      fonttools for instancing correctness); do NOT pin the instance — the
      shipped asset must stay variable so runtime fontWeight 100-900
      resolves through namedInstanceVariations.
    - Output replaces NotoSansSC-VF.ttf in both public/ and
      packages/core/assets/ (the repo keeps the two copies in sync).
"""

import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FONTS_DIR = os.path.join(os.path.dirname(REPO_ROOT), 'FONTS')
CHARSET_FILE = os.path.join(REPO_ROOT, 'tools', 'font-subset', 'charset-cjk.txt')
OUTPUT_DIRS = [
    os.path.join(REPO_ROOT, 'public'),
    os.path.join(REPO_ROOT, 'packages', 'core', 'assets'),
]

SOURCE = os.path.join(FONTS_DIR, 'noto-sans-sc', 'NotoSansSC[wght].ttf')
OUT_NAME = 'NotoSansSC-VF.ttf'


def make_options():
    opts = subset.Options()
    opts.name_IDs = ['*']
    opts.name_legacy = True
    opts.name_languages = ['*']
    opts.layout_features = ['*']
    opts.hinting = False
    opts.flavor = None  # plain TTF, no woff/woff2
    return opts


def main():
    with open(CHARSET_FILE, encoding='utf-8') as fp:
        charset = fp.read()
    print(f'charset: {len(charset)} chars from {CHARSET_FILE}')

    if not os.path.exists(SOURCE):
        print(f'ERROR: source missing: {SOURCE}', file=sys.stderr)
        sys.exit(1)

    in_size = os.path.getsize(SOURCE)
    font = subset.load_font(SOURCE, make_options())
    subsetter = subset.Subsetter(make_options())
    subsetter.populate(text=charset)
    subsetter.subset(font)

    for out_dir in OUTPUT_DIRS:
        font.save(os.path.join(out_dir, OUT_NAME))
    font.close()

    out_file = os.path.join(OUTPUT_DIRS[0], OUT_NAME)
    out_size = os.path.getsize(out_file)
    with TTFont(out_file, lazy=True) as check:
        glyph_count = check['maxp'].numGlyphs
        axes = [(a.axisTag, a.minValue, a.maxValue) for a in check['fvar'].axes]

    print(
        f'{OUT_NAME}: {in_size / 1e6:.2f}MB -> {out_size / 1e6:.2f}MB, '
        f'{glyph_count} glyphs, axes={axes}'
    )


if __name__ == '__main__':
    main()
