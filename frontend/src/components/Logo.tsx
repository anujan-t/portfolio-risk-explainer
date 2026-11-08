/** Masthead wordmark: "LENS" in serif small capitals, a thin rule, then the publication line. */
export function Logo() {
  return (
    <span className="logo">
      <span className="logo__word">LENS</span>
      <span className="logo__rule" aria-hidden="true" />
      <span className="logo__line">Portfolio risk notes</span>
    </span>
  );
}
