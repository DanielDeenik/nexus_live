// The LensIQ look, in one place. Tailwind reads these tokens (tailwind.config.ts) and the
// charts read them here, so a colour changes once for the whole Nexus live web.
// Taken from the LensIQ website (lensiq.company): paper ground, white cards with a hairline,
// a lemon accent, a near-black band, Manrope headings, IBM Plex Sans body, IBM Plex Mono labels.

export const palette = {
  paper: '#FAFAF7', // page ground
  card: '#FFFFFF', // cards, inputs, menus
  ink: '#15171B', // headings, primary buttons, strong text
  body: '#3A4048', // running text
  muted: '#6E7480', // labels, captions (4.6:1 on paper)
  line: '#E5E7E3', // hairlines and borders
  chip: '#F1F2EE', // chips, hover fills, quiet surfaces
  lemon: { DEFAULT: '#F5D843', soft: '#FCF6D8', ink: '#6E6112', deep: '#A08200' },
  night: { DEFAULT: '#15171B', 2: '#1D2025', line: '#2C3037', body: '#C2C7CE', muted: '#8A919B' },
  good: { DEFAULT: '#1E7A4E', soft: '#E6F3EC' },
  bad: { DEFAULT: '#9B2C2C', soft: '#FDECEC' },
} as const

export const fonts = {
  display: ['Manrope', 'system-ui', 'sans-serif'],
  sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'sans-serif'],
  mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
}

/** Series colours for charts on the white card. Checked with the dataviz validator on #FFFFFF
 *  (lightness band, chroma, colour-blind and normal-vision separation, 3:1 contrast, all pairs). */
export const series = { blue: '#257DE0', aqua: '#00866E', lemon: palette.lemon.deep } as const

/** Fixed categorical order for charts with more series (the time sunburst). Light-mode reference
 *  order from the dataviz palette, with the LensIQ lemon in the yellow slot. Never cycled. */
export const categorical = [series.blue, '#F47230', series.aqua, series.lemon, '#EE7FAC', '#008A17', '#6A4CE2', '#EC4647']

/** Chart furniture and roles. Text stays in the text inks; only marks carry series colour. */
export const chart = {
  actual: series.blue,
  forecast: series.lemon,
  neutral: palette.muted,
  grid: palette.line,
  axis: { fill: palette.muted, fontSize: 12 },
  cursor: 'rgba(110,116,128,0.08)',
  tooltip: { background: palette.card, border: `1px solid ${palette.line}`, borderRadius: 8, color: palette.ink },
  track: palette.chip,
  centre: palette.ink,
  label: palette.body,
  labelOnFill: palette.card,
}

/** The split of net income on Look-through: tax stays neutral, the other three are validated hues. */
export const split = { tax: palette.muted, business: series.aqua, living: series.blue, yours: series.lemon }

/** Living cost categories, one blue stepped light to dark; the lightest clears 2:1 on white. */
export const livingRamp = ['#84B9F3', '#519CED', '#2370CD', '#1757AC']
