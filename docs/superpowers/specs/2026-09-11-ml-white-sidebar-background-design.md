# ML White Mode Sidebar Background Design

## Goal

Make the external background of the Mercado Livre sidebar white when White Mode is active, while retaining the existing DachByte visual identity inside the sidebar.

## Confirmed constraints

- Keep the existing DachByte logo, name, subtitle, typography, cards, icons, and navigation structure unchanged.
- Keep the dark DachByte gradient when Dark Mode is active.
- Change only the external sidebar background in White Mode.
- Use pure white (`#ffffff`) for White Mode.

## Design

`public/brand/dachbyte/theme.css` currently assigns the dark Seller gradient to `.ml-shell__sidebar` without checking the selected theme. The rule will be split by theme:

- `body.theme-light`: set `.ml-shell__sidebar` to `#ffffff`.
- `body.theme-dark`: retain the current dark DachByte gradient.

This keeps the product-brand override responsible for brand-specific styling, while the shell continues to own layout, cards, navigation, and typography.

## Verification

- Confirm the stylesheet contains mutually exclusive light and dark selectors for the Seller sidebar.
- Run the existing architecture test suite to ensure no platform contracts regress.
- Visually verify that White Mode renders a white outer sidebar and Dark Mode preserves the current gradient.
