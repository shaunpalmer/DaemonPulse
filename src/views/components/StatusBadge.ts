/**
 * StatusBadge — Reusable status indicator component.
 *
 * Colour mapping from docs/Architecture & Design System.md section 5:
 *   Emerald → Active / Online
 *   Slate   → Idle / Offline
 *   Orange  → Warning / Latency
 *   Indigo  → Selected / Interactive
 *   Red     → Error / Stalled
 */

type BadgeVariant = 'active' | 'idle' | 'warning' | 'error' | 'selected';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  active:   'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
  idle:     'bg-slate-700/40   text-slate-400   border border-slate-700/40',
  warning:  'bg-orange-500/20  text-orange-400  border border-orange-500/30',
  error:    'bg-red-500/20     text-red-400     border border-red-500/30',
  selected: 'bg-indigo-600/20  text-indigo-400  border border-indigo-500/30',
};

export function renderStatusBadge(label: string, variant: BadgeVariant): string {
  return `
    <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono uppercase tracking-wider ${VARIANT_CLASSES[variant]}">
      <span class="w-1.5 h-1.5 rounded-full ${variant === 'active' ? 'bg-emerald-400 animate-pulse' : 'bg-current'}"></span>
      ${label}
    </span>
  `;
}
