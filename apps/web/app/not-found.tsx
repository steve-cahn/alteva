import Link from "next/link";

export default function NotFound() {
  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">There is nothing at this address.</p>
      <Link href="/" className="mt-4 inline-block text-blue-600 underline dark:text-blue-400">
        Start a crawl
      </Link>
    </div>
  );
}
