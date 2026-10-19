import { ReviewDeskView } from "@/components/review-desk";
import { requirePage } from "@/lib/auth/guard";
import { roleAtLeast } from "@/lib/auth/roles";
import { loadReviewDesk, type ReviewDesk } from "@/lib/send/desk";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const user = await requirePage("viewer");
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
  return (
    <ReviewDeskView
      initial={desk}
      canWrite={roleAtLeast(user.role, "operator")}
      canToggleApproval={user.role === "admin"}
    />
  );
}
