import { csvTemplate } from "@/lib/leads/rules";

/** The lead import template, generated from CSV_TEMPLATE_HEADER (it replaced public/leads-template.csv, which had drifted). */
export function GET() {
  return new Response(csvTemplate(), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="leads-template.csv"',
    },
  });
}
