/**
 * The AEGIS mark: a camera aperture ("AEGIS is a camera"). Outer ring, hexagonal opening, six blade edges.
 * One colour (currentColor), so it follows whatever palette the site uses. Source of the favicon and share image too
 * (public/favicon.svg, apple-touch-icon.png, icon-*.png, og.png — regenerate those if this shape changes).
 */
export function Mark({ size = 26, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <g fill="none" stroke="currentColor" strokeWidth={size < 20 ? 2.6 : 2} strokeLinejoin="round" strokeLinecap="round">
        <circle cx="16" cy="16" r="13.5" />
        <path d="M16.00 9.50 L21.63 12.75 L21.63 19.25 L16.00 22.50 L10.37 19.25 L10.37 12.75 Z" />
        <path d="M16.00 9.50 L8.19 4.99 M21.63 12.75 L21.63 3.73 M21.63 19.25 L29.44 14.74 M16.00 22.50 L23.81 27.01 M10.37 19.25 L10.37 28.27 M10.37 12.75 L2.56 17.26" />
      </g>
    </svg>
  );
}
