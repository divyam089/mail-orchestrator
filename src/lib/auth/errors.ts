export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: "unauthorized" | "forbidden" | "validation",
    message: string,
  ) {
    super(message);
  }
}

export function authJson(error: AuthError): Response {
  return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
}
