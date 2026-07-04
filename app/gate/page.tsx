import { redirect } from "next/navigation";
import { hasValidSession } from "@/lib/session";
import { GateForm } from "./GateForm";

/**
 * /gate — the only page reachable unauthenticated (DESIGN.md §4). Server shell
 * + a small client form. If already authenticated, bounce to home.
 */
export default async function GatePage() {
  if (await hasValidSession()) {
    redirect("/");
  }

  return (
    <main className="flex min-h-full items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="font-mono text-2xl font-semibold tracking-tight text-[var(--accent)]">
            talasin
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Sharpen your reasoning and delivery.
          </p>
        </div>
        <GateForm />
      </div>
    </main>
  );
}
