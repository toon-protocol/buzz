import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const FactoryJobsScreen = React.lazy(async () => {
  const module = await import("@/features/factory-jobs/ui/FactoryJobsScreen");
  return { default: module.FactoryJobsScreen };
});

export const Route = createFileRoute("/jobs")({
  component: JobsRouteComponent,
});

function JobsRouteComponent() {
  usePreviewFeatureWarning("factoryJobs");
  return (
    <React.Suspense
      fallback={<ViewLoadingFallback includeHeader kind="factoryJobs" />}
    >
      <FactoryJobsScreen />
    </React.Suspense>
  );
}
