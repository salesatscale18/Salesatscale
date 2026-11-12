import type { Metadata } from "next";
import Link from "next/link";
import { Year } from "../year";

export const metadata: Metadata = {
  title: "Terms & Conditions — Sales at Scale",
  description: "The terms and conditions for using the Sales at Scale website and services.",
};

export default function TermsPage() {
  return (
    <>
      <header>
        <div className="container nav">
          <Link href="/" className="logo">
            <span className="logo-mark" aria-hidden="true">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth={2.6}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 17 9 11 13 15 21 7" />
                <polyline points="15 7 21 7 21 13" />
              </svg>
            </span>
            Sales at Scale
          </Link>
          <Link href="/#contact" className="btn btn-primary">
            Book a call
          </Link>
        </div>
      </header>

      <main className="legal">
        <div className="container">
          <h1>Terms &amp; Conditions</h1>
          <p className="updated">Last updated: TODO</p>

          {/* TODO: replace with the terms text provided by the user. */}
          <p>TODO: terms text goes here.</p>
        </div>
      </main>

      <footer>
        <div className="container footer-inner">
          <span>
            © <Year /> Sales at Scale. All rights reserved.
          </span>
          <nav className="nav-links" style={{ display: "flex" }}>
            <Link href="/">Home</Link>
            <Link href="/#contact">Contact</Link>
            <Link href="/terms">Terms &amp; Conditions</Link>
          </nav>
        </div>
      </footer>
    </>
  );
}
