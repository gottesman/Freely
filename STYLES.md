# Freely Styles Architecture

This document describes the modular CSS structure introduced after refactoring the original monolithic `src/styles.css`.

## Goals
- Centralize design tokens (colors, radii, spacing, typography) for easy theming.
- Reduce duplication (shared transitions, surfaces, borders, shadows).
- Improve scanability & maintainability (smaller focused partials).
- Keep existing class names (non-breaking for components) while enabling future rename strategy.

## File Overview
`src/styles.css` – Aggregator that imports all partials. Vite processes `@import` in standard CSS; the bundle order matches the list.

```
src/
  styles.css                # aggregator (imports below)
  styles/
    variables.css           # design tokens & CSS custom properties
    base.css                # reset, scrollbars, small utilities
    components.css          # generic UI atoms: buttons, cards, chips, media cards
    layout.css              # app shell, panels container, resize handle, splash screen
    titlebar.css            # title bar, nav buttons, search, window controls
    panels.css              # right panel tabs, shelves & small card grid
    center-tabs.css         # central tab system (header + body)
    home.css                # home page & hero sections
    now-playing.css         # now playing, lyrics overlay, artist sections
    player.css              # bottom player bar, controls, volume & progress
    background.css          # animated background layer
    alerts.css              # transient player alerts / toasts
    tests.css               # genius / API test harness & multi-select styling
```

## Design Tokens (`variables.css`)
Core tokens are defined as CSS custom properties on `:root`:
- Color system: `--accent`, `--secondary`, semantic surfaces `--surface-*`, borders `--border-*`.
- Radii & shadows: `--radius-sm` → `--radius-xl`, `--shadow-*`.
- Typography: `--font-ui`, weight constants.
- Timing & easing: `--dur-*`, `--ease-standard`.
- Z-index layering: `--z-*`.

Use tokens directly in partials; prefer adding new tokens instead of hard-coded values to keep consistency.

## Naming & Conventions
- Existing BEM-like / semantic class names preserved (`.track-player`, `.np-tracklist`).
- New utilities start with `u-` (kept minimal to avoid utility sprawl).
- Modifier classes reuse original patterns (`.media-card.compact`, `.media-card.is-circle`).
- Keep component-specific styles local to their partial to avoid accidental cascade bleed.

## Adding New Styles
1. If it’s a global primitive (color, spacing size) add token to `variables.css`.
2. If it’s a generic component or pattern reused in multiple places, extend `components.css` or create a new partial (then import it in `styles.css`).
3. If it belongs to a single feature (e.g., Search overlay), create a feature partial (e.g., `search.css`).
4. Append the new partial import to `styles.css` **after** dependencies (tokens/base) but before unrelated later layers if it should be overridden by feature-specific rules.

## Layer Ordering Rationale
1. `variables.css` – tokens first.
2. `base.css` – reset & utilities depend on tokens.
3. Structural & generic components: `components`, `layout`, `titlebar`, `panels`, `center-tabs`.
4. Feature pages: `home`, `now-playing`.
5. Player & background & alerts.
6. Test harness last (least critical precedence) but before future overrides or debug helpers.

## Stylelint Integration
A Stylelint config (`.stylelintrc.cjs`) was added with:
- `stylelint-config-standard` base rules.
- `stylelint-order` plugin for grouping order sections.
- Relaxed some rules (e.g., `selector-class-pattern`) to avoid false positives for existing naming.

### Run Lint
```bash
npm run lint:css
```

### Adjusting Rules
Update `.stylelintrc.cjs` if you introduce nested syntax (e.g. postcss-nesting) or switch to SCSS (add `stylelint-config-standard-scss`).

## Future Enhancements
- Introduce light/dark theme variants via `[data-theme]` attribute and theme-specific overrides.
- Consider CSS Cascade Layers (`@layer`) for enforced order instead of import ordering.
- Add a `tokens.json` → build step to generate both CSS vars and TypeScript typings for design tokens.
- Introduce Style Dictionary / Theo if token complexity grows.

## Migration Notes
- No class renames yet; components should continue to function.
- If you remove the aggregator and import partials individually in React components, ensure ordering (or adopt cascade layers for stability).

Happy styling! 🎧
