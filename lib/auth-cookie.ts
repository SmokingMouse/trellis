// Shared name of the session cookie set by /api/login and checked by
// middleware.ts. In its own module so the edge (middleware) and node (route)
// sides don't import each other.
export const AUTH_COOKIE = "trellis_auth";
