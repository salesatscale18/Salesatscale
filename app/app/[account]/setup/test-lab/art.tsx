/**
 * Small decorative drawings for the test lab's empty states (chat, call,
 * history). Inline SVG in the page's own colours (CSS variables), so they
 * follow the lab palette; hidden from screen readers (the text beside them
 * says what to do).
 */
const P = "var(--primary)";
const A = "var(--primary-accent, var(--primary))";
const S = "var(--primary-soft)";
const R = "var(--surface-raised)";
const L = "var(--line)";

export function ChatArt() {
  return (
    <svg className="lab-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
      <circle cx="80" cy="60" r="56" fill={S} />
      <rect x="28" y="30" width="72" height="34" rx="12" fill={R} stroke={L} strokeWidth="2" />
      <path d="M44 64 l-6 12 l16 -12z" fill={R} stroke={L} strokeWidth="2" strokeLinejoin="round" />
      <rect x="40" y="40" width="40" height="5" rx="2.5" fill={L} />
      <rect x="40" y="50" width="26" height="5" rx="2.5" fill={L} />
      <rect x="64" y="58" width="68" height="32" rx="12" fill={A} />
      <path d="M118 90 l8 10 l-2 -10z" fill={A} />
      <circle cx="84" cy="74" r="4" fill={R} />
      <circle cx="98" cy="74" r="4" fill={R} />
      <circle cx="112" cy="74" r="4" fill={R} />
      <path d="M122 22 l3 7 l7 3 l-7 3 l-3 7 l-3 -7 l-7 -3 l7 -3z" fill={P} />
    </svg>
  );
}

export function CallArt() {
  return (
    <svg className="lab-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
      <circle cx="80" cy="60" r="56" fill={S} />
      <circle cx="80" cy="60" r="26" fill={A} />
      <path
        d="M70 50 c0 -2 2 -4 4 -4 h3 l3 8 l-4 3 c2 4 5 7 9 9 l3 -4 l8 3 v3 c0 2 -2 4 -4 4 c-12 0 -22 -10 -22 -22z"
        fill={R}
      />
      <g stroke={P} strokeWidth="4" strokeLinecap="round">
        <path d="M120 46 v28" />
        <path d="M130 52 v16" />
        <path d="M140 57 v6" />
        <path d="M40 46 v28" />
        <path d="M30 52 v16" />
        <path d="M20 57 v6" />
      </g>
    </svg>
  );
}

export function HistoryArt() {
  return (
    <svg className="lab-art" viewBox="0 0 160 120" aria-hidden="true" focusable="false">
      <circle cx="80" cy="60" r="56" fill={S} />
      <rect x="44" y="26" width="72" height="20" rx="8" fill={R} stroke={L} strokeWidth="2" />
      <rect x="44" y="52" width="72" height="20" rx="8" fill={R} stroke={L} strokeWidth="2" />
      <rect x="44" y="78" width="72" height="20" rx="8" fill={R} stroke={L} strokeWidth="2" />
      <circle cx="55" cy="36" r="5" fill={A} />
      <circle cx="55" cy="62" r="5" fill={P} />
      <circle cx="55" cy="88" r="5" fill={A} />
      <rect x="66" y="33" width="38" height="6" rx="3" fill={L} />
      <rect x="66" y="59" width="30" height="6" rx="3" fill={L} />
      <rect x="66" y="85" width="34" height="6" rx="3" fill={L} />
    </svg>
  );
}
