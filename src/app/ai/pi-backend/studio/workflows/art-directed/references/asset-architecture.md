# Asset architecture

Read this only after the workflow's "integrated design decision" selects a slot
matrix, cutout stack, or layered collage. The workflow section owns topology
and asset count; this reference owns multi-asset cohesion and the
asset-plan recording. [Imagery](imagery.md) controls how each asset is prompted
and validated.

## Multi-asset cohesion

### Slot matrix

Use for product families, catalog grids, comparisons, specimens, menus, and
timelines. Give every bounded cell its own asset and let JSX define identical
cell geometry, gutters, labels, and alignment.

Freeze one shared art-direction block for all prompts: camera, lens or rendering
style, viewpoint, lighting, background treatment, scale, palette, and crop. Add
only the subject-specific difference to each prompt. Prose alone does not lock a
series: when material, camera, and set continuity matter, give every slot the
same visual style anchor. Prefer the non-shipping art-directed reference when it
already defines the set; otherwise generate and approve one canonical slot,
then use it as the style reference for the remaining slots. Record the anchor
in the asset plan. If exact branded products are required, use supplied
packshots; do not invent packaging, labels, or product variants.

### Cutout stack

Use when subjects float over a field, overlap one another, or cross typography.
Plan the order explicitly, for example: backdrop, rear decoration, headline,
main subject, foreground detail, metadata. Put exact text as live text nodes at
the correct position in that order; never bake it into a cutout.

Use one transparent file per independently movable subject. Follow the
transparency workflow in [Imagery](imagery.md), and keep enough clean padding
around each subject for reliable positioning and cropping.

### Layered collage

Use a restrained base field plus a purposeful set of fragments. Split only
pieces whose overlap, angle, crop, or replacement matters. Generate photographic
or materially complex fragments; make simple tape, rules, flat paper polygons,
and frames in JSX. Reuse a fragment only when repetition is visibly part of
the design language.

Vary scale, angle, edge treatment, and depth, but preserve one palette and one
material logic. Avoid filling every gap: collage still needs hierarchy and
negative space.

## Asset plan

Record this in the brief's conclusion area (one line per asset, append-only)
when two or more shipping assets are required. Keep it small. For every asset
record:

- `id` and `form`: `backdrop`, `slot`, `cutout`, or `fragment`;
- `rect`: intended `x`, `y`, `width`, and `height` on the poster canvas;
- `layer`: its named position in the back-to-front order;
- `prompt`: the prompt identifier used to write that asset's prompt;
- `style_reference`: the common visual anchor node id or `null`;
- `depends_on`: the prerequisite asset only when returned pixels from it are
  required, otherwise empty;
- `source`: `generated`, `user`, or `provided-reference`.

List text and geometry layers separately so the overlap order is explicit.

## Assembly checks

- Inspect every asset alone before assembly, especially alpha edges and unwanted
  generated lettering.
- Inspect the final canvas for rectangular seams, inconsistent light direction,
  mismatched scale, accidental tangencies, and text trapped between busy layers.
- If the composition only works after hiding seams with gradients and shadows,
  the split was wrong. Regenerate a continuous scene or change the architecture.
