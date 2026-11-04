// Diagnose actual core reports; process names and screen text are not status.
export function reportingHealth(terminal) {
  const status = typeof terminal.status === "string" ? terminal.status : terminal.status?.state ?? terminal.report?.state;
  const known = ["idle", "working", "done", "blocked", "error"].includes(status);
  const metadata = terminal.records?.["unified-chat"];
  return { terminal: terminal.address, live: terminal.state === "live",
    status: known ? status : "unknown", reporting: known,
    metadata: Boolean(metadata?.msg),
    action: known ? "Verify working → blocked/idle transitions with a test session."
      : "Install a native OSC 7501 lifecycle integration; do not infer idle from terminal output." };
}
