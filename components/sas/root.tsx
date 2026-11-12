import type { ReactNode } from "react";
import { JetBrains_Mono, Noto_Sans_Hebrew } from "next/font/google";
import "./sas.css";

const notoHebrew = Noto_Sans_Hebrew({ subsets: ["hebrew"], weight: ["400", "600"], variable: "--font-noto-hebrew", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-jetbrains-mono", display: "swap" });

/**
 * Root of every workspace, admin and buyer surface that uses the design
 * system. Scopes tokens and component styles (see sas.css) and loads the
 * Hebrew and mono faces. Inter comes from the root layout.
 */
export function SasRoot({ children, theme }: { children: ReactNode; theme?: "light" | "dark" }) {
  return (
    <div className={`sas-app ${notoHebrew.variable} ${jetbrainsMono.variable}`} data-theme={theme} dir="ltr">
      {children}
    </div>
  );
}
