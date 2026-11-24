import type { ReactNode } from "react";
import { JetBrains_Mono, Noto_Sans_Hebrew } from "next/font/google";
import "./sas.css";

const notoHebrew = Noto_Sans_Hebrew({ subsets: ["hebrew"], weight: ["400", "600"], variable: "--font-noto-hebrew", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-jetbrains-mono", display: "swap" });

/**
 * Root of every workspace, admin and buyer surface that uses the design
 * system. Scopes tokens and component styles (see sas.css) and loads the
 * Hebrew and mono faces. Inter comes from the root layout.
 * `tone`: "admin" = the platform admin's green palette, "seller" = the seller
 * workspace's orange palette (sas.css, `.sas-app--admin` / `.sas-app--seller`).
 */
export function SasRoot({ children, theme, tone }: { children: ReactNode; theme?: "light" | "dark"; tone?: "admin" | "seller" }) {
  return (
    <div className={`sas-app${tone ? ` sas-app--${tone}` : ""} ${notoHebrew.variable} ${jetbrainsMono.variable}`} data-theme={theme} dir="ltr">
      {children}
    </div>
  );
}
