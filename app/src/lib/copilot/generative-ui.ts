/**
 * What a Bot is told about drawing an interface it wrote itself.
 *
 * The SDK ships a default set of guidelines, and they describe shadcn/ui: rounded cards, a violet
 * accent, its own spacing scale. OpenBot does not look like that. The app's palette is deliberately
 * without colour — every token in styles.css sits at chroma zero except the destructive red and the
 * success teal — so the default guidance produces something that reads as a foreign widget dropped
 * into the transcript rather than part of it.
 *
 * This is a prompt, so it is written for a model rather than for a person: concrete values it can
 * copy, and the few rules that are actually load-bearing.
 *
 * WHY THE COLOURS ARE LITERAL. The generated interface renders inside a sandboxed iframe with no
 * same-origin access to this app. It cannot reach the stylesheet, the theme class, or the CSS custom
 * properties the rest of the UI is built from, so anything it should match has to be written out
 * here in full. Referring it to `--muted-foreground` would produce an unstyled document.
 *
 * WHY prefers-color-scheme AND NOT THIS APP'S THEME. For the same reason: the iframe is a separate
 * document and cannot see which theme the person picked. `prefers-color-scheme` is the only signal
 * that crosses, so a generated interface follows the browser rather than the app's own switch. A
 * person who has overridden their OS theme in OpenBot will see a generated interface that disagrees
 * with the surface around it. That is a known limitation of the sandbox rather than something this
 * text can fix.
 */
export const GENERATIVE_UI_DESIGN_SKILL = `Render generated UI as a compact OpenBot-native surface.

STYLE
- Neutral only: light bg #fafafa/#fff, text #0a0a0a/#636363, border #e5e5e5; dark bg #0a0a0a/#171717, text #fafafa/#a1a1a1, border rgba(255,255,255,.10).
- Meaningful accents only: success #009689 (dark #00bba7), destructive #e7000b (dark #ff6467). No gradients or decorative brand colours.
- Inter/system-ui, 14px/1.5; headings 15-16px/600. Cards 0.55rem radius, controls 0.375rem; 1px borders, no shadows; 8-12px gaps, 12-16px padding.
- Use @media (prefers-color-scheme: dark). Set explicit body background/text.

LAYOUT
- Design for a 320-680px chat column; max-width:100%, box-sizing:border-box. Use flex/grid. Wide tables/charts/code scroll inside their own container; never make the page scroll horizontally.
- Prefer one clear view. Charts use greys and direct labels; use success/destructive colours only when semantically required.

RULES
- Show only data supplied by the conversation/tools. Label examples; never invent deployment readings.
- Keep CSS/JS self-contained. No same-origin deployment fetches. Guard browser-storage reads in try/catch.
- Use semantic controls, visible focus, and >=32px targets. Keep interactions simple and accessible.`;
