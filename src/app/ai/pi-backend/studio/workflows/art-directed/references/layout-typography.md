# Layout and typography

Read this before rendering when the layout is unclear, and again when the
result is "correct everywhere but does not look designed". The "Shape the
poster" section of the workflow is the entry point.

A poster is read from a distance, scanned once, and taken in a fixed order.
Everything below serves that.

## Layout

**Hierarchy is the whole job.** A viewer should absorb a poster in three passes:
the hook, then the claim, then the detail. Build that staircase with size,
weight, colour, and white space, and make the steps genuinely different. Two
elements of similar visual weight compete and both lose. Emphasising everything
emphasises nothing.

**White space is structure, not what is left over.** Generous, deliberate margins
and gutters are the line between a designed poster and a filled one.

**Align to a grid.** Fix the margins and columns first, then place everything on
them. Optical alignment beats an offset you typed from memory; an edge that
is almost aligned reads as a mistake.

**Control the palette by role, not count.** Define the field, text, accent, and
semantic roles first. A restrained poster may need very few colours; a brand,
reference-led, or information-dense poster may need more. Every colour must
have a compositional or semantic job.

**Commit to one direction** — editorial, luxury, brutalist, playful, technical.
Pick one and let it drive every decision. A poster hedging between two reads as
neither.

**Anti-patterns:**

- Centring everything by default
- Equal spacing between unrelated blocks, flattening the hierarchy
- Text straight over busy artwork with no contrast treatment
- Borders, badges, and rules filling space in place of real structure
- Drop shadows and gradients patching a weak layout
- Marketplace styling: starbursts, unmotivated diagonal ribbons, clip art

A poster should look considered at full size and still read structurally as a
thumbnail.

## Working with the backdrop

Once the full-bleed backdrop exists, you are not laying out on white paper — you
are laying out on that image's bands.

- Text blocks land on the **flat** bands; the subject and the detail keep their own
- Let the text margins breathe with the image's composition; do not run type
  along the edge of the subject
- More than two levels of hierarchy inside one band wastes the flatness you
  asked the band for
- If the backdrop changes, revisit the layout. The same coordinates rarely hold
  on a different image

## Typography

Give every family a distinct job and valid script coverage. Add a family when
the brand, reference, script, or typographic contrast requires it, not as
decoration. Read [Font system](font-system.md) for the available families,
pairing patterns, and shipping rules.

Do not confuse visual consistency with typographic sameness. A finished poster
usually activates two or three families, even when the available list exposes
many more.

**Build a real size ramp.** display, headline, subhead, body, caption, each
clearly different from the last. A ramp with 10 percent steps reads as an error.

- Tighten tracking on large display type; open it slightly on small caps
- **A single-line block with `letter-spacing` needs explicit width awareness.**
  Tracking adds space after the last character too, so the measured content
  width is a fraction wider than the glyphs need. Anything that later writes that
  measured width back — a layout pass converting the block to absolute
  positioning, for instance — pushes the last character onto a second line.
  The block's height doubles and nothing reports an error
- Line height: 1.1–1.2 for display, 1.5–1.7 for body
- Keep poster body copy to 20–40 characters per line
- Do not run text to the edge; respect the margins you set
- Nothing below 9px after rendering. Small type is still meant to be read

## CJK typography

- **Choose a family that genuinely covers the script.** A Latin-only family must
  not set CJK text; use a CJK-capable family in that stack
- **No synthetic italics or synthetic bold.** Use a real weight, or another family
- **Weight is a choice of family, not only of `font-weight`.** Kai, running-script,
  and handwriting faces are structurally thin and stay thin at any size, so a
  headline set in one looks weightless however large. When a headline has to hold
  the page, take the weight from the family itself
- **CJK display type tolerates tight tracking; body copy does not**
- **In mixed settings put the Latin family first in the stack**, otherwise digits
  and roman characters inherit the CJK face's proportions
- **For vertical CJK type, give the single-line block an explicit width and
  centre it; do not let the text ride the frame edge.** A block whose width
  is left to the text engine can end up flush against the right margin, so
  always declare the column width and centre inside it

## Markup conventions

- Fixed px for every dimension, position, and gap that carries layout. No
  vw/vh/vmin/vmax/%. Decorative values — gradient stops, radii, shadow spread —
  are unrestricted
- Palette and font roles referenced consistently throughout the canvas
- Layers positioned inside the canvas (auto-layout where it carries the
  semantic; absolute positioning when each coordinate is explicit)
- Semantic `name` attributes describing the block's role on the poster
- Images are placed as node fills (`set_image_fill`), not referenced by path or
  URL — assets enter through the brief's assets region and `generate_image` /
  `stock_photo`
- Never embed, print, or commit a key or credential
