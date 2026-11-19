/**
 * Icons with fixed meanings (design system › Iconography). Lucide, 16px in UI,
 * 12px in pills and tags, colored with currentColor. Decorative by default.
 */
import {
  Pencil, Activity, AlarmClock, AlarmClockOff, Archive, BookOpen, Bookmark, Building2, Calendar, CalendarX, ChartLine, Check, ChevronsUpDown, CircleCheck, CircleDot,
  CircleAlert, CircleSlash, CircleX, Clock, Cog, Copy, Download, CreditCard, Eye, FileText, FilePen, FileX, Info, FlaskConical, Layers, LayoutGrid, Link2, ListChecks, Lock, MessageCircle,
  MessageSquare, Package, Pause, Pen, Plus, RefreshCw, Rocket, RotateCcw, ScanSearch, Search, Send, ShieldAlert, ShieldCheck, SlidersHorizontal, Sparkles, Store, TriangleAlert,
  Minus, ScrollText, FileSignature, Tags, Trophy, Upload, User, UserPlus, Wrench, X, Menu, Ellipsis, ListFilter, ArrowUpRight, ChevronDown, ChevronLeft, ArrowUp, ArrowDown, Globe, StickyNote, PhoneCall, Trash2, type LucideIcon,
} from "lucide-react";

const ICONS = {
  pencil: Pencil,
  activity: Activity,
  "alarm-clock": AlarmClock,
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
  "file-signature": FileSignature,
  "file-text": FileText,
  // Draft (pill and banner): its own icon, so it is never read as the File source type (R5 S6).
  "file-pen": FilePen,
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
  "scroll-text": ScrollText,
  tags: Tags,
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
  menu: Menu,
  ellipsis: Ellipsis,
  "list-filter": ListFilter,
  "arrow-up-right": ArrowUpRight,
  "chevron-down": ChevronDown,
  /** Back links (mirrors in RTL). */
  "chevron-left": ChevronLeft,
  "arrow-up": ArrowUp,
  "arrow-down": ArrowDown,
  globe: Globe,
  "sticky-note": StickyNote,
  "phone-call": PhoneCall,
  /** Delete (row menus, delete confirms). Never x-circle, which means Failed. */
  trash: Trash2,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** Icons that point in a direction and must mirror in RTL. */
const DIRECTIONAL: ReadonlySet<IconName> = new Set(["send", "chevron-left"]);

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
