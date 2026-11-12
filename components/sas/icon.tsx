/**
 * Icons with fixed meanings (design system › Iconography). Lucide, 16px in UI,
 * 12px in pills and tags, colored with currentColor. Decorative by default.
 */
import {
  Activity, Archive, BookOpen, Building2, Calendar, CalendarX, ChartLine, Check, ChevronsUpDown, CircleCheck, CircleDot,
  CircleSlash, CircleX, Clock, CreditCard, Eye, FileText, FlaskConical, Layers, LayoutGrid, ListChecks, MessageCircle,
  MessageSquare, Package, Pause, Pen, Rocket, Send, ShieldCheck, SlidersHorizontal, Sparkles, TriangleAlert,
  User, UserPlus, type LucideIcon,
} from "lucide-react";

const ICONS = {
  activity: Activity,
  archive: Archive,
  "alert-triangle": TriangleAlert,
  "book-open": BookOpen,
  building: Building2,
  calendar: Calendar,
  "calendar-x": CalendarX,
  chart: ChartLine,
  check: Check,
  "check-circle": CircleCheck,
  "chevrons-up-down": ChevronsUpDown,
  "circle-dot": CircleDot,
  "circle-slash": CircleSlash,
  clock: Clock,
  "credit-card": CreditCard,
  eye: Eye,
  "file-text": FileText,
  "flask-conical": FlaskConical,
  layers: Layers,
  "layout-grid": LayoutGrid,
  "list-checks": ListChecks,
  "message-circle": MessageCircle,
  "message-square": MessageSquare,
  package: Package,
  pause: Pause,
  pen: Pen,
  rocket: Rocket,
  send: Send,
  "shield-check": ShieldCheck,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  user: User,
  "user-plus": UserPlus,
  "x-circle": CircleX,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** Icons that point in a direction and must mirror in RTL. */
const DIRECTIONAL: ReadonlySet<IconName> = new Set(["send"]);

export function Icon({ name, label, className }: { name: IconName; label?: string; className?: string }) {
  const Cmp = ICONS[name];
  const style = DIRECTIONAL.has(name) ? { transform: "scaleX(var(--sas-dir-flip, 1))" } : undefined;
  return (
    <Cmp
      className={className ? `sas-ico ${className}` : "sas-ico"}
      strokeWidth={2}
      style={style}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}
