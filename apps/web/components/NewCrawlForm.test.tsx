// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { NewCrawlForm } from "./NewCrawlForm";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), createJob: vi.fn() }));
import { createJob } from "@/lib/api";

const createJobMock = vi.mocked(createJob);

beforeEach(() => {
  push.mockReset();
  createJobMock.mockReset();
});
afterEach(cleanup);

async function submit(url: string, maxDepth?: number) {
  const user = userEvent.setup();
  render(<NewCrawlForm />);
  if (url) await user.type(screen.getByLabelText(/website url/i), url);
  if (maxDepth !== undefined) await user.click(screen.getByRole("radio", { name: String(maxDepth) }));
  await user.click(screen.getByRole("button", { name: /start crawl/i }));
}

describe("NewCrawlForm", () => {
  it("posts the trimmed url and navigates to the job page", async () => {
    createJobMock.mockResolvedValue({ jobId: "job-42" });
    await submit("  https://site.test  ");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/jobs/job-42"));
    expect(createJobMock).toHaveBeenCalledWith({ url: "https://site.test", maxDepth: 2 }); // the default depth
  });

  it("sends the depth that was chosen", async () => {
    createJobMock.mockResolvedValue({ jobId: "j" });
    await submit("https://site.test", 3);
    await waitFor(() => expect(createJobMock).toHaveBeenCalledWith({ url: "https://site.test", maxDepth: 3 }));
  });

  it("sends depth 0 (the start page only) as a real 0, not as 'no depth chosen'", async () => {
    createJobMock.mockResolvedValue({ jobId: "j" });
    await submit("https://site.test", 0);
    await waitFor(() => expect(createJobMock).toHaveBeenCalledWith({ url: "https://site.test", maxDepth: 0 }));
  });

  it("fills the address from an example site with one click", async () => {
    const user = userEvent.setup();
    render(<NewCrawlForm />);
    await user.click(screen.getByRole("button", { name: "books.toscrape.com" }));
    expect((screen.getByLabelText(/website url/i) as HTMLInputElement).value).toBe("https://books.toscrape.com/");
  });

  it("shows the api's validation errors next to the fields and does not navigate", async () => {
    createJobMock.mockRejectedValue(
      new ApiRequestError(400, "VALIDATION_ERROR", "Request validation failed", [
        { field: "url", message: "must be an absolute http or https URL" },
        { field: "maxDepth", message: "must be a whole number from 0 to 200" },
      ]),
    );
    await submit("ftp://nope", 5);

    expect(await screen.findByText(/URL must be an absolute http or https URL/)).toBeTruthy();
    expect(screen.getByText(/Max depth must be a whole number from 0 to 200/)).toBeTruthy();
    expect(screen.getByLabelText(/website url/i).getAttribute("aria-invalid")).toBe("true");
    expect(push).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /start crawl/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a non-field api error (503, unreachable) as an alert with its reference", async () => {
    createJobMock.mockRejectedValue(new ApiRequestError(503, "SERVICE_UNAVAILABLE", "The message broker is unavailable", [], "ref-9"));
    await submit("https://site.test");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The message broker is unavailable");
    expect(alert.textContent).toContain("ref-9");
  });

  it("is never silent when the api rejects a field the form does not show", async () => {
    createJobMock.mockRejectedValue(new ApiRequestError(400, "VALIDATION_ERROR", "Request validation failed", [{ field: "body", message: "must be a JSON object" }]));
    await submit("https://site.test");
    expect((await screen.findByRole("alert")).textContent).toContain("Request validation failed");
  });

  it("disables the button while submitting, and clears old errors on resubmit", async () => {
    createJobMock.mockRejectedValueOnce(new ApiRequestError(0, "NETWORK_ERROR", "Could not reach the API")).mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<NewCrawlForm />);
    await user.type(screen.getByLabelText(/website url/i), "https://site.test");
    await user.click(screen.getByRole("button", { name: /start crawl/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /start crawl/i }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: /starting/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// With cacheComponents, Next does not unmount a page you navigate away from: it hides it with
// <Activity>, which keeps React state. So any state left over from submitting comes back with the
// page. These tests hide and re-show the form the way a navigation to /history and back does.
describe("NewCrawlForm when its page is hidden and shown again (Activity)", () => {
  const renderInActivity = () => {
    const tree = (mode: "visible" | "hidden") => (
      <Activity mode={mode}>
        <NewCrawlForm />
      </Activity>
    );
    const view = render(tree("visible"));
    return { hide: () => view.rerender(tree("hidden")), show: () => view.rerender(tree("visible")) };
  };

  it("is a fresh, usable form after a successful submit and a round trip", async () => {
    createJobMock.mockResolvedValue({ jobId: "job-1" });
    const user = userEvent.setup();
    const page = renderInActivity();
    await user.type(screen.getByLabelText(/website url/i), "https://site.test");
    await user.click(screen.getByRole("button", { name: /start crawl/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/jobs/job-1"));

    page.hide();
    page.show();

    const button = screen.getByRole("button", { name: /start crawl/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect((screen.getByLabelText(/website url/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("radio", { name: "2" }) as HTMLInputElement).checked).toBe(true); // depth is back to the default
  });

  it("can start a second crawl after coming back", async () => {
    createJobMock.mockResolvedValueOnce({ jobId: "job-1" }).mockResolvedValueOnce({ jobId: "job-2" });
    const user = userEvent.setup();
    const page = renderInActivity();
    await user.type(screen.getByLabelText(/website url/i), "https://one.test");
    await user.click(screen.getByRole("button", { name: /start crawl/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/jobs/job-1"));
    page.hide();
    page.show();

    await user.type(screen.getByLabelText(/website url/i), "https://two.test");
    await user.click(screen.getByRole("button", { name: /start crawl/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/jobs/job-2"));
    expect(createJobMock).toHaveBeenLastCalledWith({ url: "https://two.test", maxDepth: 2 });
  });

  it("keeps a half-typed draft when the user leaves without submitting", async () => {
    const user = userEvent.setup();
    const page = renderInActivity();
    await user.type(screen.getByLabelText(/website url/i), "https://draft.test");
    page.hide();
    page.show();
    expect((screen.getByLabelText(/website url/i) as HTMLInputElement).value).toBe("https://draft.test");
  });
});
