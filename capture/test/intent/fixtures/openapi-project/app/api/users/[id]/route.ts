// Fixture: Next.js app-router handler for /users/{id}.
// Used by capture/test/intent/openapi.test.mjs.
//
// Both the file path (`app/api/users/[id]/route.ts`) and the function
// names ("GET", "PATCH") are inferred by the OpenAPI source.
//
// @ts-nocheck

export async function GET(req, { params }) {
  return Response.json({ id: params.id })
}

export async function PATCH(req, { params }) {
  const body = await req.json()
  return Response.json({ id: params.id, ...body })
}
