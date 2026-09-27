import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { WorkflowsList } from "@/components/workflows/workflows-list";

export const Route = createFileRoute("/_authed/_app/workflows")({
  component: WorkflowsPage,
});

function WorkflowsPage() {
  return (
    <PageShell
      description="Durable multi-step work your coworkers can pause, sleep, resume and complete across Agent turns. Inspect step progress and assets, or pause, resume and cancel a workflow here."
      title="Workflows"
    >
      <WorkflowsList />
    </PageShell>
  );
}
