/**
 * Icons with fixed meanings (design system › Iconography). Lucide, 16px in UI,
 * 12px in pills and tags, colored with currentColor. Decorative by default.
 */
import {
  Activity, AlarmClockOff, Archive, BookOpen, Bookmark, Building2, Calendar, CalendarX, ChartLine, Check, ChevronsUpDown, CircleCheck, CircleDot,
  CircleAlert, CircleSlash, CircleX, Clock, Cog, Copy, Download, CreditCard, Eye, FileText, FileX, Info, FlaskConical, Layers, LayoutGrid, Link2, ListChecks, Lock, MessageCircle,
  MessageSquare, Package, Pause, Pen, Plus, RefreshCw, Rocket, RotateCcw, ScanSearch, Search, Send, ShieldAlert, ShieldCheck, SlidersHorizontal, Sparkles, Store, TriangleAlert,
  Minus, Trophy, Upload, User, UserPlus, Wrench, X, type LucideIcon,
} from "lucide-react";

const ICONS = {
  activity: Activity,
  "alarm-clock-off": AlarmClockOff,
  archive: Archive,
  "alert-triangle": TriangleAlert,
  "book-open": BookOpen,
  bookmark: Bookmark,
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
  cog: Cog,
  copy: Copy,
  download: Download,
  "credit-card": CreditCard,
  eye: Eye,
  "file-text": FileText,
  "flask-conical": FlaskConical,
  layers: Layers,
  "link-2": Link2,
  "layout-grid": LayoutGrid,
  "list-checks": ListChecks,
  lock: Lock,
  "message-circle": MessageCircle,
  "message-square": MessageSquare,
  package: Package,
  pause: Pause,
  pen: Pen,
  plus: Plus,
  minus: Minus,
  "refresh-cw": RefreshCw,
  "rotate-ccw": RotateCcw,
  rocket: Rocket,
  search: Search,
  send: Send,
  "shield-alert": ShieldAlert,
  "shield-check": ShieldCheck,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  store: Store,
  "scan-search": ScanSearch,
  "circle-alert": CircleAlert,
  trophy: Trophy,
  upload: Upload,
  user: User,
  "user-plus": UserPlus,
  wrench: Wrench,
  "x-circle": CircleX,
  x: X,
  "file-x": FileX,
  info: Info,
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
