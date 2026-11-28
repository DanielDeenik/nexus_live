// The Nexus live menu: sections in the order of the LensIQ designs, and which section a page
// belongs to. Pure, so it is checked in supabase/tests/nav_web_test.ts.

export interface NavItem {
  label: string
  path: string
  /** Pages shown in the second row while this section is open. */
  sub?: { label: string; path: string }[]
}

// The Nexus live sections, in the order of the LensIQ designs.
export const NAV: NavItem[] = [
  { label: 'Look-through', path: '/look' },
  { label: 'Review', path: '/review' },
  { label: 'Forecast', path: '/forecast' },
  { label: 'Income & Tax', path: '/' },
  { label: 'Expenses', path: '/expenses' },
  { label: 'Tax filings', path: '/tax' },
  {
    label: 'Time', path: '/time',
    sub: [
      { label: 'Overview', path: '/time' },
      { label: 'Time entries', path: '/time/entries' },
      { label: 'Projects', path: '/time/projects' },
      { label: 'Flow blocks', path: '/time/flow' },
    ],
  },
  {
    label: 'Recruiter', path: '/recruiter',
    sub: [
      { label: 'Overview', path: '/recruiter' },
      { label: 'Fit reports', path: '/recruiter/fit' },
      { label: 'Applications', path: '/recruiter/applications' },
      { label: 'Roles', path: '/recruiter/roles' },
    ],
  },
  { label: 'LinkedIn', path: '/linkedin' },
  { label: 'Settings', path: '/settings' },
]

/** The section a path belongs to: an exact match, else the longest section path it starts with. */
export function sectionFor(pathname: string): NavItem | undefined {
  const exact = NAV.find((n) => n.path === pathname)
  if (exact) return exact
  return NAV.filter((n) => n.path !== '/' && pathname.startsWith(`${n.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
}
