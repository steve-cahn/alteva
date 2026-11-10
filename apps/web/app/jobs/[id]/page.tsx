import { Suspense } from "react";
import { JobSkeleton, JobView } from "@/components/JobView";

export default function JobPage(props: PageProps<"/jobs/[id]">) {
  return (
    <Suspense fallback={<JobSkeleton />}>
      <JobView params={props.params} />
    </Suspense>
  );
}
