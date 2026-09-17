# render JSX 语法大全

> base.md 的按需参考——首次 `render` 调用前经 `load_reference` 读取本文。
> 本文是 render JSX 的唯一完整真源；base.md 的「Render essentials」只是防崩底线。
> 元素/属性/helpers 清单与渲染器 schema 对齐（design-jsx/schema.ts）；布局与验收教义融合上游 authoring reference 与我方实证纪律。

The `render` tool takes JSX and produces design nodes. JavaScript expressions (map, ternaries, Array.from) work inside JSX. **Render ONE root element per call by default** — a Fragment of siblings is legal and renders each child as a separate root (the tool returns them in `siblings`), but reserve that for batch-sibling placement; a single root keeps `replace_id` and position semantics predictable. **Output valid JSX only** — never emit a literal `</jsx>` tag, and never follow a self-closing tag (`<Frame ... />`) with a closing tag for the same element; either self-close or nest content, never both.

**Fixing mistakes:** if a render produces warnings or wrong output, fix the broken node by rendering again with `replace_id` (the broken node's id) — NEVER render a second copy at the same position. Duplicates corrupt the layout.

**Max 40 elements per render call.** Split large structures into 2–3 calls (skeleton first, then fills).

## Elements

Content: `Frame` (container / auto-layout), `Text`, `Rectangle`, `Ellipse`, `Line`, `Star`, `Polygon`, `Vector`, `Group`, `Section`, `Icon`. Aliases: `View` = Frame, `Rect` = Rectangle.

Arbitrary vector paths: use inline SVG — `<svg viewBox="0 0 24 24" size={24}><path d="M2 12 L22 12" stroke="#000" fill="none" /></svg>` (open stroked paths supported).

Component system — `Component`, `ComponentSet`, `Instance` exist in the renderer but are **not taught yet** (pending end-to-end verification in this stack); do not author them, and do not use `of` / `component` / `componentId` / `properties` / `propertyRefs` / `bind` or the `designVar` / `defineVars` helpers.

Paint/effect helpers usable inside JSX: `solid`, `gradient`, `linearGradient`, `radialGradient`, `angularGradient`, `diamondGradient`, `dropShadow`, `innerShadow`, `layerBlur`, `backgroundBlur`, `foregroundBlur`.

All styling is done via props — no `className`, no CSS. Colors are hex only (#RRGGBB or #RRGGBBAA).

## Props reference

Canonical names below — always write these. (The renderer additionally accepts a family of CSS-style aliases — `width`/`height`→`w`/`h`, `padding`→`p`, `fontSize`→`size`, `fontFamily`→`font`, `fontWeight`→`weight`, `justifyContent`→`justify`, `align`/`alignItems`→`items`, `backgroundColor`/`background`→`bg`, `borderColor`/`border`→`stroke`, `borderWidth`→`strokeWidth`, `borderRadius`/`cornerRadius`→`rounded`, `rotation`→`rotate`, `top`/`left`→`x`/`y`, `pointCount`→`points`, `textAlignHorizontal`/`textHorizontalAlignment`/`textAlignVertical`/`textVerticalAlignment`→`textAlign`, `characters`/`content`/`label`/`value`/`title`→`text`, `col`→`colStart`, `row`→`rowStart`, etc. — plus a restricted `style={{...}}` object mapped onto the same canonical props. Those exist for compatibility only; never author with them.)

**Position:** x={N}, y={N} — only without auto-layout parent. Inside flex, x/y (or `position="absolute"`) makes the child absolutely positioned — reserve for intentional overlays and artwork.

**Sizing:** w={N}, h={N} (px), w="hug"/h="hug" (shrink-to-fit, default), w="fill"/h="fill" (stretch, requires flex parent), grow={N} (flex-grow, requires parent with concrete size), minW={N}, maxW={N}, minH={N}, maxH={N}.

**Layout:** flex="row"|"col" enables auto-layout. flow="auto"|"ltr"|"rtl" controls child flow direction for auto-layout containers. gap={N}, wrap, rowGap={N}. justify="start"|"end"|"center"|"between" ⚠ NO "evenly" — not supported. items="start"|"end"|"center"|"stretch". Padding: p={N}, px={N}, py={N}, pt={N}, pr={N}, pb={N}, pl={N} (longhands override shorthands). Grid: `grid`, columns="1fr 1fr", rows="1fr", columnGap={N}, rowGap={N}, colStart={N}, rowStart={N}, colSpan={N}, rowSpan={N}. ⚠ With `wrap`, always set `rowGap={N}`. Grid `gap` overrides axis-specific columnGap/rowGap.

**Appearance:** bg="#hex", fills=[solid()/linearGradient()/...] (structured paints; array draw order: first = bottom; gradients need an explicit transform — default direction is right→left; fade with 8-digit hex alpha like `#FFFFFF00`), stroke="#hex", strokeWidth={N}, strokeAlign="inside"|"center"|"outside", strokeDash={[N, N]} (or boolean), rounded={N}, roundedTL={N}, roundedTR={N}, roundedBL={N}, roundedBR={N}, cornerSmoothing={0-1}, opacity={0-1}, rotate={deg}, blendMode="multiply"|etc, overflow="hidden", effects=[dropShadow(...)/innerShadow(...)/layerBlur(...)] (structured). Shorthands: shadow="offX offY blur #color", blur={N}.

**Text (only on `<Text>`):** text="string" (content prop — children text wins when both are present; aliases `characters`/`content`/`label`/`value`/`title`), size={N}, weight={N} or "thin"|"light"|"regular"|"medium"|"semibold"|"bold"|"extrabold"|"heavy"|"black" (case-insensitive; unknown names silently fall back to 400), color="#hex", font="Family", dir="auto"|"ltr"|"rtl", textAlign="left"|"center"|"right"|"justified" (also `textAlignHorizontal`/`textHorizontalAlignment` for the horizontal axis, `textAlignVertical`/`textVerticalAlignment` for the vertical), lineHeight={N} (px), letterSpacing={N} (px), textDecoration="underline"|"strikethrough", textCase="upper"|"lower"|"title", maxLines={N}, truncate, textAutoResize="none"|"width"|"height". ⚠ Text without `color` is invisible. `textAutoResize` defaults sensibly (fixed-width or fill-in-flex → height; otherwise width-and-height) — omit it unless you need a fixed box ("none").

**Icon:** `<Icon name="lucide:heart" size={20} color="#FFF" />` — fetches and renders vector icon inline. No need for separate search/fetch/insert calls. Popular sets: lucide (outline), mdi (filled), heroicons, tabler, solar, mingcute, ph. ⚠ Always set `color` — default is black.

**Shapes:** points={N} (Star/Polygon), innerRadius={N} (Star). All shapes need `bg` or `stroke` — invisible without.

**Identity:** name="string" for the layers panel.

## Layout rules

⚠ **Every Frame with 2+ children needs `flex="col"` or `flex="row"`.** Without it, children stack at (0,0). Card with photo + info → `flex="col"`. Row of buttons → `flex="row"`. Only omit for decorative layers with explicit x/y positioning.

⚠ **Every parent with children using `w="fill"` or `h="fill"` MUST have `flex="col"` or `flex="row"`.** Without flex, fill is ignored.

justify/items require flex. The value is "between", not "space-between". `between` distributes existing space — it cannot create room in a hug container.

Use `dir="rtl"` on Arabic/Hebrew text when direction should be explicit. Use `flow="rtl"` on auto-layout containers when children should start from the right. `flow="auto"` inherits from the parent container. Text `dir` and container `flow` are separate — set whichever you mean.

A hug parent shrinks to fit children. A fill child stretches to parent. Can't be circular — at least one child needs concrete size. Prefer `hug` for notes, cards, and long pages instead of guessing heights (fixed viewport sizes and artwork geometry are the intentional exceptions).

Nested flex containers need w="fill" at EVERY level to stretch. `grow={1}` inside HUG parent = zero width. Avoid redundant fixed widths on growing children.

No margin property. For single-child offset, wrap in a Frame with padding.

For wrapping text in a column, prefer `w="fill"`; `maxLines`/`truncate` are intentional truncation — never use them (or `overflow="hidden"`) to make a broken layout look fixed. Resolve overflow at its source.

Set colors explicitly for predictable contrast. Verify fonts actually load before judging dimensions — do not assume every family is available. Image fills belong on leaf shapes, not on containers whose children must stay visible.

## Prohibited

No className, no arbitrary CSS, no `style={{...}}` authoring (a restricted style shim exists for compatibility — do not use it). No named colors or rgb(). No percentage values. No TypeScript casts. No Math.random(). No `Math.` prefix in calc — use `floor(x)` not `Math.floor(x)`. No emoji in UI elements (use `<Icon>` instead) — emoji renders as □. **No margin props — `mt`, `mb`, `ml`, `mr`, `mx`, `my` do not exist.** Vertical spacing between children = parent's `gap`; outer offset = wrap in a Frame with `p`. Inspect structure with `describe` and visuals with `look`.

## Repair and verification discipline

- ⚠ **If a fix fails after 2 attempts — delete the node and re-render with corrections.** Do NOT debug with `eval`.
- ⚠ Common `describe` errors: "overflows" → `w="fill"` or `overflow="hidden"`; "collapses to zero" → fix grow/fill chain; "invisible"/"no color" → add bg/color; "dark on dark" → change text color.
- Node counts and `describe` diagnostics do not establish visual fidelity. Check wrapping with longer content and narrower containers; use `look` for what `describe` cannot answer (text-over-image legibility, visual harmony).
- Resolve overflow and contrast problems at their source — never paper over with clipping, guessed heights, or manually positioned siblings.
- Reuse IDs returned by creation tools rather than repeatedly searching for the same nodes.
