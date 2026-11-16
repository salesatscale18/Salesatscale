"use client";

import { useRef, useState } from "react";
import { Icon } from "@/components/sas/icon";

/**
 * The person's reply box. When it starts with the agent's suggested reply, an
 * agent-tone label says so (UX: a person must never send agent text without
 * seeing that it is agent text). The label goes away once they edit the text;
 * "Clear" empties the box.
 */
export function SuggestedReplyBox(props: {
  id: string;
  suggested: string | null;
  label: string;
  clearLabel: string;
  describedBy?: string;
}) {
  const [agentText, setAgentText] = useState(Boolean(props.suggested));
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      {agentText ? (
        <span className="sas-small" data-agent-suggestion="" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", color: "var(--agent)" }}>
          <Icon name="sparkles" />
          <span>{props.label}</span>
          <button
            type="button"
            className="sas-btn sas-btn--ghost sas-btn--sm"
            onClick={() => {
              if (ref.current) {
                ref.current.value = "";
                ref.current.focus();
              }
              setAgentText(false);
            }}
          >
            {props.clearLabel}
          </button>
        </span>
      ) : null}
      <textarea
        ref={ref}
        className="sas-textarea"
        id={props.id}
        name="text"
        rows={3}
        required
        maxLength={4000}
        defaultValue={props.suggested ?? ""}
        dir="auto"
        aria-describedby={props.describedBy}
        onInput={() => setAgentText(false)}
      />
    </>
  );
}
