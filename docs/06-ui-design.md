# Interface design

## The constraints a clinical UI is actually under

Not a style guide — these are the properties that made the decisions:

| Constraint | Consequence |
|---|---|
| Read under time pressure, on a mounted screen, at an angle, possibly with gloves | Generous type, high contrast, large hit targets |
| On screen for a twelve-hour shift | Low-chroma surfaces; saturation reserved for what must interrupt |
| Dense by necessity — a chart has a lot in it | Tight spacing scale and strong hierarchy, not cards floating in whitespace |
| Shared workstations, public-facing screens | Contact details masked on list views; `no-store` everywhere; 15-minute lock |
| Night shifts on wards with the lights down | Dark mode is a selected palette, not an inversion |

## Colour

Semantic tokens in `apps/web/src/styles/globals.css`. Components reference roles
(`--ink`, `--surface-raised`, `--critical-soft`), never raw hex, so the two
themes swap in one place.

The data-visualisation palette was **validated with a script, not by eye**,
against this application's own surfaces (`#ffffff` light, `#15191f` dark):

| Check | Light | Dark |
|---|---|---|
| Lightness band | PASS | PASS |
| Chroma floor | PASS | PASS |
| CVD separation (worst adjacent) | ΔE 9.1 | ΔE 8.4 |
| Normal-vision floor (worst adjacent) | ΔE 19.6 | ΔE 19.3 |
| Contrast vs surface | WARN on 3 slots → relief applied | PASS |

The light-mode contrast warning is handled, not dismissed: every chart that uses
those slots carries visible direct labels, which is the documented relief.

The AR ageing ramp is **ordinal**, not categorical — the buckets are an ordered
scale, so it is one hue stepped light-to-dark, validated for monotone lightness,
a 0.06 minimum step gap, and a light end that clears 2:1 against the surface in
both modes.

**Status colours are fixed and reserved** (`good`, `warning`, `serious`,
`critical`) and never reused as a series colour. On the light surface `warning`
and `serious` sit below 3:1 by design; the mitigation is that **every status
ships with a glyph and a text label**, so colour never carries meaning alone.
That rule is enforced in the `Badge`, `StatTile`, `Alert` and `Meter`
primitives rather than left to each caller.

## Choosing forms

| Job | Form used | What was rejected |
|---|---|---|
| A handful of unrelated headline numbers | KPI row of stat tiles | A grouped bar chart of unrelated measures — the most common dashboard mistake |
| A ratio against a limit (stock vs reorder level) | Meter with the threshold marked on the track | A two-slice pie; two bare numbers the reader has to compare themselves |
| Magnitude across ordered buckets (AR ageing) | Horizontal bars, ordinal ramp, direct labels | Vertical columns — the category labels are long and would have to rotate |
| Where the day is, right now | Gantt-style lane per clinician with a now-line | A list, which makes the user compute their own position in the day |

The timeline window **adapts to the booked range** rather than spanning a fixed
07:00–20:00. On a quiet day a 30-minute appointment in a 13-hour axis renders at
under 4% width — too narrow to read the patient's name, which defeats the point
of the board. Below a legibility threshold a block falls back to its glyph plus
a screen-reader label and a tooltip.

## Information hierarchy

The patient chart is ordered by clinical consequence, not by data model:

1. **Allergy banner** — full width, critical tone, above everything. The highest
   consequence information on the screen, and the one most often buried in a
   sidebar chip.
2. **Identity strip** — name, MRN, date of birth, sex, blood type. The fields
   used to confirm you are looking at the right person before you act.
3. **Access basis**, shown back to the user: *"Access recorded as Care team.
   This view is logged against your name."* Staff who know their access is
   reviewed behave differently from staff who find out afterwards.
4. Problem list, allergies in full, latest observations.
5. Contact details, account, administrative metadata.

The dashboard follows the same logic: unacknowledged critical results interrupt
as a banner before any tile renders.

## Navigation

The sidebar is **permission-driven**. A receptionist does not see a Pharmacy
link they would only be refused at — which also means the screen is not a menu
of things they cannot do. The billing clerk's sidebar in
`docs/screenshots/light-07-billing.png` shows two sections where a doctor's
shows eight.

Global patient search sits in the topbar on every screen, bound to `/`, because
"find this patient" is the single most frequent action in the building. It is
debounced at 280ms and aborts the previous request — every keystroke would
otherwise be an audited PHI read.

## Accessibility

- Visible focus ring everywhere. Staff work this interface by keyboard at speed,
  and losing the caret costs seconds per patient.
- Status never by colour alone — glyph plus label, enforced in the primitives.
- Semantic tables (`<table>`, `<th scope>`), not grids of divs: clinical tables
  are read by screen readers and printed.
- `role="meter"` with min/max/now on every stock level.
- `prefers-reduced-motion` honoured; vestibular symptoms are a presenting
  complaint, and staff have them too.
- `forced-colors` keeps structural borders so the OS palette can come through.
- Skip link as the first tab stop.
- Pinch-zoom is **not** disabled — ward tablets are used one-handed.

## Density and responsiveness

The content column caps at `88rem` and centres, so a clinical note on a 32-inch
display does not stretch to 200 characters per line. Below `lg` the sidebar
becomes a drawer; tables scroll horizontally inside their card rather than
reflowing into unreadable stacks. Verified at 390 × 844.

## What the screenshots show

`docs/screenshots/` — captured against the running stack with seeded data.

| File | Shows |
|---|---|
| `light-01-login`, `dark-01-login` | The assurance panel: access is logged, before anyone types |
| `light-02-dashboard`, `dark-02-dashboard` | KPI row, adaptive clinic timeline with now-line, waiting room, stock meters |
| `light-03-patients`, `dark-03-patients` | Roster with masked contact details |
| `light-04-chart`, `dark-04-chart` | Allergy banner, decrypted PHI, computed BMI and NEWS2, access basis |
| `light-05-appointments`, `dark-05-appointments` | Day board and schedule with check-in |
| `light-06-inventory`, `dark-06-inventory` | Stock meters with reorder thresholds, controlled-drug badges |
| `light-07-billing` | AR ageing ordinal bars; note the permission-narrowed sidebar |
| `mobile-01-dashboard`, `mobile-02-patients` | 390px ward tablet |
