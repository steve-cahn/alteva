import Link from "next/link";
import { HistoryList } from "@/components/HistoryList";
import { ArrowRightIcon } from "@/components/Icons";
import { buttonStyles } from "@/components/ui";

export default function HistoryPage() {
  return (
    <div className="animate-fade-up">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">History</h1>
          <p className="mt-1.5 text-muted">Every crawl you have run, newest first. Open one to see its pages.</p>
        </div>
        <Link href="/" className={buttonStyles("primary")}>
          New crawl
          <ArrowRightIcon size={16} />
        </Link>
      </div>
      <HistoryList />
    </div>
  );
}
