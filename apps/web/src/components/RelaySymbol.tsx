import { relayNodes, relayPath } from "../branding";

export function RelaySymbol({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 96 96"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={relayPath}
        fill="none"
        stroke="var(--logo-text)"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {relayNodes.map(({ cx, cy, secondary }) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r="10"
          fill={secondary ? "var(--logo-secondary)" : "var(--logo-text)"}
        />
      ))}
    </svg>
  );
}
