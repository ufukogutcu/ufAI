export function MessageEnvelope({ className, transform }: { className?: string; transform?: string }) {
  return (
    <g aria-hidden="true" className={className} transform={transform}
      stroke="var(--communication-envelope-foreground)" strokeWidth={1.35}
      strokeLinecap="round" strokeLinejoin="round">
      <rect x={-12} y={-8} width={24} height={16} rx={2.7} fill="var(--communication-envelope-surface)" />
      <path d="M-11.1 -6.5L-1.5 0.8Q0 1.9 1.5 0.8L11.1 -6.5" fill="none" />
    </g>
  );
}
