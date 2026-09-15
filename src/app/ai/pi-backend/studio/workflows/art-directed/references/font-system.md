# Font system

Read this when typography carries the design, when the brief needs a distinctive
editorial voice, or when the defaults feel generic.

## Two different counts

The **active type system** and the **editable font palette** are not the same.

- A finished poster normally uses two or three families: one display voice, one
  text voice, and optionally one utility or accent voice.
- The canvas may expose many more families so a user has meaningful
  alternatives. Do not use every exposed family in the composition.

For a poster, cover, flyer, or campaign, declare at least three meaningfully
different selectable font roles unless the brief deliberately specifies a
single-family identity. A body sans, another nearly identical sans, and the
same sans at a different weight are not three roles.

## Voice roles

Design by voice first, then commit to a family only after verifying it is in
the host. The table below names the design voices the kit was curated for, and
the concrete Fontsource / system family that fills each role — but the host's
actual list may differ. Use `list_available_fonts` to enumerate what is
currently renderable; the family you commit to is the intersection of the role
recommendation and the host's available list.

| ID                     | Voice                            | Family                    | Best use                                                |
| ---------------------- | -------------------------------- | ------------------------- | ------------------------------------------------------- |
| `editorial-serif`      | high-contrast editorial serif    | Fraunces Variable         | expressive editorial and cultural headlines             |
| `luxury-serif`         | high-contrast didone-style serif | Bodoni Moda Variable      | fashion, beauty, luxury, magazine covers                |
| `clean-sans`           | quiet grotesque sans             | Instrument Sans Variable  | refined campaigns and editorial body copy               |
| `geometric-sans`       | geometric sans                   | Space Grotesk Variable    | technology, information, contemporary labels            |
| `condensed-sans`       | condensed sans                   | Roboto Condensed Variable | dense layouts, deck lines, prices, utilities            |
| `experimental-display` | variable display face            | Unbounded Variable        | art, music, youth, experimental display                 |
| `cjk-sans`             | Chinese sans                     | Noto Sans SC              | Chinese body copy, campaigns, information design        |
| `cjk-serif`            | Chinese serif                    | Noto Serif SC             | Chinese editorial, culture, literature, premium display |
| `cjk-calligraphy`      | Chinese handwritten              | Ma Shan Zheng             | short Chinese handwritten accents and titles            |
| `cjk-display`          | Chinese display face             | ZCOOL XiaoWei             | distinctive Chinese editorial display titles            |

When a recommended family is not in the host, fall back to another family
matching the same voice (e.g. any high-contrast didone for `luxury-serif`,
any quiet grotesque for `clean-sans`). When no family in the host matches
the voice well enough, relax the role constraint — the design should not be
shipped on a missing family.

System fonts pass through unchanged when they appear in a font name — those
are user assets. If design intent depends on a specific voice, name a family
that matches the role and confirm it exists in the host before committing.

## Pairing by contrast

Choose pairs that differ in structure, not merely in weight:

- luxury campaign: `luxury-serif` + `clean-sans`
- editorial or culture: `editorial-serif` + `clean-sans`
- technical information: `geometric-sans` + `condensed-sans`
- Chinese editorial: `cjk-serif` + `cjk-sans`, optionally a Latin display face
- Chinese expressive poster: `cjk-display` or `cjk-calligraphy` for short display
  copy, with `cjk-sans` or `cjk-serif` for everything longer
- experimental art: `experimental-display` + a quiet sans or serif

Do not set paragraphs in a display or calligraphic face. Do not use synthetic
bold or italics on CJK fonts that do not supply those styles. Mixed Chinese and
Latin display lines may use separate text spans (multi-node text or
`set_font_range`) when the intended Latin voice would otherwise disappear
behind the CJK family.

## Shipping rules

- Use only families present in the host. System-local fonts pass through
  unchanged, but declaring a design dependency on one should be told to the
  user.
- Each family has a defined role and script coverage. After render, run
  `describe` once and read its tree summary's per-node family-and-size lines;
  fix any mismatch in place (`set_font` / `set_font_range`).
- A weight name that the family does not provide silently falls back to 400 and
  emits a `describe` warning. Recognise this in the warning list.
