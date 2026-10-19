import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError, authJson } from "@/lib/auth/errors";
import { roleAtLeast, type Role } from "@/lib/auth/roles";
import { csrfMatches, currentUser, type SessionUser } from "@/lib/auth/session";

export { AuthError, authJson };

export async function requireApi(request: Request, min: Role): Promise<SessionUser> {
  const user = await currentUser(request);
  if (!user) throw new AuthError(401, "unauthorized", "Sign in required");
  if (!roleAtLeast(user.role, min)) throw new AuthError(403, "forbidden", "This role cannot do that");
  if (!csrfMatches(request, user.csrf)) throw new AuthError(403, "forbidden", "Refresh the page and try again");
  return user;
}

export async function guard(request: Request, min: Role): Promise<{ user: SessionUser } | { response: Response }> {
  try {
    return { user: await requireApi(request, min) };
  } catch (error) {
    if (error instanceof AuthError) return { response: authJson(error) };
    throw error;
  }
}

export async function requirePage(min: Role): Promise<SessionUser> {
  const jar = await cookies();
  const header = jar
    .getAll()
    .map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
    .join("; ");
  const user = await currentUser(new Request("http://local/", { headers: { cookie: header } }));
  if (!user) redirect("/sign-in");
  if (!roleAtLeast(user.role, min)) redirect("/");
  return user;
}
