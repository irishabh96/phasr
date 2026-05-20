type BackgroundOrbProps = {
  /** 0–1. Default 0.04 — bright variant for empty states uses 0.08. */
  intensity?: number;
};

/**
 * The "light source" of the app. A non-interactive radial accent glow
 * fixed to the top-left of the window. Every glass surface picks it
 * up through `backdrop-filter`.
 */
export function BackgroundOrb({ intensity = 0.04 }: BackgroundOrbProps) {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
      style={{
        background:
          "radial-gradient(circle at 12% -10%, var(--color-accent-500) 0%, transparent 55%)",
        opacity: intensity,
      }}
    />
  );
}
