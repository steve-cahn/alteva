// Serves test/fixtures/site on a fixed port so the crawler can be tried by hand against pages
// whose correct answer is known (see the README's "Verifying it works").
//   pnpm --filter @alteva/worker fixtures        then crawl http://127.0.0.1:8099/
import { startFixtureServer } from "./helpers";

const { baseUrl, requests } = await startFixtureServer(Number(process.env.FIXTURE_PORT ?? 8099));
console.log(`Fixture site on ${baseUrl}/  (Ctrl+C to stop)`);
setInterval(() => {}, 1 << 30);
process.on("SIGINT", () => {
  console.log(`\nServed ${requests.length} requests: ${requests.join(" ")}`);
  process.exit(0);
});
