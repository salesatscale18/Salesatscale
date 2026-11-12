"use client";

import { useState, type FormEvent } from "react";

// TODO: connect this form to a real backend (e.g. Formspree, HubSpot, or your own endpoint).
export function ContactForm() {
  const [note, setNote] = useState("");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNote("Thanks! We'll be in touch shortly.");
    e.currentTarget.reset();
  }

  return (
    <form id="contact-form" onSubmit={onSubmit}>
      <div className="row">
        <input type="text" name="name" placeholder="Your name" required />
        <input type="email" name="email" placeholder="Work email" required />
      </div>
      <input type="text" name="company" placeholder="Company" />
      <textarea name="message" placeholder="What's your biggest sales challenge right now?" />
      <button type="submit" className="btn btn-primary">
        Request a call →
      </button>
      <p className="form-note" id="form-note" role="status">
        {note}
      </p>
    </form>
  );
}
