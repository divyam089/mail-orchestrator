import { ReviewDeskView } from "@/components/review-desk";
import { loadReviewDesk, type ReviewDesk } from "@/lib/send/desk";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  let desk: ReviewDesk | null = null;
  let error: string | null = null;
  try {
    desk = await loadReviewDesk();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Database unreachable";
  }
  if (!desk) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-10">
        <p className="text-rust">{error ?? "Review is unavailable"}</p>
      </main>
    );
  }
  return <ReviewDeskView initial={desk} />;
}
