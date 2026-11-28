/** The LensIQ mark with the application name: a lemon square, "LensIQ", and "Nexus live" in mono.
 *  `tone` picks the ink for the night band (dark) or the paper ground (light). */
export function Brand({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="w-2.5 h-2.5 rounded-[2px] bg-lemon" aria-hidden="true" />
      <span className={`font-display font-extrabold text-lg ${tone === 'dark' ? 'text-white' : 'text-ink'}`}>LensIQ</span>
      <span className={`font-mono font-medium text-xs uppercase tracking-[0.14em] ${tone === 'dark' ? 'text-lemon' : 'text-lemon-ink'}`}>Nexus live</span>
    </span>
  )
}
