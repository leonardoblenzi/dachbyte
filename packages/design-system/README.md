# DACHBYTE Design System

This package is the canonical source for DACHBYTE visual primitives. It is
deliberately CSS-first and has no build step, dependency, server route, or app
runtime entrypoint. That makes it safe to introduce while the suite still has
several independent front-end stacks.

## Structure

```text
packages/design-system/
└── src/
    └── tokens.css       # canonical DACHBYTE token source
```

`tokens.css` has three layers:

- **Foundation:** the shared dark surfaces, text, borders, and signal colours.
- **Semantic aliases:** the preferred names for new UI (`--dachbyte-panel`,
  `--dachbyte-action`, etc.).
- **Line accents:** Seller and Business accent choices, selected by
  `data-dachbyte-line` on an app root.

The known Marketplace colours (Mercado Livre yellow, Shopee orange,
MadeiraMadeira red, and so on) remain product/channel accents. They are not
global DACHBYTE tokens.

## Use in a modern front end

Import the source from the application's stylesheet or entry module, then put
the appropriate line on its document root:

```css
@import "../../../packages/design-system/src/tokens.css";
```

```html
<html data-dachbyte-line="business">
```

Use `seller` for Seller applications. Omit the attribute when an application
does not need a line-specific accent.

## Legacy static pages

Existing static pages must continue linking to
`/brand/dachbyte/tokens.css`. That public file is a compatibility snapshot of
the original transition tokens and is intentionally **not** changed to an
`@import`: package directories are not guaranteed to be public in every
deployment. This avoids altering CSS serving, start commands, or CDN caching.

When a static host is deliberately configured to expose this package, replace
the snapshot with an explicit public build/copy step and verify it in that host
before changing any page links.

## Migration rules

1. Add tokens to a module; do not globally replace the module's existing CSS.
2. Use semantic aliases for new components and preserve channel-specific
   colours where they carry marketplace meaning.
3. Apply one line attribute at the application shell, not on individual cards.
4. Keep existing variables, selectors, routes, and asset URLs during the
   transition. Removing a legacy name is a separate, tested migration.
5. If a token changes, update both this canonical source and the public
   compatibility snapshot in the same pull request until a build step exists.

## Compatibility contract

No file in this package is loaded by a current server automatically. Adding or
editing it cannot change initialization. The public snapshot stays the only
runtime-loaded token file until each app opts in.
