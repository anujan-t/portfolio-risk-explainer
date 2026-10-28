const BLADES = [
  'M20.85 13.2L30.26 18.63A14.5 14.5 0 0 1 20.85 29.66Z',
  'M20.85 18.8L20.85 29.66A14.5 14.5 0 0 1 6.59 27.03Z',
  'M16 21.6L6.59 27.03A14.5 14.5 0 0 1 1.74 13.37Z',
  'M11.15 18.8L1.74 13.37A14.5 14.5 0 0 1 11.15 2.34Z',
  'M11.15 13.2L11.15 2.34A14.5 14.5 0 0 1 25.41 4.97Z',
  'M16 10.4L25.41 4.97A14.5 14.5 0 0 1 30.26 18.63Z',
];

/** Six-blade aperture mark. Blade gaps are cut with a canvas-coloured stroke. */
export function ApertureMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <g className="aperture__blades">
        {BLADES.map(path => (
          <path key={path} d={path} />
        ))}
      </g>
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <ApertureMark className="logo__mark" />
      <span className="logo__word">LENS</span>
    </span>
  );
}
